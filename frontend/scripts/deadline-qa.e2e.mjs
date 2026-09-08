import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, rm, copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { assertIsolated, startDeadlineServer, createDeadlineFixture, evidenceBody } from '../../backend/tests/deadline-fixture.js';
import { networkAudit, protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const sharedScenarioArgs = args[0] === '--scenario'
  && ['baseline', 'recruitment-nav', 'nav-pref', 'members-pagination', 'assets-footer'].includes(args[1])
  && (args.length === 2 || (args.length === 4 && args[2] === '--probe' && ['error', 'cancel'].includes(args[3])));
const dedicatedScenarioArgs = args.length === 2 && args[0] === '--scenario' && ['month-summary', 'roles'].includes(args[1]);
if (!sharedScenarioArgs && !dedicatedScenarioArgs) {
  console.error('Usage: deadline-qa.e2e.mjs --scenario baseline|recruitment-nav|nav-pref|members-pagination|assets-footer [--probe error|cancel] | --scenario month-summary|roles');
  process.exitCode = 2;
} else {
  assertIsolated();
  if (args[1] === 'roles') await (await import('./deadline-roles-qa.mjs')).rolesScenario();
  else if (args[1] === 'month-summary') await (await import('./deadline-month-summary.e2e.mjs')).monthSummary();
  else if (args[1] === 'nav-pref') await (await import('./deadline-nav-pref.e2e.mjs')).navPrefScenario(args[3]);
  else await baseline(args[3], args[1]);
}

// 브라우저 DOM 변경 신호를 기다린다. sleep/networkidle/polling으로 완성을 추정하지 않는다.
async function rendered(page, selector) {
  await page.evaluate(selector => new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Render deadline: ${selector}`)); }, 15000);
    function check() {
      if (document.querySelector(selector) && !document.querySelector('main .spinner')) {
        clearTimeout(timer); observer.disconnect(); resolve(true);
      }
    }
    observer.observe(document.documentElement, { childList: true, attributes: true, subtree: true });
    check();
  }), selector);
}

async function baseline(probe, scenario) {
  const evidence = path.join(root, `.omo/evidence/task-${scenario === 'recruitment-nav' ? 3 : scenario === 'members-pagination' ? 6 : scenario === 'assets-footer' ? 7 : 1}-deadline-erp-redesign`, ...(probe ? [`probe-${probe}`] : []));
  const runId = randomUUID(), attempt = path.join(evidence, 'runs', runId);
  await mkdir(attempt, { recursive: true });
  // 이전 성공 스크린샷을 현재 실패의 증거로 오인하지 않도록 current pointer를 먼저 무효화한다.
  await rm(path.join(evidence, 'screen.png'), { force: true });
  const result = { runId, status: 'running', scenario, probe: probe ?? null, source: 'legacy SQLite / actual HTTP APIs', surfaces: [], http: [], blockedBrowserRequests: [], browserResponses: [], errors: [], resources: [], nativePostgres: 'not exercised', liveServicesUsed: false };
  result.provenance = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim(), files: {} };
  for (const file of ['scripts/run_deadline_isolated.mjs', 'scripts/deadline-isolation-guard.mjs', 'scripts/deadline-runner.test.mjs', 'backend/tests/deadline-fixture.js', 'backend/tests/deadline-fixture.test.js', 'frontend/scripts/deadline-qa.e2e.mjs', 'frontend/scripts/deadline-harness.test.mjs', ...(scenario === 'recruitment-nav' ? ['frontend/scripts/deadline-recruitment-nav.scenario.mjs', 'frontend/src/routes/catalog.ts'] : [])]) result.provenance.files[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  if (scenario === 'members-pagination') for (const file of ['frontend/scripts/deadline-members-pagination.mjs', 'frontend/scripts/deadline-members-pagination-edges.mjs', 'frontend/src/screens/orgchart/MemberDirectory.tsx', 'frontend/src/screens/OrgChartScreen.tsx', 'frontend/src/components/data/MemberListModal.tsx', 'frontend/src/components/data/member-pagination.css']) result.provenance.files[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify({ runId, status: 'pending' }, null, 2));
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('DEADLINE_CANCELLED'));
  const onMessage = message => { if (message?.type === 'deadline:cancel') cancel(); };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel); process.on('message', onMessage);
  let api, vite, browserServer, browser, dependency, fixture, firstScreenshot;
  let closeForAbort = () => {};
  controller.signal.addEventListener('abort', () => closeForAbort(), { once: true });
  const responseTasks = new Set();
  try {
    api = await startDeadlineServer(controller.signal); result.resources.push(api.resource);
    // 별도 예약 서비스는 시작하지 않는다. 실제 UI가 의존성 부재를 표시하는 기준만 기록한다.
    dependency = createHttpServer((_request, response) => { response.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); response.end(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '격리 기준: 예약 서비스 미실행' } })); });
    const dependencyReady = once(dependency, 'listening', { signal: AbortSignal.timeout(10000) });
    dependency.listen(0, '127.0.0.1'); await dependencyReady;
    const dependencyPort = dependency.address().port;
    assert.ok(!protectedPorts.has(dependencyPort));
    const dependencyResource = { kind: 'reservation-unavailable-boundary', pid: process.pid, port: dependencyPort, closed: false };
    result.resources.push(dependencyResource);
    const dependencyOrigin = `http://127.0.0.1:${dependencyPort}`;
    vite = await createServer({
      configFile: false, root: path.join(root, 'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT,
      plugins: [react()], define: { 'import.meta.env.VITE_RESERVATION_API_URL': JSON.stringify(dependencyOrigin) },
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(api.baseUrl).origin }, watch: { ignored: ['**/.omo/**', '**/dist/**'] } },
    });
    await vite.listen();
    const port = vite.httpServer.address().port;
    assert.ok(!protectedPorts.has(port));
    result.resources.push({ kind: 'vite', pid: process.pid, port, closed: false });
    const origin = `http://127.0.0.1:${port}`;
    browserServer = await chromium.launchServer({ channel: 'chrome', headless: true, timeout: 20000, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
    const browserProcess = browserServer.process();
    const controlPort = Number(new URL(browserServer.wsEndpoint()).port);
    const profile = browserProcess.spawnargs.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
    result.resources.push({ kind: 'chrome', pid: browserProcess.pid, controllerPid: process.pid, port: controlPort, portKind: 'playwright-control', profile, closed: false });
    assert.ok(!protectedPorts.has(controlPort));
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 10000 });
    result.chrome = browser.version(); result.api = api.baseUrl; result.frontend = origin;
    // 취소는 진행 중인 Playwright 작업을 중단하고 아래 finally에서 모든 소유 자원을 정리한다.
    closeForAbort = () => { void browser.close().catch(error => result.errors.push({ phase: 'abort-browser', message: error.message })); };
    if (probe) {
      process.send?.({ type: 'deadline:ready', runId, evidence, resources: result.resources });
      if (probe === 'error') throw new Error('DEADLINE_INJECTED_AFTER_RESOURCES');
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Cancellation signal missing')), 15000);
        controller.signal.addEventListener('abort', () => { clearTimeout(deadline); resolve(); }, { once: true });
        if (controller.signal.aborted) { clearTimeout(deadline); resolve(); }
      });
      controller.signal.throwIfAborted();
    }
    fixture = await createDeadlineFixture(api);
    result.fixture = evidenceBody({ companyA: fixture.A, companyB: fixture.B, actorAdmin: fixture.actorAdmin, actorManager: fixture.actorManager, actorMember: fixture.actorMember, members: fixture.members, assets: fixture.assets, project: fixture.project, task: fixture.task, events: fixture.events, transactions: fixture.transactions, approval: fixture.approval, period: fixture.period, states: fixture.states });
    const allowed = new Set([origin, new URL(api.baseUrl).origin, dependencyOrigin]);
    result.browserAllowedRequests = [];
    result.limitations = ['Native PG database not exercised', 'Reservation domain not started; owned HTTP 503 boundary only', 'External font stylesheet blocked; system font fallback'];
    async function surface(name, actor, route, selector, apiPath, inspect, widths = [375, 768, 1280]) {
      controller.signal.throwIfAborted();
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (allowed.has(url.origin) && !protectedPorts.has(Number(url.port))) {
          result.browserAllowedRequests.push({ url: url.href, method: route.request().method() });
          return route.continue();
        }
        result.blockedBrowserRequests.push({ url: url.href, method: route.request().method() });
        return route.abort('blockedbyclient');
      });
      await context.routeWebSocket('**/*', socket => {
        const url = new URL(socket.url());
        const httpOrigin = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
        if (allowed.has(httpOrigin) && !protectedPorts.has(Number(url.port))) {
          result.browserAllowedRequests.push({ url: httpOrigin + url.pathname, method: 'WEBSOCKET' });
          socket.connectToServer();
        } else { result.blockedBrowserRequests.push({ url: url.href, method: 'WEBSOCKET' }); socket.close(); }
      });
      await context.addInitScript(session => { localStorage.setItem('orbitflow.session.v1', JSON.stringify(session)); localStorage.setItem('orbitflow.demoMode', '0'); }, actor.session);
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => {
        if (!new URL(response.url()).pathname.startsWith('/api/')) return;
        const task = (async () => {
          const record = { surface: name, url: response.url(), status: response.status() };
          try { record.body = evidenceBody(await response.json()); } catch (error) { record.bodyError = error.message; }
          result.browserResponses.push(record);
        })();
        responseTasks.add(task); void task.finally(() => responseTasks.delete(task));
      });
      try {
        const response = apiPath ? page.waitForResponse(response => new URL(response.url()).pathname === apiPath, { timeout: 15000 }) : null;
        await page.goto(origin + route, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (response) await response;
        await rendered(page, selector);
        const observations = inspect ? await inspect(page) : {};
        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(() => document.fonts.ready);
          const screenshot = path.join(attempt, `${name}-${width}.png`);
          await page.screenshot({ path: screenshot, fullPage: !name.includes('modal'), animations: 'disabled', timeout: 20000 });
          firstScreenshot ??= screenshot;
          const geometry = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, mainWidth: document.querySelector('main')?.getBoundingClientRect().width ?? null }));
          result.surfaces.push({ name, route, actor: actor.userId, orgId: actor.orgId, width, screenshot: path.relative(evidence, screenshot), observations, geometry, pageErrors: [...errors] });
        }
        assert.deepEqual(errors, [], `${name}: browser crash`);
      } finally { await context.unrouteAll({ behavior: 'wait' }); await context.close(); }
    }
    if (scenario === 'recruitment-nav') {
      const { recruitmentNav } = await import('./deadline-recruitment-nav.scenario.mjs');
      await recruitmentNav({ surface, api, fixture, rendered, result });
    } else if (scenario === 'members-pagination') {
      const { membersPagination } = await import('./deadline-members-pagination.mjs');
      await membersPagination({ surface, api, fixture, result, attempt });
    } else if (scenario === 'assets-footer') {
      const { assetsFooter } = await import('./deadline-assets-footer.mjs');
      await assetsFooter({ surface, fixture, api, result, attempt, evidence });
    } else {
    await surface('members-25-sidebar', fixture.actorAdmin, '/members', '.org-directory__table tbody tr', '/api/v1/members', async page => {
      const names = await page.locator('.org-directory__table tbody tr td:first-child').allTextContents();
      assert.ok(names.length > 0);
      for (const name of names) assert.ok(fixture.members.some(member => member.name === name));
      return { visibleRows: names.length, responseCount: 25, recruitmentLinks: await page.locator('.sidebar a[href="/hr/recruitment"]').count(), collapsedGroups: await page.locator('.nav-group [aria-expanded]').count() };
    });
    await surface('members-search-empty', fixture.actorAdmin, '/members?q=NO_SYNTHETIC_MATCH', '.org-directory .orgchart__empty', '/api/v1/members', async page => {
      assert.equal(await page.locator('.org-directory__table tbody tr').count(), 0); return { visibleRows: 0, sourceCount: 25 };
    }, [375, 1280]);
    await surface('assets-25', fixture.actorAdmin, '/assets', '[data-screen-id="AST-001"] tbody tr', '/api/v1/assets', async page => {
      const text = await page.locator('tbody').innerText(); assert.ok(fixture.assets.some(asset => text.includes(asset.name)));
      return { visibleRows: await page.locator('tbody tr').count(), responseCount: 25 };
    });
    await surface('assets-empty-company-b', fixture.B.actor, '/assets', '[data-screen-id="AST-001"] .state-card:not([role])', '/api/v1/assets', async page => {
      assert.equal(await page.locator('tbody tr').count(), 0); return { responseCount: 0 };
    }, [375, 1280]);
    await surface('assets-denied-manager', fixture.actorManager, '/assets', 'main [role="alert"]', null, async page => {
      assert.equal(await page.locator('tbody tr').count(), 0); assert.equal(await page.locator('.sidebar a[href="/assets"]').count(), 0); return { directApiStatus: 403 };
    }, [375, 1280]);
    await surface('month-boundaries', fixture.actorAdmin, `/calendar?month=${fixture.period.month}&day=${fixture.period.from}`, '.calendar-summary', '/api/v1/calendar', async page => {
      const summaryValues = await page.locator('.calendar-summary__stats dd').allTextContents();
      return { summaryValues, apiEventIds: fixture.events.slice(0, 2).map(event => event.id) };
    });
    await surface('approvals-assigned-member', fixture.actorMember, '/approvals', 'main .operational-list li', '/api/v1/approvals/requests', async page => {
      assert.ok((await page.locator('.operational-list').innerText()).includes(fixture.approval.title));
      return { approvalId: fixture.approval.id, requesterId: fixture.actorAdmin.userId, assigneeId: fixture.actorMember.userId };
    }, [375, 1280]);
    for (const [name, route, apiPath, selector] of [
      ['projects-members', '/projects', '/api/v1/projects', '[data-screen-id="PRJ-001"]'],
      ['roles', '/settings/roles', '/api/v1/settings/roles', 'main h1'],
      ['disabled-hr-features', '/settings/organization', '/api/v1/tenants/modules', 'main input[type="checkbox"]'],
      ['finance-transactions', '/finance/transactions', '/api/v1/finance/transactions', 'main tbody tr'],
      ['approvals-admin-inbox-empty', '/approvals', '/api/v1/approvals/requests', 'main .state-card:not([role])'],
      ['analytics', '/analytics', '/api/v1/analytics/dashboard', 'main [data-screen-id]'],
      ['company-graph', '/documents/graph', '/api/v1/documents/graph', 'main .graph-stage__canvas'],
      ['personal-graph', '/vault/graph', '/api/v1/vault/graph', 'main .graph-stage__empty:not([role])'],
      ['reservation-unavailable', '/reserve', '/api/v1/spaces', 'main .rsv-error-banner'],
    ]) await surface(name, fixture.actorAdmin, route, selector, apiPath, null, [375, 1280]);
    }
    assert.ok(result.browserAllowedRequests.every(request => allowed.has(new URL(request.url).origin) && !protectedPorts.has(Number(new URL(request.url).port))));
    assert.equal(networkAudit.blocked.length, 0);
    result.status = 'passed';
  } catch (error) {
    result.status = controller.signal.aborted ? 'cancelled' : 'failed';
    result.errors.push({ phase: 'scenario', message: error.message, stack: error.stack });
    console.error(error);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    closeForAbort = () => {};
    const cleanupErrors = [];
    async function cleanup(kind, action) {
      try { await action(); const resource = result.resources.find(item => item.kind === kind); if (resource) resource.closed = true; }
      catch (error) { cleanupErrors.push({ kind, message: error.message }); }
    }
    await cleanup('browser-connection', () => browser?.close());
    await cleanup('chrome', async () => {
      await browserServer?.close();
      const resource = result.resources.find(item => item.kind === 'chrome');
      if (resource?.profile) { resource.profileRemoved = !existsSync(resource.profile); assert.ok(resource.profileRemoved); }
    });
    await cleanup('vite', () => vite?.close());
    await cleanup('reservation-unavailable-boundary', async () => { if (dependency?.listening) await new Promise((resolve, reject) => { dependency.close(error => error ? reject(error) : resolve()); dependency.closeAllConnections(); }); });
    await cleanup('api', () => api?.close());
    await Promise.all(responseTasks);
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel); process.off('message', onMessage);
    result.http = api?.http ?? []; result.network = networkAudit;
    if (cleanupErrors.length) { result.status = 'failed'; process.exitCode = 1; }
    const cleanupReceipt = { runId, status: cleanupErrors.length ? 'failed' : 'complete', resources: result.resources, errors: cleanupErrors, browserExited: browserServer ? browserServer.process().exitCode !== null || browserServer.process().signalCode !== null : null, protectedPorts: [...protectedPorts], liveServiceRequests: 0 };
    if (result.status === 'passed') await copyFile(firstScreenshot, path.join(evidence, 'screen.png'));
    await writeFile(path.join(attempt, 'scenario.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify(cleanupReceipt, null, 2));
    console.log(JSON.stringify({ type: 'deadline:complete', runId, status: result.status, evidence, cleanup: cleanupReceipt.status }));
  }
}
