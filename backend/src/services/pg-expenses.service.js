import { pgMoneyLinks } from './project-money-links.service.js';
import { z } from 'zod';
import { pgTransaction } from '../config/pg.js';
import { pgIdentity } from '../middleware/pgAccess.js';
import { ApiError } from '../utils/errors.js';
import { recordEvent, replayPgMutation } from './pg-finance.service.js';
import { freshPgReceiptPrincipal, consumePgReceipts, pgReceiptParent } from './pg-receipt-files.service.js';

const idSchema = z.string().regex(/^[1-9]\d*$/);

// BEGIN -> 회사 lock/현재 인가 -> caller의 replay/job/domain -> 한 COMMIT.
export function withPgFinanceTransaction(req, run) {
  return pgTransaction(async client => {
    const principal = await freshPgReceiptPrincipal(client, pgIdentity(req), 'transaction');
    return run(client, principal);
  });
}

export function pgExpenseMutation(req, operation, payload, run) {
  return withPgFinanceTransaction(req, async (client, principal) => {
    if (['expense.create', 'income.create', 'transaction.create'].includes(operation)) await pgMoneyLinks(client, principal, payload, principal);
    return replayPgMutation(client, req, { operation, payload }, () => run(client, principal));
  });
}

// HTTP 호환 writer와 strict expense/후속 CSV가 공유한다. BEGIN/COMMIT은 하지 않는다.
// caller는 withPgFinanceTransaction으로 회사 lock을 replay/job보다 먼저 확보해야 한다.
export async function postPgTransaction(client, req, payload) {
  const { companyId, userId } = pgIdentity(req);
  const { projectId } = await pgMoneyLinks(client, { companyId, userId }, payload);
  const accountId = idSchema.parse(payload.account_id);
  const { rows: [account] } = await client.query(`SELECT id,account_type FROM accounting.accounts
    WHERE id=$1 AND company_id=$2 AND is_active=true AND account_type IN ('revenue','expense') FOR SHARE`, [accountId, companyId]);
  const strictAccountType = payload.kind === 'income' ? 'revenue' : 'expense';
  if (!account || (payload.input_currency && account.account_type !== strictAccountType)) throw new ApiError('VALIDATION_ERROR', payload.kind === 'income' ? '현재 회사의 활성 수입 계정을 선택하세요.' : '현재 회사의 활성 지출 계정을 선택하세요.');
  if (payload.budget_id) {
    idSchema.parse(payload.budget_id);
    const { rows: [budget] } = await client.query("SELECT id,account_id FROM accounting.budgets WHERE id=$1 AND company_id=$2 AND status='active' FOR SHARE", [payload.budget_id, companyId]);
    if (!budget || (budget.account_id !== null && String(budget.account_id) !== accountId)) throw new ApiError('VALIDATION_ERROR', '계정과 일치하는 현재 회사의 활성 예산을 선택하세요.');
  }
  const { rows: [cash] } = await client.query(`SELECT id FROM accounting.accounts WHERE company_id=$1 AND account_type='asset' AND is_active=true ORDER BY code LIMIT 1 FOR SHARE`, [companyId]);
  if (!cash) throw new ApiError('VALIDATION_ERROR', '현금(자산) 계정이 없어 거래를 만들 수 없습니다.');
  const { rows: [entry] } = await client.query(`INSERT INTO accounting.journal_entries
    (company_id,entry_date,memo,created_by,posted,counterparty,occurred_at,input_currency,no_receipt_reason,budget_id,project_id)
    VALUES($1,COALESCE($2::date,CURRENT_DATE),$3,$4,false,$5,$6,$7,$8,$9,$10) RETURNING id`,
  [companyId, payload.entry_date, payload.memo, userId, payload.counterparty ?? null, payload.occurred_at ?? null, payload.input_currency ?? null, payload.no_receipt_reason ?? null, payload.budget_id ?? null, projectId]);
  const debit = account.account_type === 'revenue' ? cash.id : account.id;
  const credit = account.account_type === 'revenue' ? account.id : cash.id;
  await client.query('INSERT INTO accounting.journal_lines(entry_id,account_id,debit,credit) VALUES($1,$2,$3,0)', [entry.id, debit, payload.amount]);
  await client.query('INSERT INTO accounting.journal_lines(entry_id,account_id,debit,credit) VALUES($1,$2,0,$3)', [entry.id, credit, payload.amount]);
  const { rows: [posted] } = await client.query('UPDATE accounting.journal_entries SET posted=true WHERE id=$1 RETURNING version,xmin::text AS receipt_version', [entry.id]);
  const receipts = payload.receipt_tokens?.length ? await consumePgReceipts(client, { companyId, userId }, {
    kind: 'transaction', parentId: entry.id, expectedVersion: posted.receipt_version, tokens: payload.receipt_tokens,
  }) : [];
  const result = { id: String(entry.id), version: posted.version, receipt_version: posted.receipt_version,
    status: 'confirmed', amount: payload.amount, currency: payload.input_currency ?? null,
    counterparty: payload.counterparty ?? null, occurred_at: payload.occurred_at ?? null,
    expense_date: payload.entry_date, no_receipt_reason: payload.no_receipt_reason ?? null,
    account_id: accountId, budget_id: payload.budget_id ?? null, project_id: projectId, memo: payload.memo, receipts };
  await recordEvent(client, req, 'transactions', entry.id, null, result);
  return result;
}

export async function appendPgExpenseReceipts(client, principal, { parentId, expectedVersion, tokens }) {
  const parent = await pgReceiptParent(client, principal, { kind: 'transaction', parentId, write: true });
  if (parent.receipt_version !== expectedVersion) throw new ApiError('VERSION_CONFLICT', '부모 기록의 버전이 변경되었습니다.');
  const receipts = await consumePgReceipts(client, principal, { kind: 'transaction', parentId, expectedVersion: parent.receipt_version, tokens });
  // 부모/lines는 그대로다. 소비기가 append-only files.receipt_events를 같은 client에 기록한다.
  return { id: String(parent.id), receipt_version: parent.receipt_version, receipts };
}
