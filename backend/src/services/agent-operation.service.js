import { z } from 'zod';
import { db, transaction } from '../config/db.js';
import { pgTransaction } from '../config/pg.js';
import { newId, nowIso, bumpVersion } from '../models/base.js';
import { ApiError, notFound } from '../utils/errors.js';
import { sha256, verifyPassword } from '../utils/crypto.js';
import { freshLegacyAgent, freshPgAgent, authorizeCapability, parseInput } from './agent-capabilities.service.js';
import { writeLegacyAgent, writePgAgent, afterAgentWrite, validateLegacyAgentReferences, validatePgAgentReferences } from './agent-domain-writes.service.js';
import { createApproval, approvalById, assertLegacyApprovers, recordApprovalHistory } from './approval.service.js';
import { legacyRoleGrants } from './company-roles.service.js';
import * as audit from './audit.service.js';

const id = z.string().min(1).max(200);
const version = z.number().int().positive().safe();
const proposalSchema = z.object({ run_id: id, tool_call_id: id, conversation_id: id, tool: id, input: z.unknown() }).strict();
const confirmSchema = z.object({ expected_version: version, approver_id: id.optional() }).strict();
const executeSchema = z.object({ expected_version: version, reauth_password: z.string().min(1).max(1000).optional() }).strict();
const cancelSchema = z.object({ expected_version: version }).strict();
const filtersSchema = z.object({ conversation_id: id.optional(), run_id: id.optional() }).strict();
const parse = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError('VALIDATION_ERROR', '작업 요청 형식이 올바르지 않습니다.');
  return result.data;
};
const decoded = value => typeof value === 'string' ? JSON.parse(value) : value;
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const stale = (row, expected) => { if (row.version !== expected) throw new ApiError('VERSION_CONFLICT', '작업이 변경되었습니다. 최신 내용을 확인하세요.'); };
const scope = p => [p.tenantId, p.orgId, p.userId];

function view(source, p, row, approval = null) {
  const cap = authorizeCapability(source, p, row.tool, 'execute');
  const input = decoded(row.input_json);
  return {
    id: row.id, tool: row.tool, version: row.version, status: row.status,
    preview: { title: input.title ?? (row.tool === 'update.task_status' ? '업무 상태 변경' : '거래 확정'),
      fields: Object.entries(input).map(([label, value]) => ({ label, value: typeof value === 'string' ? value : JSON.stringify(value) })),
      warnings: cap.requires_approval ? ['선택한 결재자의 승인과 본인 재인증 후 실행합니다.'] : [] },
    requires_confirmation: true, requires_approval: cap.requires_approval, requires_reauth: cap.requires_reauth,
    approval_id: row.approval_id ?? null, approval_status: approval?.status ?? null,
    can_confirm: row.status === 'preview',
    can_execute: row.status === 'confirmed' && (!cap.requires_approval || approval?.status === 'approved'),
    can_cancel: ['preview', 'confirmed'].includes(row.status),
    result: row.result_json == null ? null : decoded(row.result_json),
    classification: 'confidential',
    provider_receipt: { kind: 'operation_preview', tool: row.tool, id: row.id, status: row.status,
      requires_confirmation: true, requires_approval: cap.requires_approval, requires_reauth: cap.requires_reauth },
  };
}
function legacyRow(p, operationId) {
  const row = db().prepare('SELECT * FROM agent_operations WHERE id=? AND tenant_id=? AND org_id=? AND actor_id=? AND knowledge_mode=?').get(parse(id, operationId), ...scope(p), p.knowledgeMode);
  if (!row) throw notFound('operation');
  authorizeCapability('legacy', p, row.tool, 'execute');
  return row;
}
function legacyView(p, row) { return view('legacy', p, row, row.approval_id ? approvalById(p, row.approval_id) : null); }
async function pgRow(client, p, operationId) {
  const row = (await client.query('SELECT * FROM public.agent_operations WHERE id=$1 AND company_id=$2 AND actor_id=$3 AND knowledge_mode=$4 FOR UPDATE', [parse(id, operationId), p.companyId, p.userId, p.knowledgeMode])).rows[0];
  if (!row) throw notFound('operation');
  authorizeCapability('pg', p, row.tool, 'execute');
  return row;
}
function reauth(p, password) {
  const user = db().prepare('SELECT password_hash FROM app_user WHERE id=? AND auth_status=?').get(p.userId, 'active');
  if (!password || !verifyPassword(password, user?.password_hash)) throw new ApiError('REAUTH_REQUIRED', '비밀번호로 본인 확인이 필요합니다.');
}
function approvers(p) {
  return db().prepare(`SELECT u.id,u.name,m.roles FROM membership m JOIN app_user u ON u.id=m.user_id
    WHERE m.tenant_id=? AND m.org_id=? AND m.status='active' AND m.deleted_at IS NULL AND u.auth_status='active'
    ORDER BY u.name,u.id`).all(p.tenantId, p.orgId).filter(row => {
    const { permissions } = legacyRoleGrants(p, (row.roles ?? '').split(',').filter(Boolean));
    return permissions.has('*') || (permissions.has('approval.decide') && permissions.has('menu.approvals'));
  }).map(({ id, name }) => ({ id, name, display_name: name }));
}
function executionReplay(row, expected, key) {
  if (row.status !== 'executed') return false;
  if (row.execution_key !== key || row.execution_version !== expected) throw new ApiError('CONFLICT', '이미 다른 실행 요청으로 처리된 작업입니다.');
  return true;
}
const receipt = row => Object.fromEntries(Object.entries(row).filter(([key]) => !['tenant_id', 'org_id', 'company_id', 'created_by', 'updated_by'].includes(key)));

export async function propose(context, raw) {
  const payload = parse(proposalSchema, raw);
  const input = parseInput(context.source, payload.tool, payload.input);
  const hash = sha256(canonical({ tool: payload.tool, input, knowledge_mode: context.knowledgeMode }));
  if (context.source === 'legacy') return transaction(() => {
    const p = freshLegacyAgent(context); authorizeCapability('legacy', p, payload.tool, 'execute');
    const run = db().prepare('SELECT * FROM agent_runs WHERE id=? AND tenant_id=? AND org_id=? AND actor_id=? AND conversation_id=? AND knowledge_mode=?')
      .get(payload.run_id, ...scope(p), payload.conversation_id, p.knowledgeMode);
    if (!run) throw notFound('run');
    const existing = db().prepare('SELECT * FROM agent_operations WHERE tenant_id=? AND org_id=? AND actor_id=? AND run_id=? AND tool_call_id=?')
      .get(...scope(p), payload.run_id, payload.tool_call_id);
    if (existing) {
      if (existing.input_hash !== hash || existing.conversation_id !== payload.conversation_id) throw new ApiError('CONFLICT', '같은 도구 호출의 입력이 변경되었습니다.');
      return legacyView(p, existing);
    }
    if (run.status !== 'running') throw new ApiError('CONFLICT', '진행 중인 실행에만 제안할 수 있습니다.');
    validateLegacyAgentReferences(p, payload.tool, input);
    const operationId = newId(), now = nowIso();
    db().prepare(`INSERT INTO agent_operations(id,tenant_id,org_id,actor_id,run_id,tool_call_id,conversation_id,tool,input_json,input_hash,status,created_at,updated_at,knowledge_mode)
      VALUES(?,?,?,?,?,?,?,?,?,?,'preview',?,?,?)`).run(operationId, ...scope(p), payload.run_id, payload.tool_call_id, payload.conversation_id, payload.tool, JSON.stringify(input), hash, now, now, p.knowledgeMode);
    return legacyView(p, legacyRow(p, operationId));
  })();
  return pgTransaction(async client => {
    const p = await freshPgAgent(context, client); authorizeCapability('pg', p, payload.tool, 'execute');
    const run = (await client.query('SELECT * FROM public.agent_runs WHERE id=$1 AND company_id=$2 AND actor_id=$3 AND conversation_id=$4 AND knowledge_mode=$5 FOR UPDATE',
      [payload.run_id, p.companyId, p.userId, payload.conversation_id, p.knowledgeMode])).rows[0];
    if (!run) throw notFound('run');
    const existing = (await client.query('SELECT * FROM public.agent_operations WHERE company_id=$1 AND actor_id=$2 AND run_id=$3 AND tool_call_id=$4',
      [p.companyId, p.userId, payload.run_id, payload.tool_call_id])).rows[0];
    if (existing) {
      if (existing.input_hash !== hash || existing.conversation_id !== payload.conversation_id) throw new ApiError('CONFLICT', '같은 도구 호출의 입력이 변경되었습니다.');
      return view('pg', p, existing);
    }
    if (run.status !== 'running') throw new ApiError('CONFLICT', '진행 중인 실행에만 제안할 수 있습니다.');
    await validatePgAgentReferences(client, p, payload.tool, input);
    const row = (await client.query(`INSERT INTO public.agent_operations(id,company_id,actor_id,run_id,tool_call_id,conversation_id,tool,input_json,input_hash,status,knowledge_mode)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'preview',$10) RETURNING *`,
    [newId(), p.companyId, p.userId, payload.run_id, payload.tool_call_id, payload.conversation_id, payload.tool, JSON.stringify(input), hash, p.knowledgeMode])).rows[0];
    return view('pg', p, row);
  });
}

export async function getOperation(context, operationId) {
  if (context.source === 'legacy') { const p = freshLegacyAgent(context); return legacyView(p, legacyRow(p, operationId)); }
  return pgTransaction(async client => { const p = await freshPgAgent(context, client); return view('pg', p, await pgRow(client, p, operationId)); });
}

export async function listOperations(context, raw = {}) {
  const filters = parse(filtersSchema, raw);
  if (context.source === 'legacy') {
    const p = freshLegacyAgent(context);
    return db().prepare(`SELECT * FROM agent_operations WHERE tenant_id=? AND org_id=? AND actor_id=? AND knowledge_mode=?
      ${filters.conversation_id ? 'AND conversation_id=?' : ''} ${filters.run_id ? 'AND run_id=?' : ''} ORDER BY created_at,id LIMIT 100`)
      .all(...scope(p), p.knowledgeMode, ...(filters.conversation_id ? [filters.conversation_id] : []), ...(filters.run_id ? [filters.run_id] : []))
      .map(row => legacyView(p, row));
  }
  return pgTransaction(async client => {
    const p = await freshPgAgent(context, client), params = [p.companyId, p.userId, p.knowledgeMode];
    const rows = (await client.query(`SELECT * FROM public.agent_operations WHERE company_id=$1 AND actor_id=$2 AND knowledge_mode=$3
      ${filters.conversation_id ? `AND conversation_id=$${params.push(filters.conversation_id)}` : ''}
      ${filters.run_id ? `AND run_id=$${params.push(filters.run_id)}` : ''} ORDER BY created_at,id LIMIT 100`, params)).rows;
    return rows.map(row => view('pg', p, row));
  });
}

export async function listOperationApprovers(context, operationId) {
  if (context.source === 'legacy') {
    const p = freshLegacyAgent(context), row = legacyRow(p, operationId);
    return row.tool === 'confirm.transaction' ? approvers(p) : [];
  }
  await getOperation(context, operationId); return [];
}

export async function confirmOperation(context, operationId, raw) {
  const input = parse(confirmSchema, raw);
  if (context.source === 'legacy') return transaction(() => {
    const p = freshLegacyAgent(context), row = legacyRow(p, operationId);
    stale(row, input.expected_version);
    if (row.status !== 'preview') throw new ApiError('CONFLICT', '미리보기 상태에서만 확인할 수 있습니다.');
    validateLegacyAgentReferences(p, row.tool, decoded(row.input_json));
    const cap = authorizeCapability('legacy', p, row.tool, 'execute');
    let approvalId = null;
    if (cap.requires_approval) {
      if (!input.approver_id || !approvers(p).some(person => person.id === input.approver_id)) throw new ApiError('VALIDATION_ERROR', '현재 결재 권한이 있는 결재자를 선택하세요.');
      assertLegacyApprovers(p, [{ approver_id: input.approver_id }]);
      const target = decoded(row.input_json);
      const tx = db().prepare('SELECT * FROM transaction_record WHERE id=? AND tenant_id=? AND org_id=? AND deleted_at IS NULL')
        .get(target.transaction_id, p.tenantId, p.orgId);
      if (!tx || (p.scope !== 'all' && tx.created_by !== p.userId)) throw notFound('transaction');
      stale(tx, target.expected_version);
      const approval = createApproval(p, { title: `AI 거래 확정: ${tx.memo || tx.id}`, steps: [{ approver_id: input.approver_id }],
        subjectType: 'transaction_record', subjectId: tx.id, amount: tx.amount_minor,
        payload: { operation_id: row.id, input_hash: row.input_hash, transaction_id: tx.id, expected_version: target.expected_version } });
      approvalId = approval.id;
    } else if (input.approver_id) throw new ApiError('VALIDATION_ERROR', '이 작업에는 결재자를 지정하지 않습니다.');
    db().prepare("UPDATE agent_operations SET status='confirmed',version=version+1,approval_id=?,updated_at=? WHERE id=? AND version=?")
      .run(approvalId, nowIso(), row.id, row.version);
    return legacyView(p, legacyRow(p, row.id));
  })();
  return pgTransaction(async client => {
    const p = await freshPgAgent(context, client), row = await pgRow(client, p, operationId);
    stale(row, input.expected_version);
    if (row.status !== 'preview') throw new ApiError('CONFLICT', '미리보기 상태에서만 확인할 수 있습니다.');
    await validatePgAgentReferences(client, p, row.tool, decoded(row.input_json));
    if (input.approver_id) throw new ApiError('VALIDATION_ERROR', '이 작업에는 결재자를 지정하지 않습니다.');
    const updated = (await client.query("UPDATE public.agent_operations SET status='confirmed',version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING *", [row.id, row.version])).rows[0];
    return view('pg', p, updated);
  });
}

export async function executeOperation(context, operationId, raw, idempotencyKey) {
  const input = parse(executeSchema, raw), key = parse(id, idempotencyKey);
  let effect;
  let result;
  if (context.source === 'legacy') result = transaction(() => {
    const p = freshLegacyAgent(context), row = legacyRow(p, operationId);
    if (executionReplay(row, input.expected_version, key)) return legacyView(p, row);
    stale(row, input.expected_version);
    if (row.status !== 'confirmed') throw new ApiError('CONFLICT', '사람의 확인 후에만 실행할 수 있습니다.');
    const cap = authorizeCapability('legacy', p, row.tool, 'execute');
    if (cap.requires_reauth) reauth(p, input.reauth_password);
    if (cap.requires_approval) {
      const approval = approvalById(p, row.approval_id);
      const binding = approval ? decoded(approval.payload) : null;
      if (!approval || approval.status !== 'approved' || approval.requester_id !== p.userId || binding?.operation_id !== row.id || binding?.input_hash !== row.input_hash) {
        throw new ApiError('APPROVAL_REQUIRED', '이 작업에 연결된 승인이 필요합니다.');
      }
    }
    const output = writeLegacyAgent(p, row.tool, parseInput('legacy', row.tool, decoded(row.input_json)), context.request.requestId, row.approval_id);
    db().prepare("UPDATE agent_operations SET status='executed',version=version+1,execution_key=?,execution_version=?,result_json=?,updated_at=? WHERE id=? AND version=?")
      .run(key, row.version, JSON.stringify(receipt(output)), nowIso(), row.id, row.version);
    effect = { p, tool: row.tool, output };
    return legacyView(p, legacyRow(p, row.id));
  })();
  else result = await pgTransaction(async client => {
    const p = await freshPgAgent(context, client), row = await pgRow(client, p, operationId);
    if (executionReplay(row, input.expected_version, key)) return view('pg', p, row);
    stale(row, input.expected_version);
    if (row.status !== 'confirmed') throw new ApiError('CONFLICT', '사람의 확인 후에만 실행할 수 있습니다.');
    const output = await writePgAgent(client, p, row.tool, parseInput('pg', row.tool, decoded(row.input_json)));
    const updated = (await client.query(`UPDATE public.agent_operations SET status='executed',version=version+1,execution_key=$2,execution_version=$3,result_json=$4::jsonb,updated_at=now()
      WHERE id=$1 AND version=$3 RETURNING *`, [row.id, key, row.version, JSON.stringify(receipt(output))])).rows[0];
    effect = { p, tool: row.tool, output }; return view('pg', p, updated);
  });
  if (effect) afterAgentWrite(context.source, effect.p, effect.tool, effect.output);
  return result;
}

export async function cancelOperation(context, operationId, raw) {
  const input = parse(cancelSchema, raw);
  if (context.source === 'legacy') return transaction(() => {
    const p = freshLegacyAgent(context), row = legacyRow(p, operationId);
    stale(row, input.expected_version);
    if (!['preview', 'confirmed'].includes(row.status)) throw new ApiError('CONFLICT', '취소할 수 없는 작업입니다.');
    if (row.approval_id) {
      const approval = approvalById(p, row.approval_id);
      if (approval?.status === 'pending') {
        const updated = bumpVersion('approval', approval, { status: 'withdrawn', withdrawn_at: nowIso() }, p.userId);
        recordApprovalHistory(p, updated, 'withdrawn');
        audit.record({ tenantId: p.tenantId, actorId: p.userId, action: 'approval.withdrawn', resourceType: 'approval',
          resourceId: approval.id, requestId: context.request.requestId, after: { version: updated.version } });
      }
    }
    db().prepare("UPDATE agent_operations SET status='cancelled',version=version+1,updated_at=? WHERE id=? AND version=?").run(nowIso(), row.id, row.version);
    return legacyView(p, legacyRow(p, row.id));
  })();
  return pgTransaction(async client => {
    const p = await freshPgAgent(context, client), row = await pgRow(client, p, operationId);
    stale(row, input.expected_version);
    if (!['preview', 'confirmed'].includes(row.status)) throw new ApiError('CONFLICT', '취소할 수 없는 작업입니다.');
    const updated = (await client.query("UPDATE public.agent_operations SET status='cancelled',version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING *", [row.id, row.version])).rows[0];
    return view('pg', p, updated);
  });
}
