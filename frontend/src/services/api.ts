import { z } from "zod";

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

  const request: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };
  if (options.body !== undefined) request.body = JSON.stringify(options.body);
  if (options.signal) request.signal = options.signal;
  const response = await fetch(`${API_BASE_URL}${path}`, request);

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

export function userMessageOf(error: unknown): string {
  if (error instanceof ApiError) {
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
