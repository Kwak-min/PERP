import { z } from 'zod';
import { pgTransaction } from '../config/pg.js';
import { effectivePgPermissions } from '../config/menu-permissions.js';
import { assertFeatureEnabled } from '../config/features.js';
import { resolvePgCompanyPrincipal } from '../middleware/pgAccess.js';
import { BUILTIN_APPROVAL_FORMS, approvalBody, initialApprovalFormRevision, normalizeApprovalFields, validateApprovalSubmission } from '../services/approval-forms.service.js';
import { consumePgReceipts } from '../services/pg-receipt-files.service.js';
import { canReadPgApproval } from '../services/pg-approval-read-policy.service.js';
import { ApiError, notFound } from '../utils/errors.js';

const idSchema = z.string().regex(/^[1-9]\d*$/);
const bodySchema = z.record(z.union([z.string(), z.null()]));
const draftCreateSchema = z.object({ form_key: z.string().min(1).max(100).default('generic'), title: z.string().max(300).default(''), body: bodySchema.default({}) }).strict();
const draftPatchSchema = z.object({ expected_version: z.number().int().positive(), form_key: z.string().min(1).max(100).optional(),
  title: z.string().max(300).optional(), body: bodySchema.optional(), receipt_tokens: z.array(z.string()).max(5).optional() }).strict();
const submitSchema = z.object({ expected_version: z.number().int().positive(), form_revision: z.number().int().positive(),
  receipt_tokens: z.array(z.string()).max(5).default([]) }).strict();
const expectedSchema = z.object({ expected_version: z.number().int().positive() }).strict();
const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).default(''),
  confirm_self_decision: z.boolean().optional() }).strict().superRefine((value, context) => {
  if (value.decision === 'reject' && !value.comment.trim()) context.addIssue({ code: z.ZodIssueCode.custom, path: ['comment'], message: '반려 사유는 필수입니다.' });
});
const formWriteSchema = z.object({ key: z.string().min(1).max(100), name: z.string().min(1).max(200), fields: z.array(z.record(z.any())).max(100) }).strict();

async function freshPrincipal(client, principal, permission = null) {
  const company = (await client.query('SELECT id FROM org.companies WHERE id=$1 AND is_active=true FOR UPDATE', [principal.companyId])).rows[0];
  if (!company) throw notFound('company');
  const membership = (await client.query(`SELECT m.user_id FROM org.company_memberships m JOIN auth.users u ON u.id=m.user_id
    WHERE m.company_id=$2 AND m.user_id=$1 AND m.status='active' AND u.account_status='active' AND u.approval_status='approved' FOR SHARE OF m,u`,
  [principal.userId, principal.companyId])).rows[0];
  const grants = (await client.query(`SELECT p.code,r.name AS role FROM org.user_roles ur JOIN org.roles r ON r.id=ur.role_id AND r.company_id=$2 AND r.deleted_at IS NULL
    JOIN org.role_permissions rp ON rp.role_id=r.id JOIN org.permissions p ON p.id=rp.permission_id
    WHERE ur.user_id=$1 AND ur.workspace_id IS NULL`, [principal.userId, principal.companyId])).rows;
  if (!membership) throw new ApiError('PERMISSION_DENIED', '현재 회사 소속이 없습니다.');
  const permissions = effectivePgPermissions(grants);
  const fresh = { ...principal, permissions, has: code => permissions.includes(code), require(code) {
    if (!this.has(code)) throw new ApiError('PERMISSION_DENIED', '현재 결재 권한이 없습니다.');
  } };
  fresh.require('menu.approvals');
  if (permission) fresh.require(permission);
  const modules = (await client.query('SELECT module_key FROM org.company_modules WHERE company_id=$1', [principal.companyId])).rows.map(row => row.module_key);
  const features = (await client.query('SELECT enabled_features FROM org.company_feature_settings WHERE company_id=$1', [principal.companyId])).rows[0];
  assertFeatureEnabled('approvals', features?.enabled_features, modules);
  return fresh;
}

function formRow(row) {
  return { id: row.id == null ? undefined : String(row.id), key: row.form_key, name: row.name, revision: row.revision,
    fields: normalizeApprovalFields(row.fields), builtin: false };
}

async function forms(client, companyId) {
  const rows = (await client.query('SELECT id,form_key,name,fields,revision FROM org.approval_forms WHERE company_id=$1 AND active=true ORDER BY form_key', [companyId])).rows;
  const custom = new Map(rows.map(row => [row.form_key, formRow(row)]));
  return BUILTIN_APPROVAL_FORMS.map(form => custom.get(form.key) ?? { ...form, fields: form.fields.map(field => ({ ...field })) })
    .concat(rows.filter(row => !BUILTIN_APPROVAL_FORMS.some(form => form.key === row.form_key)).map(formRow));
}

async function form(client, companyId, key) {
  const found = (await forms(client, companyId)).find(item => item.key === key);
  if (!found) throw notFound('approval form');
  return found;
}

async function assertTargetReference(client, principal, targetId) {
  if (targetId == null) return;
  const activeTarget = (await client.query(`SELECT 1 FROM org.company_memberships m JOIN auth.users u ON u.id=m.user_id
    WHERE m.company_id=$1 AND m.user_id=$2 AND m.status='active' AND u.account_status='active' AND u.approval_status='approved' FOR SHARE OF m,u`,
  [principal.companyId, targetId])).rows[0];
  if (!activeTarget) throw notFound('approval reference');
}

async function requestRow(client, principal, id, lock = false) {
  const row = (await client.query(`SELECT *,xmin::text AS row_version FROM org.approval_requests WHERE id=$1 AND company_id=$2 ${lock ? 'FOR UPDATE' : ''}`,
    [id, principal.companyId])).rows[0];
  if (!row) throw notFound('approval');
  return row;
}

function view(row) {
  return {
    id: String(row.id), title: row.title ?? row.request_type, request_type: row.request_type,
    requester_id: row.requester_id == null ? null : String(row.requester_id), target_user_id: row.target_user_id == null ? null : String(row.target_user_id),
    form_key: row.form_key, body: approvalBody(row) ?? null, status: row.status, version: row.version,
    form_snapshot: row.form_snapshot, attachment_snapshot: row.attachment_snapshot ?? [], predecessor_id: row.predecessor_id == null ? null : String(row.predecessor_id),
    workflow_locked: Boolean(row.workflow_locked), submitted_at: row.submitted_at, withdrawn_at: row.withdrawn_at,
    decided_by: row.decided_by == null ? null : String(row.decided_by), decided_at: row.decided_at, decision_note: row.decision_note,
  };
}

async function history(client, principal, row, action) {
  await client.query(`INSERT INTO org.approval_request_history(company_id,approval_id,actor_id,action,status,snapshot)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [principal.companyId, row.id, principal.userId, action, row.status, JSON.stringify(view(row))]);
}

async function audit(client, req, principal, action, row, before = null, extra = {}) {
  await client.query(`INSERT INTO org.role_change_events(company_id,actor_id,action,resource_id,before_data,after_data,request_id)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`, [principal.companyId, principal.userId, action, String(row.id),
    before == null ? null : JSON.stringify(before), JSON.stringify({ status: row.status, version: row.version, ...extra }), req.requestId ?? null]);
}

function expected(row, version) {
  if (row.version !== version) throw new ApiError('VERSION_CONFLICT', '결재가 변경되었습니다.', { current_version: row.version });
}

async function attachments(client, principal, id) {
  return (await client.query(`SELECT f.id::text AS file_id,f.original_name AS filename,f.mime_type AS mime,
    f.size_bytes::int AS size_bytes,f.checksum_sha256 FROM org.approval_request_files l
    JOIN files.objects f ON f.id=l.file_id AND f.company_id=l.company_id WHERE l.company_id=$1 AND l.approval_id=$2 ORDER BY f.id`,
  [principal.companyId, id])).rows;
}

export async function listPgForms(req, res) {
  const principal = await resolvePgCompanyPrincipal(req);
  const items = await pgTransaction(async client => { const fresh = await freshPrincipal(client, principal, 'approval.request'); return forms(client, fresh.companyId); });
  res.json({ items });
}

export async function savePgForm(req, res) {
  const principal = await resolvePgCompanyPrincipal(req); const payload = formWriteSchema.parse(req.body);
  let created = false;
  const saved = await pgTransaction(async client => {
    const fresh = await freshPrincipal(client, principal, 'approval.form.manage');
    const existing = (await client.query('SELECT * FROM org.approval_forms WHERE company_id=$1 AND form_key=$2 FOR UPDATE', [fresh.companyId, payload.key])).rows[0];
    const fields = normalizeApprovalFields(payload.fields);
    if (existing) return (await client.query(`UPDATE org.approval_forms SET name=$3,fields=$4::jsonb,revision=revision+1,active=true,updated_at=now()
      WHERE company_id=$1 AND form_key=$2 RETURNING *`, [fresh.companyId, payload.key, payload.name, JSON.stringify(fields)])).rows[0];
    created = true;
    return (await client.query(`INSERT INTO org.approval_forms(company_id,form_key,name,fields,created_by,revision) VALUES($1,$2,$3,$4::jsonb,$5,$6) RETURNING *`,
      [fresh.companyId, payload.key, payload.name, JSON.stringify(fields), fresh.userId, initialApprovalFormRevision(payload.key)])).rows[0];
  });
  res.status(created ? 201 : 200).json(formRow(saved));
}

export async function createPgDraft(req, res) {
  const principal = await resolvePgCompanyPrincipal(req); const payload = draftCreateSchema.parse(req.body);
  const row = await pgTransaction(async client => {
    const fresh = await freshPrincipal(client, principal, 'approval.request'); await form(client, fresh.companyId, payload.form_key);
    const created = (await client.query(`INSERT INTO org.approval_requests(company_id,request_type,requester_id,payload,status,title,form_key,body)
      VALUES($1,$2,$3,$4::jsonb,'draft',$5,$6,$4::jsonb) RETURNING *`, [fresh.companyId, payload.form_key, fresh.userId, JSON.stringify(payload.body), payload.title, payload.form_key])).rows[0];
    await history(client, fresh, created, 'draft.created'); await audit(client, req, fresh, 'approval.draft.created', created);
    return created;
  });
  res.status(201).json(view(row));
}

export async function patchPgDraft(req, res) {
  const principal = await resolvePgCompanyPrincipal(req); const id = idSchema.parse(req.params.id), payload = draftPatchSchema.parse(req.body);
  const row = await pgTransaction(async client => {
    const fresh = await freshPrincipal(client, principal, 'approval.request'); const current = await requestRow(client, fresh, id, true);
    if (String(current.requester_id) !== String(fresh.userId)) throw notFound('approval');
    if (current.status !== 'draft') throw new ApiError('CONFLICT', '제출된 결재 원본은 수정할 수 없습니다.');
    expected(current, payload.expected_version); const formKey = payload.form_key ?? current.form_key; await form(client, fresh.companyId, formKey);
    const next = (await client.query(`UPDATE org.approval_requests SET form_key=$3,request_type=$3,title=$4,body=$5::jsonb,payload=$5::jsonb,version=version+1
      WHERE id=$1 AND company_id=$2 RETURNING *`, [id, fresh.companyId, formKey, payload.title ?? current.title, JSON.stringify(payload.body ?? current.body)])).rows[0];
    if (payload.receipt_tokens?.length) await consumePgReceipts(client, fresh, { kind: 'approval', parentId: id,
      expectedVersion: (await requestRow(client, fresh, id)).row_version, tokens: payload.receipt_tokens });
    next.attachment_snapshot = await attachments(client, fresh, id);
    await history(client, fresh, next, 'draft.updated'); return next;
  });
  res.json(view(row));
}

export async function submitPgDraft(req, res) {
  const principal = await resolvePgCompanyPrincipal(req); const id = idSchema.parse(req.params.id), payload = submitSchema.parse(req.body);
  const row = await pgTransaction(async client => {
    const fresh = await freshPrincipal(client, principal, 'approval.request'); const current = await requestRow(client, fresh, id, true);
    if (String(current.requester_id) !== String(fresh.userId)) throw notFound('approval');
    if (current.status !== 'draft') throw new ApiError('CONFLICT', '제출된 결재는 다시 제출할 수 없습니다.');
    expected(current, payload.expected_version); const activeForm = await form(client, fresh.companyId, current.form_key);
    if (activeForm.revision !== payload.form_revision) throw new ApiError('VERSION_CONFLICT', '양식 revision이 변경되었습니다.', { current_form_revision: activeForm.revision });
    const formSnapshot = validateApprovalSubmission({ title: current.title, body: current.body, form: activeForm });
    await assertTargetReference(client, fresh, current.target_user_id);
    if (payload.receipt_tokens.length) await consumePgReceipts(client, fresh, { kind: 'approval', parentId: id, expectedVersion: current.row_version, tokens: payload.receipt_tokens });
    const attachmentSnapshot = await attachments(client, fresh, id);
    const next = (await client.query(`UPDATE org.approval_requests SET status='pending',workflow_locked=true,form_revision=$3,
      form_snapshot=$4::jsonb,attachment_snapshot=$5::jsonb,submitted_at=now(),version=version+1 WHERE id=$1 AND company_id=$2 RETURNING *`,
    [id, fresh.companyId, activeForm.revision, JSON.stringify(formSnapshot), JSON.stringify(attachmentSnapshot)])).rows[0];
    await history(client, fresh, next, 'submitted'); await audit(client, req, fresh, 'approval.submitted', next, null,
      { form_revision: activeForm.revision, attachment_snapshot: attachmentSnapshot }); return next;
  });
  res.json(view(row));
}

export async function getPgApproval(req, res) {
  const principal = await resolvePgCompanyPrincipal(req); const id = idSchema.parse(req.params.id);
  const row = await pgTransaction(async client => { const fresh = await freshPrincipal(client, principal); const found = await requestRow(client, fresh, id);
    if (!canReadPgApproval(fresh, found)) throw notFound('approval');
    if (!found.workflow_locked) found.attachment_snapshot = await attachments(client, fresh, id);
    return found; });
  res.json(view(row));
}

export async function pgApprovalHistory(req, res) {
  const principal = await resolvePgCompanyPrincipal(req); const id = idSchema.parse(req.params.id);
  const items = await pgTransaction(async client => { const fresh = await freshPrincipal(client, principal); const row = await requestRow(client, fresh, id);
    if (!canReadPgApproval(fresh, row)) throw notFound('approval');
    const recorded = (await client.query(`SELECT id::text,actor_id::text,action,status,snapshot,created_at
      FROM org.approval_request_history WHERE company_id=$1 AND approval_id=$2 ORDER BY approval_request_history.id`, [fresh.companyId, id])).rows;
    if (!recorded.some(item => item.action.startsWith('decision.')) && row.decided_at && ['approved', 'rejected'].includes(row.status)) {
      recorded.push({ id: null, actor_id: row.decided_by == null ? null : String(row.decided_by),
        action: row.status === 'approved' ? 'decision.approve' : 'decision.reject', status: row.status,
        snapshot: null, created_at: row.decided_at, comment: row.decision_note, origin: 'legacy_decision' });
    }
    return recorded; });
  res.json({ items });
}

export async function decidePgApproval(req, res) {
  const principal = await resolvePgCompanyPrincipal(req); const id = idSchema.parse(req.params.id), payload = decisionSchema.parse(req.body);
  const row = await pgTransaction(async client => {
    const fresh = await freshPrincipal(client, principal, 'approval.decide'); const current = await requestRow(client, fresh, id, true);
    if (current.status !== 'pending') throw new ApiError('CONFLICT', '이미 처리된 결재 요청입니다');
    const selfDecision = String(current.requester_id) === String(fresh.userId);
    if (current.workflow_locked && selfDecision && payload.confirm_self_decision !== true) throw new ApiError('VALIDATION_ERROR', '본인 요청 결정 여부를 명시적으로 확인해야 합니다.');
    const status = payload.decision === 'approve' ? 'approved' : 'rejected';
    const next = (await client.query(`UPDATE org.approval_requests SET status=$3,decided_by=$4,decided_at=now(),decision_note=$5,version=version+1
      WHERE id=$1 AND company_id=$2 RETURNING *`, [id, fresh.companyId, status, fresh.userId, payload.comment])).rows[0];
    await history(client, fresh, next, `decision.${payload.decision}`); await audit(client, req, fresh, 'approval.decided', next,
      { status: current.status, version: current.version }, { decision: payload.decision, self_decision: selfDecision, attachment_snapshot: next.attachment_snapshot });
    return next;
  });
  res.json(view(row));
}

export async function withdrawPgApproval(req, res) {
  const principal = await resolvePgCompanyPrincipal(req); const id = idSchema.parse(req.params.id);
  const payload = z.object({ expected_version: z.number().int().positive().optional() }).strict().parse(req.body ?? {});
  const row = await pgTransaction(async client => {
    const fresh = await freshPrincipal(client, principal, 'approval.request'); const current = await requestRow(client, fresh, id, true);
    if (String(current.requester_id) !== String(fresh.userId)) throw notFound('approval');
    if (current.status !== 'pending') throw new ApiError('CONFLICT', '이미 처리된 결재 요청입니다');
    if (payload.expected_version !== undefined) expected(current, payload.expected_version);
    const next = (await client.query(`UPDATE org.approval_requests SET status='withdrawn',withdrawn_at=now(),version=version+1 WHERE id=$1 AND company_id=$2 RETURNING *`,
      [id, fresh.companyId])).rows[0];
    await history(client, fresh, next, 'withdrawn'); await audit(client, req, fresh, 'approval.withdrawn', next, { status: current.status, version: current.version });
    return next;
  });
  res.json(view(row));
}

export async function resubmitPgApproval(req, res) {
  const principal = await resolvePgCompanyPrincipal(req); const id = idSchema.parse(req.params.id), payload = expectedSchema.parse(req.body);
  const row = await pgTransaction(async client => {
    const fresh = await freshPrincipal(client, principal, 'approval.request'); const source = await requestRow(client, fresh, id, true);
    if (String(source.requester_id) !== String(fresh.userId)) throw notFound('approval');
    if (!['rejected', 'withdrawn'].includes(source.status)) throw new ApiError('CONFLICT', '반려 또는 철회된 결재만 새 초안으로 재상신할 수 있습니다.');
    expected(source, payload.expected_version); await form(client, fresh.companyId, source.form_key);
    await assertTargetReference(client, fresh, source.target_user_id);
    const body = approvalBody(source);
    const created = (await client.query(`INSERT INTO org.approval_requests(company_id,request_type,requester_id,target_user_id,payload,status,title,form_key,body,predecessor_id)
      VALUES($1,$2,$3,$4,$5::jsonb,'draft',$6,$7,$8::jsonb,$9) RETURNING *`, [fresh.companyId, source.request_type, fresh.userId, source.target_user_id,
      JSON.stringify(body), source.title, source.form_key, JSON.stringify(body), source.id])).rows[0];
    await history(client, fresh, created, 'draft.resubmitted'); await audit(client, req, fresh, 'approval.resubmitted', created, { predecessor_id: String(source.id) });
    return created;
  });
  res.status(201).json(view(row));
}
