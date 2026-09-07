import { z } from "zod";

import { resolvePrincipal } from "../middleware/auth.js";
import * as keys from "../services/ai-key.service.js";
import { ApiError } from "../utils/errors.js";

const keySchema = z.object({
  api_key: z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/),
}).strict();

function scopeFor(req, res) {
  res.set("Cache-Control", "no-store");
  if (req.aiKeyScope) return req.aiKeyScope;
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  return principal;
}

export function getKey(req, res) {
  res.json(keys.keyMetadata(scopeFor(req, res)));
}

export function putKey(req, res) {
  const principal = scopeFor(req, res);
  const parsed = keySchema.safeParse(req.body);
  // 검증 오류에도 원본 비밀값이나 Zod 입력 상세를 포함하지 않는다.
  if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "OpenRouter API 키 형식을 확인하세요.");
  res.json(keys.saveKey(principal, parsed.data.api_key, req.requestId));
}

export function deleteKey(req, res) {
  res.json(keys.deleteKey(scopeFor(req, res), req.requestId));
}

export async function testKey(req, res) {
  res.json(await keys.testKey(scopeFor(req, res)));
}
