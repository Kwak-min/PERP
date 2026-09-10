import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';
import { dom } from './deadline-expense-actions.mjs';
import { recoverProjectMoney } from './project-money-recovery.mjs';
import { projectMoneyPrerequisites } from './project-money-prerequisites.mjs';
import { createOwnerOrg } from '../../backend/tests/http.js';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
const root = fileURLToPath(new URL('../../', import.meta.url)), evidence = path.join(root, '.omo/project-money/browser');
await mkdir(evidence, { recursive: true });
const result = { passed: false, cases: [], screenshots: [], pageErrors: [] };
let native, server, vite, browserServer, browser, closeDb, closePgPool;
try {
  native = await startDailyNativePostgres();
  await native.pool.query(await readFile(new URL('../../db/perp_additions_v8.sql', import.meta.url), 'utf8'));
  const { createApp } = await import('../../backend/src/app.js');
  const { migrate } = await import('../../backend/src/config/migrate.js');
  const sqlite = await import('../../backend/src/config/db.js'); closeDb = sqlite.closeDb;
  ({ closePgPool } = await import('../../backend/src/config/pg.js')); migrate();
  server = createServer(createApp()); const ready = once(server, 'listening', { signal: AbortSignal.timeout(10000) }); server.listen(0, '127.0.0.1'); await ready;
  const base = `http://127.0.0.1:${server.address().port}`;
  vite = await preview({ configFile: false, root: path.join(root, 'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT, preview: { host: '127.0.0.1', port: 0, proxy: { '/api': base } } });
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browserServer = await chromium.launchServer({ channel: 'chrome', headless: false, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  browser = await chromium.connect(browserServer.wsEndpoint()); result.chrome = browser.version();
  for (const pg of [false, true]) {
    const prefix = pg ? '/pg' : '';
    async function request(actor, route, body, status = 201) {
      const response = await fetch(base + '/api/v1' + prefix + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
    }
    let actor, account, incomeAccount;
    if (pg) {
      const signup = await request(null, '/auth/signup', { name: '재무 브라우저', email: 'money-browser@example.invalid', password: 'password-1234' });
      actor = { token: signup.token }; actor.orgId = (await request(actor, '/companies', { name: '격리 프로젝트 재무', modules: ['projects', 'tasks', 'finance'] })).org_id;

    } else {
      actor = await createOwnerOrg(base + '/api/v1', ['projects', 'tasks', 'finance']);

    }
    for (const width of [375, 768, 1280]) {
      const project = await request(actor, '/projects', { name: `프로젝트 ${pg ? 'PG' : 'SQLite'} ${width}` });
      const otherProject = width === 375 ? await request(actor, '/projects', { name: '다른 프로젝트로 옮기지 않음' }) : null;
      const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await context.addInitScript(session => localStorage.setItem('orbitflow.session.v1', JSON.stringify(session)), { ...actor, name: '프로젝트 재무 검증', email: 'money-browser@example.invalid', mustChangePassword: false, organizations: [{ org_id: actor.orgId, org_name: '프로젝트 재무', org_type: pg ? 'perp_db' : 'custom', roles: ['owner'] }] });
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => result.pageErrors.push(error.message));
      if (width === 375) {
        assert.equal((await request(actor, '/finance/accounts', undefined, 200)).items.length, 0);
        await page.goto(origin + '/finance', { waitUntil: 'domcontentloaded' }); await dom(page, '[data-finance-prepare]');
        const prepared = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(prefix + '/finance/setup') && response.request().method() === 'POST');
        await page.locator('[data-finance-prepare]').click(); assert.equal((await prepared).status(), 200);
        const accounts = (await request(actor, '/finance/accounts', undefined, 200)).items;
        const expenseAccount = accounts.find(row => (row.kind ?? row.account_type) === 'expense');
        const revenueAccount = accounts.find(row => (row.kind ?? row.account_type) === (pg ? 'revenue' : 'income'));
        account = expenseAccount.id ?? expenseAccount.value; incomeAccount = revenueAccount.id ?? revenueAccount.value;
        assert.equal((await request(actor, '/finance/transactions', undefined, 200)).items.length, 0);
        result.cases.push({ source: pg ? 'nativePG' : 'SQLite', flow: 'ordinary empty company -> real finance setup UI -> real project screen; no seeded accounts or fake ledger' });
      }
      const moneyRoute = `/projects/${project.id}/money`, routePath = prefix + moneyRoute;
      const summaryResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(routePath) && response.request().method() === 'GET');
      await page.goto(`${origin}/projects/${project.id}`, { waitUntil: 'domcontentloaded' });
      assert.equal((await summaryResponse).status(), 200);
      const panel = page.locator('[data-project-money]'); await expect(panel.locator('[data-money-empty]')).toBeVisible();
      if (width === 375) {
        await projectMoneyPrerequisites({ page, native, sqlite, actor, pg, account, incomeAccount, routePath });
        result.cases.push({ source: pg ? 'nativePG' : 'SQLite', flow: 'direction-specific project prerequisites: expense without income, income without expense, PG cash required for either; no global setup.ready gate' });
      }
      await panel.getByRole('button', { name: '예산 배정', exact: true }).click();
      const budgetForm = panel.locator('[data-project-budget-form]');
      await budgetForm.locator('[name=budget_name]').fill('행사 배정 예산'); await budgetForm.locator('[name=budget_amount]').fill('1000.01'); await budgetForm.getByRole('checkbox').check();
      const budgetPost = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(routePath + '/budgets') && response.request().method() === 'POST');
      const budgetSummary = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(routePath) && response.request().method() === 'GET');
      await budgetForm.getByRole('button', { name: '예산 배정 저장' }).click(); const budgetResult = await budgetPost; assert.equal(budgetResult.status(), 201); const budget = await budgetResult.json(); await budgetSummary;
      await expect(panel.locator('[data-money-stat=allocated]')).toHaveText('1000.01'); await expect(panel.locator('[data-money-stat=remaining]')).toHaveText('1000.01');
      await panel.getByRole('button', { name: '프로젝트 지출 기록', exact: true }).click();
      const form = panel.locator('[data-expense-form]');
      await form.locator('[name=amount]').fill('100.01'); await form.locator('[name=merchant]').fill('프로젝트 사용처'); await form.locator('[name=expense_date]').fill('2026-09-09');
      await form.locator('[name=account_id]').selectOption(account); await form.locator('[name=budget_id]').selectOption(budget.id); await form.locator('[name=no_receipt_reason]').fill('영수증 미발급'); await form.locator('.expense-confirm input').check();
      if (width === 375) {
        const accessRefresh = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/settings/access') && response.request().method() === 'GET');
        await page.evaluate(() => window.dispatchEvent(new Event('focus'))); assert.equal((await accessRefresh).status(), 200);
        await dom(page, '[data-expense-form] input[name="amount"][value="100.01"]');
        assert.equal(await form.locator('[name=budget_id]').inputValue(), budget.id);
      }
      const expenseAttempts = [];
      if (width === 375) {
        await page.route('**/api/v1' + prefix + '/finance/expenses', async route => {
          expenseAttempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
          const response = await route.fetch(); assert.equal(response.status(), 201);
          if (expenseAttempts.length === 1) await route.fulfill({ status: 201, contentType: 'application/json', body: '{' }); else await route.fulfill({ response });
        });
        const uncertain = dom(page, '[data-expense-form][data-money-state=uncertain]');
        await form.getByRole('button', { name: '지출 확정 기록', exact: true }).click(); await uncertain;
        await recoverProjectMoney({ page, origin, kind: 'expense', projectId: project.id, otherProjectId: otherProject.id, amount: '100.01', accountId: account, budgetId: budget.id });
      }
      const expensePost = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(prefix + '/finance/expenses') && response.request().method() === 'POST');
      const expenseSummary = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(routePath) && response.request().method() === 'GET');
      await form.locator('button[type=submit]').click(); const posted = await expensePost; assert.equal(posted.status(), 201); assert.equal((await posted.json()).project_id, project.id); assert.equal((await expenseSummary).status(), 200);
      if (width === 375) { assert.deepEqual(expenseAttempts[0], expenseAttempts[1]); await page.unroute('**/api/v1' + prefix + '/finance/expenses'); }
      await expect(panel.locator('[data-money-stat=spending]')).toHaveText('100.01'); await expect(panel.locator('[data-money-stat=remaining]')).toHaveText('900.00'); await expect(panel.locator('[data-money-stat=income]')).toHaveCount(0);
      await panel.getByRole('button', { name: '프로젝트 수입 기록', exact: true }).click();
      const incomeForm = panel.locator('[data-income-form]');
      await incomeForm.locator('[name=amount]').fill('200.02'); await incomeForm.locator('[name=payer]').fill('프로젝트 입금자'); await incomeForm.locator('[name=income_date]').fill('2026-09-09');
      await incomeForm.locator('[name=account_id]').selectOption(incomeAccount); await incomeForm.locator('.expense-confirm input').check();
      const attempts = [];
      if (width === 375) {
        await page.route('**/api/v1' + prefix + '/finance/incomes', async route => {
          attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
          const response = await route.fetch(); assert.equal(response.status(), 201); const payload = await response.json();
          if (attempts.length === 1) await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...payload, project_id: 'wrong-project' }) });
          else await route.fulfill({ response });
        });
        const uncertain = dom(page, '[data-income-form][data-money-state=uncertain]');
        await incomeForm.getByRole('button', { name: '수입 확정 기록', exact: true }).click(); await uncertain;
        assert.equal(await incomeForm.locator('[name=amount]').isDisabled(), true);
        assert.equal(await panel.getByRole('button', { name: '프로젝트 지출 기록', exact: true }).isDisabled(), true);
        await recoverProjectMoney({ page, origin, kind: 'income', projectId: project.id, otherProjectId: otherProject.id, amount: '200.02', accountId: incomeAccount });
      }
      const incomePosted = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(prefix + '/finance/incomes') && response.request().method() === 'POST');
      const incomeSummary = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(routePath) && response.request().method() === 'GET');
      await incomeForm.locator('button[type=submit]').click(); const received = await incomePosted; assert.equal(received.status(), 201); const income = await received.json();
      assert.equal(income.project_id, project.id); assert.equal(income.budget_id, null); assert.equal((await incomeSummary).status(), 200);
      if (width === 375) { assert.deepEqual(attempts[0], attempts[1]); await page.unroute('**/api/v1' + prefix + '/finance/incomes'); }
      await expect(panel.locator('[data-money-stat=income]')).toHaveText('200.02'); await expect(panel.locator('[data-money-stat=net]')).toHaveText('100.01');
      const reloadSummary = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(routePath) && response.request().method() === 'GET'); await page.reload({ waitUntil: 'domcontentloaded' }); await reloadSummary;
      await expect(panel.locator('[data-money-stat=remaining]')).toHaveText('900.00');
      await expect(panel.locator('[data-money-stat=income]')).toHaveText('200.02'); await expect(panel.locator('[data-money-stat=net]')).toHaveText('100.01');
      await page.evaluate(() => document.fonts.ready); await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page must not horizontally overflow');
      const image = `${pg ? 'pg' : 'sqlite'}-${width}.png`; await page.screenshot({ path: path.join(evidence, image), fullPage: true }); result.screenshots.push(image);
      if (width === 375) {
        await panel.locator('.project-finance__totals').evaluate(element => window.scrollBy({ top: element.getBoundingClientRect().top - 120, behavior: 'instant' }));
        for (const name of ['allocated', 'spending', 'remaining', 'income', 'net']) {
          const box = await panel.locator(`[data-money-stat=${name}]`).boundingBox(); assert.ok(box && box.y >= 100 && box.y + box.height < 930, `${name} visible above fixed navigation`);
        }
        const viewportImage = `${pg ? 'pg' : 'sqlite'}-375-totals.png`; await page.screenshot({ path: path.join(evidence, viewportImage) }); result.screenshots.push(viewportImage);
      }
      // 실제 응답이 가리키는 확정 전표와 예산의 관계를 재조회한다.
      const summary = await request(actor, moneyRoute, undefined, 200); assert.equal(summary.totals[0].remaining, '900.00'); assert.equal(summary.entries.length, 2); assert.equal(summary.totals[0].income, '200.02'); assert.equal(summary.totals[0].net, '100.01');
      result.cases.push({ source: pg ? 'nativePG' : 'SQLite', width, flow: 'project detail -> explicit budget -> linked confirmed expense + income without budget -> distinct exact totals -> reload', amounts: { allocated: '1000.01', spending: '100.01', remaining: '900.00', income: '200.02', net: '100.01' }, replay: width === 375 ? 'expense loss + income project mismatch -> reload/other project/finance/original project -> identical original keys and bodies' : 'not injected' });
      if (width === 1280) {
        const existing = await request(actor, '/finance/budgets', pg ? { name: '과거 미연결 예산', amount: '10.00' } : { name: '과거 미연결 예산', amount_minor: 1000 });
        const oldEntry = await request(actor, '/finance/expenses', { amount: '1.01', account_id: account, budget_id: existing.id, expense_date: '2026-09-09', merchant: '과거 사용', no_receipt_reason: '미발급' });
        const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(routePath) && response.request().method() === 'GET');
        await panel.getByRole('button', { name: '재무 새로고침', exact: true }).click(); await refreshed;
        await panel.getByRole('button', { name: '예산 배정', exact: true }).click();
        const associationForm = panel.locator('[data-project-budget-form]'); await associationForm.getByLabel('배정 방법').selectOption('associate'); await associationForm.getByRole('combobox').nth(1).selectOption(existing.id); await associationForm.getByRole('checkbox').check();
        const associated = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/budgets/${existing.id}/associate`) && response.request().method() === 'POST');
        const associationSummary = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(routePath) && response.request().method() === 'GET');
        await associationForm.getByRole('button', { name: '예산 배정 저장', exact: true }).click(); assert.equal((await associated).status(), 200); await associationSummary;
        await expect(panel.locator('[data-money-unit=KRW] [data-money-stat=spending]')).toHaveText('100.01');
        assert.equal((await request(actor, `/finance/transactions/${oldEntry.id}`, undefined, 200)).project_id, null);
        result.cases.push({ source: pg ? 'nativePG' : 'SQLite', flow: 'explicit existing-budget association UI preserves unknown currency and leaves old posted expense unlinked' });
        let originalRoles;
        if (pg) {
          await native.pool.query("INSERT INTO org.permissions(code,module) VALUES('menu.configured','menu') ON CONFLICT DO NOTHING");
          await native.pool.query("INSERT INTO org.role_permissions(role_id,permission_id) SELECT r.id,p.id FROM org.roles r CROSS JOIN org.permissions p WHERE r.company_id=$1 AND p.code='menu.configured' ON CONFLICT DO NOTHING", [actor.orgId.slice(3)]);
          await native.pool.query("DELETE FROM org.role_permissions rp USING org.roles r,org.permissions p WHERE rp.role_id=r.id AND rp.permission_id=p.id AND r.company_id=$1 AND p.code='menu.finance'", [actor.orgId.slice(3)]);
        } else {
          const role = await request(actor, '/settings/roles', { name: '프로젝트만 조회', scope: 'all', permissions: ['menu.projects', 'project.read', 'project.write', 'task.read', 'task.write'] });
          originalRoles = sqlite.db().prepare('SELECT roles FROM membership WHERE org_id=? AND user_id=?').get(actor.orgId, actor.userId).roles;
          sqlite.db().prepare('UPDATE membership SET roles=? WHERE org_id=? AND user_id=?').run(role.key, actor.orgId, actor.userId);
        }
        const requests = [], observe = request => requests.push(new URL(request.url()).pathname); page.on('request', observe);
        await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('[data-project-money-unavailable]')).toBeVisible(); await expect(page.locator('[data-money-stat]')).toHaveCount(0);
        assert.equal(requests.some(value => value.endsWith(routePath)), false); page.off('request', observe);
        result.cases.push({ source: pg ? 'nativePG' : 'SQLite', flow: 'finance menu denied: project detail remains; no money request and no hidden amount DOM' });
        if (pg) await native.pool.query("INSERT INTO org.role_permissions(role_id,permission_id) SELECT r.id,p.id FROM org.roles r CROSS JOIN org.permissions p WHERE r.company_id=$1 AND p.code='menu.finance' ON CONFLICT DO NOTHING", [actor.orgId.slice(3)]);
        else sqlite.db().prepare('UPDATE membership SET roles=? WHERE org_id=? AND user_id=?').run(originalRoles, actor.orgId, actor.userId);
        if (pg) await native.pool.query("DELETE FROM org.company_modules WHERE company_id=$1 AND module_key='finance'", [actor.orgId.slice(3)]);
        else sqlite.db().prepare("UPDATE organization SET modules='projects,tasks' WHERE id=?").run(actor.orgId);
        await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('[data-project-money-unavailable]')).toBeVisible(); await expect(page.locator('[data-money-stat]')).toHaveCount(0);
        await expect(page.getByRole('heading', { name: '프로젝트', exact: true })).toBeVisible();
        result.cases.push({ source: pg ? 'nativePG' : 'SQLite', flow: 'finance disabled: projects remain usable; no amount DOM or fabricated zeros' });
      }
      await context.close();
    }
  }
  assert.deepEqual(result.pageErrors, []); result.passed = true;
} finally {
  await browser?.close(); await browserServer?.close();
  if (vite) await new Promise((resolve, reject) => { vite.httpServer.close(error => error ? reject(error) : resolve()); vite.httpServer.closeAllConnections(); });
  if (server?.listening) { const closed = once(server, 'close', { signal: AbortSignal.timeout(10000) }); server.close(); server.closeAllConnections(); await closed; }
  closeDb?.(); await closePgPool?.(); await native?.close();
  result.resourcesClosed = true; await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
