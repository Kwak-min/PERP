import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { startDeadlineServer, createDeadlineFixture } from '../../backend/tests/deadline-fixture.js';
import { networkAudit, protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function navPrefScenario(probe) {
  const evidence = path.join(root, '.omo/evidence/task-4-deadline-erp-redesign', ...(probe ? [`probe-${probe}`] : []));
  await mkdir(evidence, { recursive: true });
  await rm(path.join(evidence, 'screen.png'), { force: true });
  const result = { runId: randomUUID(), scenario: 'nav-pref', status: 'running', resources: [], errors: [], blockedBrowserRequests: [], observations: {} };
  result.provenance = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim(), files: {} };
  for (const file of ['frontend/src/store/navPref.ts', 'frontend/scripts/deadline-nav-pref.test.mjs', 'frontend/scripts/deadline-nav-pref.e2e.mjs', 'frontend/scripts/deadline-qa.e2e.mjs']) {
    result.provenance.files[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  }
  await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify({ runId: result.runId, status: 'pending' }));
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('DEADLINE_CANCELLED'));
  const onMessage = message => { if (message?.type === 'deadline:cancel') cancel(); };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel); process.on('message', onMessage);
  let api, vite, browserServer, browser;
  let closeForAbort = () => {};
  controller.signal.addEventListener('abort', () => closeForAbort(), { once: true });
  try {
    api = await startDeadlineServer(controller.signal); result.resources.push(api.resource);
    vite = await createServer({ configFile: false, root: path.join(root, 'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT,
      plugins: [react()], server: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(api.baseUrl).origin }, watch: { ignored: ['**/.omo/**', '**/dist/**'] } } });
    await vite.listen();
    const port = vite.httpServer.address().port;
    assert.ok(!protectedPorts.has(port));
    result.resources.push({ kind: 'vite', pid: process.pid, port, closed: false });
    const origin = `http://127.0.0.1:${port}`;
    browserServer = await chromium.launchServer({ channel: 'chrome', headless: true, timeout: 20000, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
    const child = browserServer.process();
    const controlPort = Number(new URL(browserServer.wsEndpoint()).port);
    assert.ok(!protectedPorts.has(controlPort));
    result.resources.push({ kind: 'chrome', pid: child.pid, port: controlPort, profile: child.spawnargs.find(arg => arg.startsWith('--user-data-dir='))?.slice(16), closed: false });
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 10000 });
    result.chrome = browser.version(); result.frontend = origin;
    closeForAbort = () => { void browser.close().catch(error => result.errors.push({ phase: 'abort-browser', message: error.message })); };
    if (probe) {
      process.send?.({ type: 'deadline:ready', runId: result.runId, evidence, resources: result.resources });
      if (probe === 'error') throw new Error('DEADLINE_INJECTED_AFTER_RESOURCES');
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Cancellation signal missing')), 15000);
        const aborted = () => { clearTimeout(timeout); resolve(); };
        controller.signal.addEventListener('abort', aborted, { once: true });
        if (controller.signal.aborted) aborted();
      });
      controller.signal.throwIfAborted();
    }
    const fixture = await createDeadlineFixture(api);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && !protectedPorts.has(Number(url.port))) return route.continue();
      result.blockedBrowserRequests.push({ url: url.href, method: route.request().method() });
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (url.host === new URL(origin).host) socket.connectToServer();
      else { result.blockedBrowserRequests.push({ url: url.href, method: 'WEBSOCKET' }); socket.close(); }
    });
    await context.addInitScript(session => {
      sessionStorage.setItem('orbitflow.session.v1', JSON.stringify(session));
      localStorage.setItem('orbitflow.demoMode', '0');
    }, fixture.actorAdmin.session);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const membersReady = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/members', { timeout: 15000 });
    await page.goto(origin + '/members', { waitUntil: 'domcontentloaded' });
    assert.equal((await membersReady).status(), 200);
    await page.evaluate(() => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Member render deadline')); }, 15000);
      const check = () => { if (document.querySelector('.org-directory__table tbody tr')) { clearTimeout(timeout); observer.disconnect(); resolve(); } };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true }); check();
    }));
    // 제품 화면은 그대로 둔다. 별도 모듈 import와 실제 Storage API가 task 4의 검증 surface다.
    const scopes = await page.evaluate(async sessions => {
      const { apiRequest } = await import('/src/services/api.ts');
      return Promise.all(sessions.map(async session => {
        const me = await apiRequest('/auth/me', { session });
        return { userId: me.id, source: 'legacy', orgId: session.orgId };
      }));
    }, [fixture.actorAdmin.session, fixture.actorManager.session, fixture.B.actor.session]);
    assert.deepEqual(scopes.map(scope => scope.userId), [fixture.actorAdmin.userId, fixture.actorManager.userId, fixture.B.actor.userId]);
    result.observations.storage = await page.evaluate(async scopes => {
      const p = await import('/src/store/navPref.ts');
      const [A, manager, B] = scopes;
      const expected = { version: 1, favoriteScreenIds: ['CAL-001', 'PRJ-001', 'AST-001'], collapsedSectionIds: ['work', 'people'] };
      p.writeNavPref(A, { ...expected, favoriteScreenIds: ['CAL-001', 'PRJ-001', 'CAL-001', 'removed', 'AST-001'], token: 'DO_NOT_PERSIST', content: 'PRIVATE_NOTE' });
      p.writeNavPref(manager, { ...expected, favoriteScreenIds: ['PRJ-001', 'AST-001'] });
      p.writeNavPref(B, { ...expected, favoriteScreenIds: ['DOC-001'] });
      const sameUserOtherCompany = { ...A, orgId: B.orgId };
      const sameIDsOtherSource = { ...A, source: 'pg' };
      const isolated = [sameUserOtherCompany, sameIDsOtherSource].map(scope => p.readNavPref(scope));
      // 늦은 처리도 명시 scope에 고정되어 다른 회사의 값을 덮어쓰지 않는다.
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const stale = gate.then(() => p.updateNavPref(A, current => ({ ...current, favoriteScreenIds: [...current.favoriteScreenIds].reverse() })));
      p.updateNavPref(B, current => ({ ...current, collapsedSectionIds: ['knowledge'] }));
      release(); await stale;
      return { A: p.readNavPref(A), B: p.readNavPref(B), isolated, entries: Object.entries(localStorage).filter(([key]) => key.startsWith('orbitflow.nav.v1:')) };
    }, scopes);
    const expectedA = { version: 1, favoriteScreenIds: ['AST-001', 'PRJ-001', 'CAL-001'], collapsedSectionIds: ['work', 'people'] };
    assert.deepEqual(result.observations.storage.A, { status: 'ready', value: expectedA });
    assert.deepEqual(result.observations.storage.B.value.favoriteScreenIds, ['DOC-001']);
    assert.deepEqual(result.observations.storage.B.value.collapsedSectionIds, ['knowledge']);
    assert.ok(result.observations.storage.isolated.every(read => read.status === 'empty'));
    assert.equal(result.observations.storage.entries.length, 3);
    for (const [, raw] of result.observations.storage.entries) {
      assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['collapsedSectionIds', 'favoriteScreenIds', 'version']);
      assert.ok(!raw.includes('DO_NOT_PERSIST') && !raw.includes('PRIVATE_NOTE'));
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    result.observations.reload = await page.evaluate(async scope => (await import('/src/store/navPref.ts')).readNavPref(scope), scopes[0]);
    assert.deepEqual(result.observations.reload, { status: 'ready', value: expectedA });
    async function projectManagerFavorites() {
      return page.evaluate(async ({ session, scope }) => {
        const [p, { apiRequest }, { canOpenScreen }, { navigation }] = await Promise.all([
          import('/src/store/navPref.ts'), import('/src/services/api.ts'), import('/src/hooks/useWorkspaceAccess.tsx'), import('/src/routes/catalog.ts'),
        ]);
        const access = await apiRequest('/settings/access', { session });
        return { ids: p.selectNavFavorites(p.readNavPref(scope).value, navigation.filter(screen => canOpenScreen(access, screen))).map(screen => screen.id), raw: localStorage.getItem(p.navPrefKey(scope)), access };
      }, { session: fixture.actorManager.session, scope: scopes[1] });
    }
    const assignments = await api.request(fixture.actorAdmin, '/settings/members');
    const manager = assignments.items.find(member => member.membership_id === fixture.actorManager.membershipId);
    const originalRoles = manager.roles;
    result.observations.granted = await projectManagerFavorites();
    assert.deepEqual(result.observations.granted.ids, ['PRJ-001']);
    const revoked = await api.request(fixture.actorAdmin, `/settings/members/${fixture.actorManager.membershipId}/roles`, 'PUT', { roles: [], expected_roles_version: manager.roles_version });
    result.observations.revoked = await projectManagerFavorites();
    assert.deepEqual(result.observations.revoked.ids, []);
    assert.equal(result.observations.revoked.raw, result.observations.granted.raw);
    await api.request(fixture.actorAdmin, `/settings/members/${fixture.actorManager.membershipId}/roles`, 'PUT', { roles: originalRoles, expected_roles_version: revoked.roles_version });
    result.observations.restored = await projectManagerFavorites();
    assert.deepEqual(result.observations.restored.ids, ['PRJ-001']);
    assert.equal(result.observations.restored.raw, result.observations.granted.raw);
    result.observations.corrupt = await page.evaluate(async scope => {
      const p = await import('/src/store/navPref.ts');
      const { screens } = await import('/src/routes/catalog.ts');
      localStorage.setItem(p.navPrefKey(scope), '{');
      const invalid = p.readNavPref(scope);
      p.updateNavPref(scope, current => ({ ...current, favoriteScreenIds: ['PRJ-002', 'removed', 'PRJ-001', 'PRJ-001'] }));
      return { invalid, repaired: p.readNavPref(scope), visible: p.selectNavFavorites(p.readNavPref(scope).value, screens).map(screen => screen.id) };
    }, scopes[2]);
    assert.equal(result.observations.corrupt.invalid.status, 'invalid');
    assert.equal(result.observations.corrupt.repaired.status, 'ready');
    assert.deepEqual(result.observations.corrupt.visible, ['PRJ-001']);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(evidence, 'screen.png'), fullPage: true, animations: 'disabled' });
    assert.deepEqual(pageErrors, []); assert.equal(networkAudit.blocked.length, 0);
    result.limitations = ['AppShell pin/collapse controls are task 5, not changed or claimed here', 'PG source key separation exercised with real localStorage; no native PG API claimed', 'External fonts blocked; real application screenshot uses system fallback'];
    await context.unrouteAll({ behavior: 'wait' }); await context.close();
    result.status = 'passed';
  } catch (error) {
    result.status = controller.signal.aborted ? 'cancelled' : 'failed';
    result.errors.push({ phase: 'scenario', message: error.message, stack: error.stack });
    console.error(error); process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    closeForAbort = () => {};
    const errors = [];
    async function close(kind, action) {
      try { await action(); const resource = result.resources.find(resource => resource.kind === kind); if (resource) resource.closed = true; }
      catch (error) { errors.push({ kind, message: error.message }); }
    }
    await close('browser-connection', () => browser?.close());
    await close('chrome', async () => {
      await browserServer?.close();
      const chrome = result.resources.find(resource => resource.kind === 'chrome');
      if (chrome?.profile) { chrome.profileRemoved = !existsSync(chrome.profile); assert.ok(chrome.profileRemoved); }
    });
    await close('vite', () => vite?.close());
    await close('api', () => api?.close());
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel); process.off('message', onMessage);
    result.http = api?.http ?? []; result.network = networkAudit;
    if (errors.length) { result.status = 'failed'; process.exitCode = 1; }
    if (result.status !== 'passed') await rm(path.join(evidence, 'screen.png'), { force: true });
    await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify({ runId: result.runId, status: errors.length ? 'failed' : 'complete', resources: result.resources, errors,
      browserExited: browserServer ? browserServer.process().exitCode !== null || browserServer.process().signalCode !== null : null,
      protectedPorts: [...protectedPorts], liveServiceRequests: networkAudit.blocked.length }, null, 2));
    console.log(JSON.stringify({ type: 'deadline:complete', runId: result.runId, status: result.status, evidence, cleanup: errors.length ? 'failed' : 'complete' }));
  }
}
