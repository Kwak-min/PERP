import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
const storage = {};
Object.defineProperties(storage, {
  getItem: { value: key => Object.hasOwn(storage, key) ? storage[key] : null },
  setItem: { value: (key, value) => { storage[key] = String(value); } },
  removeItem: { value: key => { delete storage[key]; } },
});
globalThis.sessionStorage = storage;
const vite = await createServer({ configFile: false, envDir: process.env.DEADLINE_TEMP_ROOT, server: { middlewareMode: true, watch: null, hmr: false } });
after(async () => { await vite.close(); delete globalThis.sessionStorage; });
const { saveMoneyAttempt, loadMoneyAttempt, clearMoneyAttempt, clearMoneyAttempts, knownMoneyRollback } = await vite.ssrLoadModule('/frontend/src/services/money-attempts.ts');
const { incomeSchema, expenseSchema } = await vite.ssrLoadModule('/frontend/src/screens/expenses/model.ts');
const { ApiError } = await vite.ssrLoadModule('/frontend/src/services/api.ts');
test('only explicit initial rollback codes are definite; unknown structured 4xx is still uncertain', () => {
  const error = (code, status = 400) => new ApiError('test', { code, status, requestId: '', details: {} });
  assert.equal(knownMoneyRollback(error('VALIDATION_ERROR')), true);
  for (const code of ['HTTP_ERROR', 'INVALID_RESPONSE', 'UPSTREAM_UNKNOWN']) assert.equal(knownMoneyRollback(error(code)), false);
  assert.equal(knownMoneyRollback(error('VALIDATION_ERROR', 500)), false);
  assert.equal(knownMoneyRollback(new TypeError('response lost')), false);
});
const scope = { source: 'legacy', userId: 'account-1', orgId: 'space-1' };
const income = { kind: 'income', key: '8bef4a32-d363-4a24-8eba-910c94bc3faa', body: incomeSchema.parse({ amount: '100.01', currency: 'KRW', income_date: '2026-09-09', payer: 'Payer', account_id: 'revenue', memo: 'pending' }) };
const expense = { kind: 'expense', key: '8bef4a32-d363-4a24-8eba-910c94bc3fab', body: expenseSchema.parse({ amount: '40.02', currency: 'KRW', expense_date: '2026-09-09', expense_time: undefined, merchant: 'Merchant', account_id: 'expense', budget_id: null, memo: '', receipt_tokens: ['a'.repeat(43)], no_receipt_reason: '' }) };
test('canonical income and receipt expense survive per-tab storage exactly, including null optional values', () => {
  for (const attempt of [income, expense]) {
    saveMoneyAttempt(scope, attempt);
    assert.deepEqual(JSON.parse(JSON.stringify(loadMoneyAttempt(scope))), JSON.parse(JSON.stringify(attempt)));
    assert.deepEqual(JSON.parse(Object.values(storage)[0]), JSON.parse(JSON.stringify(attempt)));
    assert.throws(() => saveMoneyAttempt(scope, { ...attempt, key: crypto.randomUUID() }));
    clearMoneyAttempt(scope); assert.equal(loadMoneyAttempt(scope), null);
  }
});
test('project linkage is retained while v1 omitted fields remain omitted in persisted replay bodies', () => {
  for (const original of [income, expense]) {
    assert.equal(Object.hasOwn(original.body, 'project_id'), false);
    saveMoneyAttempt(scope, original);
    const oldRaw = Object.values(storage)[0];
    assert.equal(Object.hasOwn(loadMoneyAttempt(scope).body, 'project_id'), false);
    assert.equal(JSON.stringify(loadMoneyAttempt(scope)), oldRaw);
    clearMoneyAttempt(scope);
    for (const projectId of ['project-a', null]) {
      const schema = original.kind === 'income' ? incomeSchema : expenseSchema;
      const attempt = { ...original, body: schema.parse({ ...original.body, ...(original.kind === 'expense' ? { no_receipt_reason: original.body.no_receipt_reason ?? '' } : {}), project_id: projectId }) };
      saveMoneyAttempt(scope, attempt);
      assert.equal(loadMoneyAttempt(scope).body.project_id, projectId);
      assert.equal(JSON.stringify(loadMoneyAttempt(scope)), Object.values(storage)[0]);
      assert.throws(() => saveMoneyAttempt(scope, { ...attempt, body: { ...attempt.body, project_id: 'project-b' } }));
      clearMoneyAttempt(scope);
    }
  }
});
test('account, source and space are independent boundaries; no auth token or email is used as identity', () => {
  saveMoneyAttempt(scope, income);
  for (const changed of [{ userId: 'account-2' }, { orgId: 'space-2' }, { source: 'pg' }]) assert.equal(loadMoneyAttempt({ ...scope, ...changed }), null);
  assert.deepEqual(loadMoneyAttempt(scope), income);
  clearMoneyAttempts(); assert.deepEqual(Object.keys(storage), []);
});
test('malformed or truncated saved operations block recovery instead of becoming a new request', () => {
  saveMoneyAttempt(scope, income); const key = Object.keys(storage)[0];
  for (const value of ['{', JSON.stringify({ ...income, body: { ...income.body, extra: 'must not drop' } }), JSON.stringify({ ...income, body: { amount: '100.01' } })]) {
    storage.setItem(key, value); assert.throws(() => loadMoneyAttempt(scope)); assert.equal(storage.getItem(key), value);
  }
  clearMoneyAttempts();
});
