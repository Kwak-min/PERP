import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';
import { api, startTestServer } from '../../backend/tests/http.js';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';

// 실제 Chrome + 빌드 + 격리 Express/SQLite/네이티브 PG. 장애만 HTTP 경계에서 주입한다.
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.resolve(process.env.AUTH_TRANSITION_EVIDENCE_DIR ?? path.resolve(root, '../.omo/evidence/st_01a08625/browser'));
await mkdir(evidence, { recursive: true });
const results = [], key = 'orbitflow.session.v1', password = 'password-1234';
const unavailable = { error: { code: 'SERVICE_UNAVAILABLE', message: '소속 정보를 일시적으로 확인할 수 없습니다.', details: { reason: 'connection', pg_code: null }, request_id: 'isolated-outage' } };
let fixture, server, vite, browser, origin;
let cleanupDoneClaim = false;
const stored = page => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? localStorage.getItem(key)), key);
const routePath = response => new URL(response.url()).pathname;
async function screenshot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(evidence, name + '.png'), fullPage: true, animations: 'disabled' });
}
async function submitLogin(page, email) {
  await expect(page.locator('#login-title')).toBeVisible();
  await page.getByLabel('이메일', { exact: true }).fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(password);
  const [response] = await Promise.all([
    page.waitForResponse(r => routePath(r) === '/api/v1/pg/auth/login'),
    page.getByRole('button', { name: '로그인', exact: true }).click(),
  ]);
  return response;
}
async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // No requests to operational APIs, email services, or remote account stores.
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === origin || url.hostname === 'cdn.jsdelivr.net' ? route.continue() : route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const requests = [], errors = [], consoleText = [];
  page.on('request', req => { const url = new URL(req.url()); if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, method: req.method() }); });
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', message => consoleText.push(message.text()));
  try {
    await run(page, requests, consoleText);
    assert.deepEqual(errors, []);
    results.push({ name, result: 'PASS', requests }); console.log('PASS ' + name);
  } catch (error) {
    const state = await page.evaluate(() => ({ path: location.pathname, alert: document.querySelector('[role=alert]')?.textContent, hasSession: Boolean(localStorage.getItem('orbitflow.session.v1') ?? sessionStorage.getItem('orbitflow.session.v1')), hasInvite: Boolean(sessionStorage.getItem('orbitflow.auth.invite.v1')) }));
    results.push({ name, result: 'FAIL', error: String(error), requests, state });
    console.error(JSON.stringify({ name, state, requests }));
    await screenshot(page, name + '-failure'); throw error;
  } finally { await context.unrouteAll({ behavior: 'wait' }); await context.close(); }
}
try {
  fixture = await startDailyNativePostgres();
  // 기본 daily 픽스처가 생략하는 원본 v8도 격리 클러스터에 적용한다.
  await fixture.pool.query(await readFile(new URL('../../db/perp_additions_v8.sql', import.meta.url), 'utf8'));
  server = await startTestServer();
  console.log(JSON.stringify({ ownedSQLite: process.env.ORBITFLOW_DATABASE_FILE }));
  vite = await preview({ configFile: false, root, envDir: path.join(evidence, 'no-env'), preview: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(server.baseUrl).origin } } });
  origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome' });
  console.log(JSON.stringify({ chrome: browser.version(), origin, surface: 'isolated production build', realNativePostgres: true }));

  await scenario('signup-created-workspace503-retry', async (page, requests) => {
    let outage = true;
    await page.route('**/api/v1/pg/auth/workspace', route => outage ? route.fulfill({ status: 503, json: unavailable }) : route.continue());
    await page.goto(origin + '/signup');
    await page.getByLabel('이름', { exact: true }).fill('복구 검증 계정');
    await page.getByLabel('이메일', { exact: true }).fill('created-recovery@example.invalid');
    await page.getByLabel('비밀번호', { exact: true }).fill(password);
    await page.getByLabel('비밀번호 확인', { exact: true }).fill(password);
    await page.getByRole('checkbox').check();
    const [created] = await Promise.all([
      page.waitForResponse(r => routePath(r) === '/api/v1/pg/auth/signup'), page.waitForURL(origin + '/welcome'),
      page.getByRole('button', { name: '계정 만들기', exact: true }).click(),
    ]);
    assert.equal(created.status(), 201);
    await expect(page.getByRole('alert')).toBeVisible();
    const token = (await stored(page)).token;
    assert.equal((await stored(page)).organizationStatus, 'loading');
    assert.equal(await page.locator('form').count(), 0);
    for (const width of [375, 768, 1280]) { await page.setViewportSize({ width, height: 900 }); await screenshot(page, `signup-created-outage-${width}`); }
    await page.reload(); await expect(page.getByRole('alert')).toBeVisible();
    assert.equal((await stored(page)).token, token);
    outage = false;
    await Promise.all([page.waitForResponse(r => routePath(r) === '/api/v1/pg/auth/workspace' && r.status() === 200),
      page.getByRole('button', { name: '다시 확인', exact: true }).click()]);
    await expect(page.getByRole('link', { name: /새 조직 만들기/ })).toBeVisible();
    assert.equal((await stored(page)).organizationStatus, 'ready'); assert.equal((await stored(page)).token, token);
    assert.equal(requests.filter(req => req.path.endsWith('/auth/signup')).length, 1);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM auth.users WHERE email='created-recovery@example.invalid'")).rows[0].count, 1);
    await screenshot(page, 'signup-recovered-empty');
  });

  for (const status of [503, 500, 502]) await scenario('login-outage-' + status, async (page, requests) => {
    await page.route('**/api/v1/pg/auth/login', route => route.fulfill({ status, json: unavailable }));
    await page.goto(origin + '/login'); assert.equal((await submitLogin(page, fixture.identity.users[0].email)).status(), status);
    await expect(page.getByRole('alert')).toBeVisible();
    assert.equal(new URL(page.url()).pathname, '/login'); assert.equal(await stored(page), null);
    assert.equal(requests.some(req => req.path === '/api/v1/auth/login'), false);
    await screenshot(page, 'login-outage-' + status);
  });
  await scenario('login-network-failure', async (page, requests) => {
    await page.route('**/api/v1/pg/auth/login', route => route.abort('connectionfailed'));
    await page.goto(origin + '/login');
    await page.getByLabel('이메일', { exact: true }).fill(fixture.identity.users[0].email);
    await page.getByLabel('비밀번호', { exact: true }).fill(password);
    await Promise.all([page.waitForEvent('requestfailed', req => new URL(req.url()).pathname === '/api/v1/pg/auth/login'),
      page.getByRole('button', { name: '로그인', exact: true }).click()]);
    await expect(page.getByRole('alert')).toBeVisible(); assert.equal(await stored(page), null);
    assert.equal(requests.some(req => req.path === '/api/v1/auth/login'), false);
    await screenshot(page, 'login-network-failure');
  });
  await scenario('login-genuine-invalid-credentials', async (page, requests) => {
    await page.goto(origin + '/login');
    const [rejected, pgRejected] = await Promise.all([page.waitForResponse(r => routePath(r) === '/api/v1/auth/login'), submitLogin(page, 'absent@example.invalid')]);
    assert.equal(pgRejected.status(), 401);
    assert.equal(rejected.status(), 401); await expect(page.getByRole('alert')).toBeVisible();
    assert.equal(await stored(page), null);
    assert.deepEqual(requests.filter(req => req.path.endsWith('/login')).map(req => req.path), ['/api/v1/pg/auth/login', '/api/v1/auth/login']);
    await screenshot(page, 'invalid-credentials');
  });

  const signupLegacy = email => api(server.baseUrl, '/auth/signup', { method: 'POST', body: { email, name: '초대 검증', password } });
  const owner = await signupLegacy('owner-recovery@example.invalid'); assert.equal(owner.status, 201);
  const org = await api(server.baseUrl, '/tenants', { method: 'POST', token: owner.body.access_token, body: { name: '격리 초대 조직', type: 'company', modules: ['members'], features: [], departments: [] } }); assert.equal(org.status, 201);
  // 직접 초대 URL에서는 인증 가드가 쿼리 정리보다 우선해야 한다.
  const forcedEmail = 'direct-invite-forced@example.invalid';
  const forcedAccount = await signupLegacy(forcedEmail); assert.equal(forcedAccount.status, 201);
  const { db } = await import('../../backend/src/config/db.js');
  db().prepare('UPDATE app_user SET must_change_password = 1 WHERE id = ?').run(forcedAccount.body.user.id);
  const forcedInvite = await api(server.baseUrl, '/members/invites', { method: 'POST', token: owner.body.access_token, orgId: org.body.org_id,
    body: { email: forcedEmail, roles: ['member'] } }); assert.equal(forcedInvite.status, 201);
  await scenario('direct-signed-out-invite-forced-password-continuation', async (page, requests, consoleText) => {
    const token = forcedInvite.body.token, next = '/members?tab=active', changedPassword = 'direct-invite-changed-1234';
    const entry = origin + '/invitations?invite=' + encodeURIComponent(token) + '&next=' + encodeURIComponent(next);
    await page.goto(entry);
    await expect(page).toHaveURL(origin + '/login');
    await expect(page.locator('#login-title')).toBeVisible();
    assert.equal(await stored(page), null); assert.deepEqual(requests, []);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('orbitflow.auth.invite.v1')), token);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('orbitflow.auth.next.v1')), next);
    for (const width of [375, 768, 1280]) { await page.setViewportSize({ width, height: 900 }); await screenshot(page, `direct-invite-login-${width}`); }
    await Promise.all([page.waitForURL(origin + '/change-password'), submitLogin(page, forcedEmail)]);
    assert.equal((await stored(page)).mustChangePassword, true);
    // 인증은 됐지만 비밀번호 변경이 필요한 직접 진입도 가드가 소유한다.
    await page.goto(entry);
    await expect(page).toHaveURL(origin + '/change-password');
    await page.reload();
    await page.getByLabel('현재 임시 비밀번호', { exact: true }).fill(password);
    await page.getByLabel('새 비밀번호', { exact: true }).fill(changedPassword);
    await page.getByLabel('새 비밀번호 확인', { exact: true }).fill(changedPassword);
    const [changed] = await Promise.all([page.waitForResponse(r => routePath(r) === '/api/v1/auth/password'),
      page.waitForURL(origin + '/login'), page.getByRole('button', { name: '비밀번호 변경', exact: true }).click()]);
    assert.equal(changed.status(), 200); assert.equal(await stored(page), null);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('orbitflow.auth.invite.v1')), token);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('orbitflow.auth.next.v1')), next);
    await expect(page.locator('#login-title')).toBeVisible();
    await page.getByLabel('이메일', { exact: true }).fill(forcedEmail);
    await page.getByLabel('비밀번호', { exact: true }).fill(changedPassword);
    await Promise.all([page.waitForURL(origin + '/invitations'), page.getByRole('button', { name: '로그인', exact: true }).click()]);
    assert.equal((await stored(page)).mustChangePassword, false);
    await expect(page.getByLabel('초대 링크 또는 토큰', { exact: true })).toHaveValue(token);
    const [verified] = await Promise.all([page.waitForResponse(r => routePath(r) === '/api/v1/auth/invitations/verify'),
      page.getByRole('button', { name: '초대 확인', exact: true }).click()]);
    assert.equal((await verified.json()).valid, true);
    const [accepted] = await Promise.all([page.waitForResponse(r => routePath(r) === '/api/v1/auth/invitations/accept'),
      page.waitForURL(origin + next), page.locator('.invite-manual__actions').getByRole('button', { name: /참여하기/ }).click()]);
    assert.equal(accepted.status(), 201); assert.equal((await stored(page)).orgId, org.body.org_id);
    assert.equal(requests.filter(r => r.path.endsWith('/invitations/accept')).length, 1);
    assert.equal(await page.evaluate(token => Object.values(localStorage).some(value => value.includes(token)), token), false);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('orbitflow.auth.invite.v1')), null);
    assert.equal(consoleText.some(text => text.includes(token)), false);
    await screenshot(page, 'direct-invite-forced-password-returned');
  });

  const email = 'invite-recovery@example.invalid'; assert.equal((await signupLegacy(email)).status, 201);
  const invite = await api(server.baseUrl, '/members/invites', { method: 'POST', token: owner.body.access_token, orgId: org.body.org_id, body: { email, roles: ['member'] } }); assert.equal(invite.status, 201);
  await scenario('invitation-login-onboarding-verify-accept', async (page, requests, consoleText) => {
    const token = invite.body.token;
    await page.goto(origin + '/signup?invite=' + encodeURIComponent(token) + '&next=' + encodeURIComponent('/members?tab=active'));
    await expect(page).toHaveURL(origin + '/signup');
    await page.getByRole('link', { name: '로그인', exact: true }).click();
    assert.equal(new URL(page.url()).search, '');
    const [response] = await Promise.all([submitLogin(page, email), page.waitForURL(origin + '/invitations')]);
    assert.equal(response.status(), 401);
    assert.equal((await stored(page)).organizationStatus, 'ready');
    await expect(page.getByLabel('초대 링크 또는 토큰', { exact: true })).toHaveValue(token);
    // Context survives the actual onboarding screen and return, including reload.
    await page.getByRole('link', { name: '새 조직 만들기', exact: true }).click();
    await expect(page).toHaveURL(origin + '/onboarding/organization'); await page.reload();
    await page.getByRole('button', { name: '이전', exact: true }).click(); await expect(page).toHaveURL(origin + '/invitations');
    await expect(page.getByLabel('초대 링크 또는 토큰', { exact: true })).toHaveValue(token);
    const [verified] = await Promise.all([page.waitForResponse(r => routePath(r) === '/api/v1/auth/invitations/verify'),
      page.getByRole('button', { name: '초대 확인', exact: true }).click()]);
    assert.equal(verified.status(), 200);
    await expect(page.getByRole('button', { name: '격리 초대 조직 참여하기', exact: true })).toBeVisible();
    assert.equal(requests.some(req => req.path.endsWith('/invitations/accept')), false);
    for (const width of [375, 768, 1280]) { await page.setViewportSize({ width, height: 900 }); await screenshot(page, `invitation-verified-${width}`); }
    // Acceptance 201 is also independent from its follow-up organization read.
    let outage = true;
    await page.route('**/api/v1/auth/me', route => outage ? route.fulfill({ status: 503, json: unavailable }) : route.continue());
    const [accepted] = await Promise.all([page.waitForResponse(r => routePath(r) === '/api/v1/auth/invitations/accept'),
      page.getByRole('button', { name: '격리 초대 조직 참여하기', exact: true }).click()]);
    assert.equal(accepted.status(), 201); await expect(page.getByRole('alert')).toBeVisible();
    assert.equal(new URL(page.url()).pathname, '/welcome');
    await screenshot(page, 'invitation-accepted-lookup-outage');
    outage = false;
    await Promise.all([page.waitForURL(origin + '/members?tab=active'),
      page.getByRole('button', { name: '다시 확인', exact: true }).click()]);
    assert.equal((await stored(page)).orgId, org.body.org_id);
    assert.equal(requests.filter(req => req.path.endsWith('/invitations/accept')).length, 1);
    assert.equal(await page.evaluate(token => Object.values(localStorage).some(value => value.includes(token)), token), false);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('orbitflow.auth.invite.v1')), null);
    assert.equal(consoleText.some(text => text.includes(token)), false);
    await screenshot(page, 'invitation-returned-members');
  });
  await scenario('invalid-invitation-no-accept', async page => {
    await page.goto(origin + '/login?invite=' + 'A'.repeat(43));
    await Promise.all([page.waitForURL(origin + '/invitations'), submitLogin(page, email)]);
    const [verified] = await Promise.all([page.waitForResponse(r => routePath(r) === '/api/v1/auth/invitations/verify'),
      page.getByRole('button', { name: '초대 확인', exact: true }).click()]);
    assert.equal((await verified.json()).valid, false);
    await expect(page.locator('.invite-check--bad')).toBeVisible();
    assert.equal(await page.locator('.invite-manual__actions button').count(), 1);
    await screenshot(page, 'invalid-invitation');
  });
  await scenario('unsafe-next-stays-in-app', async page => {
    await page.goto(origin + '/login?next=' + encodeURIComponent('/\\evil.invalid'));
    await Promise.all([page.waitForURL(origin + '/'), submitLogin(page, fixture.identity.users[0].email)]);
    assert.equal(new URL(page.url()).origin, origin);
  });
} finally {
  await browser?.close();
  if (vite) await new Promise((resolve, reject) => vite.httpServer.close(error => error ? reject(error) : resolve()));
  await server?.close();
  const { closePgPool } = await import('../../backend/src/config/pg.js'); await closePgPool();
  await fixture?.close();
  cleanupDoneClaim = true;
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ results, cleanupDoneClaim, operationalServicesUsed: false }, null, 2));
  console.log('AUTH_TRANSITION_OWNED_RESOURCES_CLOSED');
}
console.log('AUTH_TRANSITION_CHROME_PASS');
