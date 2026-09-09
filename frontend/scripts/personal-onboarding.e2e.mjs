import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { api, startTestServer } from '../../backend/tests/http.js';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';

// 새 로컬 PostgreSQL/SQLite와 실제 SPA만 사용한다. HTTP/SQL 대체물은 없다.
assert.equal(process.env.DEADLINE_ISOLATED, '1');
const frontend = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(frontend, '.artifacts/personal-onboarding');
await mkdir(evidence, { recursive: true });
const results = [];
const password = 'password-1234';
const storageKey = 'orbitflow.session.v1';
let database, server, vite, browser;
try {
  database = await startDailyNativePostgres();
  await database.pool.query(await readFile(new URL('../../db/perp_additions_v8.sql', import.meta.url), 'utf8'));
  server = await startTestServer();
  const signup = await api(server.baseUrl, '/pg/auth/signup', { method: 'POST', body: { email: 'migration@example.invalid', name: '마이그레이션 검증', password } });
  assert.equal(signup.status, 201);
  const token = signup.body.token;
  const before = (await database.pool.query('SELECT id,name FROM org.companies ORDER BY id')).rows;
  const missing = await api(server.baseUrl, '/pg/companies', { token, method: 'POST', body: { type: 'personal', name: 'Ignored' } });
  assert.equal(missing.status, 503);
  assert.equal(missing.body.error.code, 'SERVICE_UNAVAILABLE');
  assert.deepEqual((await database.pool.query('SELECT id,name FROM org.companies ORDER BY id')).rows, before);
  const oldCompany = await api(server.baseUrl, '/pg/companies', { token, method: 'POST', body: { name: 'Before migration' } });
  assert.equal(oldCompany.status, 201);
  assert.equal(oldCompany.body.type, 'perp_db');
  const oldWorkspace = await api(server.baseUrl, '/pg/auth/workspace', { token });
  assert.equal(oldWorkspace.status, 200);
  assert.equal(oldWorkspace.body.organizations[0].org_type, 'perp_db');
  const migration = await readFile(new URL('../../db/perp_additions_v19_personal_organizations.sql', import.meta.url), 'utf8');
  await database.pool.query(migration);
  await database.pool.query(migration);
  assert.deepEqual((await database.pool.query('SELECT DISTINCT organization_type FROM org.companies')).rows, [{ organization_type: 'company' }]);
  assert.deepEqual((await database.pool.query('SELECT id,name FROM org.companies WHERE id=ANY($1::bigint[]) ORDER BY id', [before.map(row => row.id)])).rows, before);
  results.push({ name: 'native-migration-absence-rollback-company-compatibility-and-replay', result: 'PASS' });

  vite = await createServer({ configFile: false, root: frontend, plugins: [react()], server: {
    host: '127.0.0.1', port: 0, watch: { ignored: ['**/.artifacts/**', '**/dist/**'] },
    proxy: { '/api': new URL(server.baseUrl).origin },
  } });
  await vite.listen();
  const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
  browser = await chromium.launch({ channel: 'chrome', headless: false });

  for (const native of [true, false]) for (const width of [1440, 390]) {
    const scenario = `${native ? 'pg' : 'sqlite'}-${width}`;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const owner = `개인 사용자 ${scenario}`;
      const email = `${scenario}@example.invalid`;
      if (native) {
        await page.goto(origin + '/signup');
        await page.getByLabel('이름', { exact: true }).fill(owner);
        await page.getByLabel('이메일', { exact: true }).fill(email);
        await page.getByLabel('비밀번호', { exact: true }).fill(password);
        await page.getByLabel('비밀번호 확인', { exact: true }).fill(password);
        await page.getByRole('checkbox').check();
        const signedUp = page.waitForResponse(response => response.url().endsWith('/pg/auth/signup') && response.request().method() === 'POST');
        const welcome = page.waitForURL(origin + '/welcome');
        await page.getByRole('button', { name: '계정 만들기', exact: true }).click();
        assert.equal((await signedUp).status(), 201);
        await welcome;
      } else {
        const response = await api(server.baseUrl, '/auth/signup', { method: 'POST', body: { email, name: owner, password } });
        assert.equal(response.status, 201);
        await page.goto(origin + '/login');
        await page.evaluate(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: storageKey, session: {
          token: response.body.access_token, name: owner, email, orgId: null, organizations: [], mustChangePassword: false, organizationStatus: 'ready',
        } });
        await page.goto(origin + '/welcome');
      }
      await page.getByRole('link', { name: /새 조직 만들기/ }).click();
      // 회사/직접 설정 초안은 개인 유형 왕복에도 손실되지 않는다.
      const nonpersonal = native ? /소규모 기업/ : /직접 설정/;
      await page.getByRole('radio', { name: nonpersonal }).click();
      await page.getByRole('button', { name: '다음', exact: true }).click();
      assert.equal(await page.locator('.form-stack input').count(), 1);
      assert.equal(await page.getByRole('button', { name: '다음', exact: true }).isDisabled(), true);
      await page.getByLabel('조직 이름', { exact: true }).fill('보존할 조직 초안');
      await page.getByRole('button', { name: '이전', exact: true }).click();
      await page.getByRole('radio', { name: /개인 프로젝트 관리 및 사용/ }).click();
      await page.getByRole('button', { name: '다음', exact: true }).click();
      assert.equal(await page.getByLabel('조직 이름', { exact: true }).inputValue(), owner);
      assert.equal(await page.getByLabel('조직 이름', { exact: true }).getAttribute('readonly'), '');
      assert.equal(await page.locator('.form-stack input').count(), 1);
      assert.equal(await page.getByRole('button', { name: '다음', exact: true }).isEnabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.screenshot({ path: path.join(evidence, scenario + '-basic.png'), fullPage: true });
      await page.getByRole('button', { name: '이전', exact: true }).click();
      await page.getByRole('radio', { name: nonpersonal }).click();
      await page.getByRole('button', { name: '다음', exact: true }).click();
      assert.equal(await page.getByLabel('조직 이름', { exact: true }).inputValue(), '보존할 조직 초안');
      assert.equal(await page.getByLabel('조직 이름', { exact: true }).isEditable(), true);
      await page.getByRole('button', { name: '이전', exact: true }).click();
      await page.getByRole('radio', { name: /개인 프로젝트 관리 및 사용/ }).click();
      await page.getByRole('button', { name: '다음', exact: true }).click();
      await page.getByRole('button', { name: '다음', exact: true }).click();
      const projects = page.locator('.module-option').filter({ has: page.locator('strong', { hasText: /^프로젝트$/ }) }).getByRole('checkbox');
      const tasks = page.locator('.module-option').filter({ has: page.locator('strong', { hasText: /^업무$/ }) }).getByRole('checkbox');
      await projects.check();
      assert.equal(await tasks.isChecked(), false);
      await tasks.check();
      await projects.uncheck();
      assert.equal(await tasks.isChecked(), true);
      await projects.check();
      await page.getByRole('button', { name: '다음', exact: true }).click();
      assert.equal(await page.locator('.summary-review dd').nth(1).textContent(), owner);
      await page.screenshot({ path: path.join(evidence, scenario + '-review.png'), fullPage: true });
      const created = page.waitForResponse(response => response.url().endsWith(native ? '/pg/companies' : '/tenants') && response.request().method() === 'POST');
      const home = page.waitForURL(origin + '/');
      await page.getByRole('button', { name: '조직 만들기', exact: true }).click();
      const response = await created;
      assert.equal(response.status(), 201);
      const body = response.request().postDataJSON();
      assert.equal(body.name, owner);
      assert.equal(body.type, 'personal');
      assert.equal(Object.hasOwn(body, 'departments'), false);
      assert.ok(body.modules.includes('projects') && body.modules.includes('tasks'));
      const organization = await response.json();
      assert.equal(organization.name, owner);
      assert.equal(organization.type, 'personal');
      await home;
      await page.reload();
      if (width < 600) await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
      await page.locator('.workspace-picker__button').waitFor();
      if (width < 600) await page.getByRole('button', { name: '메뉴 닫기', exact: true }).click();
      const session = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
      assert.equal(session.orgId, organization.org_id);
      assert.equal(session.organizations.find(org => org.org_id === organization.org_id).org_type, 'personal');
      const login = await api(server.baseUrl, native ? '/pg/auth/login' : '/auth/login', { method: 'POST', body: { email, password } });
      assert.equal(login.status, 200);
      const freshToken = login.body.token ?? login.body.access_token;
      const membership = await api(server.baseUrl, native ? '/pg/auth/workspace' : '/auth/me', { token: freshToken });
      assert.equal(membership.status, 200);
      assert.equal(membership.body.organizations[0].org_name, owner);
      assert.equal(membership.body.organizations[0].org_type, 'personal');
      const departments = await api(server.baseUrl, native ? '/pg/members/departments' : '/members/departments', { token: freshToken, orgId: organization.org_id });
      assert.equal(departments.status, 200);
      assert.deepEqual(departments.body.items, []);
      if (native) {
        assert.deepEqual((await database.pool.query('SELECT name,organization_type FROM org.companies WHERE id=$1', [organization.org_id.slice(3)])).rows, [{ name: owner, organization_type: 'personal' }]);
        assert.equal((await database.pool.query('SELECT company_id FROM auth.users WHERE email=$1', [email])).rows[0].company_id, null);
      }
      // 같은 실제 화면에서 비개인 조직도 이름을 입력해 정상 생성한다.
      await page.goto(origin + '/onboarding/organization');
      await page.getByRole('radio', { name: nonpersonal }).click();
      await page.getByRole('button', { name: '다음', exact: true }).click();
      await page.getByLabel('조직 이름', { exact: true }).fill('비개인 조직 ' + scenario);
      await page.getByRole('button', { name: '다음', exact: true }).click();
      await page.getByRole('button', { name: '다음', exact: true }).click();
      const companyCreated = page.waitForResponse(response => response.url().endsWith(native ? '/pg/companies' : '/tenants') && response.request().method() === 'POST');
      const companyHome = page.waitForURL(origin + '/');
      await page.getByRole('button', { name: '조직 만들기', exact: true }).click();
      const companyResponse = await companyCreated;
      assert.equal(companyResponse.status(), 201);
      const company = await companyResponse.json();
      assert.equal(company.name, '비개인 조직 ' + scenario);
      assert.equal(company.type, native ? 'perp_db' : 'custom');
      await companyHome;
      const companyDepartments = await api(server.baseUrl, native ? '/pg/members/departments' : '/members/departments', { token: freshToken, orgId: company.org_id });
      assert.equal(companyDepartments.status, 200);
      assert.deepEqual(companyDepartments.body.items, []);
      assert.deepEqual(errors, []);
      results.push({ name: scenario, result: 'PASS', checks: 'real signup (PG), personal name, no department input/payload/rows, type switch, independent projects/tasks, create, reload, re-login, persisted PG row, nonpersonal create' });
      console.log('PASS ' + scenario);
    } catch (error) {
      await page.screenshot({ path: path.join(evidence, scenario + '-failure.png'), fullPage: true });
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  await vite?.close();
  await server?.close();
  if (server) { const { pgPool } = await import('../../backend/src/config/pg.js'); await pgPool.end(); }
  await database?.close();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ results, cleanup: 'Owned Chrome, Vite, API and PG closed; temporary SQLite and PG cluster removed; no production writes' }, null, 2));
}
console.log('PERSONAL_ONBOARDING_BROWSER_PASS');
