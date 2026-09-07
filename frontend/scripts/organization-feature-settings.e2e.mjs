import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { api, createOwnerOrg, startTestServer } from '../../backend/tests/http.js';
import { installCompanyFixture } from '../../backend/tests/pg-company-fixture.js';

process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
const frontend = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(frontend, '.artifacts/organization-feature-settings');
await mkdir(evidence, { recursive: true });
const server = await startTestServer();
const fixture = await installCompanyFixture();
let vite, browser;
const results = [];
const storageKey = 'orbitflow.session.v1';
const features = [
  { key: 'attendance', label: '근태', nav: '근태', legacy: '/hr/attendance', pg: '/pg/hr/attendance' },
  { key: 'leave', label: '휴가', nav: '휴가', legacy: '/hr/leaves', pg: '/pg/hr/leaves' },
  { key: 'approvals', label: '전자결재', nav: '결재', legacy: '/approvals/requests', pg: '/pg/approvals' },
];

async function account(nativePg) {
  if (!nativePg) {
    const owner = await createOwnerOrg(server.baseUrl, [], []);
    const me = await api(server.baseUrl, '/auth/me', owner);
    return { ...owner, name: me.body.name, email: me.body.email, organizations: me.body.organizations, mustChangePassword: false };
  }
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.users[1].email, password: 'password-1234' } });
  assert.equal(login.status, 200);
  const token = login.body.token;
  const company = await api(server.baseUrl, '/pg/companies', { token, method: 'POST', body: { name: '기능 설정 QA 전용', modules: [], features: [] } });
  assert.equal(company.status, 201);
  const workspace = await api(server.baseUrl, '/pg/auth/workspace', { token });
  return { token, orgId: company.body.org_id, name: login.body.user.name, email: login.body.user.email,
    organizations: workspace.body.organizations, mustChangePassword: false };
}

try {
  vite = await preview({ configFile: false, root: frontend,
    preview: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(server.baseUrl).origin } } });
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome' });
  for (const nativePg of [false, true]) {
    const name = nativePg ? 'pg-sql-boundary-fixture' : 'sqlite';
    const session = await account(nativePg);
    const context = await browser.newContext({ viewport: { width: 1360, height: 1100 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.addInitScript(({ key, session }) => {
        localStorage.setItem(key, JSON.stringify(session));
        window.settingsAccessEvents = 0;
        window.addEventListener('orbitflow:access-changed', () => window.settingsAccessEvents++);
      }, { key: storageKey, session });
      await page.goto(origin + '/settings/organization');
      const navigation = page.getByRole('navigation', { name: '주 메뉴' });
      const checkboxes = features.map(feature => page.getByRole('checkbox', { name: new RegExp(`^${feature.label}`) }));
      await checkboxes[0].waitFor({ state: 'visible' });
      for (const checkbox of checkboxes) assert.equal(await checkbox.isChecked(), false);
      assert.equal(await page.getByRole('checkbox', { name: /^전자결재/ }).count(), 1, 'one feature control, not a competing legacy module switch');
      let saves = 0;
      for (const [index, feature] of features.entries()) {
        for (const enabled of [true, false]) {
          await checkboxes[index].setChecked(enabled);
          const patchPath = '/api/v1' + (nativePg ? '/pg/org/modules' : '/tenants/current');
          // 정확한 저장 및 접근 재조회 응답을 동작 전에 구독한다. sleep/polling 없음.
          const savedSignal = page.waitForResponse(response => new URL(response.url()).pathname === patchPath && response.request().method() === 'PATCH');
          const refreshedSignal = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/settings/access');
          await page.getByRole('button', { name: '저장', exact: true }).click();
          const [saved, refreshed] = await Promise.all([savedSignal, refreshedSignal]);
          assert.equal(saved.status(), 200);
          assert.deepEqual(saved.request().postDataJSON().features, enabled ? [feature.key] : []);
          assert.deepEqual((await saved.json()).enabled_features, enabled ? [feature.key] : []);
          assert.equal(refreshed.status(), 200);
          assert.deepEqual((await refreshed.json()).features, enabled ? [feature.key] : []);
          saves++;
          assert.equal(await page.evaluate(() => window.settingsAccessEvents), saves, 'save must notify access without reload');
          await navigation.getByRole('link', { name: feature.nav, exact: true }).waitFor({ state: enabled ? 'visible' : 'detached' });
          for (const candidate of features) {
            const response = await api(server.baseUrl, nativePg ? candidate.pg : candidate.legacy, session);
            assert.equal(response.status, enabled && candidate.key === feature.key ? 200 : 403);
            if (response.status === 403) assert.equal(response.body.error.code, 'FEATURE_DISABLED');
          }
          assert.deepEqual((await api(server.baseUrl, '/settings/access', session)).body.features, enabled ? [feature.key] : []);
          await page.screenshot({ path: path.join(evidence, `${name}-${feature.key}-${enabled ? 'enabled' : 'disabled'}.png`), fullPage: true });
        }
      }
      await page.reload();
      await checkboxes[0].waitFor({ state: 'visible' });
      for (const checkbox of checkboxes) assert.equal(await checkbox.isChecked(), false);
      assert.deepEqual(errors, []);
      results.push({ name, result: 'PASS', saves, productionDist: true });
      console.log(`PASS ${name}: six saves, immediate access/menu refresh, direct HTTP gates, reload persistence`);
    } catch (error) {
      await page.screenshot({ path: path.join(evidence, `${name}-failure.png`), fullPage: true });
      results.push({ name, result: 'FAIL', error: String(error) });
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  if (vite) await new Promise((resolve, reject) => vite.httpServer.close(error => error ? reject(error) : resolve()));
  await fixture.close();
  await server.close();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ results,
    pg: 'SQL boundary fixture, not an actual PostgreSQL engine; no real data or migrations',
    cleanup: 'Owned Chrome contexts, preview server, ERP HTTP server, fixture pool and temporary SQLite removed',
  }, null, 2));
}
assert.equal(results.length, 2);
assert.ok(results.every(result => result.result === 'PASS'));
console.log('ORGANIZATION_FEATURE_SETTINGS_BROWSER_PASS');
