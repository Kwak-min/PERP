import { db } from '../config/db.js';
import { resolvePrincipal } from '../middleware/auth.js';
import { getScoped, insert } from '../models/base.js';
import { ApiError } from '../utils/errors.js';
import * as audit from './audit.service.js';
import { requestKeySchema, legacyMinor } from './expense-input.service.js';
import { decimal } from './pg-finance.service.js';
import { freshReceiptPrincipal, consumeLegacyReceipts, legacyReceiptParent } from './legacy-receipt-files.service.js';

export const txView = t => ({
  id: t.id, kind: t.kind, account_id: t.account_id, counterparty_id: t.counterparty_id,
  project_id: t.project_id, budget_id: t.budget_id, amount_minor: t.amount_minor,
  amount: decimal(BigInt(t.amount_minor)), currency: t.currency, occurred_on: t.occurred_on,
  expense_date: t.occurred_on, memo: t.memo, status: t.status, approval_id: t.approval_id,
  evidence_count: t.input_currency === 'KRW' ? db().prepare(`SELECT COUNT(*) AS n FROM transaction_evidence l JOIN file_object f ON f.id=l.file_id
    AND f.tenant_id=l.tenant_id AND f.org_id=l.org_id WHERE l.transaction_id=? AND l.tenant_id=? AND l.org_id=?`).get(t.id, t.tenant_id, t.org_id).n : t.evidence_count,
  ai_generated: Boolean(t.ai_generated), version: t.version,
  counterparty: t.counterparty, occurred_at: t.occurred_at, input_currency: t.input_currency, no_receipt_reason: t.no_receipt_reason,
});

export function assertLegacyPeriodOpen(principal, date) {
  const lock = db().prepare("SELECT period FROM fiscal_period_lock WHERE tenant_id=? AND org_id=? AND period=? AND status='locked' AND deleted_at IS NULL")
    .get(principal.tenantId, principal.orgId, date.slice(0, 7));
  if (lock) throw new ApiError('PERIOD_LOCKED', '마감된 회계 기간입니다.');
}

export function withLegacyFinanceTransaction(req, run) {
  const identity = resolvePrincipal(req);
  db().exec('BEGIN IMMEDIATE');
  try {
    const principal = freshReceiptPrincipal(identity, 'transaction');
    principal.require('transaction.write');
    const result = run(principal);
    db().exec('COMMIT'); return result;
  } catch (error) { db().exec('ROLLBACK'); throw error; }
}

export function replayLegacyMutation(req, principal, { operation, payload, keyRequired = true }, run) {
  const header = req.get('Idempotency-Key');
  if (!keyRequired && header === undefined) return run();
  const key = requestKeySchema.parse(header);
  const scope = [principal.tenantId, principal.orgId, principal.userId, operation, key];
  const encoded = JSON.stringify(payload);
  const existing = db().prepare('SELECT payload,response FROM finance_request_replay WHERE tenant_id=? AND org_id=? AND actor_id=? AND operation=? AND request_key=?').get(...scope);
  if (existing) {
    if (existing.payload !== encoded) throw new ApiError('IDEMPOTENCY_CONFLICT', '같은 요청 키에 다른 내용이 사용되었습니다.');
    return JSON.parse(existing.response);
  }
  const response = run();
  db().prepare('INSERT INTO finance_request_replay(tenant_id,org_id,actor_id,operation,request_key,payload,response) VALUES(?,?,?,?,?,?,?)').run(...scope, encoded, JSON.stringify(response));
  return response;
}

// caller의 동기 write transaction 안에서만 실행한다. 후속 CSV는 row별 COMMIT을 하지 않는다.
export function writeLegacyTransaction(principal, payload, requestId) {
  if (!db().isTransaction) throw new Error('writeLegacyTransaction requires caller transaction');
  const strict = payload.input_currency === 'KRW';
  if (strict) principal.require('transaction.confirm');
  const occurredOn = payload.entry_date ?? payload.occurred_on;
  assertLegacyPeriodOpen(principal, occurredOn);
  if (payload.account_id) {
    const account = getScoped('account', principal, payload.account_id);
    if (!account.active || account.kind !== payload.kind) throw new ApiError('VALIDATION_ERROR', '현재 회사의 활성 거래 계정을 선택하세요.');
  }
  for (const [field, table] of [['project_id', 'project'], ['counterparty_id', 'counterparty']]) if (payload[field]) getScoped(table, principal, payload[field]);
  const amountMinor = strict ? legacyMinor(payload.amount) : payload.amount_minor;
  if (payload.budget_id) {
    const budget = getScoped('budget', principal, payload.budget_id);
    if (budget.status !== 'approved' || (budget.account_id && budget.account_id !== payload.account_id)) throw new ApiError('VALIDATION_ERROR', '계정과 일치하는 현재 회사의 승인 예산을 선택하세요.');
    if (strict && budget.over_policy === 'block') {
      const statement = db().prepare("SELECT amount_minor FROM transaction_record WHERE tenant_id=? AND org_id=? AND budget_id=? AND kind='expense' AND status='confirmed' AND deleted_at IS NULL");
      statement.setReadBigInts(true);
      const spent = statement.all(principal.tenantId, principal.orgId, budget.id).reduce((sum, row) => sum + row.amount_minor, 0n);
      if (spent + BigInt(amountMinor) > BigInt(budget.amount_minor)) throw new ApiError('CONFLICT', '예산 한도를 초과했습니다.');
    }
  }
  const dedupe = `${payload.kind}:${amountMinor}:${occurredOn}:${payload.memo}`;
  const duplicate = db().prepare('SELECT id FROM transaction_record WHERE tenant_id=? AND org_id=? AND dedupe_key=? AND deleted_at IS NULL LIMIT 1').get(principal.tenantId, principal.orgId, dedupe);
  const tx = insert('transaction_record', {
    tenant_id: principal.tenantId, org_id: principal.orgId, kind: payload.kind,
    amount_minor: amountMinor, occurred_on: occurredOn, account_id: payload.account_id ?? null,
    counterparty_id: payload.counterparty_id ?? null, project_id: payload.project_id ?? null, budget_id: payload.budget_id ?? null,
    memo: payload.memo, dedupe_key: dedupe, created_by: principal.userId, status: strict ? 'confirmed' : 'draft',
    counterparty: payload.counterparty ?? null, occurred_at: payload.occurred_at ?? null,
    input_currency: payload.input_currency ?? null, no_receipt_reason: payload.no_receipt_reason ?? null,
    evidence_count: payload.receipt_tokens?.length ?? 0,
  });
  const receipts = payload.receipt_tokens?.length ? consumeLegacyReceipts(principal, { kind: 'transaction', parentId: tx.id, expectedVersion: tx.version, tokens: payload.receipt_tokens }) : [];
  const result = { ...txView(tx), receipts, duplicate_warning: duplicate ? { id: duplicate.id } : null };
  audit.record({ tenantId: principal.tenantId, actorId: principal.userId, action: strict ? 'transaction.confirmed' : 'transaction.created', resourceType: 'transaction', resourceId: tx.id, after: result, requestId });
  return result;
}

export function appendLegacyExpenseReceipts(principal, { parentId, expectedVersion, tokens }) {
  const parent = legacyReceiptParent(principal, { kind: 'transaction', parentId, write: true });
  const receipts = consumeLegacyReceipts(principal, { kind: 'transaction', parentId, expectedVersion, tokens });
  return { id: parent.id, version: parent.version, receipts };
}
