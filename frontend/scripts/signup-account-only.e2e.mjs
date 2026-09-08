import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { api, createOwnerOrg, startTestServer } from '../../backend/tests/http.js';
import { installCompanyFixture } from '../../backend/tests/pg-company-fixture.js';

// 실제 Chrome/SPA/HTTP/인증/SQLite 초대. PG만 SQL 경계 픽스처이며 원격 DB는 접속하지 않는다.
process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
const frontend = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(frontend, '.artifacts/signup-account-only');
await mkdir(evidence, { recursive: true });
const server = await startTestServer();
const fixture = await installCompanyFixture();
const storageKey = 'orbitflow.session.v1', password = 'password-1234';
const results = [];
let browser, vite, origin;
const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
function orgSnapshot() {
  return structuredClone(Object.fromEntries(Object.entries(fixture.state).filter(([key]) => !['users', 'sessions', 'logs'].includes(key))));
}
async function signup(page, email, invite = '') {
  await page.goto(origin + '/signup' + (invite ? '?invite=' + encodeURIComponent(invite) : ''));
  assert.equal(await page.locator('input[name="company_name"]').count(), 0);
  await page.getByLabel('이름', { exact: true }).fill('계정 전용 QA');
  await page.getByLabel('이메일', { exact: true }).fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(password);
  await page.getByLabel('비밀번호 확인', { exact: true }).fill(password);
  await page.getByRole('checkbox').check();
  const response = page.waitForResponse(r => r.url().endsWith('/pg/auth/signup'));
  await page.getByRole('button', { name: '계정 만들기', exact: true }).click();
  const saved = await response;
  assert.equal(saved.status(), 201);
  assert.deepEqual(saved.request().postDataJSON(), { email, name: '계정 전용 QA', password, ...(invite ? { invitation_token: invite } : {}) });
  const payload = await saved.json();
  assert.equal(payload.user.company, null);
  assert.equal(payload.user.department, null);
  assert.equal(payload.user.position, null);
  assert.equal(payload.user.is_admin, false);
  return payload;
}
async function login(page, email, destination) {
  await page.goto(origin + '/login');
  await page.getByLabel('이메일', { exact: true }).fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(password);
  const authenticated = page.waitForResponse(r => r.url().endsWith('/pg/auth/login'));
  const navigated = page.waitForURL(origin + destination);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  assert.equal((await authenticated).status(), 200);
  await navigated;
}
async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await run(page);
    assert.deepEqual(errors, []);
    results.push({ name, result: 'PASS' }); console.log('PASS ' + name);
  } catch (error) {
    results.push({ name, result: 'FAIL', error: String(error) });
    await page.screenshot({ path: path.join(evidence, name + '-failure.png') });
    throw error;
  } finally { await context.close(); }
}
try {
  vite = await createServer({ configFile: false, root: frontend, plugins: [react()], server: {
    host: '127.0.0.1', port: 0, watch: { ignored: ['**/.artifacts/**', '**/dist/**'] },
    proxy: { '/api': new URL(server.baseUrl).origin },
  } });
  await vite.listen(); origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
  browser = await chromium.launch({ channel: 'chrome' });
  console.log('CHROME_VERSION ' + browser.version());
  await scenario('fresh-signup-welcome-explicit-create-relogin', async page => {
    // Given: 새 계정. When: 가입 후 사용자가 회사 생성을 선택. Then: 그 전에는 소속이 없고 이후 재로그인으로 진입한다.
    const before = orgSnapshot(), start = fixture.queries.length;
    const email = 'fresh-account@example.invalid';
    await signup(page, email);
    await page.waitForURL(origin + '/welcome');
    await page.getByRole('link', { name: /새 조직 만들기/ }).waitFor();
    assert.equal(await page.getByRole('link', { name: /초대 링크로 참여/ }).count(), 1);
    assert.equal((await stored(page)).orgId, null);
    assert.deepEqual((await stored(page)).organizations, []);
    assert.deepEqual(orgSnapshot(), before);
    assert.deepEqual(fixture.queries.slice(start).filter(q => /^(INSERT|UPDATE|DELETE)/.test(q.sql)).map(q => /INSERT INTO ([\w.]+)/.exec(q.sql)?.[1]), ['auth.users', 'auth.sessions', 'auth.login_logs']);
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: path.join(evidence, 'welcome-' + width + '.png') });
    }
    await page.reload();
    await page.getByRole('link', { name: /새 조직 만들기/ }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/welcome');
    await page.getByRole('link', { name: /새 조직 만들기/ }).click();
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await page.getByLabel('조직 이름', { exact: true }).fill('EXPLICIT_SIGNUP_COMPANY');
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await page.locator('.module-option').first().waitFor();
    await page.getByRole('button', { name: '다음', exact: true }).click();
    assert.deepEqual(orgSnapshot(), before, 'wizard must not provision before explicit submit');
    const created = page.waitForResponse(r => r.url().endsWith('/pg/companies') && r.request().method() === 'POST');
    const entered = page.waitForURL(origin + '/');
    await page.getByRole('button', { name: '조직 만들기', exact: true }).click();
    const response = await created; assert.equal(response.status(), 201);
    const company = await response.json(); await entered;
    assert.equal((await stored(page)).orgId, company.org_id);
    assert.equal(fixture.state.companies.length, before.companies.length + 1);
    assert.deepEqual(fixture.state.companies.slice(0, before.companies.length), before.companies);
    await page.locator('.workspace-picker__button').waitFor();
    await page.screenshot({ path: path.join(evidence, 'explicit-company-home.png') });
    const loggedOut = page.waitForURL(origin + '/login');
    await page.getByRole('button', { name: '로그아웃', exact: true }).click(); await loggedOut;
    await login(page, email, '/');
    assert.equal((await stored(page)).orgId, company.org_id);
    assert.deepEqual((await stored(page)).organizations.map(org => org.org_id), [company.org_id]);
    assert.equal(fixture.users.find(user => user.email === email).company_id, null);
  });
  await scenario('existing-member-login-direct-entry', async page => {
    // Given: 검증된 기존 소속. When: 로그인. Then: 기존 회사로 바로 진입하며 데이터는 유지한다.
    const before = orgSnapshot();
    await login(page, fixture.users[0].email, '/');
    assert.equal((await stored(page)).orgId, 'pg:77');
    assert.deepEqual(orgSnapshot(), before);
  });
  const owner = await createOwnerOrg(server.baseUrl, ['members']);
  for (const mismatch of [false, true]) await scenario(mismatch ? 'invitation-email-mismatch-no-membership' : 'invitation-signup-joins-only-intended-org', async page => {
    // Given: 실제 SQLite 초대 토큰. When: PG 계정으로 가입/인증 후 수락. Then: 일치하는 이메일만 대상 조직에 가입한다.
    const email = mismatch ? 'wrong-invite@example.invalid' : 'invited-account@example.invalid';
    const invite = await api(server.baseUrl, '/members/invites', { method: 'POST', token: owner.token, orgId: owner.orgId,
      body: { email: mismatch ? 'intended-other@example.invalid' : email, roles: ['member'] } });
    assert.equal(invite.status, 201);
    const before = orgSnapshot();
    const accepted = page.waitForResponse(r => r.url().endsWith('/auth/invitations/accept'));
    const payload = await signup(page, email, invite.body.token);
    assert.equal((await accepted).status(), mismatch ? 400 : 201);
    assert.deepEqual(orgSnapshot(), before);
    if (mismatch) {
      await page.getByRole('alert').waitFor();
      assert.equal(new URL(page.url()).pathname, '/signup');
      const me = await api(server.baseUrl, '/auth/me', { token: payload.token });
      assert.deepEqual(me.body.organizations, []);
      await login(page, email, '/welcome');
    } else {
      // Acceptance persists in SQLite, but cannot become authority for a PG session.
      await page.waitForURL(origin + '/welcome');
      assert.deepEqual((await stored(page)).organizations, []);
      assert.equal((await stored(page)).orgId, null);
      const me = await api(server.baseUrl, '/auth/me', { token: payload.token });
      assert.equal(me.status, 200);
      assert.deepEqual(me.body.organizations.map(org => org.org_id), [owner.orgId]);
      const workspace = await api(server.baseUrl, '/pg/auth/workspace', { token: payload.token });
      assert.equal(workspace.status, 200);
      assert.deepEqual(workspace.body.organizations, []);
      await login(page, email, '/welcome');
      assert.deepEqual((await stored(page)).organizations, []);
    }
  });
} finally {
  await browser?.close(); await vite?.close(); await fixture.close(); await server.close();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ results,
    pg: 'SQL boundary fixtures only; real PostgreSQL unverified; no remote DB contacted',
    cleanup: 'Chrome contexts/browser, Vite, API, PG pool closed; temporary SQLite directory removed' }, null, 2));
  console.log('SIGNUP_ACCOUNT_ONLY_CLEANUP_PASS');
}
console.log('SIGNUP_ACCOUNT_ONLY_CHROME_PASS');
