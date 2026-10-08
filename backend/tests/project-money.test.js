import test from 'node:test';
import { projectMoneyV1Replay } from './project-money-v1-replay.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, createOwnerOrg, api } from './http.js';

// 실제 HTTP -> SQLite write -> 새 HTTP summary. 금액은 문자열로만 비교한다.
test('project money: explicit budgets, exact posted flows, replay authorization and scoped references', { timeout: 120000 }, async () => {
  const server = await startTestServer();
  try {
    const actor = await createOwnerOrg(server.baseUrl, ['projects', 'tasks', 'finance']);
    const foreign = await createOwnerOrg(server.baseUrl, ['projects', 'finance']);
    const call = async (route, body, status = 200, who = actor, key = randomUUID()) => {
      const result = await api(server.baseUrl, route, { ...who, method: body === undefined ? 'GET' : 'POST', body, headers: { 'Idempotency-Key': key } });
      assert.equal(result.status, status, `${route}: ${JSON.stringify(result.body)}`); return result.body;
    };
    const project = await call('/projects', { name: '연결 프로젝트' }, 201);
    const other = await call('/projects', { name: '다른 프로젝트' }, 201);
    const foreignProject = await call('/projects', { name: '다른 회사' }, 201, foreign);
    const root = `/projects/${project.id}/money`;
    assert.deepEqual((await call(root)).totals, []);
    const account = await call('/finance/accounts', { code: 'EXP', name: '지출', kind: 'expense' }, 201);
    const incomeAccount = await call('/finance/accounts', { code: 'INC', name: '수입', kind: 'income' }, 201);
    const budgetBody = { name: '행사 예산', amount: '1000.01', currency: 'KRW', account_id: account.id };
    const key = randomUUID();
    const budget = await call(root + '/budgets', budgetBody, 201, actor, key);
    assert.deepEqual(await call(root + '/budgets', budgetBody, 201, actor, key), budget);
    await call(root + '/budgets', { ...budgetBody, amount: '1000.02' }, 409, actor, key);
    await call(root + '/budgets', { ...budgetBody, currency: 'USD' }, 400);
    const second = await call(root + '/budgets', { name: '추가 예산', amount: '0.09', currency: 'KRW' }, 201);
    const expense = { budget_id: budget.id, amount: '100.01', expense_date: '2026-09-09', merchant: '사용처', account_id: account.id, no_receipt_reason: '미발급' };
    const expenseKey = randomUUID();
    const posted = await call('/finance/expenses', expense, 201, actor, expenseKey);
    assert.equal(posted.project_id, project.id);
    const replay = await Promise.all([call('/finance/expenses', expense, 201, actor, expenseKey), call('/finance/expenses', expense, 201, actor, expenseKey)]);
    assert.deepEqual(replay, [posted, posted]);
    await call('/finance/expenses', { ...expense, project_id: other.id }, 400);
    await call('/finance/expenses', { ...expense, project_id: foreignProject.id }, 404);
    const foreignBudget = await call(`/projects/${foreignProject.id}/money/budgets`, { name: '외부', amount: '9', currency: 'KRW' }, 201, foreign);
    await call('/finance/expenses', { ...expense, budget_id: foreignBudget.id }, 404);
    await call(root, undefined, 404, foreign);
    // 미연결 확정, 초안은 프로젝트 집계에 포함하지 않는다.
    await call('/finance/expenses', { ...expense, budget_id: null, amount: '999.99' }, 201);
    await call('/finance/transactions', { kind: 'expense', amount_minor: 999999, occurred_on: '2026-09-09', project_id: project.id, budget_id: budget.id, account_id: account.id }, 201);
    let summary = await call(root);
    assert.deepEqual(summary.totals, [{ unit: 'KRW', allocated: '1000.10', spending: '100.01', remaining: '900.09', income: null, net: null }]);
    assert.equal(summary.budgets.find(row => row.id === second.id).remaining, '0.09');
    const income = await call('/finance/transactions', { kind: 'income', amount_minor: 20002, occurred_on: '2026-09-09', project_id: project.id, account_id: incomeAccount.id }, 201);
    await call(`/finance/transactions/${income.id}/confirm`, {}, 200);
    summary = await call(root);
    assert.equal(summary.totals[0].income, '200.02'); assert.equal(summary.totals[0].net, '100.01');
    const linkedIncomeBody = { amount: '25.03', currency: 'KRW', income_date: '2026-09-09', payer: '프로젝트 수입', account_id: incomeAccount.id, project_id: project.id, memo: '' };
    const incomeKey = randomUUID(), linkedIncome = await call('/finance/incomes', linkedIncomeBody, 201, actor, incomeKey);
    assert.equal(linkedIncome.project_id, project.id); assert.equal(linkedIncome.budget_id, null);
    assert.deepEqual(await call('/finance/incomes', linkedIncomeBody, 201, actor, incomeKey), linkedIncome);
    await call('/finance/incomes', { ...linkedIncomeBody, amount: '25.04' }, 409, actor, incomeKey);
    await call('/finance/incomes', { ...linkedIncomeBody, project_id: foreignProject.id }, 404);
    await call('/finance/incomes', { ...linkedIncomeBody, budget_id: budget.id }, 400);
    await call('/finance/incomes', { ...linkedIncomeBody, project_id: undefined, amount: '999.99' }, 201);
    summary = await call(root);
    assert.equal(summary.totals[0].income, '225.05'); assert.equal(summary.totals[0].net, '125.04'); assert.equal(summary.totals[0].remaining, '900.09');
    const { db } = await import('../src/config/db.js');
    await projectMoneyV1Replay({ request: (route, body, status, requestKey) => call(route, body, status, actor, requestKey), projectId: project.id, incomeId: incomeAccount.id, expenseId: account.id,
      replayRow: (operation, requestKey) => db().prepare('SELECT payload,response FROM finance_request_replay WHERE org_id=? AND actor_id=? AND operation=? AND request_key=?').get(actor.orgId, actor.userId, operation, requestKey),
      snapshot: () => ['transaction_record', 'audit_event', 'finance_request_replay'].map(table => db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()) });
    // 쓰기 실패 시 예산/감사/재시도 테이블이 모두 rollback한다.
    const count = () => ['budget', 'audit_event', 'finance_request_replay'].map(table => db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    const before = count();
    db().exec("CREATE TRIGGER money_failure BEFORE INSERT ON audit_event BEGIN SELECT RAISE(ABORT,'money injected failure'); END");
    try { await call(root + '/budgets', { ...budgetBody, name: '실패' }, 500); } finally { db().exec('DROP TRIGGER money_failure'); }
    assert.deepEqual(count(), before);
    // 기존 예산을 명시 연결하더라도 과거 미연결 장부는 그대로다.
    const old = await call('/finance/budgets', { name: '과거 미연결', amount_minor: 7000 }, 201);
    const oldExpenseKey = randomUUID(), oldExpense = await call('/finance/expenses', { ...expense, budget_id: old.id }, 201, actor, oldExpenseKey);
    const version = db().prepare('SELECT version FROM budget WHERE id=?').get(old.id).version;
    await call(`${root}/budgets/${old.id}/associate`, { expected_version: version }, 200);
    assert.equal(db().prepare('SELECT project_id FROM transaction_record WHERE id=?').get(oldExpense.id).project_id, null);
    assert.deepEqual(await call('/finance/expenses', { ...expense, budget_id: old.id }, 201, actor, oldExpenseKey), oldExpense);
    assert.equal((await call(root)).totals.find(row => row.unit === 'KRW').spending, '100.01');
    await call(`/projects/${other.id}/money/budgets/${old.id}/associate`, { expected_version: version + 1 }, 409);
    // 회사/프로젝트 관계는 HTTP뿐 아니라 DB 새 쓰기에서도 강제된다.
    assert.throws(() => db().prepare('UPDATE budget SET project_id=? WHERE id=?').run(foreignProject.id, second.id), /project|company|scope/);
    assert.throws(() => db().prepare('UPDATE transaction_record SET project_id=? WHERE id=?').run(other.id, posted.id), { code: 'ERR_SQLITE_ERROR', errcode: 1811 });
    assert.equal(db().prepare('SELECT project_id FROM transaction_record WHERE id=?').get(posted.id).project_id, project.id);
    // 안전한 입력 범위를 넘지 않는 개별 금액도 합산할 때는 BigInt가 필요하다.
    const largeProject = await call('/projects', { name: '정밀 금액' }, 201);
    const largeRoot = `/projects/${largeProject.id}/money`;
    for (const name of ['큰 예산 A', '큰 예산 B']) await call(largeRoot + '/budgets', { name, amount: '90071992547409.91', currency: 'KRW' }, 201);
    assert.equal((await call(largeRoot)).totals[0].allocated, '180143985094819.82');
    await call(largeRoot + '/budgets', { name: '범위 초과', amount: '90071992547409.92', currency: 'KRW' }, 400);
    const usdDraft = await call('/finance/transactions', { kind: 'expense', amount_minor: 101, occurred_on: '2026-09-09', project_id: project.id, account_id: account.id }, 201);
    db().prepare("UPDATE transaction_record SET currency='USD' WHERE id=?").run(usdDraft.id);
    await call(`/finance/transactions/${usdDraft.id}/confirm`, {}, 200);
    const currencies = (await call(root)).totals;
    assert.equal(currencies.find(row => row.unit === 'USD').spending, '1.01');
    assert.equal(currencies.find(row => row.unit === 'KRW').spending, '100.01');
    const email = `project-money-reader-${randomUUID()}@example.invalid`;
    const invitation = await call('/members/invites', { email, roles: ['treasurer'] }, 201);
    const teammateSignup = await call('/auth/signup', { email, name: '동료 회계 담당자', password: 'password-1234', invitation_token: invitation.token }, 201, {});
    const teammate = { token: teammateSignup.access_token, orgId: actor.orgId, userId: teammateSignup.user.id };
    // 회사 전체로 승격하지 않는 좁은 역할과 현재 메뉴/행 범위 재인가.
    const permissions = ['menu.projects', 'project.read', 'project.write', 'menu.finance', 'budget.read', 'budget.write', 'transaction.read', 'transaction.write', 'transaction.confirm'];
    const role = await call('/settings/roles', { name: '재무 범위 검증', scope: 'self', permissions }, 201);
    const originalRoles = db().prepare('SELECT roles FROM membership WHERE org_id=? AND user_id=?').get(actor.orgId, actor.userId).roles;
    db().prepare('UPDATE membership SET roles=? WHERE org_id=? AND user_id=?').run(role.key, actor.orgId, actor.userId);
    try {
      const denied = await call(root, undefined, 403); assert.equal(denied.totals, undefined);
      await call('/finance/expenses', expense, 403, actor, expenseKey);
      await call('/finance/incomes', linkedIncomeBody, 403, actor, incomeKey);
      db().prepare("UPDATE company_role SET scope='department' WHERE id=?").run(role.key);
      await call(root, undefined, 403);
      db().prepare("UPDATE company_role SET scope='project' WHERE id=?").run(role.key);
      assert.equal((await call(root)).totals.find(row => row.unit === 'KRW').spending, '100.01');
      db().prepare("UPDATE project_member SET deleted_at='2026-09-09' WHERE project_id=? AND user_id=?").run(project.id, actor.userId);
      try { await call(root, undefined, 403); await call('/finance/expenses', expense, 403, actor, expenseKey); }
      finally { db().prepare('UPDATE project_member SET deleted_at=NULL WHERE project_id=? AND user_id=?').run(project.id, actor.userId); }
      await call('/finance/expenses', { ...expense, budget_id: null, project_id: project.id, amount: '0.01' }, 201, teammate);
      const hidden = await call(root, undefined, 404); assert.equal(hidden.totals, undefined);
      db().prepare('UPDATE company_role SET permissions_json=? WHERE id=?').run(JSON.stringify(permissions.filter(code => code !== 'menu.finance')), role.key);
      await call(root, undefined, 403); await call(root + '/budgets', budgetBody, 403, actor, key);
      await call('/projects', undefined, 200);
    } finally { db().prepare('UPDATE membership SET roles=? WHERE org_id=? AND user_id=?').run(originalRoles, actor.orgId, actor.userId); }
    // finance 입력 경로에서도 현재 projects 모듈이 필요하다. 미연결 거래는 영향받지 않는다.
    db().prepare("UPDATE organization SET modules='finance,tasks' WHERE id=?").run(actor.orgId);
    await call('/finance/incomes', linkedIncomeBody, 403, actor, incomeKey);
    await call('/finance/expenses', expense, 403, actor, expenseKey);
    await call('/finance/incomes', { ...linkedIncomeBody, project_id: null }, 201);
    // 재시도도 현재 메뉴/모듈/프로젝트 권한을 다시 확인한다.
    db().prepare("UPDATE organization SET modules='projects,tasks' WHERE id=?").run(actor.orgId);
    await call(root, undefined, 403); await call('/finance/expenses', expense, 403, actor, expenseKey);
    await call(root + '/budgets', budgetBody, 403, actor, key);
    await call('/projects', undefined, 200);
  } finally { await server.close(); }
});
