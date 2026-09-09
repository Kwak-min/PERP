import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOwnerOrg } from '../../backend/tests/http.js';

export async function expenseFixture({ base, native, pg, http }) {
  const prefix = pg ? '/pg' : '';
  async function request(actor, route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + '/api/v1' + prefix + route, { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const payload = await response.json();
    http.push({ route: prefix + route, method, status: response.status });
    assert.ok(response.ok, JSON.stringify(payload)); return payload;
  }
  async function company(name) {
    if (!pg) return createOwnerOrg(base + '/api/v1', ['finance']);
    const signup = await request(null, '/auth/signup', { name, email: `${name}-${randomUUID()}@example.invalid`, password: 'password-1234' });
    const actor = { token: signup.token, userId: signup.user.id };
    const company = await request(actor, '/companies', { name, modules: ['finance'] });
    actor.orgId = company.org_id; return actor;
  }
  const actor = await company('expense-a'), foreign = await company('expense-b');
  let expense, income, inactive;
  if (pg) {
    const accounts = (await native.pool.query(`INSERT INTO accounting.accounts(company_id,code,name,account_type,is_active) VALUES
      ($1,'EXP','수입이라는 이름의 실제 비용 계정','expense',true),($1,'REV','지출이라는 이름의 실제 수익 계정','revenue',true),
      ($1,'OLD','비활성 비용 계정','expense',false),($1,'CASH','Cash','asset',true) RETURNING id,code`, [actor.orgId.slice(3)])).rows;
    expense = accounts.find(row => row.code === 'EXP').id; income = accounts.find(row => row.code === 'REV').id; inactive = accounts.find(row => row.code === 'OLD').id;
  } else {
    expense = (await request(actor, '/finance/accounts', { code: 'EXP', name: '수입이라는 이름의 실제 비용 계정', kind: 'expense' })).id;
    income = (await request(actor, '/finance/accounts', { code: 'REV', name: '지출이라는 이름의 실제 수익 계정', kind: 'income' })).id;
    inactive = (await request(actor, '/finance/accounts', { code: 'OLD', name: '비활성 비용 계정', kind: 'expense' })).id;
    const { db } = await import('../../backend/src/config/db.js'); db().prepare('UPDATE account SET active=0 WHERE id=?').run(inactive);
  }
  const oldIncome = await request(actor, '/finance/transactions', pg ? { account_id: income, amount: '123.45', entry_date: '2020-01-01', memo: 'OLD_INCOME_BOUNDARY' } : { kind: 'income', account_id: income, amount_minor: 12345, occurred_on: '2020-01-01', memo: 'OLD_INCOME_BOUNDARY' });
  if (!pg) await request(actor, `/finance/transactions/${oldIncome.id}/confirm`, {});
  for (let index = 0; index < 102; index++) await request(actor, '/finance/transactions', pg ? { account_id: expense, amount: '1.01', entry_date: '2026-09-08', memo: `HISTORY_${index}` } : { kind: 'expense', account_id: expense, amount_minor: 101, occurred_on: '2026-09-08', memo: `HISTORY_${index}` });
  const defaultList = await request(actor, '/finance/transactions');
  if (!pg) { assert.equal(defaultList.items.length, 100); assert.equal(defaultList.items.some(row => row.id === oldIncome.id), false); }
  const allList = await request(actor, '/finance/transactions' + (pg ? '' : '?limit=-1'));
  assert.equal(allList.items.length, 103);
  assert.ok(allList.items.some(row => String(row.id ?? row.__id) === oldIncome.id));
  return { actor, foreign, expense, income, inactive, oldIncome, request, prefix, pg, initialCount: 103 };
}
