import { db } from '../config/db.js';
import { createPgDocument, listPgDocuments, canReadPgDocumentRestrictions } from './pg-documents.service.js';
import { pgQuery } from '../config/pg.js';
import { insert, getScoped, bumpVersion, listScoped } from '../models/base.js';
import { ApiError, notFound } from '../utils/errors.js';
import { assertProjectAssignee, assertPgProjectAssignee, notifyTaskAssignment, notifyPgTaskAssignment } from './project-assignment.service.js';
import { assertCorrectionMember, assertCorrectionVersion } from './daily-corrections.service.js';
import { legacyMoneyLinks } from './project-money-links.service.js';
import { assertLegacyPeriodOpen, txView } from './legacy-expenses.service.js';
import * as audit from './audit.service.js';
import { documentSemantic, documentSemanticScope, pgDocumentSemanticScope, DOCUMENT_CANDIDATE_LIMIT } from './document-semantic.service.js';
import { canReadDocument } from './rag.service.js';

export function guardTaskCompletion(principal, task) {
  const pending = db().prepare(`SELECT 1 FROM task_checklist_item WHERE tenant_id=? AND task_id=?
    AND required=1 AND done=0 AND deleted_at IS NULL LIMIT 1`).get(principal.tenantId, task.id);
  if (pending) throw new ApiError('CONFLICT', '필수 체크리스트가 완료되지 않았습니다.');
  const blocked = db().prepare(`SELECT 1 FROM task_dependency d JOIN task t ON t.id=d.depends_on_id AND t.tenant_id=d.tenant_id
    WHERE d.tenant_id=? AND d.task_id=? AND d.deleted_at IS NULL AND t.status<>'done' LIMIT 1`).get(principal.tenantId, task.id);
  if (blocked) throw new ApiError('CONFLICT', '선행 업무가 완료되지 않았습니다.');
}

export function reindexDocument(principal, document) {
  db().prepare('DELETE FROM document_chunk WHERE tenant_id=? AND document_id=?').run(principal.tenantId, document.id);
  const chunks = (document.content ?? '').split('\n\n').map(part => part.trim()).filter(Boolean);
  const parts = chunks.length ? chunks : [document.title];
  parts.forEach((content, ordinal) => insert('document_chunk', {
    tenant_id: document.tenant_id, org_id: document.org_id, document_id: document.id, ordinal,
    content: content.slice(0, 4000), sensitivity: document.sensitivity, visibility: document.visibility, created_by: principal.userId,
  }));
  return parts.length;
}

export function validateLegacyAgentReferences(p, tool, input) {
  if (p.knowledgeMode === 'company' && (input.visibility === 'private' || input.sensitivity === 'personal' || input.calendar === 'personal')) {
    throw new ApiError('PERMISSION_DENIED', '회사 모드에서 개인 자료를 만들 수 없습니다.');
  }
  if (input.project_id) getScoped('project', p, input.project_id);
  if (input.space_id) {
    const space = getScoped('space', p, input.space_id);
    if (space.visibility === 'private' && (p.knowledgeMode === 'company' || space.created_by !== p.userId)) throw notFound('space');
  }
  if (tool === 'create.task') assertProjectAssignee(p, input.project_id ?? null, input.assignee_id === undefined ? p.userId : input.assignee_id);
  if (tool === 'create.event') {
    if (Date.parse(input.end_at) <= Date.parse(input.start_at)) throw new ApiError('VALIDATION_ERROR', '종료는 시작보다 늦어야 합니다.');
    (input.attendee_ids ?? []).forEach(userId => assertCorrectionMember(p, userId));
  }
  if (tool === 'update.task_status' || tool === 'confirm.transaction') {
    const task = tool === 'update.task_status';
    const row = getScoped(task ? 'task' : 'transaction_record', p, task ? input.task_id : input.transaction_id);
    if (p.scope !== 'all' && row.created_by !== p.userId && (!task || row.assignee_id !== p.userId)) throw notFound(task ? 'task' : 'transaction');
    assertCorrectionVersion(row, input.expected_version);
  }
}

export async function validatePgAgentReferences(client, p, tool, input) {
  if (p.knowledgeMode === 'company' && (input.visibility === 'private' || input.sensitivity === 'personal')) throw new ApiError('PERMISSION_DENIED', 'Company mode excludes personal documents.');
  if (input.project_id) {
    const project = (await client.query('SELECT id FROM project.projects WHERE company_id=$1 AND id=$2 FOR SHARE', [p.companyId, input.project_id])).rows[0];
    if (!project) throw notFound('project');
  }
  if (tool === 'create.task') await assertPgProjectAssignee(client, { companyId: p.companyId, projectId: input.project_id,
    userId: input.assignee_id === undefined ? p.userId : input.assignee_id });
  if (tool === 'create.event' && Date.parse(input.ends_at) <= Date.parse(input.starts_at)) throw new ApiError('VALIDATION_ERROR', '종료는 시작보다 늦어야 합니다.');
  if (tool === 'update.task_status') {
    const row = (await client.query(`SELECT t.* FROM project.tasks t JOIN project.projects p ON p.id=t.project_id
      WHERE p.company_id=$1 AND t.id=$2 FOR SHARE OF t`, [p.companyId, input.task_id])).rows[0];
    if (!row) throw notFound('task');
    assertCorrectionVersion(row, input.expected_version);
  }
}

// 호출자가 트랜잭션을 소유한다. 이 함수에는 BEGIN, COMMIT, 외부 I/O가 없다.
export function writeLegacyAgent(p, tool, input, requestId, approvalId = null) {
  validateLegacyAgentReferences(p, tool, input);
  const common = { tenant_id: p.tenantId, org_id: p.orgId, created_by: p.userId };
  let row, before, resource, action;
  if (tool === 'create.task') {
    const assignee = input.assignee_id === undefined ? p.userId : input.assignee_id;
    if (input.project_id) getScoped('project', p, input.project_id);
    assertProjectAssignee(p, input.project_id ?? null, assignee);
    row = insert('task', { ...common, title: input.title, description: input.description ?? '', project_id: input.project_id ?? null,
      assignee_id: assignee, due_at: input.due_at ?? null, ai_generated: 1 });
    notifyTaskAssignment(p, row); resource = 'task'; action = 'task.created';
  } else if (tool === 'update.task_status') {
    before = getScoped('task', p, input.task_id);
    if (p.scope !== 'all' && before.created_by !== p.userId && before.assignee_id !== p.userId) throw notFound('task');
    assertCorrectionVersion(before, input.expected_version);
    if (input.status === 'done') guardTaskCompletion(p, before);
    row = bumpVersion('task', before, { status: input.status }, p.userId);
    resource = 'task'; action = 'task.updated';
  } else if (tool === 'create.event') {
    if (Date.parse(input.end_at) <= Date.parse(input.start_at)) throw new ApiError('VALIDATION_ERROR', '종료는 시작보다 늦어야 합니다.');
    if (input.project_id) getScoped('project', p, input.project_id);
    if (input.calendar === 'project' && !input.project_id) throw new ApiError('VALIDATION_ERROR', '프로젝트 일정에는 프로젝트가 필요합니다.');
    const ids = [...new Set(input.attendee_ids ?? [])];
    ids.forEach(id => assertCorrectionMember(p, id));
    row = insert('event', { ...common, title: input.title, calendar: input.calendar ?? 'org', project_id: input.project_id ?? null,
      start_at: input.start_at, end_at: input.end_at, location: input.location ?? null });
    row.attendees = ids.map(user_id => {
      const attendee = insert('event_attendee', { tenant_id: p.tenantId, event_id: row.id, user_id, created_by: p.userId });
      return { id: attendee.id, user_id, response: attendee.response };
    });
    resource = 'event'; action = 'event.created';
  } else if (tool === 'create.document') {
    if (input.project_id) getScoped('project', p, input.project_id);
    if (input.space_id) getScoped('space', p, input.space_id);
    row = insert('document', { ...common, title: input.title, content: input.content ?? '', project_id: input.project_id ?? null,
      space_id: input.space_id ?? null, owner_id: p.userId, visibility: input.visibility ?? 'org',
      sensitivity: input.sensitivity ?? 'internal', ai_generated: 1 });
    insert('document_version', { tenant_id: p.tenantId, document_id: row.id, revision: 1,
      content: row.content, author_id: p.userId, created_by: p.userId });
    reindexDocument(p, row); resource = 'document'; action = 'document.created';
  } else if (tool === 'confirm.transaction') {
    before = getScoped('transaction_record', p, input.transaction_id);
    if (p.scope !== 'all' && before.created_by !== p.userId) throw notFound('transaction');
    assertCorrectionVersion(before, input.expected_version);
    legacyMoneyLinks(p, before);
    assertLegacyPeriodOpen(p, before.occurred_on);
    if (before.status === 'confirmed') throw new ApiError('CONFLICT', '이미 확정된 거래입니다.');
    row = bumpVersion('transaction_record', before, { status: 'confirmed', approval_id: approvalId }, p.userId);
    resource = 'transaction'; action = 'transaction.confirmed';
  } else throw new ApiError('VALIDATION_ERROR', '구현되지 않은 쓰기입니다.');
  audit.record({ tenantId: p.tenantId, actorId: p.userId, action, resourceType: resource, resourceId: row.id,
    ...(before ? { before } : {}), after: tool === 'create.document' ? { title: row.title } : row, requestId, approvalId, aiGenerated: true });
  return tool === 'confirm.transaction' ? txView(row) : row;
}

export async function writePgAgent(client, p, tool, input) {
  let row, before = {}, resource;
  if (input.project_id) {
    const project = (await client.query('SELECT id FROM project.projects WHERE company_id=$1 AND id=$2 FOR SHARE', [p.companyId, input.project_id])).rows[0];
    if (!project) throw notFound('project');
  }
  if (tool === 'create.task') {
    const assignee = input.assignee_id === undefined ? p.userId : input.assignee_id;
    await assertPgProjectAssignee(client, { companyId: p.companyId, projectId: input.project_id, userId: assignee });
    row = (await client.query(`INSERT INTO project.tasks(project_id,assignee_id,title,description,due_on,status)
      VALUES($1,$2,$3,$4,$5,'todo') RETURNING *,to_char(due_on,'YYYY-MM-DD') AS due_on`,
    [input.project_id, assignee, input.title, input.description ?? '', input.due_on ?? null])).rows[0];
    await notifyPgTaskAssignment(client, p, row); resource = 'tasks';
  } else if (tool === 'update.task_status') {
    before = (await client.query(`SELECT t.* FROM project.tasks t JOIN project.projects p ON p.id=t.project_id
      WHERE p.company_id=$1 AND t.id=$2 FOR UPDATE OF t`, [p.companyId, input.task_id])).rows[0];
    if (!before) throw notFound('task');
    assertCorrectionVersion(before, input.expected_version);
    row = (await client.query(`UPDATE project.tasks SET status=$2,version=version+1 WHERE id=$1 AND version=$3
      RETURNING *,to_char(due_on,'YYYY-MM-DD') AS due_on`, [before.id, input.status, input.expected_version])).rows[0];
    if (!row) throw new ApiError('VERSION_CONFLICT', '업무가 변경되었습니다.');
    resource = 'tasks';
  } else if (tool === 'create.event') {
    if (Date.parse(input.ends_at) <= Date.parse(input.starts_at)) throw new ApiError('VALIDATION_ERROR', '종료는 시작보다 늦어야 합니다.');
    row = (await client.query(`INSERT INTO calendar.events(company_id,owner_id,title,location,starts_at,ends_at,scope)
      VALUES($1,$2,$3,$4,$5,$6,'company') RETURNING *`, [p.companyId, p.userId, input.title, input.location ?? null, input.starts_at, input.ends_at])).rows[0];
    resource = 'calendar';
  } else if (tool === 'create.document') {
    return createPgDocument(client, p, { ...input, ai_generated: true });
  } else throw new ApiError('VALIDATION_ERROR', '구현되지 않은 PG 쓰기입니다.');
  await client.query(`INSERT INTO org.daily_correction_events(company_id,actor_id,resource_type,resource_id,action,before_data,after_data)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`, [p.companyId, p.userId, resource, row.id,
    tool === 'update.task_status' ? 'updated' : 'created', JSON.stringify(before), JSON.stringify(row)]);
  return JSON.parse(JSON.stringify({ ...row, id: String(row.id) }));
}

// 검색 색인/분석은 영수증 커밋 후에만 시작한다. 롤백된 문서는 작업 큐에 들어가지 않는다.
export function afterAgentWrite(source, p, tool, row) {
  if (tool !== 'create.document') return;
  if (source === 'legacy') {
    documentSemantic.schedule(documentSemanticScope(p), row, () => listScoped('document', p, [], { limit: DOCUMENT_CANDIDATE_LIMIT + 1 })
      .filter(document => canReadDocument(p, document)));
  } else {
    // 업무 후보는 PG에서만 읽는다. 공급자 키 연결은 기존 인증 메타데이터 계약을 유지한다.
    if (!canReadPgDocumentRestrictions(p, row)) return;
    documentSemantic.schedule(pgDocumentSemanticScope(p), { ...row, content: row.content_md }, () =>
      listPgDocuments({ query: pgQuery }, p, { limit: DOCUMENT_CANDIDATE_LIMIT + 1 }));
  }
}
