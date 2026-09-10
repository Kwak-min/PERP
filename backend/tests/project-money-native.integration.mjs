import assert from 'node:assert/strict';
import { projectMoneyV1Replay } from './project-money-v1-replay.js';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { startDailyNativePostgres } from './daily-native-fixture.js';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
const evidence = new URL('../../.omo/project-money/', import.meta.url);
await mkdir(evidence, { recursive: true });
const native = await startDailyNativePostgres();
const events = new EventEmitter(), cases = [];
let server, closeDb, closePgPool, passed = false;
try {
  const ddl = await readFile(new URL('../../db/perp_additions_v21_project_money.sql', import.meta.url), 'utf8');
  await native.pool.query(ddl); await native.pool.query(ddl);
  const pg = await import('../src/config/pg.js'); closePgPool = pg.closePgPool;
  pg.pgPool.on('connect', client => {
    const query = client.query.bind(client);
    client.query = (text, ...args) => { const result = query(text, ...args); if (text === 'SELECT id FROM org.companies WHERE id=$1 FOR UPDATE') events.emit('company-lock'); return result; };
  });
  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/config/migrate.js');
  ({ closeDb } = await import('../src/config/db.js')); migrate();
  const app = createApp();
  server = createServer((req, res) => { if (req.headers['x-test-drop'] === 'yes') res.end = () => { res.destroy(); events.emit('dropped'); return res; }; app(req, res); });
  const ready = once(server, 'listening', { signal: AbortSignal.timeout(10000) }); server.listen(0, '127.0.0.1'); await ready;
  const base = `http://127.0.0.1:${server.address().port}/api/v1/pg`;
  const call = async (actor, route, body, status = 200, key = randomUUID(), extra = {}) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key,
      ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const data = await response.json(); assert.equal(response.status, status, `${route}: ${JSON.stringify(data)}`); return data;
  };
  async function company(name) {
    const signup = await call(null, '/auth/signup', { name, email: `${name}@example.invalid`, password: 'password-1234' }, 201);
    const actor = { token: signup.token, userId: signup.user.id };
    actor.orgId = (await call(actor, '/companies', { name, modules: ['projects', 'tasks', 'finance'] }, 201)).org_id;
    actor.companyId = actor.orgId.slice(3); return actor;
  }
  const actor = await company('money-native'), foreign = await company('money-foreign');
  const project = await call(actor, '/projects', { name: '프로젝트 재무' }, 201), other = await call(actor, '/projects', { name: '다른 프로젝트' }, 201);
  const foreignProject = await call(foreign, '/projects', { name: '외부 프로젝트' }, 201);
  const root = `/projects/${project.id}/money`;
  assert.deepEqual((await call(actor, root)).totals, []);
  const accounts = (await native.pool.query(`INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,'CASH','현금','asset'),($1,'EXP','비용','expense'),($1,'REV','수익','revenue') RETURNING id,account_type`, [actor.companyId])).rows;
  const account = accounts.find(row => row.account_type === 'expense').id, revenue = accounts.find(row => row.account_type === 'revenue').id;
  const foreignAccount = (await native.pool.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,'EXP','외부','expense') RETURNING id", [foreign.companyId])).rows[0].id;
  const budgetBody = { name: '연결 예산', amount: '1000.01', currency: 'KRW', account_id: account };
  const key = randomUUID(), budget = await call(actor, root + '/budgets', budgetBody, 201, key);
  assert.deepEqual(await call(actor, root + '/budgets', budgetBody, 201, key), budget);
  await call(actor, root + '/budgets', { ...budgetBody, amount: '1000.02' }, 409, key);
  await call(actor, root + '/budgets', { ...budgetBody, account_id: foreignAccount }, 400);
  const extra = await call(actor, root + '/budgets', { name: '소액', amount: '0.09', currency: 'KRW' }, 201);
  const expense = { budget_id: budget.id, amount: '100.01', expense_date: '2026-09-09', merchant: '실제 사용', account_id: account, no_receipt_reason: '미발급' };
  const expenseKey = randomUUID();
  const posted = await call(actor, '/finance/expenses', expense, 201, expenseKey);
  assert.equal(posted.project_id, project.id);
  const raced = await Promise.all([call(actor, '/finance/expenses', expense, 201, expenseKey), call(actor, '/finance/expenses', expense, 201, expenseKey)]);
  assert.deepEqual(raced, [posted, posted]);
  const foreignBudget = await call(foreign, `/projects/${foreignProject.id}/money/budgets`, { name: '외부', amount: '10', currency: 'KRW' }, 201);
  await call(actor, '/finance/expenses', { ...expense, project_id: other.id }, 400);
  await call(actor, '/finance/expenses', { ...expense, project_id: foreignProject.id }, 404);
  await call(actor, '/finance/expenses', { ...expense, budget_id: foreignBudget.id }, 400);
  await call(foreign, root, undefined, 404);
  await call(actor, '/finance/expenses', { ...expense, budget_id: null, amount: '999.99' }, 201);
  await native.pool.query('UPDATE accounting.budgets SET spent=777777.77 WHERE id=$1', [budget.id]);
  let summary = await call(actor, root);
  assert.deepEqual(summary.totals, [{ unit: 'KRW', allocated: '1000.10', spending: '100.01', remaining: '900.09', income: null, net: null }]);
  assert.equal(summary.budgets.find(row => row.id === extra.id).remaining, '0.09');
  assert.equal(summary.entries[0].income, '0.00');
  assert.equal(summary.entries[0].expense, '100.01');
  cases.push('native writes and reload summary: multiple budgets, posted only, exact cents, stale spent ignored, unlinked excluded');
  const strictIncome = { amount: '200.02', currency: 'KRW', income_date: '2026-09-09', payer: '프로젝트 수입', project_id: project.id, account_id: revenue, memo: '' };
  const incomeKey = randomUUID(), received = await call(actor, '/finance/incomes', strictIncome, 201, incomeKey);
  assert.equal(received.project_id, project.id); assert.equal(received.budget_id, null);
  assert.deepEqual(await call(actor, '/finance/incomes', strictIncome, 201, incomeKey), received);
  await call(actor, '/finance/incomes', { ...strictIncome, amount: '200.03' }, 409, incomeKey);
  await call(actor, '/finance/incomes', { ...strictIncome, project_id: foreignProject.id }, 404);
  await call(actor, '/finance/incomes', { ...strictIncome, budget_id: budget.id }, 400);
  await call(actor, '/finance/incomes', { ...strictIncome, project_id: null, amount: '999.99' }, 201);
  const both = (await call(actor, root)).totals[0];
  assert.equal(both.income, '200.02'); assert.equal(both.net, '100.01'); assert.equal(both.spending, '100.01'); assert.equal(both.remaining, '900.09');
  cases.push('new income API writes independent project attribution without an expense budget; exact income/net, unlinked exclusion, replay and foreign rejection');
  // 과거 호환 API의 수입도 명시 project_id로만 연결된다. 미지정 통화는 KRW와 합산하지 않는다.
  const income = await call(actor, '/finance/transactions', { account_id: revenue, project_id: project.id, amount: '200.02', entry_date: '2026-09-09' }, 201);
  assert.equal(income.project_id, project.id);
  summary = await call(actor, root);
  assert.equal(summary.totals.find(row => row.unit === 'ledger_decimal').income, '200.02');
  assert.equal(summary.totals.find(row => row.unit === 'KRW').income, '200.02');
  assert.equal(summary.totals.find(row => row.unit === 'KRW').remaining, '900.09');
  const large = await call(actor, root + '/budgets', { name: '큰 금액', amount: '900719925474099.91', currency: 'KRW' }, 201);
  assert.equal((await call(actor, root)).totals.find(row => row.unit === 'KRW').allocated, '900719925475100.01');
  assert.equal(large.project_id, project.id);
  cases.push('linked revenue distinct from expense; original unspecified currency remains separate; large exact decimal sum');
  const beforeEntry = (await native.pool.query('SELECT to_jsonb(e) AS row FROM accounting.journal_entries e WHERE id=$1', [posted.id])).rows[0];
  await assert.rejects(native.pool.query('UPDATE accounting.journal_entries SET project_id=$1 WHERE id=$2', [other.id, posted.id]), { code: '23514' });
  await assert.rejects(native.pool.query('UPDATE accounting.budgets SET project_id=$1 WHERE id=$2', [other.id, budget.id]), { code: '23514' });
  await assert.rejects(native.pool.query("INSERT INTO accounting.budgets(company_id,project_id,name,amount) VALUES($1,$2,'bad',1)", [actor.companyId, foreignProject.id]), { code: '23503' });
  assert.deepEqual((await native.pool.query('SELECT to_jsonb(e) AS row FROM accounting.journal_entries e WHERE id=$1', [posted.id])).rows[0], beforeEntry);
  const old = await call(actor, '/finance/budgets', { name: '기존 미연결', amount: '700' }, 201);
  const oldId = String(old.id), oldExpenseKey = randomUUID(), oldExpense = await call(actor, '/finance/expenses', { ...expense, budget_id: oldId }, 201, oldExpenseKey);
  const version = (await native.pool.query('SELECT version FROM accounting.budgets WHERE id=$1', [oldId])).rows[0].version;
  await call(actor, `${root}/budgets/${oldId}/associate`, { expected_version: version + 1 }, 409);
  const associationKey = randomUUID();
  const associated = await call(actor, `${root}/budgets/${oldId}/associate`, { expected_version: version }, 200, associationKey);
  assert.deepEqual(await call(actor, `${root}/budgets/${oldId}/associate`, { expected_version: version }, 200, associationKey), associated);
  assert.equal((await native.pool.query('SELECT project_id FROM accounting.journal_entries WHERE id=$1', [oldExpense.id])).rows[0].project_id, null);
  assert.deepEqual(await call(actor, '/finance/expenses', { ...expense, budget_id: oldId }, 201, oldExpenseKey), oldExpense);
  cases.push('DB company FKs, immutable posted attribution, immutable budget project, explicit association/version/replay without backfill');
  const tables = ['accounting.budgets', 'accounting.journal_entries', 'accounting.journal_lines', 'accounting.record_events', 'accounting.request_replays'];
  const snapshot = () => Promise.all(tables.map(async table => (await native.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows));
  await projectMoneyV1Replay({ request: (route, body, status, requestKey) => call(actor, route, body, status, requestKey), projectId: project.id, incomeId: revenue, expenseId: account,
    replayRow: async (operation, requestKey) => (await native.pool.query('SELECT payload,response FROM accounting.request_replays WHERE company_id=$1 AND actor_id=$2 AND operation=$3 AND request_key=$4', [actor.companyId, actor.userId, operation, requestKey])).rows[0], snapshot });
  cases.push('v1 omitted project_id canonical payload unchanged; original key replays under upgraded nullable schema; explicit new linkage conflicts without ledger changes');
  for (const table of ['accounting.budgets', 'accounting.record_events', 'accounting.request_replays']) {
    const before = await snapshot();
    await native.pool.query(`CREATE FUNCTION accounting.money_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'money injected failure'; END $$; CREATE TRIGGER money_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION accounting.money_failure()`);
    try { await call(actor, root + '/budgets', budgetBody, 500); }
    finally { await native.pool.query(`DROP TRIGGER money_failure ON ${table}; DROP FUNCTION accounting.money_failure()`); }
    assert.deepEqual(await snapshot(), before);
  }
  const lostKey = randomUUID(), dropped = once(events, 'dropped', { signal: AbortSignal.timeout(10000) });
  await Promise.all([dropped, assert.rejects(call(actor, root + '/budgets', { ...budgetBody, name: '응답 유실' }, 201, lostKey, { 'X-Test-Drop': 'yes' }), /fetch failed/)]);
  const beforeReplay = await snapshot(); await call(actor, root + '/budgets', { ...budgetBody, name: '응답 유실' }, 201, lostKey); assert.deepEqual(await snapshot(), beforeReplay);
  cases.push('native triggers rollback budgets/audit/replay; socket dropped after commit replays exactly once');
  await native.pool.query("DELETE FROM org.company_modules WHERE company_id=$1 AND module_key='projects'", [actor.companyId]);
  await call(actor, '/finance/incomes', strictIncome, 403, incomeKey);
  await call(actor, '/finance/expenses', expense, 403, expenseKey);
  await native.pool.query("INSERT INTO org.company_modules(company_id,module_key) VALUES($1,'projects')", [actor.companyId]);
  // 미들웨어를 통과한 replay도 회사 잠금 뒤 현재 project grant를 다시 확인한다.
  const revoker = await native.pool.connect();
  try {
    await revoker.query('BEGIN'); await revoker.query('SELECT id FROM org.companies WHERE id=$1 FOR UPDATE', [actor.companyId]);
    const queued = once(events, 'company-lock', { signal: AbortSignal.timeout(10000) });
    const replay = call(actor, '/finance/expenses', expense, 403, expenseKey); await queued;
    await revoker.query("DELETE FROM org.role_permissions rp USING org.roles r,org.permissions p WHERE rp.role_id=r.id AND rp.permission_id=p.id AND r.company_id=$1 AND p.code='project.read'", [actor.companyId]);
    await revoker.query('COMMIT'); await replay;
  } catch (error) { await revoker.query('ROLLBACK'); throw error; } finally { revoker.release(); }
  await call(actor, root, undefined, 403);
  await call(actor, '/finance/incomes', strictIncome, 403, incomeKey);
  await call(actor, root + '/budgets', budgetBody, 403, key);
  cases.push('in-flight revoked project permission reauthorized before keyed replay; summary and budget replay denied');
  passed = true;
} finally {
  if (server?.listening) { const closed = once(server, 'close', { signal: AbortSignal.timeout(10000) }); server.close(); server.closeAllConnections(); await closed; }
  closeDb?.(); await closePgPool?.(); await native.close();
  await writeFile(new URL('native.json', evidence), JSON.stringify({ passed, cases, isolatedClusterClosed: true }, null, 2));
  console.log(JSON.stringify({ passed, cases }));
}
