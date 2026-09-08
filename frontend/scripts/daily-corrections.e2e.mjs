import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { api, createOwnerOrg, startTestServer } from '../../backend/tests/http.js';
import { installDailyPgFixture } from '../../backend/tests/daily-pg-fixture.js';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';
process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = fileURLToPath(new URL('../../.omo/daily-chrome/', import.meta.url));
await mkdir(evidence, { recursive: true });
let browser, vite, server, fixture;
try {
  if (process.env.DAILY_TEST_PG_BIN) { fixture = await startDailyNativePostgres(); server = await startTestServer(); }
  else { server = await startTestServer(); fixture = await installDailyPgFixture(); }
  const owner = await createOwnerOrg(server.baseUrl, ['projects','tasks','calendar','assets']);
  const colleague = await createOwnerOrg(server.baseUrl, ['projects','tasks','calendar','assets']);
  const { db } = await import('../../backend/src/config/db.js'); const { insert } = await import('../../backend/src/models/base.js');
  const tenant = db().prepare('SELECT tenant_id FROM membership WHERE org_id = ?').get(owner.orgId).tenant_id;
  insert('membership', { tenant_id: tenant, org_id: owner.orgId, user_id: colleague.userId, status: 'active', created_by: owner.userId });
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.identity.users[0].email, password: 'password-1234' } }); assert.equal(login.status, 200);
  const serverOptions = { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(server.baseUrl).origin } };
  if (process.env.DAILY_BUILT === '1') vite = await preview({ configFile: false, root, preview: serverOptions });
  else { vite = await createServer({ configFile: false, root, plugins: [react()], server: serverOptions }); await vite.listen(); }
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  console.log('SURFACE', process.env.DAILY_BUILT === '1' ? 'production build' : 'Vite development');
  browser = await chromium.launch({ channel: 'chrome' }); console.log('Chrome', browser.version());
  for (const session of [{ ...owner, userId: colleague.userId, pg: false }, { token: login.body.token, orgId: `pg:${fixture.companyId ?? '77'}`, pg: true, userId: fixture.assigneeId ?? '102' }]) {
    const prefix = session.pg ? '/pg' : '';
    const request = (path, body, method = 'POST') => api(server.baseUrl, prefix + path, { ...session, method, body, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    const project = (await request('/projects', { name: 'Browser project' })).body.id;
    const task = (await request('/tasks', { project_id: project, title: 'Browser task' })).body.id;
    const event = (await request('/calendar', { title: 'Browser event', ...(session.pg ? { starts_at: '2026-09-08T09:00:00Z', ends_at: '2026-09-08T10:00:00Z' } : { start_at: '2026-09-08T09:00:00Z', end_at: '2026-09-08T10:00:00Z' }) })).body.id;
    const asset = (await request('/assets', { name: 'Browser asset', asset_no: 'QA-CHROME' })).body.id;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await context.addInitScript(stored => localStorage.setItem('orbitflow.session.v1', JSON.stringify(stored)), { ...session, name: 'QA', email: 'qa@example.invalid', mustChangePassword: false, organizations: [{ org_id: session.orgId, org_name: 'QA', org_type: session.pg ? 'perp_db' : 'custom', roles: ['owner'] }] });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const responseFor = (path, method = 'PATCH') => page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${prefix}${path}` && response.request().method() === method, { timeout: 10000 });
    const save = async (path, button, method = 'PATCH') => { const pending = responseFor(path, method); await button.click(); const response = await pending;
      assert.equal(response.status(), 200); const body = response.request().postDataJSON(); assert.equal(typeof body.version, 'number'); assert.equal('expected_version' in body, false);
    };
    await page.goto(`${origin}/projects/${project}`);
    await page.getByRole('button', { name: '프로젝트 수정', exact: true }).click();
    await page.getByLabel('이름', { exact: true }).fill('Corrected browser project');
    await page.getByLabel('시작', { exact: true }).fill('2026-10-01'); await page.getByLabel('종료', { exact: true }).fill('2026-10-31');
    await save(`/projects/${project}`, page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }));
    await page.reload(); await expect(page.getByRole('button', { name: /Corrected browser project/ })).toBeVisible();
    await page.getByRole('button', { name: '프로젝트 수정', exact: true }).click();
    await expect(page.getByLabel('시작', { exact: true })).toHaveValue('2026-10-01'); await expect(page.getByLabel('종료', { exact: true })).toHaveValue('2026-10-31');
    await page.getByLabel('이름', { exact: true }).fill('Project draft retained');
    assert.equal((await request(`/projects/${project}`, { version: 2, name: 'Concurrent project' }, 'PATCH')).status, 200);
    const projectConflict = responseFor(`/projects/${project}`); await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click(); assert.equal((await projectConflict).status(), 409);
    await expect(page.getByLabel('이름', { exact: true })).toHaveValue('Project draft retained'); await expect(page.getByRole('alert')).toBeVisible();
    await page.screenshot({ path: `${evidence}/${session.pg ? 'pg' : 'legacy'}-project-draft.png`, fullPage: true });
    await page.goto(`${origin}/tasks/${task}`); await expect(page.getByLabel('담당자', { exact: true })).toBeEnabled();
    await page.getByLabel('담당자', { exact: true }).selectOption(session.userId); await page.getByLabel('기한', { exact: true }).fill('2026-10-15');
    await save(`/tasks/${task}`, page.getByRole('button', { name: '변경 저장', exact: true }));
    await page.reload(); await expect(page.getByLabel('담당자', { exact: true })).toHaveValue(session.userId);
    await expect(page.getByLabel('기한', { exact: true })).toHaveValue('2026-10-15');
    if (session.pg) assert.equal((await request(`/tasks/${task}`, { version: 2, assignee_id: fixture.foreignId ?? '103' }, 'PATCH')).status, 403);
    await page.getByLabel('제목', { exact: true }).fill('Task draft retained');
    assert.equal((await request(`/tasks/${task}`, { version: 2, title: 'Concurrent task' }, 'PATCH')).status, 200);
    const taskConflict = responseFor(`/tasks/${task}`); await page.getByRole('button', { name: '변경 저장', exact: true }).click(); assert.equal((await taskConflict).status(), 409);
    await expect(page.getByLabel('제목', { exact: true })).toHaveValue('Task draft retained');
    await page.screenshot({ path: `${evidence}/${session.pg ? 'pg' : 'legacy'}-task-draft.png`, fullPage: true });
    await page.goto(`${origin}/calendar/${event}`); await page.getByRole('button', { name: '일정 수정', exact: true }).click();
    await page.getByLabel('제목', { exact: true }).fill('Rescheduled browser event');
    await page.getByLabel('시작', { exact: true }).fill('2026-09-10T09:00'); await page.getByLabel('종료', { exact: true }).fill('2026-09-10T10:00');
    await save(`/calendar/${event}`, page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }));
    await page.reload(); await expect(page.getByText('Rescheduled browser event', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '일정 수정', exact: true }).click(); await page.getByLabel('제목', { exact: true }).fill('Calendar draft retained');
    assert.equal((await request(`/calendar/${event}`, { version: 2, title: 'Concurrent event' }, 'PATCH')).status, 200);
    const eventConflict = responseFor(`/calendar/${event}`); await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click(); assert.equal((await eventConflict).status(), 409);
    await expect(page.getByLabel('제목', { exact: true })).toHaveValue('Calendar draft retained'); await expect(page.getByRole('alert')).toBeVisible();
    await page.screenshot({ path: `${evidence}/${session.pg ? 'pg' : 'legacy'}-calendar-draft.png`, fullPage: true });
    await page.reload(); await expect(page.getByText('Concurrent event', { exact: true })).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await save(`/calendar/${event}/cancel`, page.getByRole('button', { name: '일정 취소', exact: true }), 'POST');
    await page.goto(`${origin}/assets`); const row = page.getByRole('row').filter({ hasText: 'Browser asset' });
    await row.getByRole('button', { name: '담당·상태', exact: true }).click();
    await expect(page.getByLabel('담당자', { exact: true })).toBeEnabled(); await page.getByLabel('담당자', { exact: true }).selectOption(session.userId);
    const status = session.pg ? 'stored' : 'loaned'; await page.getByLabel('상태', { exact: true }).selectOption(status);
    await save(`/assets/${asset}/custody`, page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }));
    await page.reload(); await row.getByRole('button', { name: '담당·상태', exact: true }).click();
    await expect(page.getByLabel('상태', { exact: true })).toHaveValue(status); await expect(page.getByLabel('담당자', { exact: true })).toHaveValue(session.userId);
    // 실제 동시 HTTP 변경 후 오래된 브라우저 폼 저장: 409와 초안 보존.
    const current = await api(server.baseUrl, `${prefix}/assets/${asset}${session.pg ? '/custody' : ''}`, session);
    assert.equal((await request(`/assets/${asset}/custody`, { version: current.body.version, status: session.pg ? 'repair' : 'repairing' }, 'PATCH')).status, 200);
    await page.getByLabel('상태', { exact: true }).selectOption('lost');
    const stale = responseFor(`/assets/${asset}/custody`); await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click(); assert.equal((await stale).status(), 409);
    await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByLabel('상태', { exact: true })).toHaveValue('lost');
    for (const width of [375,768,1280]) { await page.setViewportSize({ width, height: 900 }); await page.screenshot({ path: `${evidence}/${session.pg ? 'pg' : 'legacy'}-${width}.png`, fullPage: true }); }
    if (session.pg && fixture.pool) {
      const cancelled = (await fixture.pool.query('SELECT cancelled_at,version FROM calendar.events WHERE id=$1', [event])).rows[0];
      assert.ok(cancelled.cancelled_at); assert.equal(cancelled.version, 4);
      const audit = (await fixture.pool.query("SELECT before_data,after_data FROM org.daily_correction_events WHERE resource_type='calendar' AND resource_id=$1 AND action='cancelled'", [event])).rows;
      assert.equal(audit.length, 1); assert.equal(audit[0].before_data.version, 3); assert.equal(audit[0].after_data.version, 4);
      const concurrent = await Promise.all(['Winner A','Winner B'].map(name => request(`/projects/${project}`, { version: 3, name }, 'PATCH')));
      assert.deepEqual(concurrent.map(result => result.status).sort(), [200,409]);
      await fixture.pool.query("CREATE FUNCTION asset.reject_daily_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected native history failure'; END $$; CREATE TRIGGER reject_daily_history BEFORE INSERT ON asset.history FOR EACH ROW EXECUTE FUNCTION asset.reject_daily_history();");
      try { assert.equal((await request(`/assets/${asset}/custody`, { version: 3, status: 'stored' }, 'PATCH')).status, 500); }
      finally { await fixture.pool.query('DROP TRIGGER reject_daily_history ON asset.history'); }
      const after = (await fixture.pool.query('SELECT version,status FROM asset.assets WHERE id=$1', [asset])).rows[0]; assert.equal(after.version, 3); assert.equal(after.status, 'repair');
      const history = (await fixture.pool.query("SELECT count(*) AS total FROM asset.history WHERE asset_id=$1 AND event_type='custody.updated'", [asset])).rows[0]; assert.equal(Number(history.total), 2);
      const foreign = (await fixture.pool.query("INSERT INTO project.projects(company_id,name) VALUES ($1,'Foreign') RETURNING id", [fixture.otherCompanyId])).rows[0].id;
      assert.equal((await request(`/projects/${foreign}`, { version: 1, name: 'Forbidden' }, 'PATCH')).status, 404);
      console.log('NATIVE_HTTP audit retention, real concurrent [200,409], history-failure rollback, foreign-resource404 PASS');
    }
    console.log(session.pg ? process.env.DAILY_TEST_PG_BIN ? 'PG_NATIVE_REAL_AUTH' : 'PG_SQL_ENGINE' : 'LEGACY_SQLITE', 'project/date, reassignment, reschedule/cancel, custody/reload, stale draft PASS');
    await context.close();
  }
} finally { await browser?.close();
  if (vite) { if (process.env.DAILY_BUILT === '1') await new Promise((resolve, reject) => vite.httpServer.close(error => error ? reject(error) : resolve())); else await vite.close(); }
  await server?.close();
  if (process.env.DAILY_TEST_PG_BIN) { const { closePgPool } = await import('../../backend/src/config/pg.js'); await closePgPool(); }
  await fixture?.close(); }
