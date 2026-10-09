import { db } from "../config/db.js";
import { insert } from "../models/base.js";

export function notify(_entry) {
  // perp_db 전용 전환: 알림은 SQLite에 쓰지 않는다(런타임 SQLite 제거).
  // 컨트롤러는 fire-and-forget으로 사용하므로 no-op 안전.
  // TODO: perp_db 알림 테이블로 이관.
  return null;
}

function _notifyLegacyDisabled(entry) {
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
