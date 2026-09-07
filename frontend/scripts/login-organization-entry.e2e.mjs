import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { api, startTestServer } from '../../backend/tests/http.js';
import { installCompanyFixture as installPgLoginFixture } from '../../backend/tests/pg-company-fixture.js';
import { creationAndNavigationScenarios } from './login-organization-actions.mjs';

// 실제 격리 SQLite API. PG는 SQL 경계의 명시적 픽스처로 원격 접속을 차단한다.
process.env.DATABASE_URL = '';
process.env.PG_HOST = '127.0.0.1';
process.env.PG_PORT = '1';
const frontend = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(frontend, '.artifacts/login-organization-entry');
await mkdir(evidence, { recursive: true });
const server = await startTestServer();
const fixture = await installPgLoginFixture();
const results = [];
let vite;
let browser;
let origin;
const password = 'password-1234';
const storageKey = 'orbitflow.session.v1';

async function account(email) {
  const response = await api(server.baseUrl, '/auth/signup', { method: 'POST', body: { email, name: '조직 진입 QA', password } });
  assert.equal(response.status, 201);
  return { email, token: response.body.access_token, userId: response.body.user.id };
}

async function organization(user, name) {
  const response = await api(server.baseUrl, '/tenants', { method: 'POST', token: user.token,
    body: { name, type: 'custom', departments: [], modules: ['members', 'tasks', 'documents', 'agent'] } });
  assert.equal(response.status, 201);
  return response.body.org_id;
}

async function sessionOf(user, orgId) {
  const me = await api(server.baseUrl, '/auth/me', user);
  assert.equal(me.status, 200);
  return { token: user.token, orgId, name: me.body.name, email: user.email,
    organizations: me.body.organizations, mustChangePassword: false };
}

async function signIn(page, email, next = '') {
  await page.goto(origin + '/login' + (next ? '?next=' + encodeURIComponent(next) : ''));
  await page.getByLabel('이메일', { exact: true }).fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(password);
  const navigated = page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() && !new URL(frame.url()).pathname.startsWith('/login') });
  const authenticated = page.waitForResponse(response => response.url().endsWith('/pg/auth/login'));
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  assert.equal((await authenticated).status(), fixture.users.some(user => user.email === email) ? 200 : 503);
  await navigated;
  await page.locator('.workspace-picker__button, .choice-grid, input[autocomplete="new-password"]').first().waitFor();
}

async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await run(page);
    assert.deepEqual(errors, []);
    results.push({ name, result: 'PASS' });
    console.log('PASS ' + name);
  } catch (error) {
    results.push({ name, result: 'FAIL', error: String(error) });
    console.error('FAIL ' + name + '\n' + error.stack);
    await page.screenshot({ path: path.join(evidence, name + '-failure.png') });
  } finally { await context.close(); }
}

try {
  vite = await createServer({ configFile: false, root: frontend, plugins: [react()], server: {
    host: '127.0.0.1', port: 0, watch: { ignored: ['**/.artifacts/**', '**/dist/**'] },
    proxy: { '/api': new URL(server.baseUrl).origin },
  } });
  await vite.listen();
  origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
  browser = await chromium.launch({ channel: 'chrome' });
  const member = await account('entry-member@example.invalid');
  const first = await organization(member, 'QA_FIRST_ORG');
  const second = await organization(member, 'QA_SECOND_ORG');
  const empty = await account('entry-empty@example.invalid');

  await scenario('legacy-multiple-auto-entry', async page => {
    // Given: 실제 복수 소속. When: PG 장애 중 로그인. Then: 첫 소속으로 진입한다.
    await signIn(page, member.email);
    assert.equal(new URL(page.url()).pathname, '/');
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    assert.equal(stored.orgId, first);
  });

  await scenario('legacy-single-auto-entry', async page => {
    // Given: 단일 소속. When: PG 장애 중 로그인. Then: 선택 화면 없이 진입한다.
    const user = await account('entry-single@example.invalid');
    const orgId = await organization(user, 'QA_SINGLE_ORG');
    await signIn(page, user.email);
    assert.equal(new URL(page.url()).pathname, '/');
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    assert.equal(stored.orgId, orgId);
  });

  await scenario('zero-memberships-welcome', async page => {
    // Given: 소속 없음. When: 로그인. Then: 기존 생성/초대 선택 화면을 유지한다.
    await signIn(page, empty.email, '/tasks');
    await page.getByRole('link', { name: /새 조직 만들기/ }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/welcome');
    assert.equal(await page.getByRole('link', { name: /초대 링크로 참여/ }).count(), 1);
    await page.screenshot({ path: path.join(evidence, 'welcome.png') });
  });

  for (const [name, selected, email, expected] of [
    ['selected-membership-preserved', second, member.email, second],
    ['stale-selection-rejected', 'forged-org', member.email, first],
    ['other-account-selection-rejected', second, empty.email, first],
  ]) await scenario(name, async page => {
    // Given: 기존 선택. When: 재인증. Then: 같은 계정의 검증된 소속만 보존한다.
    const prior = { ...await sessionOf(member, selected), email };
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: prior });
    await signIn(page, member.email);
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    assert.equal(stored.orgId, expected);
  });

  for (const [name, next, expected] of [
    ['safe-next-preserved', '/tasks?view=list', '/tasks?view=list'],
    ['external-next-rejected', '//example.invalid/path', '/'],
  ]) await scenario(name, async page => {
    // Given: next 값. When: 소속 계정 로그인. Then: 안전한 내부 경로만 유지한다.
    await signIn(page, member.email, next);
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, expected);
  });

  await scenario('must-change-password-precedes-next', async page => {
    // Given: 임시 비밀번호. When: next 포함 로그인. Then: 변경 화면이 우선한다.
    const temporary = await account('entry-temporary@example.invalid');
    await organization(temporary, 'QA_TEMP_ORG');
    const { db } = await import('../../backend/src/config/db.js');
    db().prepare('UPDATE app_user SET must_change_password = 1 WHERE id = ?').run(temporary.userId);
    await signIn(page, temporary.email, '/tasks');
    assert.equal(new URL(page.url()).pathname, '/change-password');
  });

  for (const user of fixture.users) await scenario('pg-fixture-' + user.id + '-login', async page => {
    // Given: SQL 픽스처의 PG 신원. When: 실제 로그인 컨트롤러. Then: workspace 응답만 선택한다.
    await signIn(page, user.email);
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    assert.equal(stored.orgId, user.company_id ? 'pg:' + user.company_id : null);
    assert.deepEqual(stored.organizations.flatMap(org => org.roles), user.company_id ? ['member'] : []);
    assert.equal(new URL(page.url()).pathname, user.company_id ? '/' : '/welcome');
  });

  await creationAndNavigationScenarios({ scenario, signIn, sessionOf, server, origin, storageKey,
    evidence, member, first, empty, pgUser: fixture.users[0], fixture });
  const { departmentScenarios } = await import('./login-organization-departments.mjs');
  await departmentScenarios({ scenario, origin, storageKey, session: await sessionOf(member, first) });
  const { nativeCompanyScenarios } = await import('./native-company-browser.mjs');
  await nativeCompanyScenarios({ scenario, signIn, origin, storageKey, fixture });
} finally {
  await browser?.close();
  await vite?.close();
  await fixture.close();
  await server.close();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ results,
    cleanup: 'Chrome, Vite, API, PG pool closed; temporary SQLite directory removed',
    pg: 'SQL fixtures only; no PostgreSQL server contacted' }, null, 2));
  console.log('LOGIN_ORGANIZATION_CLEANUP_PASS');
}
assert.ok(results.every(result => result.result === 'PASS'), JSON.stringify(results.filter(result => result.result === 'FAIL'), null, 2));
console.log('LOGIN_ORGANIZATION_ENTRY_PASS');
