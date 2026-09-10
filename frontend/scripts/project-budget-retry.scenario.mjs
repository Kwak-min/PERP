import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { dom } from './deadline-expense-actions.mjs';
import { createOwnerOrg } from '../../backend/tests/http.js';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = path.join(root, '.omo/project-money/budget-retry');
await mkdir(evidence, { recursive: true });
const result = { passed: false, cases: [], pageErrors: [], screenshots: [] };
let native, server, vite, browserServer, browser, closeDb, closePgPool;
try {
  native = await startDailyNativePostgres();
  await native.pool.query(await readFile(new URL('../../db/perp_additions_v8.sql', import.meta.url), 'utf8'));
  const { createApp } = await import('../../backend/src/app.js');
  const { migrate } = await import('../../backend/src/config/migrate.js');
  const sqlite = await import('../../backend/src/config/db.js'); closeDb = sqlite.closeDb;
  ({ closePgPool } = await import('../../backend/src/config/pg.js')); migrate();
  server = createServer(createApp());
  const listening = once(server, 'listening', { signal: AbortSignal.timeout(10000) }); server.listen(0, '127.0.0.1'); await listening;
  const base = `http://127.0.0.1:${server.address().port}`;
  vite = await preview({ configFile: false, root: path.join(root, 'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT, preview: { host: '127.0.0.1', port: 0, proxy: { '/api': base } } });
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browserServer = await chromium.launchServer({ channel: 'chrome', headless: false, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  browser = await chromium.connect(browserServer.wsEndpoint()); result.chrome = browser.version();
  for (const pg of [false, true]) for (const width of [375, 1280]) {
    const prefix = pg ? '/pg' : '';
    async function request(actor, route, body, status = 201) {
      const response = await fetch(base + '/api/v1' + prefix + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
    }
    let actor;
    if (pg) {
      const signup = await request(null, '/auth/signup', { name: '예산 재시도', email: `${randomUUID()}@example.invalid`, password: 'password-1234' });
      actor = { token: signup.token }; actor.orgId = (await request(actor, '/companies', { name: '격리 예산', modules: ['projects', 'tasks', 'finance'] })).org_id;
    } else actor = await createOwnerOrg(base + '/api/v1', ['projects', 'tasks', 'finance']);
    const project = await request(actor, '/projects', { name: '예산 재시도 프로젝트' });
    const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' });
    try {
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await context.addInitScript(session => localStorage.setItem('orbitflow.session.v1', JSON.stringify(session)), { ...actor, name: '예산 검증', email: 'budget@example.invalid', mustChangePassword: false, organizations: [{ org_id: actor.orgId, org_name: '격리 예산', org_type: pg ? 'perp_db' : 'custom', roles: ['owner'] }] });
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => result.pageErrors.push(error.message));
      const moneyRoute = `/projects/${project.id}/money`, createPath = '/api/v1' + prefix + moneyRoute + '/budgets';
      await page.goto(`${origin}/projects/${project.id}`, { waitUntil: 'domcontentloaded' });
      await dom(page, '[data-project-money] [data-money-empty]');
      const panel = page.locator('[data-project-money]'), form = panel.locator('[data-project-budget-form]');
      await panel.getByRole('button', { name: '예산 배정', exact: true }).click();
      await form.locator('[name=budget_name]').fill('한 번만 배정'); await form.locator('[name=budget_amount]').fill('1000.01'); await form.getByRole('checkbox').check();
      const attempts = [], ids = [], states = [];
      await page.route('**' + createPath, async route => {
        attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
        // 모든 시도는 실제 budget/audit/replay transaction을 실행한다. 응답만 손상/거부한다.
        const response = await route.fetch(); assert.equal(response.status(), 201); ids.push((await response.json()).id);
        if (attempts.length === 1) await route.fulfill({ status: 201, contentType: 'application/json', body: '{' });
        else if (attempts.length <= 3) await route.fulfill({ status: attempts.length === 2 ? 400 : 403, contentType: 'application/json', body: JSON.stringify({ error: { code: attempts.length === 2 ? 'UPSTREAM_UNKNOWN' : 'PERMISSION_DENIED', message: 'Injected response', details: {}, request_id: 'budget-retry' } }) });
        else await route.fulfill({ response });
      });
      async function submitSettled(expectedPath = createPath) {
        // 전송 중 disabled 전환을 먼저 구독하고 해당 전송의 UI 종료까지 기다린다.
        await page.evaluate(() => {
          window.budgetSettled = new Promise((resolve, reject) => {
            let saving = false;
            const observer = new MutationObserver(check);
            const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('budget UI transition deadline')); }, 15000);
            function check() {
              const button = document.querySelector('[data-project-budget-form] button[type=submit]');
              if (button?.disabled) saving = true;
              if (saving && (!button || !button.disabled)) { observer.disconnect(); clearTimeout(timeout); resolve(); }
            }
            observer.observe(document.body, { attributes: true, childList: true, subtree: true }); check();
          });
        });
        const response = page.waitForResponse(value => new URL(value.url()).pathname === expectedPath && value.request().method() === 'POST');
        await form.locator('button[type=submit]').click(); const received = await response; await page.evaluate(() => window.budgetSettled); return received;
      }
      for (let step = 0; step < 4; step++) {
        const received = await submitSettled();
        assert.equal(received.status(), [201, 400, 403, 201][step]);
        if (step < 3) states.push({ inputLocked: await form.locator('[name=budget_amount]').isDisabled(), cancelLocked: await form.getByRole('button', { name: '취소', exact: true }).isDisabled() });
      }
      const summary = await request(actor, moneyRoute, undefined, 200);
      const budgets = pg ? (await native.pool.query('SELECT id::text FROM accounting.budgets WHERE company_id=$1 AND project_id=$2 AND name=$3', [actor.orgId.slice(3), project.id, '한 번만 배정'])).rows : sqlite.db().prepare('SELECT id FROM budget WHERE org_id=? AND project_id=? AND name=?').all(actor.orgId, project.id, '한 번만 배정');
      const audits = pg ? (await native.pool.query("SELECT COUNT(*)::int AS count FROM accounting.record_events WHERE company_id=$1 AND resource='budgets' AND resource_id=ANY($2::text[])", [actor.orgId.slice(3), budgets.map(row => row.id)])).rows[0].count : budgets.reduce((count, row) => count + sqlite.db().prepare("SELECT COUNT(*) AS count FROM audit_event WHERE resource_id=? AND action='project.budget.created'").get(row.id).count, 0);
      result.cases.push({ source: pg ? 'nativePG' : 'SQLite', width, ids, requestKeys: attempts.map(row => row.key), states, allocations: budgets.length, audits, allocated: summary.totals[0].allocated });
      assert.equal(budgets.length, 1, 'later response denials must not duplicate allocation'); assert.equal(audits, 1);
      assert.equal(summary.totals[0].allocated, '1000.01');
      for (const attempt of attempts) assert.deepEqual(attempt, attempts[0]);
      assert.ok(ids.every(id => id === ids[0])); assert.ok(states.every(state => state.inputLocked && state.cancelLocked));
      await page.unroute('**' + createPath);
      // 최초 VERSION_CONFLICT는 실제 rollback이다. 다른 유효 예산을 선택해 새 요청으로 진행할 수 있다.
      const stale = await request(actor, '/finance/budgets', pg ? { name: '먼저 수정된 예산', amount: '20.00' } : { name: '먼저 수정된 예산', amount_minor: 2000 });
      const available = await request(actor, '/finance/budgets', pg ? { name: '연결할 예산', amount: '30.00' } : { name: '연결할 예산', amount_minor: 3000 });
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(prefix + moneyRoute) && response.request().method() === 'GET');
      await panel.getByRole('button', { name: '재무 새로고침', exact: true }).click(); await refreshed;
      await panel.getByRole('button', { name: '예산 배정', exact: true }).click(); await form.getByRole('combobox').first().selectOption('associate'); await form.getByRole('combobox').nth(1).selectOption(stale.id); await form.getByRole('checkbox').check();
      if (pg) await native.pool.query('UPDATE accounting.budgets SET version=version+1 WHERE company_id=$1 AND id=$2', [actor.orgId.slice(3), stale.id]);
      else sqlite.db().prepare('UPDATE budget SET version=version+1 WHERE org_id=? AND id=?').run(actor.orgId, stale.id);
      const associationAttempts = [];
      const observe = req => { if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/associate')) associationAttempts.push({ key: req.headers()['idempotency-key'], path: new URL(req.url()).pathname, body: req.postDataJSON() }); }; page.on('request', observe);
      const conflict = await submitSettled(`${createPath}/${stale.id}/associate`); assert.equal(conflict.status(), 409); assert.equal((await conflict.json()).error.code, 'VERSION_CONFLICT');
      assert.equal(await form.getByRole('combobox').nth(1).isDisabled(), false); assert.equal(await form.getByRole('button', { name: '취소', exact: true }).isDisabled(), false);
      await form.getByRole('combobox').nth(1).selectOption(available.id);
      const associated = await submitSettled(`${createPath}/${available.id}/associate`); assert.equal(associated.status(), 200); assert.equal((await associated.json()).id, available.id);
      page.off('request', observe); assert.equal(associationAttempts.length, 2); assert.notEqual(associationAttempts[0].key, associationAttempts[1].key);
      result.cases.at(-1).initialVersionConflictRecoverable = true;
      await dom(page, `[data-money-budget="${available.id}"]`); await page.evaluate(() => document.fonts.ready);
      const screenshot = `${pg ? 'pg' : 'sqlite'}-${width}.png`; await page.screenshot({ path: path.join(evidence, screenshot), fullPage: true }); result.screenshots.push(screenshot);
    } finally { await context.close(); }
  }
  assert.deepEqual(result.pageErrors, []); result.passed = true;
} finally {
  await browser?.close(); await browserServer?.close();
  if (vite) await new Promise((resolve, reject) => { vite.httpServer.close(error => error ? reject(error) : resolve()); vite.httpServer.closeAllConnections(); });
  if (server?.listening) { const closed = once(server, 'close', { signal: AbortSignal.timeout(10000) }); server.close(); server.closeAllConnections(); await closed; }
  closeDb?.(); await closePgPool?.(); await native?.close();
  result.resourcesClosed = true; await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
