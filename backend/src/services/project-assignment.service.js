import { db } from '../config/db.js';
import { assertCorrectionMember } from './daily-corrections.service.js';
import { notify } from './notification.service.js';
import { ApiError } from '../utils/errors.js';

export function assertProjectAssignee(principal, projectId, userId) {
  assertCorrectionMember(principal, userId);
  if (userId === null || projectId === null) return;
  const member = db().prepare(`SELECT pm.id FROM project_member pm JOIN project p ON p.id = pm.project_id
    WHERE pm.tenant_id = ? AND p.org_id = ? AND pm.project_id = ? AND pm.user_id = ?
      AND pm.deleted_at IS NULL AND p.deleted_at IS NULL`).get(principal.tenantId, principal.orgId, projectId, userId);
  if (!member) throw new ApiError('PERMISSION_DENIED', '프로젝트 구성원으로 추가한 뒤 담당자로 배정하세요');
}
export async function assertPgProjectAssignee(client, assignment) {
  if (assignment.userId === null) return;
  const { rows } = await client.query(`SELECT m.user_id FROM org.company_memberships m
    JOIN auth.users u ON u.id = m.user_id JOIN project.projects p ON p.company_id = m.company_id
    LEFT JOIN project.project_members pm ON pm.project_id = p.id AND pm.user_id = m.user_id
    WHERE m.company_id = $1 AND p.id = $2 AND m.user_id = $3 AND m.status = 'active'
      AND u.account_status = 'active' AND u.approval_status = 'approved'
      AND (pm.user_id IS NOT NULL OR p.lead_id = m.user_id) FOR SHARE OF m, u, p`,
  [assignment.companyId, assignment.projectId, assignment.userId]);
  if (!rows.length) throw new ApiError('PERMISSION_DENIED', '현재 회사의 활성 프로젝트 구성원만 담당자로 지정할 수 있습니다');
}
export function notifyTaskAssignment(principal, task) {
  if (!task.assignee_id) return;
  notify({ tenantId: principal.tenantId, recipientId: task.assignee_id, type: 'task.assigned',
    title: `담당 업무 배정: ${task.title}`, body: '프로젝트에서 담당 업무가 배정되었습니다.', relatedType: 'task', relatedId: task.id,
    dedupeKey: `task-assigned:${task.id}:${task.version}` });
}
export async function notifyPgTaskAssignment(client, identity, task) {
  if (!task.assignee_id) return;
  await client.query(`INSERT INTO notice.notifications(company_id,user_id,kind,title,body,link)
    VALUES ($1,$2,'task.assigned',$3,$4,$5)`, [identity.companyId, task.assignee_id, `담당 업무 배정: ${task.title}`,
    '프로젝트에서 담당 업무가 배정되었습니다.', `/tasks/${task.id}`]);
}
