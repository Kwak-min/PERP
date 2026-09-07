import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { api, startTestServer, createOwnerOrg } from '../../backend/tests/http.js';
import { installCompanyFixture } from '../../backend/tests/pg-company-fixture.js';
import { PG_CREATOR_PERMISSIONS } from '../../backend/src/middleware/pgAccess.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = path.join(root, '.omo/pable-creator-evidence');
await mkdir(evidence, { recursive: true });
process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
const require = createRequire(import.meta.url);
require('../../Reservation/backend/node_modules/ts-node').register({ project: path.join(root, 'Reservation/backend/tsconfig.json') });
const { startSpaceFixture } = require('../../Reservation/backend/tests/space-fixture.cjs');
let erp, pg, reservation, vite, browser;
const checks = [], requests = [], errors = [];
const names = Array.from({ length: 5 }, (_, i) => `테스트 공간 ${i + 1}`);
try {
  erp = await startTestServer(); pg = await installCompanyFixture();
  pg.users[0].is_admin = false;
  const login = await api(erp.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: pg.users[0].email, password: 'password-1234' } });
  assert.equal(login.status, 200);
  const token = login.body.token;
  async function createCompany(name) {
    const response = await api(erp.baseUrl, '/pg/companies', { token, method: 'POST', body: { name, modules: ['assets'] } });
    assert.equal(response.status, 201);
    const role = pg.state.roles.find(role => role.company_id === response.body.org_id.slice(3));
    assert.deepEqual(pg.state.permissions.filter(grant => grant.role_id === role.id).map(grant => grant.code), PG_CREATOR_PERMISSIONS);
    return { orgId: response.body.org_id, roleId: role.id };
  }
  const native = await createCompany('Reservation creator QA');
  const other = await createCompany('Other creator company');
  const workspaces = await api(erp.baseUrl, '/pg/auth/workspace', { token });
  assert.equal(workspaces.status, 200);
  const nativeSession = { token, orgId: native.orgId, name: 'Reservation QA', email: pg.users[0].email, mustChangePassword: false, organizations: workspaces.body.organizations };
  const verifiedAccess = await api(erp.baseUrl, '/settings/access', nativeSession);
  assert.equal(verifiedAccess.status, 200);
  assert.ok(verifiedAccess.body.permissions.includes('reservation.create'));
  assert.ok(verifiedAccess.body.permissions.includes('reservation.manage'));
  const principal = await api(erp.baseUrl, '/auth/reservation-principal', nativeSession);
  assert.equal(principal.status, 200);
  assert.deepEqual(principal.body.permissions, [...PG_CREATOR_PERMISSIONS].sort());
  assert.ok(verifiedAccess.body.menus.includes('menu.reservations'));
  reservation = await startSpaceFixture(erp.baseUrl);
  const unrelated = await reservation.insert({ tenantId: native.orgId, orgId: native.orgId, name: 'Existing unrelated room', location: 'Existing', capacity: 7 });
  const foreign = await reservation.insert({ tenantId: other.orgId, orgId: other.orgId, name: 'Other company room', location: 'Other', capacity: 2 });
  vite = await createServer({ configFile: false, root: path.join(root, 'frontend'), plugins: [react()], define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api/v1'), 'import.meta.env.VITE_RESERVATION_API_URL': JSON.stringify(reservation.baseUrl) }, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.artifacts/**', '**/dist/**'] }, proxy: { '/api': erp.baseUrl.replace('/api/v1', '') } } });
  await vite.listen(); const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  async function newPage(session) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(session => { if (!localStorage.getItem('orbitflow.session.v1')) localStorage.setItem('orbitflow.session.v1', JSON.stringify(session)); }, session);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(String(error)));
    page.on('response', response => { if (response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    page.on('request', request => { if (request.url().startsWith(reservation.baseUrl)) requests.push({ method: request.method(), path: new URL(request.url()).pathname, orgId: request.headers()['x-org-id'] }); });
    return page;
  }
  const page = await newPage(nativeSession);
  const responseFor = (method, suffix = '') => page.waitForResponse(r => r.url() === `${reservation.baseUrl}/api/v1/spaces${suffix}` && r.request().method() === method, { timeout: 10000 });
  const main = page.locator('#main-content');
  await page.goto(origin + '/admin');
  await expect(main.locator('.settings-links')).toBeVisible();
  await expect(page.locator('nav a[href="/reserve"]')).toBeVisible();
  await main.locator('a[href="/reserve?tab=admin"]').click();
  await expect(page).toHaveURL(origin + '/reserve?tab=admin');
  await expect(main.getByRole('cell', { name: unrelated.name, exact: true })).toBeVisible();
  assert.equal(reservation.rows.length, 2, 'navigation must never insert test spaces');
  assert.equal(await main.getByRole('cell', { name: foreign.name, exact: true }).count(), 0);
  await main.getByRole('link', { name: '설정', exact: true }).click();
  await expect(page).toHaveURL(origin + '/settings');
  await main.locator('a[href="/reserve?tab=admin"]').click();
  await expect(page).toHaveURL(origin + '/reserve?tab=admin');
  await expect(main.getByRole('cell', { name: unrelated.name, exact: true })).toBeVisible();
  checks.push('native creator with exact creation grants and no is_admin opens registry SettingsScreen at /admin, opens management, returns to /settings and reenters; no automatic fixtures');

  await main.getByRole('button', { name: '+ 공간 등록', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '공간 등록', exact: true });
  await dialog.getByLabel('공간 이름 *', { exact: true }).fill('Browser-created room');
  await dialog.getByLabel('위치 *', { exact: true }).fill('Selected company floor');
  await dialog.getByLabel('수용인원 *', { exact: true }).fill('2.5');
  const beforeInvalid = reservation.rows.length;
  await dialog.getByRole('button', { name: '등록', exact: true }).click();
  await expect(dialog.locator('.rsv-error-banner')).toBeVisible();
  assert.equal(reservation.rows.length, beforeInvalid);
  await dialog.getByLabel('수용인원 *', { exact: true }).fill('6');
  await dialog.getByLabel('층', { exact: true }).fill('2F');
  const created = responseFor('POST');
  await dialog.getByRole('button', { name: '등록', exact: true }).click();
  const createdResponse = await created; assert.equal(createdResponse.status(), 201);
  const createdRow = (await createdResponse.json()).data;
  assert.equal(createdRow.orgId, native.orgId); assert.equal(createdRow.capacity, 6);
  await expect(main.getByRole('cell', { name: 'Browser-created room', exact: true })).toBeVisible();
  await page.reload();
  await expect(main.getByRole('cell', { name: 'Browser-created room', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(evidence, 'native-form-reloaded.png'), fullPage: true });
  checks.push('native PG creator form create/read/reload through actual ERP and reservation HTTP; fractional capacity rejected');

  const countBeforeCancel = reservation.rows.length;
  page.once('dialog', dialog => dialog.dismiss());
  await main.getByRole('button', { name: '테스트 공간 1~5 등록', exact: true }).click();
  assert.equal(reservation.rows.length, countBeforeCancel);
  for (const expectedCreated of [5, 0]) {
    page.once('dialog', dialog => dialog.accept());
    const seeded = responseFor('POST', '/test-spaces');
    await main.getByRole('button', { name: '테스트 공간 1~5 등록', exact: true }).click();
    const response = await seeded; assert.equal(response.status(), 200);
    assert.equal((await response.json()).data.createdCount, expectedCreated);
    for (const name of names) await expect(main.getByRole('cell', { name, exact: true })).toBeVisible();
  }
  await page.reload();
  for (const name of names) await expect(main.getByRole('cell', { name, exact: true })).toHaveCount(1);
  assert.deepEqual(reservation.rows.find(row => row.id === unrelated.id), unrelated);
  assert.deepEqual(reservation.rows.find(row => row.id === foreign.id), foreign);
  await page.screenshot({ path: path.join(evidence, 'five-spaces-reloaded.png'), fullPage: true });
  checks.push('explicit confirmation can cancel; action creates five normal records once and preserves unrelated/foreign rows on repeated invocation and reload');

  await main.getByRole('button', { name: '공간 예약', exact: true }).click();
  for (const name of names) await expect(main.getByRole('heading', { name, exact: true })).toBeVisible();
  await main.getByRole('button', { name: '공간 관리', exact: true }).click();
  await main.getByRole('button', { name: '+ 공간 등록', exact: true }).click();
  await dialog.getByLabel('공간 이름 *', { exact: true }).fill('Unsaved old company draft');
  // 실제 회사 전환 이벤트를 다른 탭의 저장소 변경처럼 전달한다. 현재 화면의 modal/state는 폐기되어야 한다.
  await page.evaluate(session => {
    localStorage.setItem('orbitflow.session.v1', JSON.stringify(session));
    window.dispatchEvent(new StorageEvent('storage', { key: 'orbitflow.session.v1' }));
  }, { ...nativeSession, orgId: other.orgId });
  await expect(dialog).toHaveCount(0);
  await expect(main.getByRole('cell', { name: foreign.name, exact: true })).toBeVisible();
  assert.equal(await main.getByRole('cell', { name: 'Browser-created room', exact: true }).count(), 0);
  checks.push('spaces appear in reservation search; changing selected company clears old form and reloads only new scope');

  async function mutate(orgId, suffix = '/test-spaces', method = 'POST', body = {}) {
    return page.request.fetch(reservation.baseUrl + '/api/v1/spaces' + suffix, { method, headers: { Authorization: `Bearer ${token}`, 'X-Org-Id': orgId }, data: body });
  }
  const beforeRejected = reservation.rows.length;
  assert.equal((await mutate('pg:999')).status(), 403);
  assert.equal((await mutate(other.orgId, '/' + createdRow.id, 'PATCH', { name: 'Foreign edit' })).status(), 404);
  pg.state.roles.find(role => role.id === native.roleId).name = 'org_admin';
  pg.state.permissions = pg.state.permissions.filter(grant => grant.role_id !== native.roleId || grant.code !== 'reservation.manage');
  for (const suffix of ['', '/test-spaces']) assert.equal((await mutate(native.orgId, suffix, 'POST', suffix ? {} : { name: 'Denied', location: 'Here', capacity: 1 })).status(), 403);
  assert.equal(reservation.rows.length, beforeRejected);
  const memberPage = await newPage({ ...nativeSession, organizations: nativeSession.organizations.map(org => ({ ...org, roles: ['owner', 'org_admin'], permissions: ['*'] })) });
  await memberPage.goto(origin + '/reserve?tab=admin');
  await expect(memberPage.locator('.rsv-empty-text')).toBeVisible();
  assert.equal(await memberPage.getByRole('button', { name: '+ 공간 등록', exact: true }).count(), 0);
  assert.equal(await memberPage.getByRole('button', { name: '테스트 공간 1~5 등록', exact: true }).count(), 0);
  await memberPage.screenshot({ path: path.join(evidence, 'nonadmin-denied.png'), fullPage: true });
  await memberPage.goto(origin + '/settings');
  await expect(memberPage.locator('#main-content h1')).toBeVisible();
  await expect(memberPage.locator('a[href="/reserve?tab=admin"]')).toHaveCount(0);
  checks.push('server org_admin name and forged cached owner/wildcard cannot show management or bypass HTTP; settings link removed; cross-company write rejected');

  await main.getByRole('button', { name: '+ 공간 등록', exact: true }).click();
  await expect(dialog).toBeVisible();
  pg.state.permissions = pg.state.permissions.filter(grant => grant.role_id !== other.roleId || grant.code !== 'reservation.manage');
  const refreshed = page.waitForResponse(r => r.url().endsWith('/api/v1/settings/access') && r.request().headers()['x-org-id'] === other.orgId, { timeout: 10000 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal((await refreshed).status(), 200);
  await expect(dialog).toHaveCount(0);
  await expect(main.getByRole('button', { name: '+ 공간 등록', exact: true })).toHaveCount(0);
  assert.equal((await mutate(other.orgId)).status(), 403);
  checks.push('revoking manage refreshes on focus without relogin and removes an open management form; next HTTP action denied');

  const legacy = await createOwnerOrg(erp.baseUrl, ['assets']);
  const legacyMe = await api(erp.baseUrl, '/auth/me', legacy);
  const legacyPage = await newPage({ token: legacy.token, orgId: legacy.orgId, name: 'Legacy QA', email: 'legacy@example.invalid', mustChangePassword: false, organizations: legacyMe.body.organizations });
  await legacyPage.goto(origin + '/settings');
  await legacyPage.locator('#main-content a[href="/reserve?tab=admin"]').click();
  const legacySeed = legacyPage.getByRole('button', { name: '테스트 공간 1~5 등록', exact: true });
  await expect(legacySeed).toBeEnabled();
  legacyPage.once('dialog', dialog => dialog.accept());
  const legacySeeded = legacyPage.waitForResponse(r => r.url().endsWith('/api/v1/spaces/test-spaces') && r.request().method() === 'POST');
  await legacySeed.click(); assert.equal((await legacySeeded).status(), 200);
  await legacyPage.reload();
  for (const name of names) await expect(legacyPage.getByRole('cell', { name, exact: true })).toHaveCount(1);
  assert.equal(reservation.rows.filter(row => row.orgId === legacy.orgId).length, 5);
  await legacyPage.screenshot({ path: path.join(evidence, 'legacy-five-spaces.png'), fullPage: true });
  checks.push('legacy wildcard owner settings and five-space action use unchanged legacy membership and isolated scope');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const result = { browser: await browser.version(), surface: 'actual SPA /admin, /settings and /reserve routes', boundary: 'real ERP HTTP/auth/controllers with explicit PG SQL fixture and temporary SQLite; real reservation HTTP/auth/controllers/service with transactional Prisma fixture; NOT a PostgreSQL server', checks, requests, errors, realRecordsInserted: false, cleanup: 'browser, Vite, reservation server, ERP server/temp SQLite and SQL/Prisma adapters closed/restored in finally' };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  for (const check of checks) console.log('PASS ' + check);
  console.log('RESERVATION_ADMIN_SPACES_BROWSER_PASS');
} catch (error) {
  const pages = browser?.contexts().flatMap(context => context.pages()) ?? [];
  await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ error: String(error), errors,
    pages: await Promise.all(pages.map(async page => ({ url: page.url(), body: await page.locator('body').innerText() }))) }, null, 2));
  throw error;
} finally {
  await browser?.close(); await vite?.close(); await reservation?.close(); await pg?.close(); await erp?.close();
}
