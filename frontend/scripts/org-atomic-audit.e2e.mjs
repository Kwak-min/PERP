import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { startOrgPostgres } from '../../backend/tests/pg-org-native-fixture.js';
import { api, startTestServer } from '../../backend/tests/http.js';

// 실제 Chrome → Vite → Express → 로컬 PostgreSQL. API 응답 fixture는 사용하지 않는다.
const root = fileURLToPath(new URL('../', import.meta.url));
const built = process.env.ORG_BUILT === '1';
const evidence = process.env.ORG_TEST_EVIDENCE ?? `${root}/.artifacts/org-atomic-audit`;
await mkdir(evidence, { recursive: true });
let database, server, vite, browser;
try {
  database = await startOrgPostgres(); server = await startTestServer();
  const { users, companyId, depts, pool } = database;
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: users[0].email, password: 'password-1234' } });
  assert.equal(login.status, 200);
  const session = { token: login.body.token, orgId: `pg:${companyId}`, name: users[0].name, email: users[0].email,
    mustChangePassword: false, organizations: [{ org_id: `pg:${companyId}`, org_name: 'F8_ISOLATED_A', org_type: 'perp_db', roles: ['F8_EXISTING_ROLE'] }] };
  const proxy = { '/api': new URL(server.baseUrl).origin };
  vite = built ? await preview({ configFile: false, root, preview: { host: '127.0.0.1', port: 0, proxy } })
    : await createServer({ configFile: false, root, plugins: [react()], server: { host: '127.0.0.1', port: 0,
      proxy, watch: { ignored: ['**/.artifacts/**', '**/dist/**'] } } });
  if (!built) await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: process.env.ORG_TEST_HEADED !== '1' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'ko-KR' });
  await context.addInitScript(value => localStorage.setItem('orbitflow.session.v1', JSON.stringify(value)), session);
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = [], writes = [], responses = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/v1/') && request.method() !== 'GET') writes.push({ url: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() }); });
  page.on('response', response => { if (response.url().includes('/api/v1/pg/members')) responses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  await page.goto(`${origin}/org-chart`);
  await page.locator('[data-org-state="ready"][data-org-permissions="ready"]').waitFor();
  assert.equal(await page.locator('.org-directory tbody tr').count(), 3);
  // 정확한 요청 이벤트를 가로막아 loading을 관찰하고 실제 HTTP를 재개한다.
  const arrived = Promise.withResolvers(), release = Promise.withResolvers();
  const activityPath = '**/api/v1/pg/members/activity?limit=200';
  await page.route(activityPath, async route => { arrived.resolve(); await release.promise; await route.continue(); }, { times: 1 });
  const emptyResponse = page.waitForResponse(r => r.url().includes('/members/activity?limit=200'));
  await page.locator('#org-log-trigger').click();
  await Promise.race([arrived.promise, new Promise((_, reject) => AbortSignal.timeout(15000).addEventListener('abort', () => reject(new Error('activity request not observed')), { once: true }))]);
  assert.equal(await page.locator('#org-log-dialog').getAttribute('data-org-log-state'), 'loading');
  await page.screenshot({ path: `${evidence}/loading.png` });
  release.resolve(); assert.equal((await emptyResponse).status(), 200);
  await page.locator('[data-org-log-state="empty"]').waitFor();
  assert.equal(await page.locator('.orglog-list > li').count(), 0);
  await page.screenshot({ path: `${evidence}/empty.png` });
  await page.keyboard.press('Escape');
  await page.locator('.orgchart__setup').first().click();
  await page.locator('.seat-setup__leader select').selectOption(users[0].id);
  for (const member of [users[1], users[2]]) await page.locator('.seat-flow__column:not(.seat-flow__column--target) li').filter({ hasText: member.name }).getByRole('button').click();
  const saved = page.waitForResponse(r => r.url().endsWith(`/departments/${depts[0].id}/seat`) && r.request().method() === 'PATCH');
  const refreshed = page.waitForResponse(r => r.url().endsWith('/members/org-chart'));
  await page.locator('.seat-setup__actions').getByRole('button').last().click();
  assert.equal((await saved).status(), 200); assert.equal((await refreshed).status(), 200);
  await page.locator('[data-org-state="ready"][data-org-permissions="ready"]').waitFor();
  assert.equal(writes.length, 1); assert.equal(writes[0].url, `/api/v1/pg/members/departments/${depts[0].id}/seat`);
  assert.deepEqual(writes[0].body.assigned, [users[1].id, users[2].id]);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM org.organization_change_events')).rows[0].count, 3);
  const activity = page.waitForResponse(r => r.url().includes('/members/activity?limit=200'));
  await page.locator('#org-log-trigger').click(); assert.equal((await activity).status(), 200);
  await page.locator('[data-org-log-state="ready"]').waitFor();
  assert.equal(await page.locator('.orglog-list > li').count(), 3);
  assert.equal(await page.locator('.orglog-item__actor').first().textContent(), users[0].name);
  assert.equal(await page.locator('.orglog-item__diff ins').count(), 3);
  await page.screenshot({ path: `${evidence}/committed-audit.png` });
  await page.keyboard.press('Escape');
  // 서버에서 다른 변경 후 오래된 편집을 전송한다. UI 입력/배치를 보존해야 한다.
  await page.locator('.orgchart__reassign').first().click();
  await page.locator('.seat-setup__leader select').selectOption(users[1].id);
  await page.locator('.seat-flow__column--target li').filter({ hasText: users[2].name }).getByRole('button').click();
  const external = await api(server.baseUrl, `/pg/members/${users[0].id}/assignment`, { ...session, method: 'PATCH', body: { department_id: depts[1].id } });
  assert.equal(external.status, 200);
  const beforeConflict = (await pool.query('SELECT * FROM org.organization_change_events ORDER BY id')).rows;
  const conflict = page.waitForResponse(r => r.url().endsWith(`/departments/${depts[0].id}/seat`) && r.request().method() === 'PATCH');
  await page.locator('.seat-setup__actions').getByRole('button').last().click();
  assert.equal((await conflict).status(), 409);
  await page.locator('.org-unified > .form-error').waitFor();
  assert.equal(await page.locator('.seat-setup__leader select').inputValue(), users[1].id);
  assert.equal(await page.locator('.seat-flow__column--target li b').count(), 1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal(await page.locator('.seat-setup__leader select').inputValue(), users[1].id);
  assert.deepEqual((await pool.query('SELECT * FROM org.organization_change_events ORDER BY id')).rows, beforeConflict);
  await page.screenshot({ path: `${evidence}/conflict-draft-retained.png`, fullPage: true });
  // 실제 저장소 미배포 오류가 빈 목록으로 위장되지 않고 재시도로 복구된다.
  await pool.query('ALTER TABLE org.organization_change_events RENAME TO f8_held_events');
  const failed = page.waitForResponse(r => r.url().includes('/members/activity?limit=200'));
  await page.locator('#org-log-trigger').click(); assert.equal((await failed).status(), 503);
  await page.locator('[data-org-log-state="error"]').waitFor();
  assert.equal(await page.locator('.orglog-list > li').count(), 0);
  await page.screenshot({ path: `${evidence}/storage-error.png` });
  await pool.query('ALTER TABLE org.f8_held_events RENAME TO organization_change_events');
  const recovered = page.waitForResponse(r => r.url().includes('/members/activity?limit=200'));
  await page.locator('.orglog-modal__toolbar button').click(); assert.equal((await recovered).status(), 200);
  await page.locator('[data-org-log-state="ready"]').waitFor();
  assert.equal(await page.locator('.orglog-list > li').count(), 4);
  // 비활성 소속의 기존 부서는 보존하고 편집 가능한 활성 인원만 전송한다.
  await page.keyboard.press('Escape');
  await pool.query("UPDATE org.company_memberships SET status = 'suspended' WHERE company_id=$1 AND user_id=$2", [companyId, users[2].id]);
  const inactiveRefresh = page.waitForResponse(r => r.url().endsWith('/members/org-chart'));
  await page.locator('.screen-header__actions button').last().click(); await inactiveRefresh;
  await page.locator('[data-org-state="ready"][data-org-permissions="ready"]').waitFor();
  await page.locator('.orgchart__reassign').first().click();
  await page.locator('.seat-setup__leader select').selectOption(users[1].id);
  const activeSaved = page.waitForResponse(r => r.url().endsWith(`/departments/${depts[0].id}/seat`) && r.request().method() === 'PATCH');
  const activeRefresh = page.waitForResponse(r => r.url().endsWith('/members/org-chart'));
  await page.locator('.seat-setup__actions').getByRole('button').last().click();
  assert.equal((await activeSaved).status(), 200); await activeRefresh;
  assert.deepEqual(writes.at(-1).body.assigned, [users[1].id]);
  assert.equal((await pool.query('SELECT department_id FROM org.company_memberships WHERE company_id=$1 AND user_id=$2', [companyId, users[2].id])).rows[0].department_id, depts[0].id);
  await page.locator('[data-org-state="ready"][data-org-permissions="ready"]').waitFor();
  const finalActivity = page.waitForResponse(r => r.url().includes('/members/activity?limit=200'));
  await page.locator('#org-log-trigger').click(); assert.equal((await finalActivity).status(), 200);
  await page.locator('[data-org-log-state="ready"]').waitFor();
  assert.equal(await page.locator('.orglog-list > li').count(), 5);
  assert.deepEqual(errors, []);
  const result = { CHROME_NATIVE_PG_PASS: true, built, origin, api: server.baseUrl, writes, responses, states: ['loading', 'empty', 'ready', 'error', 'ready'], conflictDraftRetained: true, pageErrors: errors };
  await writeFile(`${evidence}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (process.env.ORG_TEST_HEADED === '1') {
    await page.evaluate(() => { document.title = 'F8_ISOLATED_ORG_AUDIT'; });
    console.log('F8_COMPUTER_USE_READY');
    await new Promise((resolve, reject) => {
      process.stdin.once('data', () => { process.stdin.destroy(); resolve(); });
      AbortSignal.timeout(180000).addEventListener('abort', () => reject(new Error('headed inspection deadline exceeded')), { once: true });
    });
  }
} finally {
  await browser?.close();
  if (vite) {
    if (built) await new Promise((resolve, reject) => vite.httpServer.close(error => error ? reject(error) : resolve()));
    else await vite.close();
  }
  if (server) { await (await import('../../backend/src/config/pg.js')).closePgPool(); await server.close(); }
  await database?.close();
  console.log('F8_CHROME_OWNED_SERVICES_AND_DATA_CLEANED');
}
