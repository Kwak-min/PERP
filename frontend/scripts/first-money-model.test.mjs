import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import { incomeInput } from '../../backend/src/services/income-input.service.js';
const vite = await createServer({ configFile: false, envDir: process.env.DEADLINE_TEMP_ROOT, server: { middlewareMode: true, watch: null } });
after(() => vite.close());
const { incomeSchema, incomeAccounts, ledgerRows, confirmedMoneySchema } = await vite.ssrLoadModule('/frontend/src/screens/expenses/model.ts');
test('income form submits exact strict server-compatible input without expense or project adoption', () => {
  const input = { amount: '9999999999999999.99', currency: 'KRW', income_date: '2026-09-09', payer: ' Payer ', account_id: '1', memo: '' };
  const parsed = incomeSchema.parse(input), canonical = incomeInput(parsed);
  assert.equal(canonical.amount, input.amount); assert.equal(canonical.kind, 'income'); assert.equal(canonical.counterparty, 'Payer');
  for (const patch of [{ project_id: '1' }, { receipt_tokens: [] }, { amount: '1.001' }, { income_date: '2026-02-30' }, { currency: 'USD' }]) assert.equal(incomeSchema.safeParse({ ...input, ...patch }).success, false);
  assert.deepEqual(incomeAccounts({ items: [{ value: '1', label: 'A', account_type: 'revenue' }, { value: '2', label: 'B', account_type: 'expense' }] }, true), [{ id: '1', label: 'A' }]);
});
test('balanced totals never determine direction, derived account flow does; original totals remain', () => {
  const common = { __id: '1', status: 'confirmed', 일자: '2026-09-09', 내용: null, 차변: '150.00', 대변: '150.00', counterparty: null, occurred_at: null, input_currency: null, no_receipt_reason: null };
  const rows = ledgerRows({ items: [{ ...common, kind: 'income', income_amount: '100.01', expense_amount: '0.00' }, { ...common, kind: 'journal', income_amount: '100.01', expense_amount: '49.99' }, common] }, true);
  assert.equal(rows[0].recordedAmount, '100.01');
  assert.equal(rows[1].recordedAmount, undefined); assert.equal(rows[2].recordedAmount, undefined);
  assert.ok(rows.every(row => row.amount === '150.00' && row.credit === '150.00' && row.legacy));
});
test('unknown, truncated or mismatched success cannot acknowledge a pending money request', () => {
  const expected = { amount: '100.1', account_id: '1', memo: '', counterparty: 'Payer', date: '2026-09-09' };
  const schema = confirmedMoneySchema(expected);
  const result = { id: '1', status: 'confirmed', amount: '100.10', account_id: '1', memo: '', counterparty: 'Payer', expense_date: '2026-09-09', currency: 'KRW', receipts: [] };
  assert.equal(schema.safeParse(result).success, true);
  for (const value of [null, { id: '1', status: 'confirmed' }, { ...result, amount: '100.01' }, { ...result, account_id: '2' }]) assert.equal(schema.safeParse(value).success, false);
});
