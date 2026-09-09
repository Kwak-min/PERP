import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { analyticsFixture } from '../../backend/tests/analytics-http-fixture.js';
import { networkAudit, protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';
import { initializeDeadlineSession } from './deadline-browser-session.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = new URL('../../.omo/evidence/task-25-deadline-erp-redesign/', import.meta.url);
export const filter = { from: '2026-09-01', to: '2026-10-01', tz: 'Asia/Seoul' };
// Subscribe before the action; synchronous state inspection also covers a signal already delivered.
export async function observe(page, selector, attribute, value) {
  const id = randomUUID();
  await page.evaluate(({ id, selector, attribute, value }) => {
    window.__analyticsSignals ??= {};
    window.__analyticsSignals[id] = new Promise((resolve, reject) => {
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`State deadline: ${selector} ${attribute}=${value}`)); }, 15000);
      function check() {
        const element = document.querySelector(selector);
        if (element && (!attribute || element.getAttribute(attribute) === value)) { clearTimeout(timer); observer.disconnect(); resolve(true); }
      }
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true }); check();
    });
  }, { id, selector, attribute, value });
  return () => page.evaluate(async id => { try { return await window.__analyticsSignals[id]; } finally { delete window.__analyticsSignals[id]; } }, id);
}

export async function analyticsScenario(pgMode = false) {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const attempt = new URL(`runs/${randomUUID()}/`, evidence); await mkdir(attempt, { recursive: true });
  const result = { source: pgMode ? 'perp_db' : 'legacy', status: 'running', http: [], captures: [], resources: [], errors: [], hashes: {}, liveServicesUsed: false };
  let f, vite, browserServer, browser;
  try {
    result.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    for (const name of ['backend/src/services/analytics-contract.service.js', 'backend/src/services/analytics.service.js', 'backend/src/services/legacy-analytics.service.js', 'backend/src/services/pg-analytics.service.js', 'backend/src/services/analytics.contract.d.ts', 'frontend/src/screens/analytics/FinanceSeries.tsx', 'frontend/src/screens/analytics/analytics.css', 'frontend/src/screens/AnalyticsScreen.tsx', 'frontend/src/screens/analytics/model.ts', 'frontend/src/services/api.ts', 'frontend/src/services/workspace.ts', 'frontend/src/screens/registry.ts', 'frontend/src/routes/catalog.ts', 'frontend/scripts/deadline-analytics.e2e.mjs', 'frontend/scripts/deadline-qa.e2e.mjs', 'frontend/scripts/deadline-browser-session.mjs', 'backend/tests/analytics-http-fixture.js', 'db/perp_additions_v17_analytics_exports.sql']) {
      const file = path.join(root, name); result.hashes[name] = existsSync(file) ? createHash('sha256').update(await readFile(file)).digest('hex') : null;
    }
    f = await analyticsFixture(pgMode, attempt);
    result.resources.push({ kind: 'api', port: Number(new URL(f.baseUrl).port), resource: f.resource });
    assert.ok(!protectedPorts.has(Number(new URL(f.baseUrl).port)));
    const expected = await f.api(f.owner, '/analytics/kpis?' + new URLSearchParams(filter));
    assert.equal(expected.metrics.length, 16);
    vite = await createServer({ configFile: false, root: path.join(root, 'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT, plugins: [react()], server: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(f.baseUrl).origin }, watch: { ignored: ['**/.omo/**', '**/dist/**'] } } });
    await vite.listen(); const port = vite.httpServer.address().port; assert.ok(!protectedPorts.has(port));
    const origin = `http://127.0.0.1:${port}`;
    result.resources.push({ kind: 'vite', port, pid: process.pid });
    browserServer = await chromium.launchServer({ channel: 'chrome', headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
    const chrome = browserServer.process();
    result.resources.push({ kind: 'chrome', pid: chrome.pid, port: Number(new URL(browserServer.wsEndpoint()).port), profile: chrome.spawnargs.find(arg => arg.startsWith('--user-data-dir='))?.slice(16) });
    assert.ok(!protectedPorts.has(Number(new URL(browserServer.wsEndpoint()).port)));
    browser = await chromium.connect(browserServer.wsEndpoint()); result.chrome = browser.version();
    const context = await browser.newContext({ viewport: { width: 375, height: 900 }, timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    const session = actor => ({ token: actor.token, orgId: actor.orgId, name: 'Analytics test', email: 'analytics@example.invalid', mustChangePassword: false, organizations: [{ org_id: actor.orgId, org_name: actor.orgId === f.owner.orgId ? 'Analytics A' : 'Analytics B', org_type: 'custom', roles: [] }] });
    await initializeDeadlineSession(context, { origin, session: session(f.owner), onPageError: error => result.errors.push(error.message) });
    await context.addInitScript(origin => {
      if (location.origin !== origin) return;
      window.__analyticsObjectUrls = new Set();
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = blob => { const url = create(blob); window.__analyticsObjectUrls.add(url); return url; };
      URL.revokeObjectURL = url => { window.__analyticsObjectUrls.delete(url); return revoke(url); };
    }, origin);
    const page = await context.newPage();
    page.on('response', async response => { if (new URL(response.url()).pathname.includes('/analytics/')) result.http.push({ url: response.url(), status: response.status(), org: response.request().headers()['x-org-id'] }); });
    await page.goto(origin + '/analytics', { waitUntil: 'domcontentloaded' });
    await (await observe(page, 'main [data-screen-id]'))();
    await page.screenshot({ path: fileURLToPath(new URL('initial-375.png', attempt)), fullPage: true });
    assert.equal(await page.locator('.analytics-screen').count(), 1, 'ANL-001 must use the dedicated analytics screen, not the generic nested dashboard DTO');
    await exercise({ page, f, result, attempt, session });
    assert.equal(await page.evaluate(() => window.__analyticsObjectUrls.size), 0);
    assert.deepEqual(result.errors, []); assert.deepEqual(networkAudit.blocked, []); result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.errors.push(error.stack ?? error.message); console.error(error); process.exitCode = 1; }
  finally {
    const errors = [];
    for (const [kind, action] of [['browser', () => browser?.close()], ['chrome', () => browserServer?.close()], ['vite', () => vite?.close()], ['fixture', () => f?.close()]]) {
      try {
        await action(); const resource = result.resources.find(item => item.kind === kind);
        if (resource) { resource.closed = true; if (resource.profile) { resource.profileRemoved = !existsSync(resource.profile); assert.ok(resource.profileRemoved); } }
        else result.resources.push({ kind, closed: true });
        if (kind === 'fixture') { const api = result.resources.find(item => item.kind === 'api'); if (api) api.closed = true; }
      } catch (error) { errors.push({ kind, message: error.message }); }
    }
    result.cleanup = { errors, complete: errors.length === 0, networkAudit, protectedPorts: [...protectedPorts] };
    if (errors.length) { result.status = 'failed'; process.exitCode = 1; }
    await writeFile(new URL('scenario.json', attempt), JSON.stringify(result, null, 2));
    await writeFile(new URL(`${pgMode ? 'native' : 'legacy'}-latest.json`, evidence), JSON.stringify({ attempt: fileURLToPath(attempt), ...result }, null, 2));
    console.log(JSON.stringify({ status: result.status, attempt: fileURLToPath(attempt), cleanup: result.cleanup.complete }));
  }
}

async function exercise({ page, f, result, attempt, session }) {
  const prefix = f.pgMode ? '/api/v1/pg/analytics' : '/api/v1/analytics';
  const responseFor = (suffix, method = 'GET', actor = null) => page.waitForResponse(response => new URL(response.url()).pathname === prefix + suffix && response.request().method() === method && (!actor || (response.request().headers()['authorization'] === `Bearer ${actor.token}` && response.request().headers()['x-org-id'] === actor.orgId)), { timeout: 15000 });
  const metric = key => page.locator(`[data-metric-key="${key}"]`);
  async function apply(period = filter) {
    await page.getByLabel('시작일', { exact: true }).fill(period.from);
    await page.getByLabel('종료일', { exact: true }).fill(period.to);
    await page.getByLabel('시간대', { exact: true }).fill(period.tz);
    const received = responseFor('/kpis'); await page.getByRole('button', { name: '기간 적용 · 다시 조회' }).click();
    const response = await received, body = await response.json(); assert.equal(response.status(), 200);
    await (await observe(page, `.analytics-period time[datetime="${body.generated_at}"]`))();
    await compare(body); return body;
  }
  async function compare(body) {
    assert.equal(await page.locator('[data-metric-key]').count(), 16);
    assert.equal(await page.locator('.analytics-screen').getAttribute('data-company'), body.scope.org_id);
    assert.equal(await page.locator('.analytics-screen').getAttribute('data-source'), body.scope.source);
    for (const field of ['from', 'to', 'tz']) assert.equal(await page.locator('.analytics-period').getAttribute('data-' + field), body.period[field]);
    for (const row of body.metrics) {
      assert.equal(await metric(row.key).getAttribute('data-state'), row.state, row.key);
      assert.equal(await metric(row.key).getAttribute('data-unit'), row.unit);
      assert.equal(await metric(row.key).getAttribute('data-basis'), row.basis);
      assert.equal(await metric(row.key).getAttribute('data-reason'), row.reason ?? null);
      const text = await metric(row.key).locator('[data-metric-value]').textContent();
      if (row.value !== null) assert.equal(text, String(row.value), row.key);
      else assert.ok(!['0', '0%', '0.00'].includes(text), row.key);
      // The shipped source formula and scope, not pinned prose.
      const details = await metric(row.key).locator('dd').allTextContents();
      assert.equal(details[2], row.formula); assert.ok(details[3].includes(row.scope.rows));
      if (row.scope.tenant_id) assert.ok(details[3].includes(row.scope.tenant_id));
    }
    const series = body.series[0], available = ['ready', 'empty'].includes(series.state);
    assert.equal(await page.locator('[data-series-count]').getAttribute('data-series-count'), String(series.points.length));
    assert.equal(await page.locator('[data-series-state]').getAttribute('data-series-state'), series.state);
    assert.equal(await page.locator('[data-series-reason]').count(), series.reason ? 1 : 0);
    assert.equal(await page.locator('[data-series-chart]').count(), available ? 1 : 0);
    assert.equal(await page.locator('[data-series-table] tbody tr').count(), series.points.length);
    if (available) {
      const rows = await page.locator('[data-series-table] tbody tr').evaluateAll(rows => rows.map(row => ({ from: row.dataset.seriesFrom, values: [...row.querySelectorAll('[data-series-value]')].map(cell => cell.textContent) })));
      assert.deepEqual(rows, series.points.map(point => ({ from: point.from, values: [point.revenue, point.expense, point.net] })));
      assert.equal(await page.locator('[data-series-chart]').getAttribute('role'), 'img');
      const geometry = await page.locator('[data-series-chart] circle').evaluateAll(nodes => nodes.map(node => ({ x: Number(node.getAttribute('cx')), y: Number(node.getAttribute('cy')) })));
      assert.ok(geometry.every(point => Number.isFinite(point.x) && point.x >= 20 && point.x <= 700 && Number.isFinite(point.y) && point.y >= 20 && point.y <= 240));
      const expectedX = series.points.map(point => 20 + ((Date.parse(point.from) + Date.parse(point.to)) / 2 - Date.parse(body.period.from)) / (Date.parse(body.period.to) - Date.parse(body.period.from)) * 680);
      for (const [index, point] of geometry.entries()) assert.ok(Math.abs(point.x - expectedX[index % series.points.length]) < 1e-8, 'x axis must preserve actual bucket date positions, including the shorter last bucket');
      const descriptions = await page.locator('[data-series-chart]').evaluate(node => node.getAttribute('aria-describedby').split(' ').map(id => document.getElementById(id)?.textContent).join(' '));
      for (const value of [series.unit, body.period.from, body.period.to, body.period.tz, body.scope.source, body.scope.org_id, series.basis, series.date_basis]) assert.ok(descriptions.includes(value));
    } else {
      assert.deepEqual(series.points, []);
      assert.equal(await page.locator('.analytics-series svg, .analytics-series [data-series-value]').count(), 0);
    }
    result.http.push({ kind: 'kpis-body', body });
  }
  async function switchActor(actor) {
    const received = responseFor('/kpis', 'GET', actor);
    await page.evaluate(async next => { const { sessionStore } = await import('/src/store/session.ts'); sessionStore.set(next); }, session(actor));
    const response = await received; assert.equal(response.status(), 200); const body = await response.json();
    await (await observe(page, `.analytics-period time[datetime="${body.generated_at}"]`))();
    return body;
  }
  async function select(key) { await page.getByLabel('보고서 선택', { exact: true }).selectOption(key); }
  async function report(key) {
    await select(key); const received = responseFor('/reports/' + key); await page.getByRole('button', { name: '보고서 조회', exact: true }).click();
    const response = await received, body = await response.json(); assert.equal(response.status(), 200); assert.deepEqual(body.period, filter);
    await (await observe(page, '[data-report-rows]', 'data-report-rows', String(body.row_count)))();
    assert.equal(await page.locator('.analytics-reports .analytics-table tbody tr').count(), body.row_count);
    result.http.push({ kind: 'report-body', body }); return body;
  }
  async function create(key) {
    await select(key); const received = responseFor('/exports', 'POST'); await page.getByRole('button', { name: 'CSV 요청 생성', exact: true }).click();
    const response = await received, body = await response.json(); assert.equal(response.status(), 201); assert.deepEqual(body.filter, filter);
    await (await observe(page, '[data-export-id]', 'data-export-id', body.id))();
    assert.equal(await page.locator('[data-created-rows]').textContent(), String(body.row_count)); return body;
  }
  async function download(job, expectedStatus = 200) {
    const unexpectedDownloads = [], onDownload = file => unexpectedDownloads.push(file);
    if (expectedStatus !== 200) page.on('download', onDownload);
    const received = responseFor(`/exports/${job.id}/download`), downloaded = expectedStatus === 200 ? page.waitForEvent('download', { timeout: 15000 }) : null;
    await page.getByRole('button', { name: '현재 권한으로 CSV 다운로드', exact: true }).click();
    const response = await received; assert.equal(response.status(), expectedStatus);
    if (!downloaded) {
      const body = await response.json(); await (await observe(page, '[data-error-code]', 'data-error-code', body.error.code))();
      assert.equal(unexpectedDownloads.length, 0); page.off('download', onDownload);
      result.http.push({ kind: 'download-error', status: response.status(), body }); return body;
    }
    const file = await downloaded, filePath = fileURLToPath(new URL(`${job.id}-${randomUUID()}.csv`, attempt)); await file.saveAs(filePath);
    const bytes = await readFile(filePath), text = bytes.toString('utf8'), count = response.headers()['x-row-count'];
    await (await observe(page, '[data-download-rows]'))(); assert.equal(await page.locator('[data-download-rows]').textContent(), count);
    assert.equal(text.split('\r\n').length - 1, Number(count)); assert.match(file.suggestedFilename(), /\.csv$/);
    result.http.push({ kind: 'download', status: response.status(), createdRows: job.row_count, downloadedRows: count, filename: file.suggestedFilename(), sha256: createHash('sha256').update(bytes).digest('hex') }); return text;
  }
  await (await observe(page, '[data-analytics-kpis]', 'data-state', 'ready'))();
  await f.entry('2024-02-29', '12.34', 'income');
  await page.getByLabel('시작일', { exact: true }).fill('2024-02-28');
  await page.getByLabel('종료일', { exact: true }).fill('2024-03-01');
  const seriesResponse = responseFor('/kpis');
  await page.getByRole('button', { name: '기간 적용 · 다시 조회' }).click();
  const seriesBody = await (await seriesResponse).json();
  await (await observe(page, `.analytics-period time[datetime="${seriesBody.generated_at}"]`))();
  assert.equal(await page.locator('[data-series-chart]').count(), 1, 'actual nonempty API period must render a chart');
  assert.equal(await page.locator('[data-series-table] tbody tr').count(), 2);
  assert.equal(await page.locator('[data-series-table] [data-series-value="revenue"]').last().textContent(), '12.34');
  let body = await apply(); assert.equal(body.metrics.find(row => row.key === 'budgets.execution_rate').not_applicable, true);
  assert.equal(body.metrics.find(row => row.key === 'tasks.created').state, 'empty');
  if (!f.pgMode) {
    const zero = await f.budget('0.00'); body = await apply();
    const ratio = body.metrics.find(row => row.key === 'budgets.execution_rate'); assert.equal(ratio.state, 'ready'); assert.equal(ratio.not_applicable, true);
    f.database.prepare("UPDATE budget SET status='closed' WHERE id=?").run(zero);
  }
  const common = ['analytics.read', 'menu.analytics'];
  const basic = await f.limited(common), requester = await f.limited([...common, 'menu.approvals', 'approval.request']);
  await f.task('2026-09-01T00:00:00Z', 'todo', '2020-01-01');
  await f.task('2026-09-03T00:00:00Z');
  await f.task('2026-09-30T15:00:00Z'); // exclusive Seoul end, included in UTC
  await f.task('2026-08-31T15:00:00Z'); // inclusive Seoul start, excluded in UTC
  await f.task('2026-10-02T00:00:00Z');
  const budget = await f.budget('100.00');
  await f.entry('2026-09-02', '30.00', 'expense', true, budget);
  if (f.pgMode) {
    await f.entry('2026-09-02', '9999999999999999.99', 'income'); await f.entry('2026-09-02', '9999999999999999.99', 'income');
  } else {
    const statement = f.database.prepare("INSERT INTO transaction_record(id,tenant_id,org_id,created_at,updated_at,kind,amount_minor,currency,occurred_on,status) VALUES(?,?,?,'2026-09-02','2026-09-02','income',?,'KRW','2026-09-02','confirmed')");
    for (let i = 0; i < 2; i++) statement.run(randomUUID(), f.tenant, f.owner.orgId, 9223372036854775807n);
  }
  await f.approval(requester, '2026-09-02T00:00:00Z');
  await f.approval(f.owner, '2026-09-02T00:00:00Z');
  body = await apply(); assert.equal(body.metrics.find(row => row.key === 'finance.revenue').value, f.pgMode ? '19999999999999999.98' : '184467440737095516.14');
  assert.equal(body.metrics.find(row => row.key === 'budgets.execution_rate').value, '30.0000');
  const before = body.metrics.find(row => row.key === 'tasks.created').value;
  const otherPeriod = await apply({ from: '2026-10-01', to: '2026-11-01', tz: 'Asia/Seoul' });
  assert.notEqual(otherPeriod.metrics.find(row => row.key === 'tasks.created').value, before);
  assert.equal(otherPeriod.metrics.find(row => row.key === 'tasks.open').value, body.metrics.find(row => row.key === 'tasks.open').value);
  await apply({ ...filter, tz: 'UTC' }); await apply();
  for (const key of ['members', 'tasks', 'transactions', 'budgets', 'approvals_created', 'approvals_decided']) await report(key);
  const transactionJob = await create('transactions'); const csv = await download(transactionJob);
  assert.ok(csv.includes(f.pgMode ? '9999999999999999.99' : '92233720368547758.07'));
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(async () => { await document.fonts.ready; scrollTo(0, 0); });
    const observed = await page.locator('.analytics-screen').evaluate(element => {
      const box = element.getBoundingClientRect(); return { viewport: innerWidth, left: box.left, right: box.right, scroll: element.scrollWidth, client: element.clientWidth, documentWidth: document.documentElement.scrollWidth };
    });
    assert.ok(observed.left >= 0 && observed.right <= width + 1 && observed.scroll <= observed.client + 1, JSON.stringify(observed));
    const file = new URL(`analytics-${width}.png`, attempt); await page.screenshot({ path: fileURLToPath(file), fullPage: true, animations: 'disabled' });
    result.captures.push({ width, file: fileURLToPath(file), observed, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
    const choice = page.getByRole('combobox', { name: '차트 구간 선택', exact: true });
    await choice.focus(); await choice.press('Home');
    const selected = await observe(page, '[data-series-selected]', 'data-series-selected', '2026-09-02');
    await choice.press('ArrowDown'); await selected();
    assert.equal(await page.locator('[data-selected-value="revenue"]').textContent(), f.pgMode ? '19999999999999999.98' : '184467440737095516.14');
    await choice.press('Tab');
    assert.equal(await page.locator('[data-series-table]').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('[data-series-table] thead th[scope="col"]').count(), 5);
    assert.equal(await page.locator('[data-series-table] tbody th[scope="row"]').count(), 30);
    const semantics = await page.locator('.analytics-series').ariaSnapshot();
    assert.ok(semantics.includes(f.pgMode ? '19999999999999999.98' : '184467440737095516.14'));
    const semanticFile = new URL(`series-${width}-accessibility.txt`, attempt); await writeFile(semanticFile, semantics);
    const chartFile = new URL(`series-${width}.png`, attempt); await page.locator('.analytics-series').screenshot({ path: fileURLToPath(chartFile), animations: 'disabled' });
    result.captures.push({ width, file: fileURLToPath(chartFile), semantics: fileURLToPath(semanticFile), sha256: createHash('sha256').update(await readFile(chartFile)).digest('hex') });
  }
  body = await apply({ from: '2024-01-01', to: '2025-01-02', tz: 'UTC' });
  assert.equal(body.series[0].granularity, 'calendar_day_group'); assert.equal(body.series[0].points.length, 184);
  await apply();
  await switchActor(requester); body = await apply(); assert.equal(body.metrics.find(row => row.key === 'approvals.created').value, 1);
  assert.equal(body.metrics.find(row => row.key === 'approvals.created').scope.rows, 'own_requester');
  const ownReport = await report('approvals_created'); assert.equal(ownReport.row_count, 1);
  await switchActor(basic); body = await apply(); assert.ok(body.metrics.every(row => row.state === 'forbidden' && row.value === null));
  await switchActor(f.owner);
  await f.feature(false); await f.moduleEnabled('tasks', false); await f.moduleEnabled('finance', false); await f.moduleEnabled('agent', false);
  try { body = await apply(); for (const key of ['tasks.created', 'finance.revenue', 'budgets.execution_rate', 'approvals.created', 'ai.calls']) assert.equal(body.metrics.find(row => row.key === key).state, 'disabled'); }
  finally { await f.feature(true); await f.moduleEnabled('tasks', true); await f.moduleEnabled('finance', true); await f.moduleEnabled('agent', true); }
  if (f.pgMode) await f.native.pool.query('ALTER TABLE project.tasks RENAME TO tasks_analytics_ui_failed');
  else f.database.exec('ALTER TABLE task RENAME TO task_analytics_ui_failed');
  try {
    body = await apply(); assert.equal(body.metrics.find(row => row.key === 'tasks.created').reason, 'SOURCE_QUERY_FAILED');
    if (f.pgMode) assert.equal(body.metrics.find(row => row.key === 'ai.calls').reason, 'SOURCE_UNSUPPORTED');
  } finally {
    if (f.pgMode) await f.native.pool.query('ALTER TABLE project.tasks_analytics_ui_failed RENAME TO tasks');
    else f.database.exec('ALTER TABLE task_analytics_ui_failed RENAME TO task');
  }
  if (f.pgMode) await f.native.pool.query('ALTER TABLE accounting.journal_entries RENAME TO series_ui_failed');
  else f.database.exec('ALTER TABLE transaction_record RENAME TO series_ui_failed');
  try { body = await apply(); assert.equal(body.series[0].state, 'unavailable'); assert.equal(body.series[0].reason, 'SOURCE_QUERY_FAILED'); }
  finally {
    if (f.pgMode) await f.native.pool.query('ALTER TABLE accounting.series_ui_failed RENAME TO journal_entries');
    else f.database.exec('ALTER TABLE series_ui_failed RENAME TO transaction_record');
  }
  if (f.pgMode) {
    await f.native.pool.query('ALTER TABLE org.company_feature_settings RENAME COLUMN enabled_features TO analytics_ui_failed_features');
    try {
      body = await apply();
      for (const key of ['approvals.created', 'approvals.decided']) assert.equal(body.metrics.find(row => row.key === key).reason, 'SOURCE_QUERY_FAILED');
      assert.equal(body.metrics.find(row => row.key === 'ai.calls').reason, 'SOURCE_UNSUPPORTED');
      await select('approvals_created'); const failed = responseFor('/exports', 'POST'); await page.getByRole('button', { name: 'CSV 요청 생성', exact: true }).click();
      assert.equal((await failed).status(), 503); await (await observe(page, '[data-error-code]', 'data-error-code', 'SERVICE_UNAVAILABLE'))();
      assert.equal(await page.locator('[data-export-id]').count(), 0);
    } finally { await f.native.pool.query('ALTER TABLE org.company_feature_settings RENAME COLUMN analytics_ui_failed_features TO enabled_features'); }
  }
  if (!f.pgMode) {
    await f.entry('2026-09-03', '10.00', 'income', true, null, 'USD');
    await f.entry('2026-09-03', '10.00', 'expense', true, budget, 'USD');
    body = await apply(); assert.equal(body.metrics.find(row => row.key === 'finance.revenue').reason, 'MIXED_CURRENCY');
    assert.equal(body.metrics.find(row => row.key === 'budgets.execution_rate').reason, 'CURRENCY_MISMATCH');
    const mixed = await report('transactions'); assert.ok(mixed.items.some(row => row.unit === 'USD'));
  }
  await f.grants(basic, [...common, 'task.read', 'menu.projects']); await switchActor(basic); await apply();
  const taskJob = await create('tasks'); await f.task('2026-09-05T00:00:00Z'); const fresh = await download(taskJob);
  assert.equal(fresh.split('\r\n').length - 1, taskJob.row_count + 1);
  await f.grants(basic, common); await download(taskJob, 403);
  await f.grants(basic, [...common, 'task.read', 'menu.projects']);
  if (f.pgMode) await f.native.pool.query("UPDATE org.analytics_export_jobs SET expires_at='2000-01-01' WHERE id=$1", [taskJob.id]);
  else f.database.prepare("UPDATE export_job SET expires_at='2000-01-01' WHERE id=?").run(taskJob.id);
  await download(taskJob, 409);
  await staleTransitions({ page, f, apply, create, switchActor, responseFor, prefix, result, session });
  await switchActor(f.owner); await f.bulkTasks(100001); await apply({ from: '2030-01-01', to: '2030-02-01', tz: 'Asia/Seoul' });
  await select('tasks'); const overlimit = responseFor('/exports', 'POST'); await page.getByRole('button', { name: 'CSV 요청 생성', exact: true }).click();
  const error = await overlimit; assert.equal(error.status(), 413); await (await observe(page, '[data-error-code]', 'data-error-code', 'EXPORT_LIMIT_EXCEEDED'))();
  assert.equal(await page.locator('[data-export-id]').count(), 0);
  await page.getByLabel('시작일', { exact: true }).fill('2026-10-01'); await page.getByLabel('종료일', { exact: true }).fill('2026-09-01');
  const validation = await observe(page, '[data-error-code]', 'data-error-code', 'VALIDATION_ERROR'); await page.getByRole('button', { name: '기간 적용 · 다시 조회' }).click(); await validation();
  assert.equal(await page.locator('[data-metric-key]').count(), 0); assert.equal(await page.locator('[data-export-id]').count(), 0);
  result.coverage = ['daily-finance-chart', 'exact-series-table', 'bounded-long-period', 'series-keyboard-375-768-1280', 'series-accessibility-tree', 'finance-query-failure', 'all16', 'ready-empty-forbidden-disabled-unavailable', 'exact-money', 'null-ratio', 'period-change', 'source-failure-vs-unsupported', 'own-approval-privacy', 'report-allowlist', 'fresh-csv-row-count', 'download-403-409', 'overlimit-413', 'invalid-period', 'stale-transitions'];
}

async function staleTransitions({ page, f, apply, create, switchActor, responseFor, prefix, result, session }) {
  // Gate actual HTTP response delivery, not SQL or fabricated JSON. No timer-based ordering.
  async function hold(suffix, method, action, transition) {
    const owner = await page.evaluate(async () => { const { sessionStore } = await import('/src/store/session.ts'); const { token, orgId } = sessionStore.getSnapshot(); return { token, orgId }; });
    const entered = Promise.withResolvers(), released = Promise.withResolvers();
    const origin = new URL(page.url()).origin;
    const pattern = url => url.origin === origin && url.pathname === prefix + suffix;
    const inFlight = new Set(), held = new Map(), errors = []; let closing = false;
    const failed = request => held.get(request)?.cancelled.resolve(request.failure());
    // StrictMode can issue two old-scope requests. Own both, not just the first
    // (already-aborted) request, and never hold the replacement actor's request.
    const handler = route => {
      const work = (async () => {
        const request = route.request(), headers = request.headers();
        try {
          if (closing || request.method() !== method || headers.authorization !== `Bearer ${owner.token}` || headers['x-org-id'] !== owner.orgId) return await route.fallback();
          const record = { cancelled: Promise.withResolvers() }; held.set(request, record);
          const response = await route.fetch({ timeout: 15000 });
          record.status = response.status();
          record.sha256 = createHash('sha256').update(await response.body()).digest('hex');
          entered.resolve(record);
          await released.promise;
          await route.fulfill({ response });
          await response.dispose();
        } catch (error) {
          errors.push(error); entered.resolve({ error });
          try { await route.abort('failed'); } catch (abortError) { errors.push(abortError); }
        }
      })();
      inFlight.add(work); void work.finally(() => inFlight.delete(work));
      return work;
    };
    page.on('requestfailed', failed);
    await page.route(pattern, handler);
    try {
      await action(); const original = await bounded(entered.promise);
      if (original.error) throw original.error;
      assert.ok(original.status >= 200 && original.status < 300);
      await transition();
    } catch (error) { errors.push(error); }
    finally {
      closing = true; released.resolve();
      try {
        // Removing a route first lets Playwright fall it through to the context
        // handler. Drain our fetch/fulfill callbacks before relinquishing ownership.
        while (inFlight.size) await bounded(Promise.all([...inFlight]));
        if (!errors.length) for (const record of held.values()) {
          assert.ok(record.status >= 200 && record.status < 300);
          assert.equal((await bounded(record.cancelled.promise)).errorText, 'net::ERR_ABORTED');
        }
      } catch (error) { errors.push(error); }
      finally { await page.unroute(pattern, handler); page.off('requestfailed', failed); }
    }
    if (errors.length) throw new AggregateError(errors, `Analytics response gate failed: ${method} ${suffix}`);
    result.http.push({ kind: 'stale-discard', suffix, method, org: owner.orgId, responses: [...held.values()].map(record => ({ status: record.status, sha256: record.sha256, cancelled: true })) });
  }
  await apply();
  await hold('/kpis', 'GET', () => page.getByRole('button', { name: '기간 적용 · 다시 조회' }).click(), async () => {
    await page.getByLabel('시작일', { exact: true }).fill('2026-08-01');
    assert.equal(await page.locator('[data-metric-key]').count(), 0);
  });
  assert.equal(await page.locator('[data-metric-key]').count(), 0); await apply();
  await hold('/reports/tasks', 'GET', () => page.getByRole('button', { name: '보고서 조회', exact: true }).click(), async () => {
    await page.getByLabel('보고서 선택', { exact: true }).selectOption('members');
  });
  assert.equal(await page.locator('[data-report-rows]').count(), 0); await apply();
  await hold('/exports', 'POST', () => page.getByRole('button', { name: 'CSV 요청 생성', exact: true }).click(), async () => {
    await page.getByLabel('시간대', { exact: true }).fill('UTC');
  });
  assert.equal(await page.locator('[data-export-id]').count(), 0); await apply();
  const job = await create('tasks'), downloads = []; const onDownload = value => downloads.push(value); page.on('download', onDownload);
  try {
    await hold(`/exports/${job.id}/download`, 'GET', () => page.getByRole('button', { name: '현재 권한으로 CSV 다운로드', exact: true }).click(), () => switchActor(f.foreign));
    assert.equal(downloads.length, 0); assert.equal(await page.locator('[data-export-id]').count(), 0);
    assert.equal(await page.locator('.analytics-screen').getAttribute('data-company'), f.foreign.orgId);
  } finally { page.off('download', onDownload); }
  await switchActor(f.owner); await apply();
  await hold('/kpis', 'GET', () => page.getByRole('button', { name: '기간 적용 · 다시 조회' }).click(), async () => {
    // Same-company token transition is not merely a company-key remount.
    const actor = await f.limited(['analytics.read', 'menu.analytics']);
    const received = responseFor('/kpis', 'GET', actor);
    await page.evaluate(async next => { const { sessionStore } = await import('/src/store/session.ts'); sessionStore.set(next); }, session(actor));
    const response = await received; assert.equal(response.status(), 200); const body = await response.json();
    await (await observe(page, `.analytics-period time[datetime="${body.generated_at}"]`))();
  });
  assert.equal(await page.locator('[data-metric-key][data-state="forbidden"]').count(), 16);
}
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Exact event deadline exceeded')), 15000); })]).finally(() => clearTimeout(timer));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await analyticsScenario(process.argv.includes('--pg'));
