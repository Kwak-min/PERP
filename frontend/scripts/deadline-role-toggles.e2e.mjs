import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { startDeadlineServer, createDeadlineFixture } from '../../backend/tests/deadline-fixture.js';
import { networkAudit, protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';

// DOM 이벤트를 작업 전에 구독한다. 타이머는 실패 상한에만 쓴다.
export async function armDom(page, selector) {
  await page.evaluate(selector => {
    window.roleSignal = new Promise((resolve, reject) => {
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`DOM signal: ${selector}`)); }, 15000);
      function check() { if (document.querySelector(selector)) { clearTimeout(timer); observer.disconnect(); resolve(); } }
      observer.observe(document.documentElement, { childList: true, attributes: true, subtree: true }); check();
    });
  }, selector);
  return () => page.evaluate(() => window.roleSignal);
}
export async function roleTogglesScenario(native = false) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const evidence = path.join(root, '.omo/evidence/task-8-deadline-erp-redesign');
  const attempt = path.join(evidence, process.env.DEADLINE_RUN_ID);
  await mkdir(attempt, { recursive: true });
  const result = { status: 'running', native, checks: [], screens: [], responses: [], resources: [], errors: [], hashes: {}, browserRequests: [], blockedBrowserRequests: [], liveServicesUsed: false };
  for (const file of ['frontend/src/screens/RoleSettingsScreen.tsx', 'frontend/src/screens/role-settings.css', 'frontend/src/screens/role-settings-model.ts', 'frontend/scripts/deadline-role-toggles.e2e.mjs', 'frontend/scripts/deadline-role-toggles.cases.mjs', 'frontend/scripts/deadline-role-definition.cases.mjs', 'frontend/scripts/deadline-role-boundaries.cases.mjs', 'frontend/scripts/deadline-role-native.fixture.mjs', 'frontend/scripts/deadline-role-model.test.mjs', 'frontend/scripts/deadline-qa.e2e.mjs']) result.hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  let api, vite, browserServer, browser, pgFixture;
  const responseTasks = [];
  try {
    api = await startDeadlineServer(); result.resources.push(api.resource);
    const fixture = native ? await (async () => { pgFixture = await (await import('./deadline-role-native.fixture.mjs')).nativeRoleFixture(api); return pgFixture.fixture; })() : await createDeadlineFixture(api);
    if (native) result.engine = pgFixture.engine;
    const admin = fixture.actorAdmin;
    const role = await api.request(admin, '/settings/roles', 'POST', { name: 'UI CAS 역할', scope: 'all', permissions: ['task.read', 'menu.projects'] }, 201);
    vite = await createServer({ configFile: false, root: path.join(root, 'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT, cacheDir: path.join(process.env.DEADLINE_TEMP_ROOT, 'vite-cache'), plugins: [react()],
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(api.baseUrl).origin }, watch: { ignored: ['**/.omo/**', '**/dist/**'] } } });
    await vite.listen();
    const port = vite.httpServer.address().port; assert.ok(!protectedPorts.has(port));
    result.resources.push({ kind: 'vite', port, closed: false });
    const origin = `http://127.0.0.1:${port}`;
    browserServer = await chromium.launchServer({ channel: 'chrome', headless: true, args: ['--disable-background-networking', '--disable-sync', '--disable-component-update'] });
    const child = browserServer.process();
    result.resources.push({ kind: 'chrome', pid: child.pid, port: Number(new URL(browserServer.wsEndpoint()).port), profile: child.spawnargs.find(arg => arg.startsWith('--user-data-dir='))?.slice(16), closed: false });
    browser = await chromium.connect(browserServer.wsEndpoint()); result.chrome = browser.version();
    async function actorContext(actor) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && !protectedPorts.has(Number(url.port))) { result.browserRequests.push({ url: url.href, method: route.request().method() }); return route.continue(); }
        result.blockedBrowserRequests.push({ url: url.href, method: route.request().method() }); return route.abort('blockedbyclient');
      });
      await context.routeWebSocket('**/*', socket => {
        const url = new URL(socket.url());
        if (url.host === new URL(origin).host && !protectedPorts.has(Number(url.port))) { result.browserRequests.push({ url: url.href, method: 'WEBSOCKET' }); socket.connectToServer(); }
        else { result.blockedBrowserRequests.push({ url: url.href, method: 'WEBSOCKET' }); socket.close(); }
      });
      await context.addInitScript(session => { localStorage.setItem('orbitflow.session.v1', JSON.stringify(session)); }, actor.session);
      return context;
    }
    const context = await actorContext(admin);
    async function openPage(actor = admin) {
      const actorBrowser = actor === admin ? context : await actorContext(actor);
      const page = await actorBrowser.newPage(); page.setDefaultTimeout(15000);
      page.on('pageerror', error => result.errors.push(error.message));
      page.on('response', response => {
        if (!new URL(response.url()).pathname.startsWith('/api/v1/settings/')) return;
        responseTasks.push((async () => {
          const record = { path: new URL(response.url()).pathname, method: response.request().method(), status: response.status(), request: response.request().postDataJSON() };
          try { record.body = response.status() === 204 ? null : await response.json(); }
          catch (error) { record.bodyError = error.message; record.pageClosed = page.isClosed(); }
          result.responses.push(record);
        })());
      });
      await page.goto(origin + '/settings/roles', { waitUntil: 'domcontentloaded' });
      const ready = await armDom(page, actor.orgId === admin.orgId ? `[data-testid="role-${role.key}"]` : '[data-testid="role-definition-editor"]'); await ready();
      return page;
    }
    const page = await openPage();
    await page.locator(`[data-testid="role-${role.key}"]`).getByRole('button', { name: '수정', exact: true }).click();
    await page.getByLabel('역할 이름', { exact: true }).fill('UI CAS 저장');
    const saved = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/settings/roles/${role.key}` && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: '역할 저장', exact: true }).click();
    const response = await saved;
    await page.screenshot({ path: path.join(attempt, 'first-save.png'), fullPage: true, animations: 'disabled' });
    assert.equal(response.status(), 200, 'existing role UI must send expected_version from the definition DTO');
    assert.equal(response.request().postDataJSON().expected_version, role.version);
    result.checks.push('definition-explicit-CAS');
    await (await import('./deadline-role-toggles.cases.mjs')).roleCases({ page, openPage, api, fixture, role, result, attempt, armDom });
    assert.deepEqual(result.errors, []); assert.equal(networkAudit.blocked.length, 0);
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.errors.push(error.stack); console.error(error); process.exitCode = 1; }
  finally {
    const errors = [];
    await Promise.all(responseTasks);
    for (const [kind, close] of [['browser', () => browser?.close()], ['chrome', () => browserServer?.close()], ['vite', () => vite?.close()], ['api', () => api?.close()], ['pg', () => pgFixture?.close()]]) {
      try { await close(); const resource = result.resources.find(item => item.kind === kind); if (resource) resource.closed = true; } catch (error) { errors.push({ kind, message: error.message }); }
    }
    await Promise.all(responseTasks);
    const chrome = result.resources.find(item => item.kind === 'chrome'); if (chrome) chrome.profileRemoved = !existsSync(chrome.profile);
    result.http = api?.http; result.network = networkAudit; result.pgCleanup = pgFixture?.resource;
    if (errors.length) { result.status = 'failed'; process.exitCode = 1; }
    const cleanup = { status: errors.length ? 'failed' : 'complete', resources: result.resources, pg: pgFixture?.resource, errors, browserExited: browserServer?.process().exitCode !== null, liveServiceRequests: 0 };
    for (const folder of [attempt, evidence]) {
      await writeFile(path.join(folder, native ? 'native-scenario.json' : 'scenario.json'), JSON.stringify(result, null, 2));
      await writeFile(path.join(folder, native ? 'native-cleanup.json' : 'cleanup.json'), JSON.stringify(cleanup, null, 2));
    }
    console.log(JSON.stringify({ status: result.status, attempt, native, checks: result.checks.length }));
  }
}
