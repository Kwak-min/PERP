import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { createOwnerOrg } from '../../backend/tests/http.js';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';
import { dom } from './deadline-expense-actions.mjs';
import { switchMoneySession } from './money-retry-actions.mjs';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = path.join(root, '.omo/evidence/partial-money'); await mkdir(evidence, { recursive: true });
const native = await startDailyNativePostgres();
let server, vite, browserServer, browser, closeDb, closePgPool;
const result = { status: 'running', cases: [], failures: [], pageErrors: [] };
// 각 비동기 조회가 반영된 DOM 상태를 관찰한다. 지연/폴링이나 문구 비교는 하지 않는다.
const loaded = '.expense-screen:has([data-ledger-count]):has([data-finance-setup]):not(:has([data-finance-setup] [role="status"])):not(:has(> p[role="status"]:not([data-expense-success]))) [data-expense-entry]';
try {
  for (const file of ['perp_additions_v8.sql', 'perp_additions_v16_deadline_expense_imports.sql']) await native.pool.query(await readFile(path.join(root, 'db', file), 'utf8'));
  const { createApp } = await import('../../backend/src/app.js');
  const { migrate } = await import('../../backend/src/config/migrate.js');
  const database = await import('../../backend/src/config/db.js'); closeDb = database.closeDb;
  ({ closePgPool } = await import('../../backend/src/config/pg.js'));
  migrate(); server = createServer(createApp());
  const listening = once(server, 'listening', { signal: AbortSignal.timeout(10000) }); server.listen(0, '127.0.0.1'); await listening;
  const base = `http://127.0.0.1:${server.address().port}`;
  vite = await preview({ configFile: false, root: path.join(root, 'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT, preview: { host: '127.0.0.1', port: 0, proxy: { '/api': base } } });
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browserServer = await chromium.launchServer({ channel: 'chrome', headless: false, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  browser = await chromium.connect(browserServer.wsEndpoint()); result.chrome = browser.version();
  for (const pg of [false, true]) for (const chart of pg ? ['expense', 'income', 'empty', 'no-cash'] : ['expense', 'income', 'empty']) for (const width of [1280, 375]) {
    const prefix = pg ? '/pg' : '', item = { pg, chart, width };
    let context;
    try {
      async function request(actor, route, body, status = 200) {
        const response = await fetch(base + '/api/v1' + prefix + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
        const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
      }
      let actor;
      if (pg) {
        const signup = await request(null, '/auth/signup', { name: '분류 검증', email: `${randomUUID()}@example.invalid`, password: 'password-1234' }, 201);
        actor = { token: signup.token, userId: signup.user.id };
        actor.orgId = (await request(actor, '/companies', { name: '기존 부분 장부', modules: ['finance'] }, 201)).org_id;
      } else actor = await createOwnerOrg(base + '/api/v1', ['finance']);
      const directions = chart === 'no-cash' ? ['income', 'expense'] : chart === 'empty' ? [] : [chart];
      for (const direction of directions) {
        if (pg) await native.pool.query('INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,$2,$3,$4)', [actor.orgId.slice(3), direction === 'income' ? 'REV' : 'EXP', direction, direction === 'income' ? 'revenue' : 'expense']);
        else await request(actor, '/finance/accounts', { code: direction === 'income' ? 'REV' : 'EXP', name: direction, kind: direction }, 201);
      }
      if (pg && ['income', 'expense'].includes(chart)) await native.pool.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,'CASH','Cash','asset')", [actor.orgId.slice(3)]);
      if (pg) await native.pool.query("DELETE FROM org.role_permissions rp USING org.roles r,org.permissions p WHERE rp.role_id=r.id AND rp.permission_id=p.id AND r.company_id=$1 AND p.code='organization.settings'", [actor.orgId.slice(3)]);
      else database.db().prepare("UPDATE membership SET roles='treasurer' WHERE org_id=? AND user_id=?").run(actor.orgId, actor.userId);
      const setup = await request(actor, '/finance/setup'); assert.equal(setup.ready, false); assert.equal(setup.can_initialize, false);
      const missing = chart === 'expense' ? ['income'] : chart === 'income' ? ['expense'] : chart === 'no-cash' ? ['cash'] : pg ? ['cash', 'income', 'expense'] : ['income', 'expense'];
      assert.deepEqual(setup.missing, missing); await request(actor, '/finance/setup', {}, 403);
      const accounts = (await request(actor, '/finance/accounts')).items;
      const me = await request(actor, '/auth/me');
      context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Asia/Seoul' });
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => result.pageErrors.push(error.message));
      await page.goto(origin + '/login', { waitUntil: 'domcontentloaded' });
      await switchMoneySession(page, origin, { ...actor, name: '거래 작성자', email: pg ? me.user.email : me.email, mustChangePassword: false, organizations: [{ org_id: actor.orgId, org_name: '부분 장부', org_type: pg ? 'perp_db' : 'custom', roles: ['treasurer'] }] });
      await dom(page, loaded);
      const disabled = { income: await page.locator('[data-income-entry]').isDisabled(), expense: await page.locator('[data-expense-entry]').isDisabled(), csv: await page.locator('[data-expense-import-entry]').isDisabled() };
      item.missing = missing; item.disabled = disabled;
      assert.equal(await page.locator('[data-finance-prepare]').count(), 0);
      assert.deepEqual(disabled, { income: chart !== 'income', expense: chart !== 'expense', csv: chart !== 'expense' }, `${pg ? 'PG' : 'SQLite'} ${chart} direction-specific readiness`);
      if (chart === 'empty' || chart === 'no-cash') {
        for (const direction of ['income', 'expense']) {
          await page.goto(origin + '/finance?new=' + direction, { waitUntil: 'domcontentloaded' }); await dom(page, loaded);
          assert.equal(await page.locator('[data-income-form], [data-expense-form], [data-expense-import]').count(), 0);
        }
        item.entries = 0;
      } else {
        const account = accounts.find(row => (row.kind ?? row.account_type) === (pg && chart === 'income' ? 'revenue' : chart)), accountId = account.id ?? account.value;
        if (chart === 'expense') {
          const opened = dom(page, '[data-expense-import]'); await page.locator('[data-expense-import-entry]').click(); await opened;
          const panel = page.locator('[data-expense-import]');
          const upload = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/imports/uploads'));
          await panel.locator('input[type="file"]').setInputFiles({ name: 'partial.csv', mimeType: 'text/csv', buffer: Buffer.from('일자,사용처,금액,계정코드\n2026-09-09,CSV_PARTIAL,10.01,EXP\n') }); assert.equal((await upload).status(), 201);
          await dom(page, `[data-expense-import] option[value="${accountId}"]`);
          await panel.getByLabel('CSV 계정 코드', { exact: true }).fill('EXP'); await panel.locator(`select:has(option[value="${accountId}"])`).selectOption(accountId);
          await panel.getByRole('button', { name: '계정 매핑 추가', exact: true }).click(); await panel.getByLabel('영수증 미첨부 사유', { exact: true }).fill('CSV 원본 미발급'); await panel.getByRole('checkbox', { name: /헤더 매핑/ }).check();
          const previewed = dom(page, '[data-expense-import] tbody tr'); await panel.getByRole('button', { name: '전체 미리보기 만들기', exact: true }).click(); await previewed;
          const committed = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/commit'));
          await panel.getByRole('button', { name: '검토한 선택 행 적용', exact: true }).click(); const response = await committed; assert.equal(response.status(), 200); assert.equal((await response.json()).summary.created, 1);
          await dom(page, '[data-ledger-count="1"]'); await panel.getByRole('button', { name: '가져오기 닫기', exact: true }).click(); item.csvCreated = 1;
        }
        const opened = dom(page, `[data-${chart}-form] option[value="${accountId}"]`); await page.locator(`[data-${chart}-entry]`).click(); await opened;
        const form = page.locator(`[data-${chart}-form]`);
        await form.locator('[name="amount"]').fill('40.02'); await form.locator(`[name="${chart}_date"]`).fill('2026-09-09'); await form.locator(`[name="${chart === 'income' ? 'payer' : 'merchant'}"]`).fill('PARTIAL_WRITER'); await form.locator('[name="account_id"]').selectOption(accountId); await form.locator('[name="memo"]').fill('PARTIAL_RECORD');
        if (chart === 'expense') await form.locator('[name="no_receipt_reason"]').fill('원본 미발급');
        await form.locator('input[type="checkbox"]').check();
        const attempts = [], ids = [], url = '**/api/v1' + prefix + '/finance/' + (chart === 'income' ? 'incomes' : 'expenses');
        await page.route(url, async route => { attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() }); const response = await route.fetch(); assert.equal(response.status(), 201); ids.push((await response.json()).id); if (attempts.length === 1) await route.fulfill({ status: 201, contentType: 'application/json', body: '{' }); else await route.fulfill({ response }); });
        const uncertain = dom(page, `[data-${chart}-form][data-money-state="uncertain"]`); await form.locator('button[type="submit"]').click(); await uncertain;
        await page.reload({ waitUntil: 'domcontentloaded' }); await dom(page, `[data-${chart}-form][data-money-state="uncertain"]`);
        const saved = dom(page, '[data-expense-success]'); await form.locator('button[type="submit"]').click(); await saved;
        assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]); assert.equal(ids[0], ids[1]); item.recoveredId = ids[0];
        const entries = (await request(actor, '/finance/transactions')).items; assert.equal(entries.length, chart === 'expense' ? 2 : 1); item.entries = entries.length;
        assert.deepEqual(await request(actor, '/finance/setup'), setup);
      }
      await page.waitForLoadState('load'); await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator('.expense-panel').first().evaluate(element => getComputedStyle(element).borderTopStyle), 'solid');
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: path.join(evidence, `${pg ? 'pg' : 'sqlite'}-${chart}-${width}.png`), fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      item.status = 'passed';
    } catch (error) { item.status = 'failed'; item.error = error.stack; result.failures.push({ pg, chart, width, error: error.message }); }
    finally { await context?.close(); result.cases.push(item); }
  }
  assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.failures, []); result.status = 'passed';
} catch (error) { result.status = 'failed'; result.error = error.stack; throw error; }
finally {
  await browser?.close(); await browserServer?.close();
  if (vite) await new Promise((resolve, reject) => { vite.httpServer.close(error => error ? reject(error) : resolve()); vite.httpServer.closeAllConnections(); });
  if (server?.listening) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
  closeDb?.(); await closePgPool?.(); await native.close(); result.cleaned = true;
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ status: result.status, cases: result.cases, cleaned: result.cleaned }));
}
