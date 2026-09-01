import { db } from "../config/db.js";
import { newId, nowIso } from "../models/base.js";
import { sha256 } from "../utils/crypto.js";

function payloadOf(event) {
  return JSON.stringify({
    tenant_id: event.tenant_id,
    seq: event.seq,
    actor_id: event.actor_id ?? null,
    actor_kind: event.actor_kind,
    action: event.action,
    resource_type: event.resource_type,
    resource_id: event.resource_id ?? null,
    before: event.before_json ?? null,
    after: event.after_json ?? null,
    request_id: event.request_id ?? null,
    ai_generated: Boolean(event.ai_generated),
    approval_id: event.approval_id ?? null,
    prev_hash: event.prev_hash,
  });
}

export function computeHash(event) {
  return sha256(payloadOf(event));
}

export function record(entry) {
  const last = db()
    .prepare("SELECT * FROM audit_event WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1")
    .get(entry.tenantId);

  const event = {
    id: newId(),
    tenant_id: entry.tenantId,
    seq: last ? last.seq + 1 : 1,
    actor_id: entry.actorId ?? null,
    actor_kind: entry.actorKind ?? "user",
    action: entry.action,
    resource_type: entry.resourceType,
    resource_id: entry.resourceId ?? null,
    before_json: entry.before === undefined ? null : JSON.stringify(entry.before),
    after_json: entry.after === undefined ? null : JSON.stringify(entry.after),
    request_id: entry.requestId ?? null,
    ip: entry.ip ?? null,
    ai_generated: entry.aiGenerated ? 1 : 0,
    approval_id: entry.approvalId ?? null,
    prev_hash: last ? last.hash : "",
    created_at: nowIso(),
  };
  event.hash = computeHash(event);

  db()
    .prepare(
      `INSERT INTO audit_event
       (id, tenant_id, seq, actor_id, actor_kind, action, resource_type, resource_id,
        before_json, after_json, request_id, ip, ai_generated, approval_id, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id, event.tenant_id, event.seq, event.actor_id, event.actor_kind,
      event.action, event.resource_type, event.resource_id, event.before_json,
      event.after_json, event.request_id, event.ip, event.ai_generated,
      event.approval_id, event.prev_hash, event.hash, event.created_at,
    );
  return event;
}

export function verifyChain(tenantId) {
  const events = db()
    .prepare("SELECT * FROM audit_event WHERE tenant_id = ? ORDER BY seq")
    .all(tenantId);
  let prev = "";
  const broken = [];
  for (const event of events) {
    if (event.prev_hash !== prev || computeHash(event) !== event.hash) {
      broken.push({ seq: event.seq, id: event.id, action: event.action });
    }
    prev = event.hash;
  }
  return { total: events.length, valid: broken.length === 0, broken };
}

export function listEvents(tenantId, limit = 50) {
  return db()
    .prepare("SELECT * FROM audit_event WHERE tenant_id = ? ORDER BY seq DESC LIMIT ?")
    .all(tenantId, limit)
    .map((e) => ({
      id: e.id,
      seq: e.seq,
      actor_id: e.actor_id,
      actor_kind: e.actor_kind,
      action: e.action,
      resource_type: e.resource_type,
      resource_id: e.resource_id,
      before: e.before_json ? JSON.parse(e.before_json) : null,
      after: e.after_json ? JSON.parse(e.after_json) : null,
      request_id: e.request_id,
      ai_generated: Boolean(e.ai_generated),
      approval_id: e.approval_id,
      hash: e.hash,
      created_at: e.created_at,
    }));
}
