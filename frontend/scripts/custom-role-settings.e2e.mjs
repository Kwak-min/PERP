import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { api, createOwnerOrg, startTestServer } from '../../backend/tests/http.js';
import { installRoleFixture } from '../../backend/tests/pg-custom-role-fixture.js';

const pg = process.argv.includes('--pg');
let backend, fixture, web, browser;
const evidence = new URL('../../.omo/custom-role-evidence/', import.meta.url);
const serverErrors = [], pageErrors = [];
try {
  backend = await startTestServer();
  let owner, member, membershipId;
  if (pg) { fixture = await installRoleFixture(); owner = fixture.actor(); member = fixture.actor('102'); membershipId = '102'; }
  else {
    owner = await createOwnerOrg(backend.baseUrl, ['projects', 'tasks', 'agent', 'assets']);
    const email = `role-browser-${crypto.randomUUID()}@example.invalid`;
    const invite = await api(backend.baseUrl, '/members/invites', { ...owner, method: 'POST', body: { email, roles: ['member'] } });
    assert.equal(invite.status, 201);
    const signup = await api(backend.baseUrl, '/auth/signup', { method: 'POST', body: { email, name: '역할 브라우저', password: 'password-1234', invitation_token: invite.body.token } });
    assert.equal(signup.status, 201);
    member = { token: signup.body.access_token, orgId: owner.orgId };
    const { db } = await import('../../backend/src/config/db.js');
    membershipId = db().prepare('SELECT id FROM membership WHERE user_id = ? AND org_id = ?').get(signup.body.user.id, owner.orgId).id;
  }
  web = createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/v1/')) {
        let body = ''; for await (const chunk of req) body += chunk;
        const response = await fetch(`${backend.baseUrl}${req.url.slice(7)}`, { method: req.method,
          headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization ?? '', 'X-Org-Id': req.headers['x-org-id'] ?? '' },
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
        if (response.status >= 500) serverErrors.push([req.url, response.status]);
        res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text()); return;
      }
      const file = extname(req.url) ? req.url.slice(1) : 'index.html';
      const body = await readFile(new URL(`../dist/${file}`, import.meta.url));
      res.setHeader('Content-Type', extname(file) === '.js' ? 'text/javascript' : extname(file) === '.css' ? 'text/css' : 'text/html'); res.end(body);
    } catch (error) { serverErrors.push(error.message); res.writeHead(500); res.end(); }
  });
  const ready = once(web, 'listening', { signal: AbortSignal.timeout(5000) }); web.listen(0, '127.0.0.1'); await ready;
  const base = `http://127.0.0.1:${web.address().port}`;
  browser = await chromium.launch({ channel: 'chrome' });
  async function pageFor(actor) {
    const context = await browser.newContext();
    await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await context.addInitScript(actor => sessionStorage.setItem('orbitflow.session.v1', JSON.stringify({ ...actor, name: '역할 QA', email: 'fixture@example.invalid', mustChangePassword: false,
      organizations: [{ org_id: actor.orgId, org_name: '역할 QA 회사', org_type: actor.orgId.startsWith('pg:') ? 'perp_db' : 'custom', roles: [] }] })), actor);
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message)); return page;
  }
  const adminPage = await pageFor(owner);
  await adminPage.goto(`${base}/settings`);
  await expect(adminPage.getByRole('heading', { name: '설정', exact: true })).toBeVisible();
  const navigation = adminPage.getByRole('navigation', { name: '주 메뉴', exact: true });
  await expect(navigation.locator('a[href="/"]')).toHaveCount(1);
  await expect(navigation.locator('a[href="/admin"], a[href="/org-chart"], a[href="/org-log"], a[href="/tasks"]')).toHaveCount(0);
  await expect(adminPage.locator('.settings-links a[href="/settings/ai-key"]')).toBeVisible();
  await adminPage.locator('.settings-links a[href="/settings/roles"]').click();
  await expect(adminPage.getByRole('heading', { name: '역할 만들기', exact: true })).toBeVisible();
  await adminPage.getByLabel('역할 이름', { exact: true }).fill('테스트2');
  for (const code of ['menu.projects', 'task.read', 'project.read']) await adminPage.locator('form label').filter({ has: adminPage.locator('small', { hasText: new RegExp(`^${code.replace('.', '\\.')}$`) }) }).getByRole('checkbox').check();
  const createdSignal = adminPage.waitForResponse(response => response.url().endsWith('/settings/roles') && response.request().method() === 'POST', { timeout: 5000 });
  await adminPage.getByRole('button', { name: '역할 생성', exact: true }).click();
  const created = await createdSignal; assert.equal(created.status(), 201); const role = await created.json();
  await adminPage.getByRole('combobox', { name: '구성원', exact: true }).selectOption(membershipId);
  const assignments = adminPage.locator('section').filter({ has: adminPage.getByRole('heading', { name: '구성원 역할 배정', exact: true }) }).last();
  for (const checked of await assignments.getByRole('checkbox', { checked: true }).all()) await checked.uncheck();
  await assignments.getByRole('checkbox', { name: '테스트2', exact: true }).check();
  const assignedSignal = adminPage.waitForResponse(response => response.url().endsWith(`/settings/members/${membershipId}/roles`) && response.request().method() === 'PUT', { timeout: 5000 });
  await adminPage.getByRole('button', { name: '역할 배정 저장', exact: true }).click(); assert.equal((await assignedSignal).status(), 200);
  const restrictedPage = await pageFor(member);
  await restrictedPage.goto(`${base}/members`);
  await expect(restrictedPage.getByTestId('screen-access-denied')).toBeVisible();
  assert.equal((await api(backend.baseUrl, pg ? '/pg/members' : '/members', member)).status, 403);
  const memberNav = restrictedPage.getByRole('navigation', { name: '주 메뉴', exact: true });
  await expect(memberNav.locator('a')).toHaveCount(1);
  await expect(memberNav.locator('a[href="/projects"]')).toBeVisible();
  await memberNav.locator('a[href="/projects"]').click();
  await expect(restrictedPage.locator('.project-tasks')).toBeVisible();
  await mkdir(evidence, { recursive: true });
  await restrictedPage.screenshot({ path: fileURLToPath(new URL(`${pg ? 'pg' : 'legacy'}-restricted.png`, evidence)) });
  await adminPage.getByTestId(`role-${role.key}`).getByRole('button', { name: '수정', exact: true }).click();
  await adminPage.locator('form label').filter({ has: adminPage.locator('small', { hasText: /^menu\.projects$/ }) }).getByRole('checkbox').uncheck();
  const savedSignal = adminPage.waitForResponse(response => response.url().endsWith(`/settings/roles/${role.key}`) && response.request().method() === 'PATCH', { timeout: 5000 });
  await adminPage.getByRole('button', { name: '역할 저장', exact: true }).click(); assert.equal((await savedSignal).status(), 200);
  const refreshed = restrictedPage.waitForResponse(response => response.url().endsWith('/settings/access'), { timeout: 5000 });
  await restrictedPage.evaluate(() => window.dispatchEvent(new Event('focus'))); assert.equal((await refreshed).status(), 200);
  await expect(restrictedPage.getByTestId('screen-access-denied')).toBeVisible();
  assert.equal((await api(backend.baseUrl, pg ? '/pg/tasks' : '/tasks', member)).status, 403);
  await adminPage.getByTestId(`role-${role.key}`).getByRole('button', { name: '삭제', exact: true }).click();
  const deletedSignal = adminPage.waitForResponse(response => response.url().endsWith(`/settings/roles/${role.key}`) && response.request().method() === 'DELETE', { timeout: 5000 });
  await adminPage.getByRole('button', { name: '삭제 확정', exact: true }).click(); assert.equal((await deletedSignal).status(), 204);
  assert.deepEqual((await api(backend.baseUrl, '/settings/access', member)).body.permissions, []);
  await adminPage.setViewportSize({ width: 375, height: 812 });
  await adminPage.goto(`${base}/settings`);
  await expect(adminPage.getByRole('heading', { name: '설정', exact: true })).toBeVisible();
  assert.ok(await adminPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await adminPage.screenshot({ path: fileURLToPath(new URL(`${pg ? 'pg' : 'legacy'}-settings-mobile.png`, evidence)) });
  assert.deepEqual(pageErrors, []); assert.deepEqual(serverErrors, []);
  console.log(`CUSTOM_ROLE_CHROME_PASS ${pg ? 'pg-sql-fixture' : 'legacy-real-sqlite'} ${browser.version()}`);
} finally {
  await browser?.close();
  if (web) await new Promise(resolve => web.close(resolve));
  await backend?.close(); await fixture?.close();
}
