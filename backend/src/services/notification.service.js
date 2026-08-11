import { db } from "../config/db.js";
import { insert } from "../models/base.js";

export function notify(entry) {
  if (entry.dedupeKey) {
    const existing = db()
      .prepare(
        `SELECT id FROM notification
         WHERE tenant_id = ? AND recipient_id = ? AND dedupe_key = ?`,
      )
      .get(entry.tenantId, entry.recipientId, entry.dedupeKey);
    if (existing) return null;
  }

  return insert("notification", {
    tenant_id: entry.tenantId,
    recipient_id: entry.recipientId,
    type: entry.type,
    channel: entry.channel ?? "web",
    title: entry.title,
    body: entry.body ?? "",
    related_type: entry.relatedType ?? null,
    related_id: entry.relatedId ?? null,
    dedupe_key: entry.dedupeKey ?? null,
  });
}
