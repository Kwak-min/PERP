import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { transaction } from "../config/db.js";
import { env } from "../config/env.js";
import { bumpVersion, insert, listScoped, nowIso } from "../models/base.js";
import { ApiError } from "../utils/errors.js";
import * as audit from "./audit.service.js";
import * as providers from "./ai-provider.service.js";

function masterKey() {
  const encoded = env.aiKeyEncryptionKey;
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new ApiError("SERVICE_UNAVAILABLE", "개인 API 키 암호화 설정이 없습니다. 관리자에게 ORBITFLOW_AI_KEY_ENCRYPTION_KEY 설정을 요청하세요.");
  }
  return key;
}

function ownerKey(principal) {
  return listScoped("ai_user_key", principal, [
    { sql: "user_id = ? AND provider = ?", params: [principal.userId, "openrouter"] },
  ], { limit: 1 })[0];
}

function binding(principal) {
  return Buffer.from(JSON.stringify(["ai-key-v1", principal.tenantId, principal.orgId, principal.userId, "openrouter"]));
}

function decrypt(principal, row) {
  const key = masterKey();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.nonce, "base64"));
    decipher.setAAD(binding(principal));
    decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new ApiError("SERVICE_UNAVAILABLE", "저장된 API 키를 복호화할 수 없습니다. 암호화 설정을 확인하거나 키를 다시 저장하세요.");
  }
}

export function keyMetadata(principal) {
  return { provider: "openrouter", configured: Boolean(ownerKey(principal)), model: env.externalModel };
}

function record(principal, configured, requestId) {
  audit.record({
    tenantId: principal.tenantId,
    actorId: principal.userId,
    action: configured ? "agent.api_key.saved" : "agent.api_key.deleted",
    resourceType: "ai_user_key",
    after: { provider: "openrouter", configured },
    requestId,
  });
}

export const saveKey = transaction((principal, apiKey, requestId) => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), nonce);
  cipher.setAAD(binding(principal));
  const encrypted = {
    ciphertext: Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]).toString("base64"),
    nonce: nonce.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64"),
  };
  const existing = ownerKey(principal);
  if (existing) bumpVersion("ai_user_key", existing, encrypted, principal.userId);
  else insert("ai_user_key", {
    tenant_id: principal.tenantId, org_id: principal.orgId, user_id: principal.userId,
    provider: "openrouter", ...encrypted, created_by: principal.userId,
  });
  record(principal, true, requestId);
  return { provider: "openrouter", configured: true, model: env.externalModel };
});

export const deleteKey = transaction((principal, requestId) => {
  const existing = ownerKey(principal);
  if (existing) {
    bumpVersion("ai_user_key", existing, {
      ciphertext: "", nonce: "", auth_tag: "", deleted_at: nowIso(),
    }, principal.userId);
    record(principal, false, requestId);
  }
  return { provider: "openrouter", configured: false, model: env.externalModel };
});

export async function testKey(principal) {
  const row = ownerKey(principal);
  if (!row) throw new ApiError("CONFLICT", "먼저 개인 OpenRouter API 키를 저장하세요.");
  const provider = providers.openRouterForKey(decrypt(principal, row));
  // 연결 확인은 조직 문서·기억·Vault를 조회하지 않는 고정 합성 요청이다.
  const result = await provider.complete(env.externalModel, "Reply briefly.", "Reply OK.", { maxTokens: 8, timeoutMs: 8000 });
  if (result.error) throw new ApiError("SERVICE_UNAVAILABLE", "OpenRouter 연결에 실패했습니다. 키 권한, 잔액, 모델 설정과 네트워크를 확인하세요.");
  return { provider: "openrouter", connected: true, model: env.externalModel };
}

export async function completeForUser(principal, { dataClass, system, user, prefer = null }) {
  const profile = listScoped("agent_profile", principal, [
    { sql: "user_id = ?", params: [principal.userId] },
  ], { limit: 1 })[0];
  const policy = prefer === "local" || profile?.model_policy === "local" ? "local" : prefer ?? profile?.model_policy ?? null;
  // 등급/로컬 정책을 먼저 적용하여 민감 요청은 개인 키를 읽지도 않는다.
  if (policy === "local" || !providers.externalAllowed(dataClass)) {
    return providers.complete(dataClass, system, user, "local");
  }
  const row = ownerKey(principal);
  if (!row) return providers.complete(dataClass, system, user, policy);
  return providers.complete(dataClass, system, user, "external", providers.openRouterForKey(decrypt(principal, row)));
}
