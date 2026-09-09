import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { api, createOwnerOrg, startTestServer } from '../../backend/tests/http.js';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';

// Requires the isolated launcher and explicitly owned native binaries. Never uses a running API/DB.
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, '.artifacts/pg-workspace-authority');
await mkdir(evidence, { recursive: true });
const dist = process.argv.find(arg => arg.startsWith('--dist='))?.slice(7);
const key = 'orbitflow.session.v1', password = 'password-1234', results = [];
let fixture, server, vite, browser;
try {
  fixture = await startDailyNativePostgres();
  server = await startTestServer();
  const options = { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(server.baseUrl).origin } };
  const config = { configFile: false, root, envDir: path.join(evidence, 'nonexistent-env') };
  if (dist) vite = await preview({ ...config, build: { outDir: path.resolve(dist) }, preview: options });
  else { vite = await createServer({ ...config, plugins: [react()], server: options }); await vite.listen(); }
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome' });
  console.log(JSON.stringify({ chrome: browser.version(), surface: dist ? 'production build' : 'development', api: server.baseUrl, preview: origin }));
  const owner = await createOwnerOrg(server.baseUrl, ['members']);
  const user = fixture.identity.users[0], company = `pg:${fixture.companyId}`;
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: user.email, password } });
  assert.equal(login.status, 200);
  const invitation = await api(server.baseUrl, '/members/invites', { ...owner, method: 'POST', body: { email: user.email, roles: ['member'] } });
  assert.equal(invitation.status, 201);
  const accepted = await api(server.baseUrl, '/auth/invitations/accept', { token: login.body.token, method: 'POST', body: { token: invitation.body.token } });
  assert.equal(accepted.status, 201);
  const legacy = await api(server.baseUrl, '/auth/me', { token: login.body.token });
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.body.organizations.map(org => org.org_id), [owner.orgId]);

  async function scenario(name, run, prior) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const allowed = new Set([origin, new URL(server.baseUrl).origin]);
    await context.route('**/*', route => allowed.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    if (prior) await context.addInitScript(({ key, prior }) => localStorage.setItem(key, JSON.stringify(prior)), { key, prior });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const requests = [], errors = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(new URL(request.url()).pathname); });
    page.on('pageerror', error => errors.push(error.message));
    try {
      await run(page, requests);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled' });
      results.push({ name, result: 'PASS', requests }); console.log('PASS ' + name);
    } finally { await context.unrouteAll({ behavior: 'wait' }); await context.close(); }
  }
  async function signIn(page, email, destination, suppliedPassword = password) {
    await page.goto(origin + '/login');
    await page.getByLabel('이메일', { exact: true }).fill(email);
    await page.getByLabel('비밀번호', { exact: true }).fill(suppliedPassword);
    const authenticated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/pg/auth/login');
    const arrived = destination ? page.waitForURL(origin + destination) : null;
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    const response = await authenticated;
    if (arrived) await arrived;
    return response;
  }
  const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
  const prior = { token: login.body.token, name: user.name, email: user.email, orgId: owner.orgId, organizations: legacy.body.organizations, mustChangePassword: false };
  await scenario('pg-login-rejects-real-legacy-membership-and-saved-selection', async (page, requests) => {
    // The forbidden legacy lookup would fail, rather than quietly returning an empty list.
    await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'isolated legacy unavailable' } } }));
    assert.equal((await signIn(page, user.email, '/')).status(), 200);
    const session = await stored(page);
    assert.equal(session.orgId, company);
    assert.deepEqual(session.organizations.map(org => org.org_id), [company]);
    await page.locator('.workspace-picker__button').waitFor();
    assert.equal(requests.includes('/api/v1/auth/me'), false);
    assert.equal(requests.includes('/api/v1/auth/login'), false);
  }, prior);

  const multi = fixture.identity.users[1];
  const multiLogin = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: multi.email, password } });
  assert.equal(multiLogin.status, 200);
  const workspaces = await api(server.baseUrl, '/pg/auth/workspace', { token: multiLogin.body.token });
  assert.equal(workspaces.status, 200);
  assert.equal(workspaces.body.organizations.length, 2);
  for (const selected of [`pg:${fixture.otherCompanyId}`, 'pg:999999']) await scenario('pg-selection-' + selected.replace(':', '-'), async (page, requests) => {
    assert.equal((await signIn(page, multi.email, '/')).status(), 200);
    assert.equal((await stored(page)).orgId, selected === 'pg:999999' ? company : selected);
    assert.deepEqual((await stored(page)).organizations.map(org => org.org_id), workspaces.body.organizations.map(org => org.org_id));
    assert.equal(requests.includes('/api/v1/auth/me'), false);
  }, { ...prior, token: multiLogin.body.token, email: multi.email, orgId: selected, organizations: workspaces.body.organizations });

  await scenario('workspace-failure-is-not-login-fallback', async (page, requests) => {
    await page.route('**/api/v1/pg/auth/workspace', route => route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'isolated workspace unavailable' } } }));
    assert.equal((await signIn(page, user.email)).status(), 200);
    await expect(page.getByRole('alert')).toBeVisible();
    assert.equal(new URL(page.url()).pathname, '/welcome');
    assert.equal((await stored(page)).organizationStatus, 'loading');
    assert.equal(typeof (await stored(page)).token, 'string');
    assert.equal(requests.includes('/api/v1/auth/me'), false);
    assert.equal(requests.includes('/api/v1/auth/login'), false);
  });
  await scenario('credential-rejection-checks-both-stores', async (page, requests) => {
    assert.equal((await signIn(page, user.email, null, 'wrong-password')).status(), 401);
    await expect(page.getByRole('alert')).toBeVisible();
    assert.equal(await stored(page), null);
    assert.equal(requests.includes('/api/v1/auth/login'), true);
    assert.equal(requests.includes('/api/v1/pg/auth/workspace'), false);
  });
  await scenario('native-signup-creates-account-only', async (page, requests) => {
    const counts = async () => (await fixture.pool.query('SELECT (SELECT count(*) FROM org.companies) AS companies, (SELECT count(*) FROM org.company_memberships) AS memberships')).rows[0];
    const before = await counts();
    await page.goto(origin + '/signup');
    await page.getByLabel('이름', { exact: true }).fill('Native account QA');
    await page.getByLabel('이메일', { exact: true }).fill('latest-main-signup@example.invalid');
    await page.getByLabel('비밀번호', { exact: true }).fill(password);
    await page.getByLabel('비밀번호 확인', { exact: true }).fill(password);
    await page.getByRole('checkbox').check();
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/pg/auth/signup');
    const arrived = page.waitForURL(origin + '/welcome');
    await page.getByRole('button', { name: '계정 만들기', exact: true }).click();
    assert.equal((await saved).status(), 201); await arrived;
    assert.deepEqual(await counts(), before);
    assert.deepEqual((await stored(page)).organizations, []);
    assert.equal((await stored(page)).orgId, null);
    assert.equal(requests.includes('/api/v1/auth/me'), false);
  });
  console.log('PG_WORKSPACE_AUTHORITY_NATIVE_CHROME_PASS');
} finally {
  await browser?.close();
  if (vite) { if (dist) await new Promise((resolve, reject) => vite.httpServer.close(error => error ? reject(error) : resolve())); else await vite.close(); }
  await server?.close();
  const { closePgPool } = await import('../../backend/src/config/pg.js'); await closePgPool();
  await fixture?.close();
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ results, nativePostgres: true, liveServicesUsed: false }, null, 2));
  console.log('PG_WORKSPACE_AUTHORITY_OWNED_SERVICES_CLEANED');
}
