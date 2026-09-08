import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { assertIsolated } from '../../backend/tests/deadline-fixture.js';
import { networkAudit, protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';
import { expenseFixture } from './deadline-expense-fixture.mjs';
import { expenseActions } from './deadline-expense-actions.mjs';
import { expenseScope } from './deadline-expense-scope.mjs';

assertIsolated();
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = path.join(root, '.omo/evidence/task-18-deadline-erp-redesign');
await mkdir(evidence, { recursive: true });
process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'expense-receipts');
let server, vite, browserServer, browser, closeDb, closePgPool, native;
const result = { status: 'running', screens: [], resources: [], cases: [], http: [], pageErrors: [], hashes: {} };
try {
  if (process.env.DAILY_TEST_PG_BIN) {
    const { startDailyNativePostgres } = await import('../../backend/tests/daily-native-fixture.js');
    native = await startDailyNativePostgres();
    // runner의 미사용 DB용 100ms fail-fast를 실제 native 연결의 상한으로 사용하지 않는다.
    process.env.PG_CONNECTION_TIMEOUT_MS = '10000';
    const info = (await native.pool.query("SELECT current_setting('data_directory') AS directory, current_setting('port') AS port, version() AS version")).rows[0];
    result.resources.push({ kind: 'native-pg', ...info }); assert.match(info.version, /PostgreSQL 18\./);
  }
  const { createApp } = await import('../../backend/src/app.js');
  const { migrate } = await import('../../backend/src/config/migrate.js');
  ({ closeDb } = await import('../../backend/src/config/db.js'));
  ({ closePgPool } = await import('../../backend/src/config/pg.js'));
  migrate(); server = httpServer(createApp());
  const ready = once(server, 'listening', { signal: AbortSignal.timeout(10000) }); server.listen(0, '127.0.0.1'); await ready;
  const base = `http://127.0.0.1:${server.address().port}`;
  result.resources.push({ kind: 'api', port: server.address().port });
  vite = await preview({ configFile: false, root: path.join(root, 'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT,
    preview: { host: '127.0.0.1', port: 0, proxy: { '/api': base } } });
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  result.resources.push({ kind: 'vite-production', port: vite.httpServer.address().port });
  browserServer = await chromium.launchServer({ channel: 'chrome', headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  browser = await chromium.connect(browserServer.wsEndpoint()); result.chrome = browser.version();
  const profile = browserServer.process().spawnargs.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
  result.resources.push({ kind: 'chrome', pid: browserServer.process().pid, profile });
  for (const pg of native ? [false, true] : [false]) {
    const fixture = await expenseFixture({ base, native, pg, http: result.http });
    const context = await browser.newContext({ viewport: { width: 375, height: 900 }, timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.addInitScript(session => localStorage.setItem('orbitflow.session.v1', JSON.stringify(session)), {
      token: fixture.actor.token, orgId: fixture.actor.orgId, name: '비용 검증', email: 'expense@example.invalid', mustChangePassword: false,
      organizations: [{ org_id: fixture.actor.orgId, org_name: '격리 재무', org_type: pg ? 'perp_db' : 'custom', roles: ['owner'] }],
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => result.pageErrors.push(error.message));
    await page.goto(origin + '/finance', { waitUntil: 'domcontentloaded' });
    await expenseActions({ page, fixture, evidence, result, origin });
    await expenseScope({ page, fixture, origin, result });
    await context.close();
  }
  assert.deepEqual(result.pageErrors, []); assert.equal(networkAudit.blocked.length, 0);
  for (const resource of result.resources) if (resource.port) assert.ok(!protectedPorts.has(Number(resource.port)));
  result.nativePostgres = native ? 'exercised' : 'not exercised'; result.status = 'passed';
} catch (error) { result.status = 'failed'; result.error = error.stack; throw error; }
finally {
  await browser?.close(); await browserServer?.close();
  if (vite) await new Promise((resolve, reject) => { vite.httpServer.close(error => error ? reject(error) : resolve()); vite.httpServer.closeAllConnections(); });
  if (server?.listening) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
  closeDb?.(); await closePgPool?.(); await native?.close();
  for (const resource of result.resources) { resource.closed = true; if (resource.profile) resource.profileRemoved = !existsSync(resource.profile); if (resource.directory) resource.directoryRemoved = !existsSync(resource.directory); }
  for (const file of ['frontend/src/screens/ExpenseScreen.tsx', 'frontend/src/screens/expenses/FinanceOverview.tsx', 'backend/src/controllers/pgModules.controller.js', 'frontend/src/screens/expenses/model.ts', 'frontend/src/screens/expenses/ExpenseDetail.tsx', 'frontend/src/screens/expenses/expense.css', 'frontend/src/components/common/ExpenseForm.tsx', 'frontend/src/components/common/ReceiptUploads.tsx', 'frontend/src/services/api.ts', 'frontend/src/screens/registry.ts']) result.hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify({ status: 'complete', resources: result.resources, network: networkAudit, livePortsUsed: false }, null, 2));
  console.log(JSON.stringify({ status: result.status, cases: result.cases, screenshots: result.screens.length }));
}
