export const CODE_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  MODULE_DISABLED: 403,
  NO_ORGANIZATION: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PERIOD_LOCKED: 409,
  APPROVAL_REQUIRED: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class ApiError extends Error {
  constructor(code, message, details = {}, status = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
    this.status = status ?? CODE_STATUS[code] ?? 400;
  }
}

export const notFound = (resource = "resource") => new ApiError("NOT_FOUND", `${resource} not found`);
export const denied = (action) => new ApiError("PERMISSION_DENIED", `permission denied: ${action}`);
export const invalid = (message, details = {}) => new ApiError("VALIDATION_ERROR", message, details);
export const conflict = (message, details = {}) => new ApiError("CONFLICT", message, details);
