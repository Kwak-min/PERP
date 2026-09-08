import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import { expenseInput } from '../../backend/src/services/expense-input.service.js';
const vite = await createServer({ configFile: false, envDir: process.env.DEADLINE_TEMP_ROOT, server: { middlewareMode: true, watch: null } });
after(() => vite.close());
const { expenseSchema, expenseAccounts, ledgerRows, detailSchema } = await vite.ssrLoadModule('/frontend/src/screens/expenses/model.ts');
const draft = { amount: '9999999999999999.99', currency: 'KRW', expense_date: '2026-09-08', expense_time: '12:34:56', merchant: '사용처', account_id: '42', budget_id: null, memo: '', receipt_tokens: ['a'.repeat(43)], no_receipt_reason: '' };
test('exact large amount and empty optional reason produce a strict server-compatible expense', () => {
  const parsed = expenseSchema.parse(draft);
  assert.equal(parsed.amount, draft.amount); assert.equal(parsed.no_receipt_reason, null);
  const server = expenseInput(parsed); assert.equal(server.amount, draft.amount); assert.equal(server.occurred_at, '2026-09-08T03:34:56.000Z');
});
test('receipt-free input requires a reason and optional time does not infer midnight', () => {
  const body = expenseSchema.parse({ ...draft, receipt_tokens: [], no_receipt_reason: ' 분실 ', expense_time: undefined });
  assert.equal(expenseInput(body).occurred_at, null); assert.equal(body.no_receipt_reason, '분실');
  assert.equal(expenseSchema.safeParse({ ...draft, receipt_tokens: [] }).success, false);
});
for (const patch of [{ amount: 1 }, { amount: '0' }, { amount: '-1' }, { amount: '1e2' }, { amount: '1.001' }, { amount: '10000000000000000' }, { expense_date: '2026-02-29' }, { expense_date: '0000-01-01' }, { expense_time: '24:00' }, { merchant: ' ' }, { currency: 'USD' }, { account_id: '' }]) {
  test(`invalid input is rejected without mutating draft ${JSON.stringify(patch)}`, () => { const input = { ...draft, ...patch }, before = structuredClone(input); assert.equal(expenseSchema.safeParse(input).success, false); assert.deepEqual(input, before); });
}
test('account direction is machine type, never translated label text', () => {
  assert.deepEqual(expenseAccounts({ items: [{ value: '1', label: '수입', account_type: 'expense' }, { value: '2', label: '지출', account_type: 'revenue' }] }, true), [{ id: '1', label: '수입' }]);
  assert.deepEqual(expenseAccounts({ items: [{ id: '1', code: 'A', name: '수입', kind: 'expense' }, { id: '2', code: 'B', name: '지출', kind: 'income' }] }, false), [{ id: '1', label: 'A 수입' }]);
});
test('old income, draft and posted rows retain exact amounts and null metadata', () => {
  const metadata = { counterparty: null, occurred_at: null, input_currency: null, no_receipt_reason: null };
  const rows = ledgerRows({ items: ['draft', 'confirmed'].map((status, i) => ({ id: String(i), kind: 'income', status, expense_date: '2020-01-01', memo: 'old', amount: '90071992547409.91', currency: 'USD', ...metadata })) }, false);
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.kind === '수입' && row.amount === '90071992547409.91' && row.currency === 'USD' && row.legacy && row.merchant === null));
});
test('detail retains actual inactive account IDs, multiple lines and receipt-version token', () => {
  const row = detailSchema.parse({ id: '42', status: 'confirmed', amount: '9999999999999999.99', expense_date: '2026-09-08', memo: null, account_id: null, budget_id: null, version: 1, receipt_version: '785', counterparty: null, occurred_at: null, input_currency: null, no_receipt_reason: null, receipts: [], lines: [{ id: '9', account_id: 'inactive', account_type: 'expense', debit: '9999999999999999.99', credit: '0.00' }] });
  assert.equal(row.account_id, null); assert.equal(row.lines[0].account_id, 'inactive'); assert.equal(row.receipt_version, '785');
});
test('home totals sum exact confirmed rows without merging historical currencies or drafts', async () => {
  const { legacyTotals } = await vite.ssrLoadModule('/frontend/src/screens/expenses/FinanceOverview.tsx');
  const row = { id: '1', status: 'confirmed', date: '2026-09-08', memo: '', amount: '90071992547409.91', credit: null, kind: '지출', currency: 'KRW', merchant: null, legacy: true };
  const totals = legacyTotals([row, { ...row, id: '2' }, { ...row, id: '3', kind: '수입', amount: '100.01' }, { ...row, id: '4', currency: 'USD', kind: '수입', amount: '123.45' }, { ...row, id: '5', status: 'draft' }]);
  assert.deepEqual(totals, [{ currency: 'KRW', income: '100.01', expense: '180143985094819.82', balance: '-180143985094719.81' }, { currency: 'USD', income: '123.45', expense: '0.00', balance: '123.45' }]);
});
