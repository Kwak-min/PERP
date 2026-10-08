import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import { createDeadlineFixture, evidenceBody, startDeadlineServer } from '../../backend/tests/deadline-fixture.js';
import { networkAudit, protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = path.join(root, '.omo/evidence/task-12-deadline-erp-redesign');
const widths = [320, 375, 768, 1025, 1100, 1200, 1280];

async function rendered(page, selector) {
  await page.evaluate(selector => new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Render deadline: ${selector}`)); }, 15000);
    function check() {
      if (document.querySelector(selector) && !document.querySelector('main .spinner')) {
        clearTimeout(timer); observer.disconnect(); resolve(true);
      }
    }
    observer.observe(document.documentElement, { childList: true, attributes: true, subtree: true }); check();
  }), selector);
}

async function pngMetadata(file) {
  const bytes = await readFile(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}

async function resizeAndSettle(page, width) {
  const settled = page.evaluate(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Resize did not settle')), 5000);
    addEventListener('resize', () => requestAnimationFrame(() => requestAnimationFrame(() => {
      Promise.all(document.getAnimations().map(animation => animation.finished)).then(() => { clearTimeout(timer); resolve(true); }, reject);
    })), { once: true });
  }));
  await page.setViewportSize({ width, height: 900 }); await settled; await page.evaluate(() => document.fonts.ready);
}

async function layoutEvidence(page) {
  return page.evaluate(() => {
    const visible = element => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const clipped = element => {
      const box = element.getBoundingClientRect();
      return box.left < -0.5 || box.right > document.documentElement.clientWidth + 0.5 || element.scrollWidth > element.clientWidth + 1;
    };
    const stats = Object.fromEntries([...document.querySelectorAll('.calendar-summary__stats > div')].map(row => [row.querySelector('dt')?.textContent?.trim(), row.querySelector('dd')?.textContent?.trim()]));
    const controls = [...document.querySelectorAll('.calendar-screen .screen-header__actions .button, .calendar-screen .calendar-nav .button')].filter(visible);
    const values = [...document.querySelectorAll('.calendar-summary__stats dd')].filter(visible);
    const longTitle = [...document.querySelectorAll('.calendar-day-list__event strong')].sort((a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0))[0];
    const overflowing = [...document.querySelectorAll('.calendar-screen *')].filter(element => {
      const box = element.getBoundingClientRect();
      return visible(element) && (box.left < -0.5 || box.right > document.documentElement.clientWidth + 0.5);
    }).map(element => ({ tag: element.tagName, className: element.className, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })).slice(0, 20);
    const screen = document.querySelector('.calendar-screen'), screenBox = screen.getBoundingClientRect();
    return {
      viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      screen: { left: screenBox.left, right: screenBox.right, clientWidth: screen.clientWidth, scrollWidth: screen.scrollWidth },
      summaryWidth: document.querySelector('.calendar-summary')?.getBoundingClientRect().width ?? 0,
      columns: getComputedStyle(document.querySelector('.calendar-body')).gridTemplateColumns.split(' ').length,
      stats, controls: controls.map(element => ({ text: element.textContent?.trim(), clipped: clipped(element) })),
      values: values.map(element => ({ text: element.textContent?.trim(), clipped: clipped(element) })), overflowing,
      longTitle: longTitle ? { text: longTitle.textContent, wraps: getComputedStyle(longTitle).whiteSpace !== 'nowrap', clipped: clipped(longTitle) } : null,
    };
  });
}

export async function monthSummary() {
  const runId = randomUUID(), attempt = path.join(evidence, 'runs', runId);
  await mkdir(attempt, { recursive: true }); await rm(path.join(evidence, 'screen.png'), { force: true });
  const result = { runId, scenario: 'month-summary', status: 'running', source: 'legacy SQLite / actual HTTP API / real Chrome', widths, zoom: '200% equivalent: 1280 physical pixels, 640 CSS-pixel viewport, deviceScaleFactor 2', http: [], browserResponses: [], blockedBrowserRequests: [], captures: [], resources: [], errors: [], liveServicesUsed: false, reservationDomainUsed: false };
  result.provenance = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), files: {} };
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('DEADLINE_CANCELLED'));
  const onMessage = message => { if (message?.type === 'deadline:cancel') cancel(); };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel); process.on('message', onMessage);
  let api, vite, browserServer, browser, firstScreenshot, fixture;
  try {
    for (const file of ['frontend/scripts/deadline-qa.e2e.mjs', 'frontend/scripts/deadline-month-summary.e2e.mjs', 'frontend/src/components/data/CalendarSurface.tsx', 'frontend/src/components/data/calendar-surface.css', 'frontend/src/components/data/calendarModel.ts']) result.provenance.files[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
    await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify({ runId, status: 'pending' }, null, 2));
    api = await startDeadlineServer(controller.signal); result.resources.push(api.resource);
    fixture = await createDeadlineFixture(api);
    const malformed = await api.request(fixture.actorAdmin, '/calendar?from=malformed&to=2026-09-30T15%3A00%3A00Z', 'GET', undefined, 400);
    assert.equal(malformed.error.code, 'VALIDATION_ERROR');
    const monthPath = '/api/v1/calendar';
    vite = await createServer({ configFile: false, root: path.join(root, 'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT, plugins: [react()], server: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(api.baseUrl).origin }, watch: { ignored: ['**/.omo/**', '**/dist/**'] } } });
    await vite.listen(); const port = vite.httpServer.address().port; assert.ok(!protectedPorts.has(port));
    result.resources.push({ kind: 'vite', pid: process.pid, port, closed: false });
    const origin = `http://127.0.0.1:${port}`, allowed = new Set([origin, new URL(api.baseUrl).origin]);
    browserServer = await chromium.launchServer({ channel: 'chrome', headless: true, timeout: 20000, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
    const browserProcess = browserServer.process(), controlPort = Number(new URL(browserServer.wsEndpoint()).port);
    const profile = browserProcess.spawnargs.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
    assert.ok(!protectedPorts.has(controlPort)); result.resources.push({ kind: 'chrome', pid: browserProcess.pid, controllerPid: process.pid, port: controlPort, profile, closed: false });
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 10000 }); result.chrome = browser.version();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (allowed.has(url.origin) && !protectedPorts.has(Number(url.port))) return route.continue();
      result.blockedBrowserRequests.push({ url: url.href, method: route.request().method() }); return route.abort('blockedbyclient');
    });
    await context.addInitScript(session => { localStorage.setItem('orbitflow.session.v1', JSON.stringify(session)); localStorage.setItem('orbitflow.demoMode', '0'); }, fixture.actorAdmin.session);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    const response = page.waitForResponse(item => new URL(item.url()).pathname === monthPath);
    await page.goto(`${origin}/calendar?month=${fixture.period.month}&day=${fixture.period.from}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const loaded = await response, apiBody = await loaded.json(); result.browserResponses.push({ path: monthPath, status: loaded.status(), body: evidenceBody(apiBody) });
    await rendered(page, '.calendar-summary'); assert.equal(loaded.status(), 200);
    assert.equal(apiBody.items.length, 2); assert.equal(new Set(apiBody.items.map(event => event.id)).size, 2);
    assert.deepEqual(new Set(apiBody.items.map(event => event.id)), new Set(fixture.events.slice(0, 2).map(event => event.id)));
    const longTitle = fixture.events[1].title;
    for (const width of widths) {
      await resizeAndSettle(page, width);
      const observed = await layoutEvidence(page);
      const screenshot = path.join(attempt, `month-summary-${width}.png`); await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
      if (width === 375) firstScreenshot = screenshot;
      result.captures.push({ kind: 'viewport', width, observed, file: path.relative(evidence, screenshot), png: await pngMetadata(screenshot) });
      assert.equal(observed.screen.left >= -0.5 && observed.screen.right <= observed.viewport + 0.5 && observed.screen.scrollWidth <= observed.screen.clientWidth + 1, true, `calendar overflow at ${width}`);
      assert.deepEqual({ total: observed.stats['총 일정'], occupied: observed.stats['일정 있는 날'] }, { total: '2건', occupied: '3일' });
      assert.equal(observed.columns, width <= 1024 ? 1 : 2); assert.ok(observed.summaryWidth > 0);
      assert.ok(observed.controls.every(control => !control.clipped), `control clipped at ${width}`);
      assert.ok(observed.values.every(value => !value.clipped), `summary value clipped at ${width}`);
      assert.deepEqual(observed.longTitle, { text: longTitle, wraps: true, clipped: false });
    }
    result.outOfScopeDefects = result.captures.filter(capture => capture.observed.documentWidth > capture.observed.viewport).map(capture => ({ width: capture.width, area: 'AppShell topbar/closed agent panel outside CalendarSurface', documentWidth: capture.observed.documentWidth, selectors: capture.observed.overflowing.filter(element => /topbar|agent-panel/.test(String(element.className))).map(element => element.className) }));
    const detailResponse = page.waitForResponse(item => new URL(item.url()).pathname === `${monthPath}/${fixture.events[1].id}`);
    await page.locator('.calendar-day-list__event', { hasText: longTitle }).click(); assert.equal((await detailResponse).status(), 200);
    await rendered(page, '.kv-list'); assert.equal(await page.locator('.kv-list dd').first().textContent(), longTitle);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const back = page.waitForResponse(item => new URL(item.url()).pathname === monthPath); await page.getByRole('link', { name: '캘린더로', exact: true }).click(); await back; await rendered(page, '.calendar-summary');
    await page.evaluate(session => sessionStorage.setItem('orbitflow.session.v1', JSON.stringify(session)), fixture.B.actor.session);
    const switched = page.waitForResponse(item => new URL(item.url()).pathname === monthPath && item.request().headers()['x-org-id'] === fixture.B.id); await page.reload(); const switchedResponse = await switched; await rendered(page, '.calendar-summary');
    const switchedStats = await page.locator('.calendar-summary__stats > div').evaluateAll(rows => Object.fromEntries(rows.map(row => [row.querySelector('dt')?.textContent?.trim(), row.querySelector('dd')?.textContent?.trim()])));
    assert.equal(switchedResponse.status(), 200); assert.deepEqual({ total: switchedStats['총 일정'], occupied: switchedStats['일정 있는 날'] }, { total: '0건', occupied: '0일' });
    result.scopeSwitch = { fromOrgId: fixture.A.id, toOrgId: fixture.B.id, status: switchedResponse.status(), total: '0건', occupied: '0일' };
    await context.close();
    const zoomContext = await browser.newContext({ viewport: { width: 640, height: 1800 }, deviceScaleFactor: 2, timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' });
    await zoomContext.route('**/*', route => allowed.has(new URL(route.request().url()).origin) ? route.continue() : route.abort('blockedbyclient'));
    await zoomContext.addInitScript(session => localStorage.setItem('orbitflow.session.v1', JSON.stringify(session)), fixture.actorAdmin.session);
    const zoomPage = await zoomContext.newPage(), zoomResponse = zoomPage.waitForResponse(item => new URL(item.url()).pathname === monthPath);
    await zoomPage.goto(`${origin}/calendar?month=${fixture.period.month}&day=${fixture.period.from}`); assert.equal((await zoomResponse).status(), 200); await rendered(zoomPage, '.calendar-summary');
    const zoomObserved = await layoutEvidence(zoomPage); assert.equal(zoomObserved.documentWidth <= zoomObserved.viewport, true); assert.ok(zoomObserved.controls.every(control => !control.clipped)); assert.ok(zoomObserved.values.every(value => !value.clipped));
    const zoomShot = path.join(attempt, 'month-summary-zoom-200.png'); await zoomPage.screenshot({ path: zoomShot, fullPage: true, animations: 'disabled' });
    result.captures.push({ kind: 'zoom-200', physicalWidth: 1280, cssWidth: 640, observed: zoomObserved, file: path.relative(evidence, zoomShot), png: await pngMetadata(zoomShot) }); await zoomContext.close();
    assert.deepEqual(pageErrors, []); assert.equal(networkAudit.blocked.length, 0); result.status = 'passed';
  } catch (error) {
    result.status = controller.signal.aborted ? 'cancelled' : 'failed'; result.errors.push({ message: error.message, stack: error.stack }); console.error(error); process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    const cleanupErrors = [], cleanup = async (kind, action) => { try { await action(); const resource = result.resources.find(item => item.kind === kind); if (resource) resource.closed = true; } catch (error) { cleanupErrors.push({ kind, message: error.message }); } };
    await cleanup('browser-connection', () => browser?.close()); await cleanup('chrome', async () => { await browserServer?.close(); const resource = result.resources.find(item => item.kind === 'chrome'); if (resource?.profile) { resource.profileRemoved = !existsSync(resource.profile); assert.ok(resource.profileRemoved); } });
    await cleanup('vite', () => vite?.close()); await cleanup('api', () => api?.close()); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); process.off('message', onMessage);
    result.http = api?.http ?? []; if (cleanupErrors.length) { result.status = 'failed'; process.exitCode = 1; }
    const receipt = { runId, status: cleanupErrors.length ? 'failed' : 'complete', resources: result.resources, errors: cleanupErrors, browserExited: browserServer ? browserServer.process().exitCode !== null || browserServer.process().signalCode !== null : null, protectedPorts: [...protectedPorts], liveServiceRequests: 0 };
    if (result.status === 'passed' && firstScreenshot) await copyFile(firstScreenshot, path.join(evidence, 'screen.png'));
    await writeFile(path.join(attempt, 'scenario.json'), JSON.stringify(result, null, 2)); await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify(result, null, 2)); await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ type: 'deadline:complete', runId, status: result.status, evidence, cleanup: receipt.status }));
  }
}
