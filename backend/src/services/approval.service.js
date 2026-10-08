import { db } from '../config/db.js';
import { bumpVersion, findScoped, insert, listScoped, newId, nowIso, update } from '../models/base.js';
import * as audit from './audit.service.js';
import { notify } from './notification.service.js';
import { legacyApprovalPeople, personDisplay } from './approval-person-display.service.js';
import { BUILTIN_APPROVAL_FORMS, approvalBody, normalizeApprovalFields } from './approval-forms.service.js';
import { canReadDocument } from './rag.service.js';
import { enabledSet } from '../middleware/modules.js';
import { enabledFeatureSet } from '../config/features.js';
import { ApiError, notFound } from '../utils/errors.js';

export const HIGH_AMOUNT_MINOR = 1_000_000;
const TERMINAL = new Set(['approved', 'rejected', 'withdrawn']);
const json = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return fallback; }
};

export function legacyApprovalForms(principal) {
  const rows = listScoped('approval_form', principal, [{ sql: 'active = 1', params: [] }], { limit: 200, orderBy: 'key ASC' });
  const custom = new Map(rows.map(row => [row.key, {
    id: row.id, key: row.key, name: row.name, revision: row.revision,
    fields: normalizeApprovalFields(json(row.fields_json, [])), route: json(row.route_json, []), builtin: false,
  }]));
  return BUILTIN_APPROVAL_FORMS.map(form => custom.get(form.key) ?? { ...form, fields: form.fields.map(field => ({ ...field })), route: [] })
    .concat(rows.filter(row => !BUILTIN_APPROVAL_FORMS.some(form => form.key === row.key)).map(row => custom.get(row.key)));
}

export function legacyApprovalForm(principal, key) {
  const form = legacyApprovalForms(principal).find(item => item.key === key);
  if (!form) throw notFound('approval form');
  return form;
}

export function createApproval(principal, options) {
  const steps = options.steps ?? [];
  if (steps.length === 0) throw new ApiError('VALIDATION_ERROR', 'approval requires at least one step');
  const approval = insert('approval', {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    form_key: options.formKey ?? 'generic',
    title: options.title,
    requester_id: principal.userId,
    subject_type: options.subjectType ?? null,
    subject_id: options.subjectId ?? null,
    amount: options.amount ?? 0,
    due_at: options.dueAt ?? null,
    payload: JSON.stringify(options.payload ?? {}),
    body_json: JSON.stringify(options.payload ?? {}),
    steps_json: JSON.stringify(steps),
    workflow_locked: 0,
    created_by: principal.userId,
  });
  steps.forEach((step, ordinal) => insertApprovalStep(principal, approval, step, ordinal, true));
  audit.record({
    tenantId: principal.tenantId, action: 'approval.requested', resourceType: 'approval', resourceId: approval.id,
    actorId: principal.userId, after: { title: options.title, amount: options.amount ?? 0 },
  });
  return approval;
}

export function insertApprovalStep(principal, approval, step, ordinal, sendNotification = false) {
  const row = insert('approval_step', {
    tenant_id: principal.tenantId, approval_id: approval.id, ordinal,
    approver_id: step.approver_id, mode: step.mode ?? 'sequential', kind: step.kind ?? 'approve', created_by: principal.userId,
  });
  if (sendNotification) notify({
    tenantId: principal.tenantId, recipientId: step.approver_id, type: 'approval.requested', title: `결재 요청: ${approval.title}`,
    relatedType: 'approval', relatedId: approval.id, dedupeKey: `approval:${approval.id}:${step.approver_id}`,
  });
  return row;
}

export function stepsOf(principal, approvalId) {
  return listScoped('approval_step', principal, [{ sql: 'approval_id = ?', params: [approvalId] }], { limit: 100, orderBy: 'ordinal ASC' });
}

export function approvalById(principal, approvalId) {
  return db().prepare('SELECT * FROM approval WHERE id=? AND tenant_id=? AND org_id=? AND deleted_at IS NULL')
    .get(approvalId, principal.tenantId, principal.orgId) ?? null;
}

export function canReadApproval(principal, approval) {
  if (!approval) return false;
  if (approval.status === 'draft') return approval.requester_id === principal.userId && principal.has('approval.request');
  if (approval.requester_id === principal.userId) return principal.has('approval.request');
  const assigned = db().prepare(`SELECT 1 FROM approval_step WHERE tenant_id=? AND approval_id=? AND approver_id=? AND deleted_at IS NULL`)
    .get(principal.tenantId, approval.id, principal.userId);
  return Boolean(assigned && principal.has('approval.decide'));
}

export function readableApproval(principal, approvalId) {
  const approval = approvalById(principal, approvalId);
  if (!canReadApproval(principal, approval)) throw notFound('approval');
  return approval;
}

export function attachmentSnapshot(principal, approvalId) {
  return db().prepare(`SELECT f.id AS file_id,f.filename,f.mime,f.size AS size_bytes,f.checksum AS checksum_sha256
    FROM approval_receipt_files l JOIN file_object f ON f.id=l.file_id AND f.tenant_id=l.tenant_id AND f.org_id=l.org_id
    WHERE l.approval_id=? AND l.tenant_id=? AND l.org_id=? ORDER BY f.id`)
    .all(approvalId, principal.tenantId, principal.orgId);
}

export function approvalSnapshot(principal, approval) {
  return {
    id: approval.id, title: approval.title, form_key: approval.form_key,
    requester_id: approval.requester_id, subject_type: approval.subject_type, subject_id: approval.subject_id,
    amount: approval.amount, body: json(approvalBody(approval, approval.body_json), null),
    form_snapshot: json(approval.form_snapshot_json, null),
    attachment_snapshot: approval.workflow_locked ? json(approval.attachment_snapshot_json, []) : attachmentSnapshot(principal, approval.id),
    predecessor_id: approval.predecessor_id ?? null, status: approval.status, version: approval.version,
  };
}

export function recordApprovalHistory(principal, approval, action, actorId = principal.userId) {
  return db().prepare(`INSERT INTO approval_history(id,tenant_id,org_id,approval_id,actor_id,action,status,snapshot_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(newId(), principal.tenantId, principal.orgId, approval.id, actorId, action, approval.status,
    JSON.stringify(approvalSnapshot(principal, approval)), nowIso());
}

export function approvalView(principal, approval) {
  const steps = approval.status === 'draft'
    ? json(approval.steps_json, []).map((step, ordinal) => ({ ...step, ordinal, status: 'draft', comment: null, decided_at: null, delegate_of: null }))
    : stepsOf(principal, approval.id);
  const people = legacyApprovalPeople(principal, [approval.requester_id, ...steps.map(step => step.approver_id)]);
  return {
    ...approvalSnapshot(principal, approval),
    requester_display: personDisplay(people, approval.requester_id),
    current_step: approval.current_step,
    due_at: approval.due_at,
    submitted_at: approval.submitted_at ?? null,
    withdrawn_at: approval.withdrawn_at ?? null,
    workflow_locked: Boolean(approval.workflow_locked),
    requires_reauth: approval.amount >= HIGH_AMOUNT_MINOR,
    steps: steps.map(step => ({
      ordinal: step.ordinal, approver_id: step.approver_id, approver_display: personDisplay(people, step.approver_id), mode: step.mode, kind: step.kind,
      status: step.status, comment: step.comment, decided_at: step.decided_at, delegate_of: step.delegate_of,
    })),
  };
}

export function advance(principal, approval) {
  const steps = stepsOf(principal, approval.id);
  if (steps.some(step => step.status === 'rejected')) return bumpVersion('approval', approval, { status: 'rejected' }, principal.userId);
  const open = steps.filter(step => ['pending', 'held'].includes(step.status));
  if (open.length === 0) return bumpVersion('approval', approval, { status: 'approved' }, principal.userId);
  return bumpVersion('approval', approval, { current_step: Math.min(...open.map(step => step.ordinal)) }, principal.userId);
}

export function assertDraftOwner(principal, approval) {
  principal.require('approval.request');
  if (approval.requester_id !== principal.userId) throw notFound('approval');
  if (approval.status !== 'draft') throw new ApiError('CONFLICT', '제출된 결재 원본은 수정할 수 없습니다.');
}

export function assertExpectedVersion(approval, expectedVersion) {
  if (approval.version !== expectedVersion) throw new ApiError('VERSION_CONFLICT', '결재가 변경되었습니다.', { current_version: approval.version });
}

export function assertLegacyReference(principal, subjectType, subjectId) {
  if (subjectType == null && subjectId == null) return;
  if (!subjectType || !subjectId) throw new ApiError('VALIDATION_ERROR', '결재 참조 종류와 ID를 함께 지정해야 합니다.');
  // Mirror each domain's read surface; the approval link never supplies a missing grant.
  const references = {
    settlement: ['transaction.read', 'menu.finance', 'finance'],
    fiscal_period_lock: ['transaction.read', 'menu.finance', 'finance'],
    transaction_record: ['transaction.read', 'menu.finance', 'finance'],
    leave_request: [null, 'menu.leave', null],
    agent_action: ['agent.chat', 'menu.agent', 'agent'],
    project: ['project.read', 'menu.projects', 'projects'],
    document: ['document.read', 'menu.documents', 'documents'],
    task: ['task.read', 'menu.projects', 'tasks'],
  };
  if (!Object.hasOwn(references, subjectType)) throw new ApiError('VALIDATION_ERROR', '지원하지 않는 결재 참조 종류입니다.');
  const [permission, menu, module] = references[subjectType];
  const org = db().prepare('SELECT modules,enabled_features FROM organization WHERE id=? AND tenant_id=?').get(principal.orgId, principal.tenantId);
  if (!principal.has(menu) || (permission && !principal.has(permission)) || (module && !enabledSet(org.modules).has(module))
    || (subjectType === 'leave_request' && !enabledFeatureSet(org.enabled_features, org.modules).has('leave'))) throw notFound('approval reference');
  const row = findScoped(subjectType, principal, subjectId);
  if (!row) throw notFound('approval reference');
  if (subjectType === 'document' && !canReadDocument(principal, row)) throw notFound('approval reference');
  if (subjectType === 'leave_request' && row.member_id !== principal.userId && !principal.has('leave.approve')) throw notFound('approval reference');
  if (subjectType === 'agent_action' && row.user_id !== principal.userId) throw notFound('approval reference');
}

export function assertLegacyApprovers(principal, steps) {
  if (!Array.isArray(steps) || steps.length === 0) throw new ApiError('VALIDATION_ERROR', '결재자는 한 명 이상 필요합니다.');
  const seen = new Set();
  for (const step of steps) {
    if (!step || typeof step.approver_id !== 'string' || !step.approver_id || seen.has(step.approver_id)) {
      throw new ApiError('VALIDATION_ERROR', '결재 단계가 올바르지 않습니다.');
    }
    seen.add(step.approver_id);
    const member = db().prepare(`SELECT 1 FROM membership m JOIN app_user u ON u.id=m.user_id
      WHERE m.tenant_id=? AND m.org_id=? AND m.user_id=? AND m.status='active' AND m.deleted_at IS NULL AND u.auth_status='active'`)
      .get(principal.tenantId, principal.orgId, step.approver_id);
    if (!member) throw new ApiError('VALIDATION_ERROR', '현재 회사의 활성 결재자만 지정할 수 있습니다.');
  }
}

export function isTerminal(status) { return TERMINAL.has(status); }
