import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { networkAudit, protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = path.join(root, '.omo/evidence/integration-primary-reservation-ui/calendar');
const require = createRequire(import.meta.url);

// DOM 상태의 실제 변경 신호를 구독한다. 타이밍 재시도는 사용하지 않는다.
export async function rendered(page, selector) {
  await page.evaluate(selector => new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Render deadline: ${selector}`)); }, 10000);
    function check() { if (document.querySelector(selector)) { clearTimeout(timer); observer.disconnect(); resolve(); } }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true }); check();
  }), selector);
}

export async function reservationCalendar(baseline = false) {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  await mkdir(evidence, { recursive: true });
  const attempt = path.join(evidence, process.env.DEADLINE_RUN_ID); await mkdir(attempt);
  const result = { scenario: 'reservation-space-calendar', baseline, runId: process.env.DEADLINE_RUN_ID, status: 'running', files: {}, captures: [], errors: [], http: [] };
  for (const file of ['frontend/src/screens/ReservationScreen.tsx', 'frontend/src/screens/reservation.css', 'frontend/src/services/reservationApi.ts', 'frontend/scripts/deadline-reservation-calendar.scenario.mjs', 'frontend/scripts/deadline-reservation-calendar.checks.mjs', 'frontend/scripts/deadline-reservation-calendar.scope.mjs', 'frontend/src/screens/reservation/SpaceMonthCalendar.tsx', 'frontend/src/screens/reservation/DayOccupancyTimeline.tsx', 'frontend/src/screens/reservation/occupancy.ts']) {
    if (existsSync(path.join(root, file))) result.files[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  }
  let fixture, vite, browserServer, browser;
  const pending = new Set();
  try {
    require('../../Reservation/backend/node_modules/ts-node').register({ project: path.join(root, 'Reservation/backend/tsconfig.json') });
    fixture = await require('../../Reservation/backend/src/modules/reservations/reservation.native-fixture.cjs').fixture();
    const { A, member, spaceId } = fixture;
    const originReservation = `http://127.0.0.1:${fixture.report.ports[2]}`;
    const bookings = [];
    for (const [actor, title, startTime, endTime] of [
      [A, '정확 구간 첫 예약', '2032-01-31T09:05:00+09:00', '2032-01-31T09:20:00+09:00'],
      [A, '정확 구간 둘째 예약', '2032-01-31T09:35:00+09:00', '2032-01-31T09:50:00+09:00'],
      [member, '노출되면 안 되는 개인 제목', '2032-01-31T23:30:00+09:00', '2032-02-01T00:30:00+09:00'],
    ]) {
      const created = await fixture.request(actor, '/reservations', 'POST', { spaceId, title, startTime, endTime });
      assert.equal(created.status, 201); bookings.push(created.body.data[0]);
    }
    const company = await fixture.erp.request(A, '/tenants', 'POST', { name: 'TASK14_EMPTY', type: 'custom', modules: ['assets'], features: [], departments: [] }, 201);
    const me = await fixture.erp.request(A, '/auth/me');
    const session = { token: A.token, orgId: A.orgId, name: me.name ?? 'Calendar QA', email: 'calendar@example.invalid', mustChangePassword: false, organizations: me.organizations };
    vite = await createServer({ configFile: false, root: path.join(root, 'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT, plugins: [react()], define: { 'import.meta.env.VITE_RESERVATION_API_URL': JSON.stringify(originReservation) }, server: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(fixture.erp.baseUrl).origin }, watch: { ignored: ['**/.omo/**', '**/dist/**'] } } });
    await vite.listen(); const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const allowed = new Set([origin, originReservation, new URL(fixture.erp.baseUrl).origin]);
    browserServer = await chromium.launchServer({ channel: 'chrome', headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
    const child = browserServer.process(); result.browserPid = child.pid;
    result.profile = child.spawnargs.find(arg => arg.startsWith('--user-data-dir='))?.slice(16);
    browser = await chromium.connect(browserServer.wsEndpoint()); result.chrome = browser.version();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const routing = { gates: new Set() };
    await context.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!allowed.has(url.origin) || protectedPorts.has(Number(url.port))) { await route.abort('blockedbyclient'); return; }
        const gate = [...routing.gates].find(gate => gate.page === route.request().frame().page() && gate.matches(url));
        if (gate) await gate.handler(route);
        else await route.continue();
      } catch (error) { result.errors.push(`browser route ${route.request().url()}: ${error.stack}`); }
    });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (allowed.has(`http://${url.host}`)) socket.connectToServer(); else socket.close();
    });
    context.on('weberror', event => result.errors.push(event.error().message));
    await context.addInitScript(({ origin, session }) => {
      if (location.origin !== origin) return;
      if (!localStorage.getItem('orbitflow.session.v1')) localStorage.setItem('orbitflow.session.v1', JSON.stringify(session));
    }, { origin, session });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    result.cancelledRequests = [];
    page.on('requestfailed', request => { if (request.url().startsWith(originReservation)) result.cancelledRequests.push({ url: request.url(), failure: request.failure() }); });
    page.on('requestfinished', request => {
      if (!request.url().startsWith(originReservation)) return;
      const task = (async () => {
        const response = await request.response();
        assert.ok(response);
        result.http.push({ url: response.url(), status: response.status(), body: await response.json() });
      })();
      pending.add(task); task.then(() => pending.delete(task), error => { result.errors.push(error.message); pending.delete(task); });
    });
    async function capture(name) {
      for (const width of [375, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => document.fonts.ready);
        const file = path.join(attempt, `${name}-${width}.png`); await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
        // 고정 모바일 탐색이 긴 full-page 캡처 중간을 덮는 것과 실제 하단 접근성을 구분한다.
        await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
        const viewportFile = path.join(attempt, `${name}-${width}-viewport.png`);
        await page.screenshot({ path: viewportFile, animations: 'disabled' });
        const geometry = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
        result.captures.push({ name, width, file, viewportFile, geometry });
        if (!baseline) assert.ok(geometry.width <= width, JSON.stringify(geometry));
      }
    }
    await page.goto(origin + '/reserve', { waitUntil: 'domcontentloaded' });
    await rendered(page, '.rsv-space-card');
    await page.locator('.rsv-filter-bar input[type=date]').fill('2032-01-31');
    await capture('space-cards');
    await page.locator('.rsv-space-card').first().click();
    if (baseline) { await rendered(page, '.rsv-timetable, .rsv-error-banner'); await capture('baseline-day'); }
    else {
      const { calendarChecks } = await import('./deadline-reservation-calendar.checks.mjs');
      await calendarChecks({ page, fixture, bookings, rendered, capture, result });
      const { scopeChecks } = await import('./deadline-reservation-calendar.scope.mjs');
      await scopeChecks({ page, fixture, company, rendered, capture, result, routing });
    }
    await context.unrouteAll({ behavior: 'wait' });
    page.removeAllListeners('requestfinished');
    await Promise.all(pending);
    assert.deepEqual(result.errors, []); assert.equal(networkAudit.blocked.length, 0);
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.failure = { message: error.message, stack: error.stack }; throw error; }
  finally {
    const cleanup = { runId: result.runId, errors: [] };
    for (const [name, close] of [['routes', async () => { for (const context of browser?.contexts() ?? []) await context.unrouteAll({ behavior: 'wait' }); }], ['browser', () => browser?.close()], ['chrome', () => browserServer?.close()], ['vite', () => vite?.close()], ['native', () => fixture?.close()]]) {
      try { await close(); cleanup[name] = true; } catch (error) { cleanup.errors.push({ name, message: error.message }); }
    }
    await Promise.allSettled(pending);
    cleanup.browserPid = result.browserPid; cleanup.profileRemoved = !result.profile || !existsSync(result.profile);
    cleanup.browserExited = !browserServer || browserServer.process().exitCode !== null;
    result.native = fixture?.report.native; result.network = networkAudit;
    if (cleanup.errors.length || result.errors.length || !cleanup.profileRemoved || !cleanup.browserExited) result.status = 'failed';
    await writeFile(path.join(attempt, 'scenario.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(attempt, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
    await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
    assert.deepEqual(cleanup.errors, []); assert.ok(cleanup.profileRemoved && cleanup.browserExited);
    assert.deepEqual(result.errors, []);
    console.log(JSON.stringify({ status: result.status, attempt }));
  }
}
