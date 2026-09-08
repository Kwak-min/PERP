import { z } from 'zod';
import { pgQuery, pgTransaction } from '../config/pg.js';
import { pgIdentity } from '../middleware/pgAccess.js';
import { ApiError } from '../utils/errors.js';

export const orgIdSchema = z.string().regex(/^[1-9]\d*$/).max(19).refine(value => value.length < 19 || value <= '9223372036854775807');

export async function withOrgAuditSchema(work) {
  try { return await work(); }
  catch (error) {
    if (['42P01', '42703'].includes(error.code)) throw new ApiError('SERVICE_UNAVAILABLE', '조직 감사 스키마가 없습니다. perp_additions_v10_org_audit.sql 적용 상태를 확인하세요.');
    throw error;
  }
}

// 회사 잠금부터 배정/감사 저장까지 같은 연결에서 실행한다.
export async function orgMutation(req, expectedRevision, work) {
  const identity = pgIdentity(req);
  if (!identity.companyId) throw new ApiError('PERMISSION_DENIED', '권한이 없습니다');
  return withOrgAuditSchema(() => pgTransaction(async client => {
    const company = (await client.query('SELECT id, org_revision FROM org.companies WHERE id = $1 AND is_active = true FOR UPDATE', [identity.companyId])).rows[0];
    if (!company) throw new ApiError('NOT_FOUND', '회사를 찾을 수 없습니다');
    if (expectedRevision !== undefined && String(company.org_revision) !== expectedRevision) {
      throw new ApiError('VERSION_CONFLICT', '다른 사용자가 조직을 변경했습니다. 입력을 보관했습니다. 새로 고침 후 변경 내용을 다시 확인하세요.', { current_revision: String(company.org_revision) });
    }
    const result = await work(client, identity);
    const current = (await client.query('SELECT org_revision FROM org.companies WHERE id = $1', [identity.companyId])).rows[0];
    return { ...result, revision: String(current.org_revision) };
  }));
}

export async function recordOrgChange(client, req, { action, resourceType, resourceId, target, before, after }) {
  const { companyId, userId } = pgIdentity(req);
  await client.query(`INSERT INTO org.organization_change_events
    (company_id, actor_id, actor_name, action, resource_type, resource_id, target, before_data, after_data, request_id)
    VALUES ($1, $2, (SELECT name FROM auth.users WHERE id = $2), $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
  [companyId, userId, action, resourceType, resourceId, target, before === null ? null : JSON.stringify(before), JSON.stringify(after), req.requestId ?? null]);
}

const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(200),
  member_id: orgIdSchema.optional(),
});
const labels = { 'department.created': '부서 생성', 'department.updated': '부서 설정 변경', 'member.assignment.updated': '구성원 배정 변경' };
export async function readOrgActivity(req, res) {
  const { companyId } = pgIdentity(req);
  const { limit, member_id: memberId } = activityQuery.parse(req.query);
  const { rows } = await withOrgAuditSchema(() => pgQuery(`SELECT id, actor_id, actor_name, action, resource_type, resource_id,
    target, before_data, after_data, created_at, request_id FROM org.organization_change_events
    WHERE company_id = $1 AND ($2::text IS NULL OR (resource_type = 'member' AND resource_id = $2))
    ORDER BY id DESC LIMIT $3`, [companyId, memberId ?? null, limit]));
  res.json({ items: rows.map(row => ({ id: String(row.id), action: row.action, action_label: labels[row.action],
    resource_type: row.resource_type, resource_id: row.resource_id, target: row.target,
    actor_id: String(row.actor_id), actor_name: row.actor_name, actor_kind: 'user',
    before: row.before_data, after: row.after_data, created_at: row.created_at, request_id: row.request_id })) });
}
