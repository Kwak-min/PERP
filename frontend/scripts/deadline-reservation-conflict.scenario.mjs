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
import { reservationViewport, scrollTable, assertTableEdge } from './deadline-reservation-recurrence.checks.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = path.join(root, '.omo/evidence/integration-primary-reservation-ui/conflict');
const require = createRequire(import.meta.url);

// DOM 상태의 실제 변경 신호를 구독한다. 타이밍 재시도는 사용하지 않는다.
export async function rendered(page, selector) {
  let timer;
  try {
    await Promise.race([
      page.evaluate(selector => new Promise(resolve => {
        const observer = new MutationObserver(check);
        function check() { if (document.querySelector(selector)) { observer.disconnect(); resolve(); } }
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true }); check();
      }), selector),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Render deadline: ${selector}`)), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function reservationConflict(baseline = false) {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  await mkdir(evidence, { recursive: true });
  const attempt = path.join(evidence, process.env.DEADLINE_RUN_ID); await mkdir(attempt);
  const result = { scenario: 'reservation-conflict-edit', baseline, runId: process.env.DEADLINE_RUN_ID, status: 'running', files: {}, captures: [], errors: [], http: [] };
  for (const file of ['frontend/src/screens/ReservationScreen.tsx', 'frontend/src/screens/reservation.css', 'frontend/src/services/reservationApi.ts', 'frontend/scripts/deadline-reservation-conflict.scenario.mjs', 'frontend/scripts/deadline-reservation-conflict.checks.mjs', 'frontend/scripts/deadline-reservation-history.checks.mjs', 'frontend/scripts/deadline-reservation-recurrence.checks.mjs', 'frontend/src/screens/reservation/SpaceFormModal.tsx', 'frontend/src/screens/reservation/AttendeePanel.tsx', 'frontend/src/screens/reservation/ReservationFormModal.tsx', 'frontend/src/screens/reservation/ReservationModal.tsx', 'frontend/src/screens/reservation/ConflictAvailability.tsx', 'frontend/src/screens/reservation/CancelScopeModal.tsx', 'frontend/src/screens/reservation/model.ts', 'frontend/src/screens/reservation/formTime.ts', 'frontend/src/screens/reservation/useOccupancyNow.ts', 'frontend/src/screens/reservation/SpaceMonthCalendar.tsx', 'frontend/src/screens/reservation/DayOccupancyTimeline.tsx', 'frontend/src/screens/reservation/occupancy.ts']) {
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
      [A, '정확 구간 첫 예약', '2032-01-31T09:05:12.345+09:00', '2032-01-31T09:20:00+09:00'],
      [A, '정확 구간 둘째 예약', '2032-01-31T09:35:00+09:00', '2032-01-31T09:50:00+09:00'],
      [member, '노출되면 안 되는 개인 제목', '2032-01-31T23:30:00+09:00', '2032-02-01T00:30:00+09:00'],
    ]) {
      const created = await fixture.request(actor, '/reservations', 'POST', { spaceId, title, startTime, endTime });
      assert.equal(created.status, 201); bookings.push(created.body.data[0]);
    }
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
    await page.clock.install({ time: new Date('2032-01-31T09:10:00+09:00') });
    await page.clock.pauseAt(new Date('2032-01-31T09:10:00+09:00'));
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
    async function capture(name, tableEdge = 'start') {
      for (const width of [375, 768, 1280]) {
        const viewportSignal = await reservationViewport(page, width); await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => {
          const modal = document.querySelector('dialog[open]'); if (modal) modal.scrollTop = 0;
        });
        const hasTable = await page.locator('.rsv-table-scroll').count() === 1;
        if (hasTable) await scrollTable(page, tableEdge);
        const tableBefore = hasTable ? await assertTableEdge(page, tableEdge) : null;
        const file = path.join(attempt, `${name}-${width}.png`);
        const modalOpen = await page.locator('dialog[open]').count() === 1;
        await page.screenshot({ path: file, fullPage: !modalOpen, animations: 'disabled' });
        const tablePrimary = hasTable ? await assertTableEdge(page, tableEdge) : null;
        // 고정 모바일 탐색이 긴 full-page 캡처 중간을 덮는 것과 실제 하단 접근성을 구분한다.
        await page.evaluate(() => {
          const modal = document.querySelector('dialog[open]');
          if (modal) modal.scrollTop = modal.scrollHeight;
          else window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
        });
        const viewportFile = path.join(attempt, `${name}-${width}-viewport.png`);
        await page.screenshot({ path: viewportFile, animations: 'disabled' });
        const tableBottom = hasTable ? await assertTableEdge(page, tableEdge) : null;
        const geometry = await page.evaluate(() => {
          const modal = document.querySelector('dialog[open]');
          const finalInterval = document.querySelector('.rsv-intervals li:last-child');
          const navigation = document.querySelector('.mobile-nav');
          return { viewport: innerWidth, width: document.documentElement.scrollWidth,
            finalIntervalBottom: finalInterval?.getBoundingClientRect().bottom, navigationTop: navigation?.getBoundingClientRect().top,
            scrollY, scrollHeight: document.documentElement.scrollHeight, mainPadding: getComputedStyle(document.querySelector('main')).paddingBottom,
            modal: modal ? { width: modal.clientWidth, contentWidth: modal.scrollWidth, scrollTop: modal.scrollTop,
              unlabeled: [...modal.querySelectorAll('input, select, textarea')].filter(input => !input.labels?.length && !input.getAttribute('aria-label')).map(input => input.outerHTML),
              columns: [...modal.querySelectorAll('.rsv-form-row')].map(row => getComputedStyle(row).gridTemplateColumns.split(' ').length),
              inputs: [...modal.querySelectorAll('input[type="datetime-local"]')].map(input => ({ value: input.value, width: input.clientWidth })),
            } : null };
        });
        result.captures.push({ name, width, file, viewportFile, fullPage: !modalOpen, geometry, viewportSignal, tableBefore, tablePrimary, tableBottom });
        if (!baseline) {
          assert.ok(geometry.width <= width, JSON.stringify(geometry));
          if (name === 'all-times-reachable' && width === 375) assert.ok(geometry.finalIntervalBottom <= geometry.navigationTop, JSON.stringify(geometry));
          if (geometry.modal) {
            assert.ok(geometry.modal.contentWidth <= geometry.modal.width, JSON.stringify(geometry));
            assert.deepEqual(geometry.modal.unlabeled, []);
            if (width === 375) assert.ok(geometry.modal.columns.every(columns => columns === 1), JSON.stringify(geometry));
          }
        }
      }
    }
    await page.goto(origin + '/reserve', { waitUntil: 'domcontentloaded' });
    await rendered(page, '.rsv-space-card');
    await page.locator('.rsv-filter-bar input[type=date]').fill('2032-01-31');
    await capture('space-cards');
    await page.locator('.rsv-space-card').first().click();
    if (baseline) { await rendered(page, '.rsv-timetable, .rsv-error-banner'); await capture('baseline-day'); }
    else {
      const { conflictChecks } = await import('./deadline-reservation-conflict.checks.mjs');
      await conflictChecks({ page, fixture, bookings, rendered, capture, result, origin, context, routing });
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
