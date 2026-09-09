import { z } from 'zod';
import { db, transaction } from '../config/db.js';
import { pgQuery, pgTransaction } from '../config/pg.js';
import { resolvePrincipal } from '../middleware/auth.js';
import { pgIdentity } from '../middleware/pgAccess.js';
import { getScoped, insert } from '../models/base.js';
import { assertCorrectionMember, correctionDate } from '../services/daily-corrections.service.js';
import { assertPgProjectAssignee, notifyPgTaskAssignment } from '../services/project-assignment.service.js';
import { replayPgMutation } from '../services/pg-finance.service.js';
import * as audit from '../services/audit.service.js';
import { ApiError } from '../utils/errors.js';
const pgId = z.string().regex(/^[1-9]\d*$/);

// 후보 조회는 개인정보 디렉터리가 아니라 해당 프로젝트/업무의 쓰기 권한을 따른다.
function legacyCandidates(principal, projectId, membersOnly = false) {
  return db().prepare(`SELECT DISTINCT u.id, u.name, d.name AS department_name,
      EXISTS (SELECT 1 FROM project_member pm WHERE pm.tenant_id = m.tenant_id
        AND pm.project_id = ? AND pm.user_id = u.id AND pm.deleted_at IS NULL) AS already_member
    FROM membership m JOIN app_user u ON u.id = m.user_id
    LEFT JOIN department d ON d.id = m.department_id AND d.tenant_id = m.tenant_id
      AND d.org_id = m.org_id AND d.deleted_at IS NULL
    WHERE m.tenant_id = ? AND m.org_id = ? AND m.status = 'active'
      AND m.deleted_at IS NULL AND u.auth_status = 'active'
      AND (? = 0 OR already_member = 1) ORDER BY u.name, u.id`)
    .all(projectId, principal.tenantId, principal.orgId, Number(membersOnly))
    .map(row => ({ ...row, already_member: Boolean(row.already_member) }));
}
export function listLegacyProjectCandidates(req, res) {
  const principal = resolvePrincipal(req); principal.require('project.write');
  const project = getScoped('project', principal, z.string().uuid().parse(req.params.projectId), 'project');
  res.json({ items: legacyCandidates(principal, project.id) });
}
export function listLegacyCreateTaskAssignees(req, res) {
  const principal = resolvePrincipal(req); principal.require('task.write');
  const project = getScoped('project', principal, z.string().uuid().parse(req.params.projectId), 'project');
  res.json({ items: legacyCandidates(principal, project.id) });
}
export function listLegacyTaskAssignees(req, res) {
  const principal = resolvePrincipal(req); principal.require('task.write');
  const task = getScoped('task', principal, z.string().uuid().parse(req.params.taskId), 'task');
  if (!task.project_id) return res.json({ items: [] });
  const project = getScoped('project', principal, task.project_id, 'project');
  res.json({ items: legacyCandidates(principal, project.id, true) });
}
async function pgCandidates(companyId, projectId, membersOnly = false) {
  const { rows } = await pgQuery(`SELECT u.id, u.name, d.name AS department_name,
      (pm.user_id IS NOT NULL OR p.lead_id = u.id) IS TRUE AS already_member
    FROM project.projects p JOIN org.company_memberships m ON m.company_id = p.company_id
    JOIN auth.users u ON u.id = m.user_id
    LEFT JOIN org.departments d ON d.id = m.department_id AND d.company_id = m.company_id
    LEFT JOIN project.project_members pm ON pm.project_id = p.id AND pm.user_id = u.id
    WHERE p.id = $1 AND p.company_id = $2 AND m.status = 'active'
      AND u.account_status = 'active' AND u.approval_status = 'approved'
      AND (NOT $3::boolean OR pm.user_id IS NOT NULL OR p.lead_id = u.id)
    ORDER BY u.name, u.id`, [projectId, companyId, membersOnly]);
  return rows.map(row => ({ ...row, id: String(row.id) }));
}
export async function listPgProjectCandidates(req, res) {
  const { companyId } = pgIdentity(req), id = pgId.parse(req.params.id);
  const project = (await pgQuery('SELECT id FROM project.projects WHERE id = $1 AND company_id = $2', [id, companyId])).rows[0];
  if (!project) throw new ApiError('NOT_FOUND', '프로젝트를 찾을 수 없습니다');
  res.json({ items: await pgCandidates(companyId, id) });
}
export async function listPgTaskAssignees(req, res) {
  const { companyId } = pgIdentity(req), id = pgId.parse(req.params.id);
  const task = (await pgQuery(`SELECT t.project_id FROM project.tasks t JOIN project.projects p ON p.id = t.project_id
    WHERE t.id = $1 AND p.company_id = $2`, [id, companyId])).rows[0];
  if (!task) throw new ApiError('NOT_FOUND', '업무를 찾을 수 없습니다');
  res.json({ items: await pgCandidates(companyId, task.project_id, true) });
}

export function listLegacyProjectMembers(req, res) {
  const principal = resolvePrincipal(req); principal.require('project.read');
  const project = getScoped('project', principal, req.params.projectId, 'project');
  const rows = db().prepare(`SELECT DISTINCT u.id AS value, u.name AS label FROM project_member pm
    JOIN membership m ON m.user_id = pm.user_id AND m.tenant_id = pm.tenant_id JOIN app_user u ON u.id = m.user_id
    WHERE pm.tenant_id = ? AND pm.project_id = ? AND m.org_id = ? AND m.status = 'active'
      AND pm.deleted_at IS NULL AND m.deleted_at IS NULL AND u.auth_status = 'active' ORDER BY u.name`).all(principal.tenantId, project.id, principal.orgId);
  res.json({ items: rows });
}
export function addLegacyProjectMember(req, res) {
  const principal = resolvePrincipal(req); principal.require('project.write');
  const payload = z.object({ user_id: z.string().min(1), role: z.string().default('member') }).strict().parse(req.body);
  const result = transaction(() => {
    const project = getScoped('project', principal, req.params.projectId, 'project');
    assertCorrectionMember(principal, payload.user_id);
    const existing = db().prepare('SELECT id FROM project_member WHERE tenant_id = ? AND project_id = ? AND user_id = ? AND deleted_at IS NULL').get(principal.tenantId, project.id, payload.user_id);
    if (existing) return { created: false };
    insert('project_member', { tenant_id: principal.tenantId, project_id: project.id, user_id: payload.user_id, role: payload.role, created_by: principal.userId });
    audit.record({ tenantId: principal.tenantId, action: 'project.member.added', resourceType: 'project', resourceId: project.id,
      actorId: principal.userId, before: { user_id: payload.user_id, member: false }, after: { user_id: payload.user_id, member: true }, requestId: req.requestId });
    return { created: true };
  })();
  res.status(result.created ? 201 : 200).json({ project_id: req.params.projectId, user_id: payload.user_id, ...result });
}
export async function listPgProjectMembers(req, res) {
  const { companyId } = pgIdentity(req), id = pgId.parse(req.params.id);
  const project = (await pgQuery('SELECT id FROM project.projects WHERE id = $1 AND company_id = $2', [id, companyId])).rows[0];
  if (!project) throw new ApiError('NOT_FOUND', '프로젝트를 찾을 수 없습니다');
  const { rows } = await pgQuery(`SELECT DISTINCT u.id, u.name FROM project.projects p
    JOIN org.company_memberships m ON m.company_id = p.company_id JOIN auth.users u ON u.id = m.user_id
    LEFT JOIN project.project_members pm ON pm.project_id = p.id AND pm.user_id = u.id
    WHERE p.id = $1 AND p.company_id = $2 AND m.status = 'active' AND u.account_status = 'active' AND u.approval_status = 'approved'
      AND (pm.user_id IS NOT NULL OR p.lead_id = u.id) ORDER BY u.name`, [id, companyId]);
  res.json({ items: rows.map(row => ({ value: String(row.id), label: row.name })) });
}
export async function addPgProjectMember(req, res) {
  const { companyId, userId } = pgIdentity(req), id = pgId.parse(req.params.id);
  const payload = z.object({ user_id: pgId }).strict().parse(req.body);
  const created = await pgTransaction(async client => {
    const project = (await client.query('SELECT id, lead_id FROM project.projects WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, companyId])).rows[0];
    if (!project) throw new ApiError('NOT_FOUND', '프로젝트를 찾을 수 없습니다');
    const member = await client.query(`SELECT m.user_id FROM org.company_memberships m JOIN auth.users u ON u.id = m.user_id
      WHERE m.company_id = $1 AND m.user_id = $2 AND m.status = 'active' AND u.account_status = 'active' AND u.approval_status = 'approved' FOR SHARE OF m,u`, [companyId,payload.user_id]);
    if (!member.rows.length) throw new ApiError('PERMISSION_DENIED', '현재 회사의 활성 구성원만 추가할 수 있습니다');
    if (String(project.lead_id) === payload.user_id) return false;
    const inserted = await client.query('INSERT INTO project.project_members(project_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING user_id', [id,payload.user_id]);
    if (!inserted.rows.length) return false;
    await client.query(`INSERT INTO org.daily_correction_events(company_id,actor_id,resource_type,resource_id,action,before_data,after_data)
      VALUES ($1,$2,'projects',$3,'member.added',$4::jsonb,$5::jsonb)`, [companyId,userId,id,JSON.stringify({ user_id: payload.user_id, member: false }),JSON.stringify({ user_id: payload.user_id, member: true })]);
    return true;
  });
  res.status(created ? 201 : 200).json({ project_id: id, user_id: payload.user_id, created });
}
export async function createPgProjectTask(req, res) {
  const identity = pgIdentity(req);
  const payload = z.object({ project_id: pgId, title: z.string().trim().min(1).max(300), assignee_id: pgId.nullable().default(null), due_on: correctionDate.default(null) }).strict().parse(req.body);
  const task = await pgTransaction(async client => {
    const project = (await client.query('SELECT id FROM project.projects WHERE id = $1 AND company_id = $2 FOR SHARE', [payload.project_id, identity.companyId])).rows[0];
    if (!project) throw new ApiError('NOT_FOUND', '프로젝트를 찾을 수 없습니다');
    await assertPgProjectAssignee(client, { companyId: identity.companyId, projectId: payload.project_id, userId: payload.assignee_id });
    const create = async () => {
      const row = (await client.query("INSERT INTO project.tasks(project_id,assignee_id,title,due_on,status) VALUES ($1,$2,$3,$4,'todo') RETURNING id,assignee_id,title,version", [payload.project_id,payload.assignee_id,payload.title,payload.due_on])).rows[0];
      await notifyPgTaskAssignment(client, identity, row);
      return row;
    };
    return req.get('Idempotency-Key') === undefined ? create()
      : replayPgMutation(client, req, { operation: 'task.create', payload }, create);
  });
  res.status(201).json({ id: String(task.id), version: task.version });
}
