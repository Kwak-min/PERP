import { db } from '../config/db.js';

// Call only after the parent approval read/write authorization. These are current
// account labels, never an approval snapshot or a general member directory.
export function personDisplay(people, id) {
  return { name: people.get(String(id)) ?? null };
}

export function legacyApprovalPeople(principal, userIds) {
  const ids = [...new Set(userIds.filter(id => id != null))];
  if (!ids.length) return new Map();
  const rows = db().prepare(`SELECT u.id,u.name FROM membership m JOIN app_user u ON u.id=m.user_id
    WHERE m.tenant_id=? AND m.org_id=? AND m.status='active' AND m.deleted_at IS NULL
      AND u.auth_status='active' AND u.id IN (${ids.map(() => '?').join(',')})`)
    .all(principal.tenantId, principal.orgId, ...ids);
  return new Map(rows.map(row => [String(row.id), row.name.trim() || null]));
}

export async function pgApprovalPeople(query, companyId, userIds) {
  const ids = [...new Set(userIds.filter(id => id != null).map(String))];
  if (!ids.length) return new Map();
  const { rows } = await query(`SELECT u.id::text,u.name FROM org.company_memberships m JOIN auth.users u ON u.id=m.user_id
    WHERE m.company_id=$1 AND m.status='active' AND u.account_status='active' AND u.approval_status='approved'
      AND u.id=ANY($2::bigint[])`, [companyId, ids]);
  return new Map(rows.map(row => [row.id, row.name.trim() || null]));
}
