import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import sharp from 'sharp';
import { createOwnerOrg } from '../../backend/tests/http.js';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';
import { dom, downloadedBytes } from './deadline-expense-actions.mjs';
import { recoverMoneyEntry, switchMoneySession, assertMoneyScopeIsolation, moneyPendingKeys, assertMoneyLogout } from './money-retry-actions.mjs';
import { browserFixtureOrigin, routeFixture, fixtureFetch, assertFixtureSecurity, insecureOriginRequested } from './insecure-origin.mjs';
import { receiptRetry } from './request-key-receipt-retry.mjs';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
const root = fileURLToPath(new URL('../../', import.meta.url)), evidence = path.join(root, insecureOriginRequested ? `.omo/project-actions/request-key-adoption/money/${process.env.DEADLINE_RUN_ID}` : '.omo/evidence/money-retry' + (process.argv[2] ? '-' + process.argv[2] : ''));
await mkdir(evidence, { recursive: true });
process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'first-money-browser-receipts');
const native = await startDailyNativePostgres();
let server, vite, browserServer, browser, closeDb, closePgPool, failurePage, ledgerProbe;
const result = { status: 'running', cases: [], screenshots: [], pageErrors: [], browserSecurity: [], moneyPosts: [] };
try {
  // 전체 앱 셸이 조회하는 부서 접근 테이블도 격리 클러스터에 기존 DDL로 준비한다.
  await native.pool.query(await readFile(new URL('../../db/perp_additions_v8.sql', import.meta.url), 'utf8'));
  const { createApp } = await import('../../backend/src/app.js');
  const { migrate } = await import('../../backend/src/config/migrate.js');
  const database = await import('../../backend/src/config/db.js'); closeDb = database.closeDb;
  ({ closePgPool } = await import('../../backend/src/config/pg.js'));
  migrate(); server = createServer(createApp());
  const listening = once(server, 'listening', { signal: AbortSignal.timeout(10000) }); server.listen(0, '127.0.0.1'); await listening;
  const base = `http://127.0.0.1:${server.address().port}`;
  vite = await preview({ configFile: false, root: path.join(root, 'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT, preview: { host: '127.0.0.1', port: 0, proxy: { '/api': base } } });
  const origin = browserFixtureOrigin(vite.httpServer.address().port);
  browserServer = await chromium.launchServer({ channel: 'chrome', headless: insecureOriginRequested, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  browser = await chromium.connect(browserServer.wsEndpoint()); result.chrome = browser.version(); result.chromePid = browserServer.process().pid;
  for (const pg of [false, true]) for (const width of [1280, 375]) {
    const prefix = pg ? '/pg' : '', apiPrefix = '/api/v1' + prefix + '/finance';
    async function request(actor, route, body) {
      const response = await fetch(base + '/api/v1' + prefix + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      const payload = await response.json(); assert.ok(response.ok, JSON.stringify(payload)); return payload;
    }
    let actor;
    if (pg) {
      const signup = await request(null, '/auth/signup', { name: '돈 관리 검증', email: `${randomUUID()}@example.invalid`, password: 'password-1234' });
      actor = { token: signup.token, userId: signup.user.id };
      actor.orgId = (await request(actor, '/companies', { name: '처음 돈 관리', modules: ['finance'] })).org_id;
    } else actor = await createOwnerOrg(base + '/api/v1', ['finance']);
    assert.equal((await request(actor, '/finance/accounts')).items.length, 0);
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' });
    await routeFixture(context, origin);
    const me = await request(actor, '/auth/me');
    const browserSession = { ...actor, name: '검증 관리자', email: pg ? me.user.email : me.email, mustChangePassword: false, organizations: [{ org_id: actor.orgId, org_name: '처음 돈 관리', org_type: pg ? 'perp_db' : 'custom', roles: ['owner'] }] };
    const otherSignup = await request(null, '/auth/signup', { name: '다른 계정', email: `${randomUUID()}@example.invalid`, password: 'password-1234' });
    if (pg) {
      await native.pool.query('INSERT INTO org.company_memberships(company_id,user_id) VALUES($1,$2)', [actor.orgId.slice(3), otherSignup.user.id]);
      await native.pool.query("INSERT INTO org.user_roles(user_id,role_id) SELECT $1,id FROM org.roles WHERE company_id=$2 AND name='company_creator'", [otherSignup.user.id, actor.orgId.slice(3)]);
    } else {
      const { insert } = await import('../../backend/src/models/base.js');
      insert('membership', { tenant_id: database.db().prepare('SELECT tenant_id FROM organization WHERE id=?').get(actor.orgId).tenant_id, org_id: actor.orgId, user_id: otherSignup.user.id, roles: 'owner', status: 'active', created_by: actor.userId });
    }
    const otherSpace = await request(actor, pg ? '/companies' : '/tenants', { name: '다른 공간', ...(pg ? {} : { type: 'custom' }), modules: ['finance'] });
    const otherSpaceSession = { ...browserSession, orgId: otherSpace.org_id, organizations: [{ ...browserSession.organizations[0], org_id: otherSpace.org_id }] };
    await request(otherSpaceSession, '/finance/setup', {});
    const otherAccountSession = { ...browserSession, token: pg ? otherSignup.token : otherSignup.access_token, email: otherSignup.user.email };
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => result.pageErrors.push(error.message));
    failurePage = page; ledgerProbe = () => request(actor, '/finance/transactions');
    page.on('request', item => { if (item.method() === 'POST' && /\/(incomes|expenses)$/.test(new URL(item.url()).pathname)) result.moneyPosts.push({ pg, width, path: new URL(item.url()).pathname, key: item.headers()['idempotency-key'], body: item.postDataJSON() }); });
    await page.goto(origin + '/login', { waitUntil: 'domcontentloaded' });
    result.browserSecurity.push(await assertFixtureSecurity(page));
    await switchMoneySession(page, origin, browserSession);
    const capture = async state => {
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      const name = `${pg ? 'pg' : 'sqlite'}-${width}-${state}.png`;
      await page.screenshot({ path: path.join(evidence, name), fullPage: true, animations: 'disabled' });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow ${name}`); result.screenshots.push(name);
    };
    await page.goto(origin + '/finance', { waitUntil: 'domcontentloaded' }); await dom(page, '[data-finance-prepare]');
    await capture('empty');
    const ready = dom(page, '[data-income-entry]:not(:disabled)'); await page.locator('[data-finance-prepare]').click(); await ready;
    assert.equal((await request(actor, '/finance/transactions')).items.length, 0);
    const accounts = (await request(actor, '/finance/accounts')).items, accountId = kind => { const value = accounts.find(item => (item.kind ?? item.account_type) === kind); return value.id ?? value.value; };
    const incomeId = accountId(pg ? 'revenue' : 'income'), expenseId = accountId('expense');
    const incomeReady = dom(page, `[data-income-form] option[value="${incomeId}"]`); await page.locator('[data-income-entry]').click(); await incomeReady;
    const form = page.locator('[data-income-form]');
    await form.locator('[name="amount"]').fill('100.01'); await form.locator('[name="income_date"]').fill('2026-09-09');
    await form.locator('[name="payer"]').fill('첫 입금자'); await form.locator('[name="account_id"]').selectOption(incomeId); await form.locator('[name="memo"]').fill('FIRST_INCOME'); await form.locator('input[type="checkbox"]').check();
    const attempts = []; let committed;
    await page.route('**' + apiPrefix + '/incomes', async route => {
      attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
      const response = await fixtureFetch(route); assert.equal(response.status(), 201); committed = await response.json();
      if (attempts.length === 1) await route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":' });
      else if (attempts.length === 2) await route.fulfill({ status: 400, contentType: 'text/html', body: '<h1>Unknown upstream response</h1>' });
      else if (attempts.length === 3) await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'PERMISSION_DENIED', message: 'Current request denied', details: {}, request_id: 'retry-test' } }) });
      else await route.fulfill({ response });
    });
    const uncertain = dom(page, '[data-income-form][data-money-state="uncertain"]'); await form.locator('button[type="submit"]').click(); await uncertain;
    assert.equal(await page.locator('[data-expense-success]').count(), 0); assert.equal(await page.locator('[data-expense-entry]').isDisabled(), true); assert.equal(await form.locator('[name="amount"]').isDisabled(), true);
    await capture('income-uncertain');
    const firstIncomeId = committed.id;
    if (process.argv[2] !== 'expense') {
      await recoverMoneyEntry({ page, origin, kind: 'income', amount: '100.01', accountId: incomeId });
      await assertMoneyScopeIsolation({ page, origin, kind: 'income', originalSession: browserSession, otherAccountSession, otherSpaceSession, amount: '100.01', accountId: incomeId });
    }
    const unknownResponse = page.waitForResponse(response => new URL(response.url()).pathname === apiPrefix + '/incomes' && response.status() === 400);
    await form.locator('button[type="submit"]').click(); await unknownResponse; await dom(page, '[data-income-form][data-money-state="uncertain"]');
    assert.equal(await page.locator('[data-expense-success]').count(), 0);
    const deniedResponse = page.waitForResponse(response => new URL(response.url()).pathname === apiPrefix + '/incomes' && response.status() === 403);
    await form.locator('button[type="submit"]').click(); await deniedResponse; await dom(page, '[data-income-form][data-money-state="uncertain"]');
    await recoverMoneyEntry({ page, origin, kind: 'income', amount: '100.01', accountId: incomeId });
    const incomeSaved = dom(page, '[data-expense-success]'); await form.locator('button[type="submit"]').click(); await incomeSaved;
    assert.equal(attempts.length, 4); for (const attempt of attempts) assert.deepEqual(attempts[0], attempt);
    assert.equal((await request(actor, '/finance/transactions')).items.length, 1);
    const savedIncomeId = committed.id; assert.equal(savedIncomeId, firstIncomeId); assert.deepEqual(await moneyPendingKeys(page), []);
    await capture('income-saved'); await page.unroute('**' + apiPrefix + '/incomes');
    const expenseReady = dom(page, `[data-expense-form] option[value="${expenseId}"]`); await page.locator('[data-expense-entry]').click(); await expenseReady;
    const expenseForm = page.locator('[data-expense-form]');
    await expenseForm.locator('[name="amount"]').fill('40.02'); await expenseForm.locator('[name="expense_date"]').fill('2026-09-09'); await expenseForm.locator('[name="merchant"]').fill('첫 사용처'); await expenseForm.locator('[name="account_id"]').selectOption(expenseId); await expenseForm.locator('[name="memo"]').fill('FIRST_EXPENSE');
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } }).png().toBuffer();
    const uploaded = dom(page, '[data-expense-form] [data-upload-state="ready"]'); await expenseForm.locator('[name="receipts"]').setInputFiles({ name: '첫 영수증.png', mimeType: 'image/png', buffer: png }); await uploaded;
    await expenseForm.locator('input[type="checkbox"]').check();
    const expenseAttempts = [];
    await page.route('**' + apiPrefix + '/expenses', async route => {
      expenseAttempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
      const response = await fixtureFetch(route); assert.equal(response.status(), 201); committed = await response.json();
      if (expenseAttempts.length === 1) await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: committed.id, status: 'confirmed' }) }); else await route.fulfill({ response });
    });
    const expenseUncertain = dom(page, '[data-expense-form][data-money-state="uncertain"]'); await expenseForm.locator('button[type="submit"]').click(); await expenseUncertain;
    assert.equal(await page.locator('[data-expense-success]').count(), 0); await capture('expense-uncertain');
    const firstExpenseId = committed.id;
    await recoverMoneyEntry({ page, origin, kind: 'expense', amount: '40.02', accountId: expenseId });
    await assertMoneyScopeIsolation({ page, origin, kind: 'expense', originalSession: browserSession, otherAccountSession, otherSpaceSession, amount: '40.02', accountId: expenseId });
    const expenseSaved = dom(page, '[data-expense-success]'); await expenseForm.locator('button[type="submit"]').click(); await expenseSaved;
    assert.deepEqual(expenseAttempts[0], expenseAttempts[1]);
    const savedExpenseId = committed.id; assert.equal(savedExpenseId, firstExpenseId); assert.deepEqual(await moneyPendingKeys(page), []); await page.unroute('**' + apiPrefix + '/expenses');
    await page.reload({ waitUntil: 'domcontentloaded' }); await dom(page, '[data-ledger-count="2"]'); await dom(page, '[data-detail-amount]'); await dom(page, '.expense-summary');
    assert.deepEqual(await page.locator('.expense-summary dd').allTextContents(), ['100.01', '40.02', '59.99']);
    assert.ok((await page.locator(`[data-transaction-id="${savedIncomeId}"]`).innerText()).includes('100.01'));
    assert.ok((await page.locator(`[data-transaction-id="${savedExpenseId}"]`).innerText()).includes('40.02'));
    const download = page.waitForEvent('download', { timeout: 10000 }); await page.locator('[data-receipt-download]').click(); assert.deepEqual(await downloadedBytes(await download), png);
    const csvDownload = page.waitForEvent('download', { timeout: 10000 }); await page.getByRole('button', { name: '필터 결과 전체 CSV 내보내기', exact: true }).click(); const csv = (await downloadedBytes(await csvDownload)).toString('utf8'); assert.match(csv, /FIRST_INCOME/); assert.match(csv, /FIRST_EXPENSE/); assert.match(csv, /100\.01/); assert.match(csv, /40\.02/);
    if (pg) { await page.locator('[data-expense-detail] details summary').click(); assert.equal(await page.locator('[data-expense-detail] tbody tr').count(), 2); }
    const receiptRecovery = insecureOriginRequested ? await receiptRetry({ page, apiPrefix, actor, request, id: savedExpenseId, capture }) : null;
    await capture('reload-ledger');
    const entries = (await request(actor, '/finance/transactions')).items; assert.equal(entries.length, 2);
    const audit = pg ? (await native.pool.query('SELECT resource,resource_id FROM accounting.record_events WHERE company_id=$1 ORDER BY id', [actor.orgId.slice(3)])).rows : database.db().prepare("SELECT action,resource_id FROM audit_event WHERE resource_id IN (?,?,?) ORDER BY rowid").all(actor.orgId, savedIncomeId, savedExpenseId);
    await assertMoneyLogout({ page, origin, session: browserSession, incomeId, apiPrefix, request, pg });
    result.cases.push({ pg, width, entries, audit, receiptRecovery, sameIncomeKey: attempts.every(item => item.key === attempts[0].key), sameExpenseKey: expenseAttempts.every(item => item.key === expenseAttempts[0].key), reloadNavigationRestored: true, otherAccountAndSpaceExcluded: true, confirmedAndLogoutCleared: true, net: '59.99' });
    await context.close();
  }
  assert.deepEqual(result.pageErrors, []); result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.error = error.stack;
  if (ledgerProbe) result.persistedAtFailure = (await ledgerProbe()).items;
  if (failurePage && !failurePage.isClosed()) await failurePage.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
  console.error(JSON.stringify({ pageErrors: result.pageErrors, moneyPosts: result.moneyPosts, persistedAtFailure: result.persistedAtFailure }));
  throw error;
}
finally {
  await browser?.close(); await browserServer?.close();
  if (vite) await new Promise((resolve, reject) => { vite.httpServer.close(error => error ? reject(error) : resolve()); vite.httpServer.closeAllConnections(); });
  if (server?.listening) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
  closeDb?.(); await closePgPool?.(); await native.close();
  result.cleaned = true; await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ status: result.status, chrome: result.chrome, cases: result.cases.length, screenshots: result.screenshots.length, cleaned: result.cleaned }));
}
