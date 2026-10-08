import { z } from 'zod';
import { db } from '../config/db.js';
import { resolvePrincipal } from '../middleware/auth.js';
import { bumpVersion, insert, update } from '../models/base.js';
import * as audit from '../services/audit.service.js';
import {
  HIGH_AMOUNT_MINOR, advance, approvalById, approvalView, assertDraftOwner, assertExpectedVersion,
  assertLegacyApprovers, assertLegacyReference, attachmentSnapshot, canReadApproval, createApproval, insertApprovalStep,
  legacyApprovalForm, legacyApprovalForms, readableApproval, recordApprovalHistory, stepsOf,
} from '../services/approval.service.js';
import { approvalBody, initialApprovalFormRevision, legacyApprovalAmount, normalizeApprovalFields, validateApprovalSubmission } from '../services/approval-forms.service.js';
import { consumeLegacyReceipts } from '../services/legacy-receipt-files.service.js';
import { notify } from '../services/notification.service.js';
import { legacyApprovalPeople, personDisplay } from '../services/approval-person-display.service.js';
import { legacyRoleGrants } from '../services/company-roles.service.js';
import { verifyPassword } from '../utils/crypto.js';
import { ApiError, notFound } from '../utils/errors.js';

const stepSchema = z.object({
  approver_id: z.string().min(1), mode: z.enum(['sequential', 'parallel']).default('sequential'), kind: z.string().default('approve'),
}).strict();
const formSchema = z.object({
  key: z.string().min(1), name: z.string().min(1), fields: z.array(z.record(z.any())).default([]), route: z.array(z.record(z.any())).default([]),
});
const requestSchema = z.object({
  title: z.string().min(1).max(300), form_key: z.string().default('generic'), steps: z.array(stepSchema).default([]),
  subject_type: z.string().nullable().optional(), subject_id: z.string().nullable().optional(), amount: z.number().int().default(0),
  due_at: z.string().nullable().optional(), payload: z.record(z.any()).default({}),
});
const draftCreateSchema = z.object({
  form_key: z.string().min(1).max(100).default('generic'), title: z.string().max(300).default(''),
  body: z.record(z.union([z.string(), z.null()])).default({}), steps: z.array(stepSchema).max(100).default([]),
  subject_type: z.string().max(100).nullable().optional(), subject_id: z.string().max(200).nullable().optional(),
  amount: z.number().int().safe().nonnegative().default(0), due_at: z.string().nullable().optional(),
}).strict();
const draftPatchSchema = z.object({
  expected_version: z.number().int().positive(), form_key: z.string().min(1).max(100).optional(), title: z.string().max(300).optional(),
  body: z.record(z.union([z.string(), z.null()])).optional(), steps: z.array(stepSchema).max(100).optional(),
  subject_type: z.string().max(100).nullable().optional(), subject_id: z.string().max(200).nullable().optional(),
  amount: z.number().int().safe().nonnegative().optional(), due_at: z.string().nullable().optional(),
  receipt_tokens: z.array(z.string()).max(5).optional(),
}).strict();
const submitSchema = z.object({
  expected_version: z.number().int().positive(), form_revision: z.number().int().positive(), receipt_tokens: z.array(z.string()).max(5).default([]),
}).strict();
const expectedSchema = z.object({ expected_version: z.number().int().positive() }).strict();
const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'hold']), comment: z.string().max(2000).default(''), reauth_password: z.string().nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === 'reject' && !value.comment.trim()) context.addIssue({ code: z.ZodIssueCode.custom, path: ['comment'], message: '반려 사유는 필수입니다.' });
});
const delegateSchema = z.object({ to_user_id: z.string() });

function requireApprovalSurface(principal) {
  if (!principal.has('approval.request') && !principal.has('approval.decide')) principal.require('approval.request');
}

function immediateTransaction(work) {
  db().exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db().exec('COMMIT');
    return result;
  } catch (error) {
    db().exec('ROLLBACK');
    throw error;
  }
}

export function createForm(req, res) {
  const principal = resolvePrincipal(req); principal.require('approval.form.manage');
  const payload = formSchema.parse(req.body);
  payload.fields = normalizeApprovalFields(payload.fields);
  const existing = db().prepare(`SELECT * FROM approval_form WHERE tenant_id=? AND org_id=? AND key=? AND deleted_at IS NULL`)
    .get(principal.tenantId, principal.orgId, payload.key);
  if (existing) {
    const updated = update('approval_form', existing.id, { revision: existing.revision + 1, name: payload.name,
      fields_json: JSON.stringify(payload.fields), route_json: JSON.stringify(payload.route) }, principal.userId);
    return res.json({ id: updated.id, key: updated.key, revision: updated.revision });
  }
  const form = insert('approval_form', { tenant_id: principal.tenantId, org_id: principal.orgId, key: payload.key,
    revision: initialApprovalFormRevision(payload.key), name: payload.name, fields_json: JSON.stringify(payload.fields), route_json: JSON.stringify(payload.route), created_by: principal.userId });
  res.status(201).json({ id: form.id, key: form.key, revision: form.revision });
}

export function listForms(req, res) {
  const principal = resolvePrincipal(req); principal.require('approval.request');
  res.json({ items: legacyApprovalForms(principal) });
}

// 구성원 목록 권한을 확대하지 않고 기안에 필요한 활성 결재자 ID/이름만 제공한다.
export function approverCandidates(req, res) {
  const principal = resolvePrincipal(req); principal.require('approval.request');
  const rows = db().prepare(`SELECT u.id,u.name,m.roles FROM membership m JOIN app_user u ON u.id=m.user_id
    WHERE m.tenant_id=? AND m.org_id=? AND m.status='active' AND m.deleted_at IS NULL AND u.auth_status='active'
    ORDER BY u.name,u.id`).all(principal.tenantId, principal.orgId);
  const items = rows.filter(row => {
    const { permissions } = legacyRoleGrants(principal, (row.roles ?? '').split(',').filter(Boolean));
    return permissions.has('*') || (permissions.has('approval.decide') && permissions.has('menu.approvals'));
  }).map(({ id, name }) => ({ id, name }));
  res.json({ items });
}

// Compatibility route: existing callers still create an immediately submitted pending request.
export function requestApproval(req, res) {
  const principal = resolvePrincipal(req); principal.require('approval.request');
  const payload = requestSchema.parse(req.body);
  const approval = createApproval(principal, { title: payload.title, steps: payload.steps, formKey: payload.form_key,
    subjectType: payload.subject_type, subjectId: payload.subject_id, amount: payload.amount, dueAt: payload.due_at, payload: payload.payload });
  res.status(201).json(approvalView(principal, approval));
}

export function createDraft(req, res) {
  const principal = resolvePrincipal(req); principal.require('approval.request');
  const payload = draftCreateSchema.parse(req.body);
  legacyApprovalForm(principal, payload.form_key);
  if (payload.steps.length) assertLegacyApprovers(principal, payload.steps);
  const approval = immediateTransaction(() => {
    const row = insert('approval', { tenant_id: principal.tenantId, org_id: principal.orgId, requester_id: principal.userId,
      form_key: payload.form_key, title: payload.title, body_json: JSON.stringify(payload.body), payload: JSON.stringify(payload.body),
      steps_json: JSON.stringify(payload.steps), subject_type: payload.subject_type ?? null, subject_id: payload.subject_id ?? null,
      amount: payload.amount, due_at: payload.due_at ?? null, status: 'draft', workflow_locked: 0, created_by: principal.userId });
    recordApprovalHistory(principal, row, 'draft.created');
    audit.record({ tenantId: principal.tenantId, actorId: principal.userId, action: 'approval.draft.created', resourceType: 'approval', resourceId: row.id,
      after: { status: 'draft', predecessor_id: null }, requestId: req.requestId });
    return row;
  });
  res.status(201).json(approvalView(principal, approval));
}

export function patchDraft(req, res) {
  const principal = resolvePrincipal(req); principal.require('approval.request');
  const payload = draftPatchSchema.parse(req.body);
  const updated = immediateTransaction(() => {
    const current = approvalById(principal, req.params.approvalId);
    if (!current) throw notFound('approval');
    assertDraftOwner(principal, current); assertExpectedVersion(current, payload.expected_version);
    const formKey = payload.form_key ?? current.form_key;
    legacyApprovalForm(principal, formKey);
    const steps = payload.steps ?? JSON.parse(current.steps_json || '[]');
    if (payload.steps) assertLegacyApprovers(principal, steps);
    const body = payload.body ?? JSON.parse(current.body_json || '{}');
    const next = bumpVersion('approval', current, {
      form_key: formKey, title: payload.title ?? current.title, body_json: JSON.stringify(body), payload: JSON.stringify(body),
      steps_json: JSON.stringify(steps), subject_type: payload.subject_type === undefined ? current.subject_type : payload.subject_type,
      subject_id: payload.subject_id === undefined ? current.subject_id : payload.subject_id,
      amount: payload.amount ?? current.amount, due_at: payload.due_at === undefined ? current.due_at : payload.due_at,
    }, principal.userId);
    if (payload.receipt_tokens?.length) consumeLegacyReceipts(principal, { kind: 'approval', parentId: next.id, expectedVersion: next.version, tokens: payload.receipt_tokens });
    recordApprovalHistory(principal, next, 'draft.updated');
    return next;
  });
  res.json(approvalView(principal, updated));
}

export function submitDraft(req, res) {
  const principal = resolvePrincipal(req); principal.require('approval.request');
  const payload = submitSchema.parse(req.body);
  const submitted = immediateTransaction(() => {
    const current = approvalById(principal, req.params.approvalId);
    if (!current) throw notFound('approval');
    assertDraftOwner(principal, current); assertExpectedVersion(current, payload.expected_version);
    const form = legacyApprovalForm(principal, current.form_key);
    if (form.revision !== payload.form_revision) throw new ApiError('VERSION_CONFLICT', '양식 revision이 변경되었습니다.', { current_form_revision: form.revision });
    const body = JSON.parse(current.body_json || '{}');
    const formSnapshot = validateApprovalSubmission({ title: current.title, body, form });
    const amount = legacyApprovalAmount(body, current.amount);
    const steps = JSON.parse(current.steps_json || '[]');
    assertLegacyApprovers(principal, steps);
    assertLegacyReference(principal, current.subject_type, current.subject_id);
    if (payload.receipt_tokens.length) consumeLegacyReceipts(principal, {
      kind: 'approval', parentId: current.id, expectedVersion: current.version, tokens: payload.receipt_tokens,
    });
    const attachments = attachmentSnapshot(principal, current.id);
    steps.forEach((step, ordinal) => insertApprovalStep(principal, current, step, ordinal, true));
    const next = bumpVersion('approval', current, { status: 'pending', workflow_locked: 1, amount,
      form_revision: form.revision, form_snapshot_json: JSON.stringify(formSnapshot), attachment_snapshot_json: JSON.stringify(attachments),
      submitted_at: new Date().toISOString() }, principal.userId);
    recordApprovalHistory(principal, next, 'submitted');
    audit.record({ tenantId: principal.tenantId, actorId: principal.userId, action: 'approval.submitted', resourceType: 'approval', resourceId: next.id,
      after: { version: next.version, form_revision: form.revision, attachment_snapshot: attachments }, requestId: req.requestId, approvalId: next.id });
    return next;
  });
  res.json(approvalView(principal, submitted));
}

export function listRequests(req, res) {
  const principal = resolvePrincipal(req); requireApprovalSurface(principal);
  const box = req.query.box ?? 'inbox';
  const limit = Math.min(Math.max(z.coerce.number().int().default(50).parse(req.query.limit), 1), 200);
  const offset = z.coerce.number().int().min(0).max(1000000).default(0).parse(req.query.offset);
  let rows;
  if (box === 'sent' || box === 'drafts') {
    rows = db().prepare(`SELECT * FROM approval WHERE tenant_id=? AND org_id=? AND requester_id=?
      AND deleted_at IS NULL ${box === 'drafts' ? "AND status='draft'" : ''} ORDER BY created_at DESC,id DESC`)
      .all(principal.tenantId, principal.orgId, principal.userId);
  } else if (box === 'completed') {
    rows = db().prepare(`SELECT a.* FROM approval a WHERE a.tenant_id=? AND a.org_id=? AND a.deleted_at IS NULL
      AND a.status IN ('approved','rejected','withdrawn')
      AND ((a.requester_id=? AND ?=1) OR (a.requester_id<>? AND ?=1 AND EXISTS(
        SELECT 1 FROM approval_step s WHERE s.approval_id=a.id AND s.tenant_id=a.tenant_id AND s.approver_id=? AND s.deleted_at IS NULL)))
      ORDER BY a.created_at DESC,a.id DESC`)
      .all(principal.tenantId, principal.orgId, principal.userId, Number(principal.has('approval.request')),
        principal.userId, Number(principal.has('approval.decide')), principal.userId);
  } else {
    rows = db().prepare(`SELECT DISTINCT a.* FROM approval a JOIN approval_step s ON s.approval_id=a.id AND s.tenant_id=a.tenant_id
      WHERE a.tenant_id=? AND a.org_id=? AND a.status='pending' AND a.deleted_at IS NULL
        AND s.approver_id=? AND s.deleted_at IS NULL ORDER BY a.created_at DESC,a.id DESC`)
      .all(principal.tenantId, principal.orgId, principal.userId)
      .filter(row => canReadApproval(principal, row));
  }
  // 인가된 집합에서 페이지를 잘라 비공개 행의 존재/건수를 공개하지 않는다.
  const readable = rows.filter(row => canReadApproval(principal, row));
  res.json({ items: readable.slice(offset, offset + limit).map(row => approvalView(principal, row)), box,
    offset, limit, has_more: readable.length > offset + limit });
}

export function getRequest(req, res) {
  const principal = resolvePrincipal(req); requireApprovalSurface(principal);
  res.json(approvalView(principal, readableApproval(principal, req.params.approvalId)));
}

export function history(req, res) {
  const principal = resolvePrincipal(req); requireApprovalSurface(principal);
  const approval = readableApproval(principal, req.params.approvalId);
  const rows = db().prepare(`SELECT id,actor_id,action,status,snapshot_json,created_at FROM approval_history
    WHERE tenant_id=? AND org_id=? AND approval_id=? ORDER BY created_at,id`).all(principal.tenantId, principal.orgId, approval.id);
  const people = legacyApprovalPeople(principal, rows.map(row => row.actor_id));
  res.json({ items: rows.map(row => ({ ...row, actor_display: personDisplay(people, row.actor_id), snapshot: JSON.parse(row.snapshot_json), snapshot_json: undefined })) });
}

export function decide(req, res) {
  const principal = resolvePrincipal(req); principal.require('approval.decide');
  const payload = decisionSchema.parse(req.body);
  const latest = immediateTransaction(() => {
    const approval = readableApproval(principal, req.params.approvalId);
    if (approval.status !== 'pending') throw new ApiError('CONFLICT', `approval is already ${approval.status}`);
    const steps = stepsOf(principal, approval.id);
    const mine = steps.filter(step => step.approver_id === principal.userId && ['pending', 'held'].includes(step.status));
    if (!mine.length) throw new ApiError('PERMISSION_DENIED', 'you are not an open approver of this request');
    const step = mine.reduce((a, b) => a.ordinal <= b.ordinal ? a : b);
    if (step.mode === 'sequential') {
      const earlier = steps.filter(item => item.ordinal < step.ordinal && ['pending', 'held'].includes(item.status));
      if (earlier.length) throw new ApiError('CONFLICT', 'an earlier sequential step is still open');
    }
    if (approval.amount >= HIGH_AMOUNT_MINOR && payload.decision === 'approve') {
      const user = db().prepare('SELECT * FROM app_user WHERE id=?').get(principal.userId);
      if (!payload.reauth_password || !verifyPassword(payload.reauth_password, user.password_hash)) {
        throw new ApiError('PERMISSION_DENIED', 'high-amount approval requires re-authentication');
      }
    }
    const statusByDecision = { approve: 'approved', reject: 'rejected', hold: 'held' };
    update('approval_step', step.id, { status: statusByDecision[payload.decision], comment: payload.comment,
      decided_at: new Date().toISOString() }, principal.userId);
    let result = db().prepare('SELECT * FROM approval WHERE id=?').get(approval.id);
    if (payload.decision !== 'hold') result = advance(principal, result);
    recordApprovalHistory(principal, result, `decision.${payload.decision}`);
    audit.record({ tenantId: principal.tenantId, action: `approval.${payload.decision}`, resourceType: 'approval', resourceId: approval.id,
      actorId: principal.userId, after: { status: result.status, step: step.ordinal, attachment_snapshot: JSON.parse(result.attachment_snapshot_json || '[]') },
      approvalId: approval.id, requestId: req.requestId });
    if (['approved', 'rejected'].includes(result.status)) notify({ tenantId: principal.tenantId, recipientId: result.requester_id,
      type: `approval.${result.status}`, title: `결재 ${result.status === 'approved' ? '승인' : '반려'}: ${result.title}`,
      relatedType: 'approval', relatedId: result.id, dedupeKey: `approval-result:${result.id}` });
    return result;
  });
  res.json(approvalView(principal, latest));
}

export function withdraw(req, res) {
  const principal = resolvePrincipal(req); principal.require('approval.request');
  const parsed = z.object({ expected_version: z.number().int().positive().optional() }).strict().parse(req.body ?? {});
  const result = immediateTransaction(() => {
    const approval = approvalById(principal, req.params.approvalId);
    if (!approval || approval.requester_id !== principal.userId) throw notFound('approval');
    if (approval.status !== 'pending') throw new ApiError('CONFLICT', `approval is already ${approval.status}`);
    if (parsed.expected_version !== undefined) assertExpectedVersion(approval, parsed.expected_version);
    const updated = bumpVersion('approval', approval, { status: 'withdrawn', withdrawn_at: new Date().toISOString() }, principal.userId);
    recordApprovalHistory(principal, updated, 'withdrawn');
    audit.record({ tenantId: principal.tenantId, action: 'approval.withdrawn', resourceType: 'approval', resourceId: approval.id,
      actorId: principal.userId, requestId: req.requestId, after: { version: updated.version } });
    return updated;
  });
  res.json(approvalView(principal, result));
}

export function resubmit(req, res) {
  const principal = resolvePrincipal(req); principal.require('approval.request');
  const payload = expectedSchema.parse(req.body);
  const draft = immediateTransaction(() => {
    const source = approvalById(principal, req.params.approvalId);
    if (!source || source.requester_id !== principal.userId) throw notFound('approval');
    if (!['rejected', 'withdrawn'].includes(source.status)) throw new ApiError('CONFLICT', '반려 또는 철회된 결재만 새 초안으로 재상신할 수 있습니다.');
    assertExpectedVersion(source, payload.expected_version);
    legacyApprovalForm(principal, source.form_key);
    assertLegacyReference(principal, source.subject_type, source.subject_id);
    const steps = source.workflow_locked ? JSON.parse(source.steps_json || '[]') : stepsOf(principal, source.id)
      .map(({ approver_id, mode, kind }) => ({ approver_id, mode, kind }));
    assertLegacyApprovers(principal, steps);
    const body = approvalBody(source, source.body_json);
    const row = insert('approval', { tenant_id: principal.tenantId, org_id: principal.orgId, requester_id: principal.userId,
      form_key: source.form_key, title: source.title, body_json: body, payload: body,
      steps_json: JSON.stringify(steps), subject_type: source.subject_type, subject_id: source.subject_id, amount: source.amount,
      due_at: source.due_at, predecessor_id: source.id, status: 'draft', workflow_locked: 0, created_by: principal.userId });
    recordApprovalHistory(principal, row, 'draft.resubmitted');
    audit.record({ tenantId: principal.tenantId, actorId: principal.userId, action: 'approval.resubmitted', resourceType: 'approval', resourceId: row.id,
      before: { predecessor_id: source.id }, after: { status: 'draft' }, requestId: req.requestId });
    return row;
  });
  res.status(201).json(approvalView(principal, draft));
}

export function delegate(req, res) {
  const principal = resolvePrincipal(req); principal.require('approval.decide');
  const payload = delegateSchema.parse(req.body);
  const approval = readableApproval(principal, req.params.approvalId);
  if (approval.status !== 'pending') throw new ApiError('CONFLICT', '처리된 결재는 위임할 수 없습니다.');
  const step = stepsOf(principal, approval.id).find(item => item.approver_id === principal.userId && ['pending', 'held'].includes(item.status));
  if (!step) throw notFound('open approval step');
  update('approval_step', step.id, { delegate_of: principal.userId, approver_id: payload.to_user_id }, principal.userId);
  audit.record({ tenantId: principal.tenantId, action: 'approval.delegated', resourceType: 'approval', resourceId: approval.id,
    actorId: principal.userId, after: { to: payload.to_user_id }, requestId: req.requestId });
  res.json(approvalView(principal, approval));
}
