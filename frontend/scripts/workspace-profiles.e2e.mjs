import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { api, startTestServer } from '../../backend/tests/http.js';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';
import { ORG_TEMPLATES } from '../../backend/src/config/org-templates.js';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
const frontend = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(frontend, '.artifacts/workspace-profiles');
await mkdir(evidence, { recursive: true });
const results = [], password = 'password-1234', storageKey = 'orbitflow.session.v1';
let database, server, vite, browser;
try {
  database = await startDailyNativePostgres();
  for (const file of ['perp_additions_v8.sql', 'perp_additions_v19_personal_organizations.sql', 'perp_additions_v20_workspace_profiles.sql']) {
    await database.pool.query(await readFile(new URL('../../db/' + file, import.meta.url), 'utf8'));
  }
  server = await startTestServer();
  vite = await createServer({ configFile: false, root: frontend, plugins: [react()], server: {
    host: '127.0.0.1', port: 0, watch: { ignored: ['**/.artifacts/**', '**/dist/**'] }, proxy: { '/api': new URL(server.baseUrl).origin },
  } });
  await vite.listen();
  const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  for (const native of [true, false]) for (const width of [375, 768, 1280]) {
    const scenario = `${native ? 'pg' : 'sqlite'}-${width}`;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const owner = '사용자 ' + scenario, email = scenario + '@profiles.invalid';
      const signup = await api(server.baseUrl, native ? '/pg/auth/signup' : '/auth/signup', { method: 'POST', body: { email, name: owner, password } });
      assert.equal(signup.status, 201);
      const token = signup.body.token ?? signup.body.access_token;
      const before = await api(server.baseUrl, native ? '/pg/auth/workspace' : '/auth/me', { token });
      assert.deepEqual(before.body.organizations, []);
      await page.goto(origin + '/login');
      await page.evaluate(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: storageKey, session: {
        token, name: owner, email, orgId: null, organizations: [], mustChangePassword: false, organizationStatus: 'ready',
      } });
      for (const type of ['personal', 'company', 'club', 'lab']) {
        const catalog = page.waitForResponse(r => r.url().endsWith('/tenants/modules/catalog'));
        await page.goto(origin + '/onboarding/organization');
        await catalog;
        const primary = page.locator('.type-grid--primary input[type=radio]');
        assert.equal(await primary.count(), 4);
        await page.locator(`[data-profile="${type}"]`).click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(evidence, `${scenario}-${type}-choices.png`), fullPage: true });
        await page.getByRole('button', { name: '다음', exact: true }).click();
        const input = page.getByLabel('조직 이름', { exact: true });
        if (type === 'personal') { assert.equal(await input.inputValue(), owner); assert.equal(await input.isEditable(), false); }
        else await input.fill(`${type} ${scenario}`);
        await page.getByRole('button', { name: '다음', exact: true }).click();
        const module = key => page.locator(`[data-module="${key}"] input`);
        const feature = key => page.locator(`[data-feature="${key}"] input`);
        for (const key of ORG_TEMPLATES[type].modules.filter(k => k !== 'approvals')) assert.equal(await module(key).isChecked(), true, `${type} ${key}`);
        assert.equal(await module('finance').isChecked(), true);
        assert.equal(await page.locator('.onboarding-options').getAttribute('open'), null);
        for (const key of ['attendance', 'leave', 'approvals']) assert.equal(await feature(key).isChecked(), false);
        assert.equal(await page.locator('.module-option--core').count(), 0);
        if (type === 'company') {
          assert.deepEqual(await page.locator('[data-module]:has(input:checked)').evaluateAll(items => items.map(item => item.dataset.module).sort()), ['agent', 'calendar', 'documents', 'finance', 'projects', 'tasks']);
          for (const key of ['hr', 'automations', 'analytics', 'assets', 'handover']) {
            assert.equal(await module(key).isChecked(), false);
            assert.equal(await page.locator(`.onboarding-options [data-module="${key}"]`).count(), 1);
          }
          await page.screenshot({ path: path.join(evidence, `${scenario}-company-lean-default.png`), fullPage: true });
        }
        await module('projects').uncheck();
        assert.equal(await module('tasks').isChecked(), true);
        await page.locator('.onboarding-options summary').click();
        if (type === 'company') {
          await module('assets').check();
          await module('analytics').check();
        }
        await feature('approvals').check();
        await feature('attendance').check();
        await feature('leave').check();
        await feature('leave').uncheck();
        // 유형별 사용자 초안은 돌아가기, 같은 유형 재선택, 다른 유형 왕복에도 유지한다.
        await page.getByRole('button', { name: '이전', exact: true }).click();
        await page.getByRole('button', { name: '이전', exact: true }).click();
        await page.locator(`[data-profile="${type}"]`).click();
        await page.locator(`[data-profile="${type === 'club' ? 'lab' : 'club'}"]`).click();
        await page.locator(`[data-profile="${type}"]`).click();
        await page.getByRole('button', { name: '다음', exact: true }).click();
        assert.equal(await input.inputValue(), type === 'personal' ? owner : `${type} ${scenario}`);
        await page.getByRole('button', { name: '다음', exact: true }).click();
        assert.equal(await module('projects').isChecked(), false);
        assert.equal(await module('finance').isChecked(), true);
        assert.equal(await feature('approvals').isChecked(), true);
        assert.equal(await feature('attendance').isChecked(), true);
        assert.equal(await feature('leave').isChecked(), false);
        if (type === 'company') {
          assert.equal(await module('assets').isChecked(), true);
          assert.equal(await module('analytics').isChecked(), true);
          for (const key of ['hr', 'automations', 'handover']) assert.equal(await module(key).isChecked(), false);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(evidence, `${scenario}-${type}-modules.png`), fullPage: true });
        await page.getByRole('button', { name: '다음', exact: true }).click();
        await page.screenshot({ path: path.join(evidence, `${scenario}-${type}-review.png`), fullPage: true });
        const created = page.waitForResponse(r => r.url().endsWith(native ? '/pg/companies' : '/tenants') && r.request().method() === 'POST');
        const home = page.waitForURL(origin + '/');
        await page.getByRole('button', { name: '조직 만들기', exact: true }).click();
        const response = await created;
        assert.equal(response.status(), 201);
        const sent = response.request().postDataJSON(), organization = await response.json();
        assert.equal(sent.type, type);
        assert.ok(sent.modules.includes('finance') && !sent.modules.includes('projects'));
        if (type === 'company') {
          assert.ok(sent.modules.includes('assets') && sent.modules.includes('analytics'));
          for (const key of ['hr', 'automations', 'handover']) assert.equal(sent.modules.includes(key), false);
        }
        assert.deepEqual([...sent.features].sort(), ['approvals', 'attendance']);
        assert.equal(Object.hasOwn(sent, 'departments'), false);
        assert.equal(organization.type, native && type === 'company' ? 'perp_db' : type);
        await home;
        const fresh = await api(server.baseUrl, native ? '/pg/auth/workspace' : '/auth/me', { token });
        const workspace = fresh.body.organizations.find(o => o.org_id === organization.org_id);
        assert.equal(workspace.org_type, organization.type);
        const departments = await api(server.baseUrl, native ? '/pg/members/departments' : '/members/departments', { token, orgId: organization.org_id });
        assert.equal(departments.status, 200); assert.deepEqual(departments.body.items, []);
        results.push({ scenario, type, result: 'PASS', sent, organization });
        console.log('PASS ' + scenario + ' ' + type);
      }
      assert.deepEqual(errors, []);
    } catch (error) {
      await page.screenshot({ path: path.join(evidence, scenario + '-failure.png'), fullPage: true });
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser?.close(); await vite?.close(); await server?.close();
  if (server) { const { pgPool } = await import('../../backend/src/config/pg.js'); await pgPool.end(); }
  await database?.close();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ results, cleanup: 'Owned Chrome, Vite, API and native PG closed; isolated databases removed' }, null, 2));
}
console.log('WORKSPACE_PROFILES_BROWSER_PASS');
