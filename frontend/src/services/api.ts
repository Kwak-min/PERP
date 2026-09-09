import { z } from "zod";
import { workspaceEndpoint } from "./workspace";

const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).catch({}),
    request_id: z.string().catch(""),
  }),
});

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    options: {
      code: string;
      status: number;
      requestId: string;
      details: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

export type ApiSession = Readonly<{
  token: string;
  orgId: string | null;
}>;

type ApiOptions = Readonly<{
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  session?: ApiSession | null;
  signal?: AbortSignal;
  headers?: Readonly<Record<string, string>>;
}>;

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

export async function apiRequest(
  path: string,
  options: ApiOptions = {},
): Promise<unknown> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.session?.token) {
    headers.set("Authorization", `Bearer ${options.session.token}`);
  }
  if (options.session?.orgId) headers.set("X-Org-Id", options.session.orgId);

  const timeout = AbortSignal.timeout(10_000);
  const request: RequestInit = {
    method: options.method ?? "GET",
    headers,
    signal: options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout,
  };
  if (options.body !== undefined) request.body = JSON.stringify(options.body);
  const response = await fetch(`${API_BASE_URL}${workspaceEndpoint(path, options.session?.orgId)}`, request);

  if (response.status === 204 || response.status === 205) return null;
  const contentType = response.headers.get("content-type") ?? "";
  let payload: unknown;
  try {
    payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
  } catch {
    if (!response.ok) {
      throw new ApiError(`요청이 실패했습니다 (HTTP ${response.status})`, {
        code: "INVALID_RESPONSE",
        status: response.status,
        requestId: response.headers.get("x-request-id") ?? "",
        details: {},
      });
    }
    payload = null;
  }

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiError(parsed.data.error.message, {
        code: parsed.data.error.code,
        status: response.status,
        requestId: parsed.data.error.request_id,
        details: parsed.data.error.details,
      });
    }
    throw new ApiError(`요청을 완료하지 못했습니다 (${response.status})`, {
      code: "HTTP_ERROR",
      status: response.status,
      requestId: response.headers.get("x-request-id") ?? "",
      details: {},
    });
  }
  return payload;
}

async function responsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  try { return contentType.includes("application/json") ? await response.json() : await response.text(); }
  catch { return null; }
}

function throwUploadError(response: Response, payload: unknown, fallback: string): never {
  const parsed = apiErrorSchema.safeParse(payload);
  throw new ApiError(parsed.success ? parsed.data.error.message : `${fallback} (${response.status})`, {
    code: parsed.success ? parsed.data.error.code : "HTTP_ERROR", status: response.status,
    requestId: response.headers.get("x-request-id") ?? "", details: parsed.success ? parsed.data.error.details : {},
  });
}

// CSV는 JSON/base64/multipart가 아닌 선택한 UTF-8 파일의 원본 bytes로만 전송한다.
export async function apiCsvUpload(
  path: string,
  options: Readonly<{ file: File; session: ApiSession; signal: AbortSignal }>,
): Promise<unknown> {
  if (!/^\/(?:pg\/)?finance\/transactions\/imports\/uploads$/.test(path)) {
    throw new ApiError("CSV 업로드 경로가 올바르지 않습니다.", { code: "VALIDATION_ERROR", status: 400, requestId: "", details: {} });
  }
  const headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${options.session.token}`, "Content-Type": "text/csv" });
  if (options.session.orgId) headers.set("X-Org-Id", options.session.orgId);
  const response = await fetch(`${API_BASE_URL}${workspaceEndpoint(path, options.session.orgId)}`, {
    method: "POST", headers, body: await options.file.arrayBuffer(), cache: "no-store", redirect: "error",
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(30000)]),
  });
  const payload = await responsePayload(response);
  if (!response.ok) throwUploadError(response, payload, "CSV 업로드 실패");
  return payload;
}

// 원증빙은 JSON이 아닌 원본 bytes로 전송한다. 모든 네트워크 경계는 이 모듈에 둔다.
export async function apiReceiptUpload(
  path: string,
  options: Readonly<{ file: File; session: ApiSession; signal: AbortSignal }>,
): Promise<unknown> {
  if (!/^\/(?:pg\/)?finance\/transactions\/receipt-uploads$/.test(path)) {
    throw new ApiError("영수증 업로드 경로가 올바르지 않습니다.", { code: "VALIDATION_ERROR", status: 400, requestId: "", details: {} });
  }
  const headers = new Headers({ Authorization: `Bearer ${options.session.token}`, "Content-Type": options.file.type, "X-Upload-Name": encodeURIComponent(options.file.name) });
  if (options.session.orgId) headers.set("X-Org-Id", options.session.orgId);
  const response = await fetch(`${API_BASE_URL}${path}`, { method: "POST", headers, body: options.file,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(30000)]), redirect: "error" });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    throw new ApiError(parsed.success ? parsed.data.error.message : `업로드 실패 (${response.status})`, {
      code: parsed.success ? parsed.data.error.code : "HTTP_ERROR", status: response.status,
      requestId: response.headers.get("x-request-id") ?? "", details: parsed.success ? parsed.data.error.details : {},
    });
  }
  return payload;
}

// 호출자는 blob을 사용한 뒤 objectURL을 revoke한다. 인증정보를 URL에 넣지 않는다.
export async function apiBlob(
  path: string,
  options: Readonly<{ session: ApiSession; signal?: AbortSignal }>,
): Promise<Readonly<{ blob: Blob; filename: string; rowCount: number | null }>> {
  const analytics = /^\/(?:pg\/)?analytics\/exports\/[a-zA-Z0-9-]+\/download$/.test(path);
  if (!analytics && !/^\/(?:pg\/)?(?:finance\/transactions|approvals(?:\/requests)?)\/[^/?#]+\/receipts\/[^/?#]+$/.test(path)) {
    throw new ApiError("다운로드 경로가 올바르지 않습니다.", { code: "VALIDATION_ERROR", status: 400, requestId: "", details: {} });
  }
  if (analytics && (!options.session.orgId || options.session.orgId.startsWith('pg:') !== path.startsWith('/pg/'))) {
    throw new ApiError('내보내기 원천과 선택 회사가 다릅니다.', { code: 'VALIDATION_ERROR', status: 400, requestId: '', details: {} });
  }
  const headers = new Headers({ Accept: analytics ? 'text/csv' : "image/jpeg, image/png, application/pdf", Authorization: `Bearer ${options.session.token}` });
  if (options.session.orgId) headers.set("X-Org-Id", options.session.orgId);
  const response = await fetch(`${API_BASE_URL}${workspaceEndpoint(path, options.session.orgId)}`, {
    headers, cache: "no-store", redirect: "error",
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const text = await response.text();
    let payload: unknown = text;
    try { payload = JSON.parse(text); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    const parsed = apiErrorSchema.safeParse(payload);
    throw new ApiError(parsed.success ? parsed.data.error.message : `다운로드 실패 (${response.status})`, {
      code: parsed.success ? parsed.data.error.code : "HTTP_ERROR", status: response.status,
      requestId: response.headers.get("x-request-id") ?? "", details: parsed.success ? parsed.data.error.details : {},
    });
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const quoted = /filename="([^"\r\n]+)"/i.exec(disposition)?.[1];
  const filename = encoded ? decodeURIComponent(encoded) : quoted ?? (analytics ? 'analytics.csv' : 'receipt');
  const count = response.headers.get('x-row-count');
  if (analytics && (!response.headers.get('content-type')?.startsWith('text/csv') || count === null || !/^(0|[1-9]\d{0,5})$/.test(count) || Number(count) > 100000)) {
    throw new ApiError('CSV 응답 형식 또는 X-Row-Count가 올바르지 않습니다.', { code: 'INVALID_RESPONSE', status: response.status, requestId: '', details: {} });
  }
  return { blob: await response.blob(), filename, rowCount: analytics ? Number(count) : null };
}

// 결재 원본은 multipart가 아닌 검증된 원본 바이트 계약으로 전송한다.
export async function apiUpload(path: string, file: File, options: Readonly<{ session: ApiSession; signal?: AbortSignal }>): Promise<unknown> {
  if (!/^\/(?:pg\/)?approvals\/receipt-uploads$/.test(path)) {
    throw new ApiError('첨부 업로드 경로가 올바르지 않습니다.', { code: 'VALIDATION_ERROR', status: 400, requestId: '', details: {} });
  }
  const headers = new Headers({ Accept: 'application/json', 'Content-Type': file.type || 'application/octet-stream',
    'X-Upload-Name': encodeURIComponent(file.name), Authorization: `Bearer ${options.session.token}` });
  if (options.session.orgId) headers.set('X-Org-Id', options.session.orgId);
  const response = await fetch(`${API_BASE_URL}${workspaceEndpoint(path, options.session.orgId)}`, { method: 'POST', headers, body: file,
    redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    throw new ApiError(parsed.success ? parsed.data.error.message : `첨부 실패 (${response.status})`, {
      code: parsed.success ? parsed.data.error.code : 'HTTP_ERROR', status: response.status,
      requestId: response.headers.get('x-request-id') ?? '', details: parsed.success ? parsed.data.error.details : {},
    });
  }
  return payload;
}

export function userMessageOf(error: unknown): string {
  if (error instanceof ApiError) {
    // 503 은 원인·조치가 담긴 운영 안내라 그대로 노출한다.
    // 나머지 5xx 는 내부 사정을 감춘 일반 문구를 유지한다.
    if (error.status === 503 && error.message) return error.message;
    if (error.status >= 500) return "서버에 일시적인 문제가 발생했습니다.";
    return error.message;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (error instanceof TypeError) {
    return "네트워크 연결을 확인한 뒤 다시 시도해 주세요.";
  }
  return "요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}
