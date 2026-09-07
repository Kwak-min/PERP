import crypto from "node:crypto";

import { ApiError } from "../utils/errors.js";

export function requestContext(req, res, next) {
  req.requestId = req.get("x-request-id") || crypto.randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
}

export function asyncRoute(handler) {
  return (req, res, next) => {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.catch === "function") result.catch(next);
    } catch (error) {
      next(error);
    }
  };
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `no route for ${req.method} ${req.path}`,
      details: {},
      request_id: req.requestId ?? "",
    },
  });
}

export function errorHandler(error, req, res, _next) {
  // JSON 파서 오류는 원본 body를 포함하므로 비밀 입력 경로에서는 기록하지 않는다.
  if (/^\/api\/v1\/(?:pg\/)?agent\/api-key(?:\/|$)/i.test(req.path) && error?.type === "entity.parse.failed") {
    res.set("Cache-Control", "no-store").status(400).json({
      error: { code: "VALIDATION_ERROR", message: "요청 JSON 형식을 확인하세요.", details: {}, request_id: req.requestId ?? "" },
    });
    return;
  }
  if (error instanceof ApiError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
        request_id: req.requestId ?? "",
      },
    });
    return;
  }
  if (error?.name === "ZodError") {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "요청 값이 올바르지 않습니다",
        details: { issues: error.issues },
        request_id: req.requestId ?? "",
      },
    });
    return;
  }
  console.error(`[${req.requestId}] unhandled`, error);
  res.status(500).json({
    error: {
      code: "INTERNAL",
      message: "unexpected server error",
      details: {},
      request_id: req.requestId ?? "",
    },
  });
}
