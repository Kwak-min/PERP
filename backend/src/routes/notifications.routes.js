import { Router } from 'express';
import { db } from '../config/db.js';
import { resolvePrincipal } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/error.js';

export const notificationsRouter = Router();
// 기존 알림 저장소에는 org_id가 없으므로 업무의 조직을 조인해 배정 알림을 분리한다.
notificationsRouter.get('', asyncRoute((req, res) => {
  const principal = resolvePrincipal(req); principal.require('notification.read');
  const rows = db().prepare(`SELECT n.id,n.title,n.body,n.type,n.read_at,n.created_at,n.related_id,n.related_type
    FROM notification n JOIN task t ON t.id = n.related_id AND t.tenant_id = n.tenant_id
    WHERE n.tenant_id = ? AND t.org_id = ? AND n.recipient_id = ? AND n.type = 'task.assigned'
      AND n.related_type = 'task' AND n.deleted_at IS NULL ORDER BY n.created_at DESC,n.id DESC LIMIT 200`)
    .all(principal.tenantId, principal.orgId, principal.userId);
  res.json({ items: rows.map(row => ({ title: row.title, body: row.body, type: row.type,
    created_at: row.created_at, status: row.read_at ? 'done' : 'pending', id: row.id,
    related_id: row.related_id, related_type: row.related_type, link: `/tasks/${row.related_id}` })) });
}));
