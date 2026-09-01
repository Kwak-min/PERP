import { z } from "zod";

import { db } from "../config/db.js";
import { resolvePrincipal } from "../middleware/auth.js";
import { getScoped, insert, listScoped, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { ApiError } from "../utils/errors.js";
import { newToken, signPayload, sha256, tokenFingerprint } from "../utils/crypto.js";
import { env } from "../config/env.js";

const PROVIDERS = [
  { key: "google_calendar", label: "구글 캘린더", scopes: ["calendar.read", "calendar.write"] },
  { key: "outlook_calendar", label: "아웃룩 캘린더", scopes: ["calendar.read", "calendar.write"] },
  { key: "slack", label: "슬랙", scopes: ["chat.write"] },
  { key: "kakao_work", label: "카카오워크", scopes: ["chat.write"] },
  { key: "google_drive", label: "구글 드라이브", scopes: ["files.read", "files.write"] },
  { key: "notion", label: "노션", scopes: ["pages.read"] },
];

const PROVIDER_KEYS = PROVIDERS.map((p) => p.key);

const integrationSchema = z.object({
  provider: z.enum(PROVIDER_KEYS),
  scopes: z.array(z.string()).default([]),
  token: z.string().min(1),
  config: z.record(z.any()).default({}),
});

const webhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
  secret: z.string().min(8).nullable().optional(),
});

const deliverySchema = z.object({
  event: z.string().min(1),
  payload: z.record(z.any()).default({}),
});

const apiKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).default([]),
});

const integrationView = (row) => ({
  id: row.id,
  provider: row.provider,
  label: PROVIDERS.find((p) => p.key === row.provider)?.label ?? row.provider,
  scopes: row.scopes ? row.scopes.split(",").filter(Boolean) : [],
  owner_id: row.owner_id,
  health: row.health,
  config: row.config ? JSON.parse(row.config) : {},
  connected_at: row.created_at,
});

const endpointView = (row) => ({
  id: row.id,
  url: row.url,
  events: row.events ? row.events.split(",").filter(Boolean) : [],
  active: Boolean(row.active),
  created_at: row.created_at,
});

const deliveryView = (row) => ({
  id: row.id,
  endpoint_id: row.endpoint_id,
  event: row.event,
  payload: row.payload ? JSON.parse(row.payload) : {},
  signature: row.signature,
  status: row.status,
  attempts: row.attempts,
  created_at: row.created_at,
});

export function listProviders(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const connected = listScoped("integration", principal, [], { limit: 200 });
  res.json({
    items: PROVIDERS.map((provider) => ({
      ...provider,
      connected: connected.some((c) => c.provider === provider.key),
    })),
  });
}

export function connect(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const payload = integrationSchema.parse(req.body);

  const existing = listScoped(
    "integration",
    principal,
    [{ sql: "provider = ?", params: [payload.provider] }],
    { limit: 1 },
  )[0];
  if (existing) {
    throw new ApiError("CONFLICT", "이미 연결된 제공자입니다", { integration_id: existing.id });
  }

  const row = insert("integration", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    provider: payload.provider,
    scopes: payload.scopes.join(","),
    token_ref: sha256(payload.token),
    owner_id: principal.userId,
    health: "healthy",
    config: JSON.stringify(payload.config),
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "integration.connected",
    resourceType: "integration",
    resourceId: row.id,
    actorId: principal.userId,
    after: { provider: row.provider, scopes: payload.scopes },
    requestId: req.requestId,
  });

  res.status(201).json(integrationView(row));
}

export function listIntegrations(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const rows = listScoped("integration", principal, [], { limit: 200 });
  res.json({ items: rows.map(integrationView) });
}

export function checkHealth(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const row = getScoped("integration", principal, req.params.integrationId, "integration");
  const health = row.token_ref ? "healthy" : "needs_reauth";
  const updated = update("integration", row.id, { health }, principal.userId);
  res.json({ ...integrationView(updated), checked_at: new Date().toISOString() });
}

export function disconnect(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const row = getScoped("integration", principal, req.params.integrationId, "integration");
  update("integration", row.id, { deleted_at: new Date().toISOString(), health: "disconnected" }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "integration.disconnected",
    resourceType: "integration",
    resourceId: row.id,
    actorId: principal.userId,
    before: { provider: row.provider },
    requestId: req.requestId,
  });

  res.json({ id: row.id, status: "disconnected" });
}

export function createEndpoint(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const payload = webhookSchema.parse(req.body);
  const secret = payload.secret ?? newToken();

  const row = insert("webhook_endpoint", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    url: payload.url,
    events: payload.events.join(","),
    secret_ref: sha256(secret),
    active: 1,
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "webhook.registered",
    resourceType: "webhook_endpoint",
    resourceId: row.id,
    actorId: principal.userId,
    after: { url: row.url, events: payload.events },
    requestId: req.requestId,
  });

  res.status(201).json({ ...endpointView(row), secret });
}

export function listEndpoints(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const rows = listScoped("webhook_endpoint", principal, [], { limit: 200 });
  res.json({ items: rows.map(endpointView) });
}

export function deleteEndpoint(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const row = getScoped("webhook_endpoint", principal, req.params.endpointId, "webhook_endpoint");
  update("webhook_endpoint", row.id, { deleted_at: new Date().toISOString(), active: 0 }, principal.userId);
  res.json({ id: row.id, status: "deleted" });
}

export function dispatch(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const endpoint = getScoped("webhook_endpoint", principal, req.params.endpointId, "webhook_endpoint");
  const payload = deliverySchema.parse(req.body);

  const events = endpoint.events.split(",").filter(Boolean);
  if (events.length > 0 && !events.includes(payload.event)) {
    throw new ApiError("VALIDATION_ERROR", "엔드포인트가 구독하지 않는 이벤트입니다", {
      event: payload.event,
      subscribed: events,
    });
  }

  const body = JSON.stringify({ event: payload.event, data: payload.payload });
  const row = insert("webhook_delivery", {
    tenant_id: principal.tenantId,
    endpoint_id: endpoint.id,
    event: payload.event,
    payload: body,
    signature: signPayload(env.webhookSecret, body),
    status: endpoint.active ? "delivered" : "skipped",
    attempts: 1,
    created_by: principal.userId,
  });

  res.status(201).json(deliveryView(row));
}

export function listDeliveries(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const filters = req.query.endpoint_id
    ? [{ sql: "endpoint_id = ?", params: [req.query.endpoint_id] }]
    : [];
  const rows = listScoped("webhook_delivery", principal, filters, {
    limit: Number(req.query.limit ?? 100),
  });
  res.json({ items: rows.map(deliveryView) });
}

export function retryDelivery(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const row = getScoped("webhook_delivery", principal, req.params.deliveryId, "webhook_delivery");
  const updated = update(
    "webhook_delivery",
    row.id,
    { status: "delivered", attempts: row.attempts + 1 },
    principal.userId,
  );
  res.json(deliveryView(updated));
}

export function createApiKey(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const payload = apiKeySchema.parse(req.body);
  const token = newToken();

  const row = insert("api_key", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    name: payload.name,
    fingerprint: tokenFingerprint(token),
    scopes: payload.scopes.join(","),
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "api_key.created",
    resourceType: "api_key",
    resourceId: row.id,
    actorId: principal.userId,
    after: { name: row.name, scopes: payload.scopes },
    requestId: req.requestId,
  });

  res.status(201).json({
    id: row.id,
    name: row.name,
    scopes: payload.scopes,
    token,
    token_shown_once: true,
  });
}

export function listApiKeys(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const rows = listScoped("api_key", principal, [], { limit: 200 });
  res.json({
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      scopes: row.scopes ? row.scopes.split(",").filter(Boolean) : [],
      revoked_at: row.revoked_at,
      created_at: row.created_at,
    })),
  });
}

export function revokeApiKey(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const row = getScoped("api_key", principal, req.params.keyId, "api_key");
  if (row.revoked_at) throw new ApiError("CONFLICT", "이미 폐기된 키입니다");
  const updated = update("api_key", row.id, { revoked_at: new Date().toISOString() }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "api_key.revoked",
    resourceType: "api_key",
    resourceId: row.id,
    actorId: principal.userId,
    requestId: req.requestId,
  });

  res.json({ id: updated.id, revoked_at: updated.revoked_at });
}

export function listRetention(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("retention.manage");
  const rows = listScoped("retention_policy", principal, [], { limit: 100 });
  res.json({
    items: rows.map((row) => ({
      id: row.id,
      module: row.module,
      retain_days: row.retain_days,
      legal_hold: Boolean(row.legal_hold),
    })),
  });
}

export function putRetention(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("retention.manage");
  const payload = z
    .object({
      module: z.string().min(1),
      retain_days: z.number().int().min(1).max(36500),
      legal_hold: z.boolean().default(false),
    })
    .parse(req.body);

  const existing = listScoped(
    "retention_policy",
    principal,
    [{ sql: "module = ?", params: [payload.module] }],
    { limit: 1 },
  )[0];

  const row = existing
    ? update(
        "retention_policy",
        existing.id,
        { retain_days: payload.retain_days, legal_hold: payload.legal_hold },
        principal.userId,
      )
    : insert("retention_policy", {
        tenant_id: principal.tenantId,
        org_id: principal.orgId,
        module: payload.module,
        retain_days: payload.retain_days,
        legal_hold: payload.legal_hold,
        created_by: principal.userId,
      });

  res.json({
    id: row.id,
    module: row.module,
    retain_days: row.retain_days,
    legal_hold: Boolean(row.legal_hold),
  });
}

export function auditTrail(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("audit.read");
  const limit = Number(req.query.limit ?? 50);
  res.json({ items: audit.listEvents(principal.tenantId, limit) });
}

export function verifyAudit(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("audit.read");
  res.json(audit.verifyChain(principal.tenantId));
}

export function stats(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("integration.manage");
  const row = db()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM integration WHERE tenant_id = ? AND deleted_at IS NULL) AS integrations,
         (SELECT COUNT(*) FROM webhook_endpoint WHERE tenant_id = ? AND deleted_at IS NULL) AS endpoints,
         (SELECT COUNT(*) FROM webhook_delivery WHERE tenant_id = ? AND deleted_at IS NULL) AS deliveries,
         (SELECT COUNT(*) FROM api_key WHERE tenant_id = ? AND revoked_at IS NULL AND deleted_at IS NULL) AS active_keys`,
    )
    .get(principal.tenantId, principal.tenantId, principal.tenantId, principal.tenantId);
  res.json(row);
}
