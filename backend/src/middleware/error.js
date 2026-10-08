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
  const expenseImport = /^\/api\/v1\/(?:pg\/)?finance\/transactions\/imports(?:\/|$)/i.test(req.path);
  if (expenseImport) {
    res.set('Cache-Control', 'private, no-store');
    if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large') {
      res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: { code: 'VALIDATION_ERROR', message: '가져오기 요청 형식 또는 크기를 확인하세요.', details: {}, request_id: req.requestId ?? '' } });
      return;
    }
  }
  // JSON 파서 오류는 원본 body를 포함하므로 비밀 입력 경로에서는 기록하지 않는다.
  const agentInput = /^\/api\/v1\/(?:pg\/)?agent\/(?:api-key|chat|operations|attachments|knowledge|tools)(?:\/|$)/i.test(req.path);
  if (agentInput && (error?.type === "entity.parse.failed" || error?.type === "entity.too.large")) {
    res.set("Cache-Control", "no-store").status(error.type === "entity.too.large" ? 413 : 400).json({
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
  // import SQL 오류의 detail에는 불변 snapshot이 들어갈 수 있으므로 코드만 기록한다.
  console.error(`[${req.requestId}] unhandled`, expenseImport || agentInput ? { code: error?.code ?? 'INTERNAL' } : error);
  res.status(500).json({
    error: {
      code: "INTERNAL",
      message: "unexpected server error",
      details: {},
      request_id: req.requestId ?? "",
    },
  });
}
