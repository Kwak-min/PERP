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
