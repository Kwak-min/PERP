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

export type ApiStreamEvent = Readonly<{ id: string | null; event: string; data: unknown }>;

// Bearer는 헤더에만 둔다. 호출자가 화면 수명 signal과 마지막 인가 cursor를 소유한다.
export async function apiEventStream(
  path: string,
  options: Readonly<{ session: ApiSession; signal: AbortSignal; cursor?: number; onEvent: (event: ApiStreamEvent) => void }>,
): Promise<void> {
  const failure = (code: string, status: number) => new ApiError("위키 이벤트 연결을 완료하지 못했습니다.", { code, status, requestId: "", details: {} });
  if (!/^\/(?:pg\/)?(?:vault|documents)\/wiki\/events$/.test(path) || (options.cursor !== undefined && (!Number.isSafeInteger(options.cursor) || options.cursor < 0))) throw failure("VALIDATION_ERROR", 400);
  if (!options.session.token) throw failure("UNAUTHENTICATED", 401);
  const headers = new Headers({ Accept: "text/event-stream", Authorization: `Bearer ${options.session.token}` });
  if (options.session.orgId) headers.set("X-Org-Id", options.session.orgId);
  if (options.cursor !== undefined) headers.set("Last-Event-ID", String(options.cursor));
  const response = await fetch(`${API_BASE_URL}${workspaceEndpoint(path, options.session.orgId)}`, { headers, signal: options.signal, cache: "no-store" });
  if (!response.ok) {
    const text = await response.text();
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw failure("INVALID_RESPONSE", response.status); }
    const parsed = apiErrorSchema.safeParse(payload);
    if (!parsed.success) throw failure("HTTP_ERROR", response.status);
    throw new ApiError(parsed.data.error.message, { code: parsed.data.error.code, status: response.status, requestId: parsed.data.error.request_id, details: parsed.data.error.details });
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    await response.body?.cancel();
    throw failure("INVALID_RESPONSE", 502);
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", event = "message", id: string | null = null, data: string[] = [], size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { if (buffer || data.length) throw failure("TRUNCATED_EVENT", 502); return; }
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
        size += line.length;
        if (size > 65536) throw failure("EVENT_LIMIT", 502);
        if (!line) {
          if (data.length) {
            let parsed: unknown;
            try { parsed = JSON.parse(data.join("\n")); } catch { throw failure("INVALID_EVENT", 502); }
            options.onEvent({ id, event, data: parsed });
          }
          event = "message"; id = null; data = []; size = 0;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        if (field === "id" && !value.includes("\0")) id = value;
        if (field === "data") data.push(value);
      }
      if (buffer.length + size > 65536) throw failure("EVENT_LIMIT", 502);
    }
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
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
