import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
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
const pageErrors = [];
try {
  if (process.env.DAILY_TEST_PG_BIN) { fixture = await startDailyNativePostgres(); server = await startTestServer(); }
  else { server = await startTestServer(); fixture = await installDailyPgFixture(); }
  if (!fixture.pool) {
    fixture.identity.state.roles.push({ id: '2', company_id: '77', name: 'recipient' });
    fixture.identity.state.grants.push({ user_id: '102', role_id: '2' });
    for (const code of ['notification.read','task.read','project.read','member.read','menu.notifications','menu.tasks','menu.projects','menu.members','menu.home','menu.configured']) fixture.identity.state.permissions.push({ role_id: '2', code });
  }
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
  console.log(JSON.stringify({ ownedApi: server.baseUrl, ownedPreview: origin }));
  browser = await chromium.launch({ channel: 'chrome' }); console.log('Chrome', browser.version());
  for (const session of [{ ...owner, userId: colleague.userId, pg: false }, { token: login.body.token, orgId: `pg:${fixture.companyId ?? '77'}`, pg: true, userId: fixture.assigneeId ?? '102' }]) {
    const prefix = session.pg ? '/pg' : '';
    const request = (path, body, method = 'POST') => api(server.baseUrl, prefix + path, { ...session, method, body, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    const project = (await request('/projects', { name: 'Browser project' })).body.id;
    const task = (await request('/tasks', { project_id: project, title: 'Browser task' })).body.id;
    const secondTask = (await request('/tasks', { project_id: project, title: 'Second browser task' })).body.id;
    const event = (await request('/calendar', { title: 'Browser event', ...(session.pg ? { starts_at: '2026-09-08T09:00:00Z', ends_at: '2026-09-08T10:00:00Z' } : { start_at: '2026-09-08T09:00:00Z', end_at: '2026-09-08T10:00:00Z' }) })).body.id;
    const createdAsset = await request('/assets', { name: 'Browser asset', asset_no: 'QA-CHROME' }); assert.equal(createdAsset.status, 201);
    const asset = createdAsset.body.id;
    for (let i = 0; i < 12; i++) assert.equal((await request('/assets', { name: `Unrelated asset ${i}`, asset_no: `QA-DECOY-${i}` })).status, 201);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await context.addInitScript(stored => localStorage.setItem('orbitflow.session.v1', JSON.stringify(stored)), { ...session, name: 'QA', email: 'qa@example.invalid', mustChangePassword: false, organizations: [{ org_id: session.orgId, org_name: 'QA', org_type: session.pg ? 'perp_db' : 'custom', roles: ['owner'] }] });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => pageErrors.push(error.message));
    const responseFor = (path, method = 'PATCH') => page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${prefix}${path}` && response.request().method() === method, { timeout: 10000 });
    const save = async (path, button, method = 'PATCH') => { const pending = responseFor(path, method); await button.click(); const response = await pending;
      assert.equal(response.status(), 200); const body = response.request().postDataJSON(); assert.equal(typeof body.version, 'number'); assert.equal('expected_version' in body, false);
    };
    await page.goto(`${origin}/projects/${project}`);
    await page.getByRole('button', { name: '구성원 추가', exact: true }).click();
    await expect(page.getByLabel('추가할 구성원', { exact: true })).toBeEnabled(); await page.getByLabel('추가할 구성원', { exact: true }).selectOption(session.userId);
    const memberAdded = responseFor(`/projects/${project}/members`, 'POST'); await page.getByRole('dialog').getByRole('button', { name: '추가', exact: true }).click(); assert.equal((await memberAdded).status(), 201);
    await page.locator(`[data-task-id="${task}"]`).getByRole('button', { name: '담당자 배정', exact: true }).click();
    await expect(page.getByLabel('담당자', { exact: true })).toBeEnabled(); await page.getByLabel('담당자', { exact: true }).selectOption(session.userId);
    await save(`/tasks/${task}`, page.getByRole('dialog').getByRole('button', { name: '배정 저장', exact: true }));
    await page.locator(`[data-task-id="${secondTask}"]`).getByRole('button', { name: '담당자 배정', exact: true }).click();
    await expect(page.getByLabel('담당자', { exact: true })).toBeEnabled(); await page.getByLabel('담당자', { exact: true }).selectOption(session.userId);
    await save(`/tasks/${secondTask}`, page.getByRole('dialog').getByRole('button', { name: '배정 저장', exact: true }));
    await expect(page.locator(`[data-task-id="${secondTask}"]`)).toBeVisible();
    await page.getByRole('button', { name: '업무 만들기', exact: true }).click();
    await page.getByLabel('제목', { exact: true }).fill('Initially assigned browser task');
    await expect(page.getByLabel('담당자', { exact: true })).toBeEnabled();
    await page.getByLabel('담당자', { exact: true }).selectOption(session.userId);
    const taskCreated = responseFor('/tasks', 'POST');
    await page.getByRole('dialog').getByRole('button', { name: '만들기', exact: true }).click();
    const creation = await taskCreated; assert.equal(creation.status(), 201);
    assert.equal(creation.request().postDataJSON().assignee_id, session.userId);
    const assignedTask = (await creation.json()).id;
    await expect(page.locator(`[data-task-id="${assignedTask}"]`)).toBeVisible();
    for (const width of [375,768,1280]) {
      await page.setViewportSize({ width, height: 900 });
      // 화면 갱신으로 취소될 수 있는 CSS 애니메이션은 스크린샷의 최종 상태로 진행시킨다. 시간 지연은 사용하지 않는다.
      await page.screenshot({ path: `${evidence}/${session.pg ? 'pg' : 'legacy'}-project-members-${width}.png`, fullPage: true, animations: 'disabled' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'project member/task actions fit viewport');
    }
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
    if (session.pg) assert.equal((await request(`/tasks/${task}`, { version: 3, assignee_id: fixture.foreignId ?? '103' }, 'PATCH')).status, 403);
    await page.getByLabel('제목', { exact: true }).fill('Task draft retained');
    assert.equal((await request(`/tasks/${task}`, { version: 3, title: 'Concurrent task' }, 'PATCH')).status, 200);
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
    await page.goto(`${origin}/assets`);
    await page.getByRole('searchbox', { name: '이 화면에서 검색' }).fill('Browser asset');
    const row = page.getByRole('row').filter({ hasText: 'Browser asset' });
    if (session.pg) {
      await expect(row.getByRole('button', { name: '수정', exact: true })).toHaveCount(0);
      await expect(row.getByRole('button', { name: '삭제', exact: true })).toHaveCount(0);
    }
    await row.getByRole('button', { name: '담당·상태', exact: true }).click();
    await expect(page.getByLabel('담당자', { exact: true })).toBeEnabled(); await page.getByLabel('담당자', { exact: true }).selectOption(session.userId);
    const status = session.pg ? 'stored' : 'loaned'; await page.getByLabel('상태', { exact: true }).selectOption(status);
    await save(`/assets/${asset}/custody`, page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }));
    await page.reload();
    await page.getByRole('searchbox', { name: '이 화면에서 검색' }).fill('Browser asset');
    await row.getByRole('button', { name: '담당·상태', exact: true }).click();
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
      const duplicate = await request(`/tasks/${task}`, { version: 4, assignee_id: session.userId }, 'PATCH'); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.version, 4);
      await fixture.pool.query("CREATE FUNCTION notice.reject_daily_assignment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected native notification failure'; END $$; CREATE TRIGGER reject_daily_assignment BEFORE INSERT ON notice.notifications FOR EACH ROW EXECUTE FUNCTION notice.reject_daily_assignment();");
      try {
        await page.goto(`${origin}/projects/${project}`); await page.locator(`[data-task-id="${task}"]`).getByRole('button', { name: '담당자 배정', exact: true }).click();
        await expect(page.getByLabel('담당자', { exact: true })).toBeEnabled(); await page.getByLabel('담당자', { exact: true }).selectOption(fixture.identity.users[0].id);
        const failedAssignment = responseFor(`/tasks/${task}`); await page.getByRole('dialog').getByRole('button', { name: '배정 저장', exact: true }).click(); assert.equal((await failedAssignment).status(), 500);
        await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByLabel('담당자', { exact: true })).toHaveValue(fixture.identity.users[0].id);
        await page.screenshot({ path: `${evidence}/pg-assignment-notification-failure.png`, fullPage: true });
      } finally { await fixture.pool.query('DROP TRIGGER reject_daily_assignment ON notice.notifications'); }
      const retainedTask = (await fixture.pool.query('SELECT version,assignee_id FROM project.tasks WHERE id=$1', [task])).rows[0]; assert.equal(retainedTask.version, 4); assert.equal(retainedTask.assignee_id, session.userId);
      assert.equal((await request(`/tasks/${task}`, { version: 4, assignee_id: fixture.identity.users[0].id }, 'PATCH')).status, 200);
      const newRecipientNotifications = await request('/notifications', undefined, 'GET'); assert.equal(newRecipientNotifications.status, 200); assert.equal(newRecipientNotifications.body.items.filter(item => item.link === `/tasks/${task}`).length, 1);
      console.log('NATIVE_HTTP audit retention, real concurrent [200,409], history/notification rollback, assignment no-op, new-recipient delivery, foreign-resource404 PASS');
    }
    if (session.pg && fixture.pool) {
      await fixture.pool.query("INSERT INTO notice.notifications(company_id,user_id,kind,title,link) VALUES ($1,$2,'task.assigned','Foreign company notification','/tasks/foreign'),($3,$4,'task.assigned','Other recipient notification','/tasks/private')", [fixture.otherCompanyId, session.userId, fixture.companyId, fixture.identity.users[0].id]);
    }
    const targetEmail = session.pg ? fixture.identity.users[1].email : db().prepare('SELECT email FROM app_user WHERE id=?').get(session.userId).email;
    const targetLogin = await api(server.baseUrl, `${prefix}/auth/login`, { method: 'POST', body: { email: targetEmail, password: 'password-1234' } }); assert.equal(targetLogin.status, 200);
    const targetToken = session.pg ? targetLogin.body.token : targetLogin.body.access_token;
    const targetContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await targetContext.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await targetContext.addInitScript(stored => localStorage.setItem('orbitflow.session.v1', JSON.stringify(stored)), { token: targetToken, orgId: session.orgId, name: 'Recipient', email: targetEmail, mustChangePassword: false, organizations: [{ org_id: session.orgId, org_name: 'QA', org_type: session.pg ? 'perp_db' : 'custom', roles: ['member'] }] });
    const targetPage = await targetContext.newPage();
    targetPage.on('pageerror', error => pageErrors.push(error.message));
    const notificationResponse = targetPage.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${prefix}/notifications`);
    await targetPage.goto(origin + '/notifications'); const notifications = await notificationResponse; assert.equal(notifications.status(), 200);
    const delivered = (await notifications.json()).items;
    const expectedLinks = [task, secondTask, assignedTask].map(id => `/tasks/${id}`).sort();
    assert.deepEqual(delivered.map(item => item.link).sort(), expectedLinks);
    await expect(targetPage.getByRole('row').filter({ hasText: 'Second browser task' })).toHaveCount(1);
    await expect(targetPage.getByRole('row').filter({ hasText: 'Initially assigned browser task' })).toHaveCount(1);
    const reloadedNotifications = targetPage.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${prefix}/notifications`);
    await targetPage.reload();
    const reloadedResponse = await reloadedNotifications; assert.equal(reloadedResponse.status(), 200);
    assert.deepEqual((await reloadedResponse.json()).items.map(item => item.link).sort(), expectedLinks);
    await expect(targetPage.getByRole('row').filter({ hasText: 'Second browser task' })).toHaveCount(1);
    const links = targetPage.locator('tbody a[href^="/tasks/"]');
    await expect(links).toHaveCount(3);
    assert.deepEqual((await links.evaluateAll(nodes => nodes.map(node => node.getAttribute('href')))).sort(), expectedLinks);
    await expect(targetPage.getByText('Foreign company notification', { exact: true })).toHaveCount(0);
    await expect(targetPage.getByText('Other recipient notification', { exact: true })).toHaveCount(0);
    await targetPage.screenshot({ path: `${evidence}/${session.pg ? 'pg' : 'legacy'}-recipient-notifications.png`, fullPage: true });
    const taskLink = targetPage.getByRole('row').filter({ hasText: 'Second browser task' }).getByRole('link', { name: '업무 보기' });
    await expect(taskLink).toHaveAttribute('href', `/tasks/${secondTask}`);
    await expect(taskLink).toBeInViewport();
    const detailResponse = () => targetPage.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && (session.pg ? url.pathname === '/api/v1/pg/tasks' && url.searchParams.get('task_id') === secondTask : url.pathname === `/api/v1/tasks/${secondTask}`);
    }, { timeout: 10000 });
    const [opened] = await Promise.all([detailResponse(), taskLink.click()]);
    assert.equal(opened.status(), 200);
    const openedDetail = await opened.json();
    assert.equal(String(session.pg ? openedDetail.items[0].__id : openedDetail.id), secondTask);
    await expect(targetPage).toHaveURL(origin + `/tasks/${secondTask}`);
    await expect(targetPage.locator('.project-tasks__detail h2')).toHaveText('Second browser task');
    await expect(targetPage.getByLabel('제목', { exact: true })).toHaveValue('Second browser task');
    if (session.pg) await expect(targetPage.getByRole('button', { name: '변경 저장', exact: true })).toBeDisabled();
    const [detailReload] = await Promise.all([detailResponse(), targetPage.reload()]);
    assert.equal(detailReload.status(), 200);
    await expect(targetPage.locator('.project-tasks__detail h2')).toHaveText('Second browser task');
    await writeFile(`${evidence}/${session.pg ? 'pg' : 'legacy'}-recipient-link.json`, JSON.stringify({ expectedLinks, openedUrl: targetPage.url(), detailStatus: opened.status(), detail: openedDetail, reloadStatus: detailReload.status() }, null, 2));
    await targetPage.screenshot({ path: `${evidence}/${session.pg ? 'pg' : 'legacy'}-recipient-task-detail.png`, fullPage: true });
    await targetContext.unrouteAll({ behavior: 'wait' }); await targetContext.close();
    console.log(session.pg ? 'PG' : 'LEGACY', 'recipient internal task link + actual task detail GET200 + reload + isolation PASS');
    console.log(session.pg ? 'PG' : 'LEGACY', 'actual recipient login + two task-row assignments + assigned task creation + exact recipient-only durable notification list PASS');
    console.log(session.pg ? process.env.DAILY_TEST_PG_BIN ? 'PG_NATIVE_REAL_AUTH' : 'PG_SQL_ENGINE' : 'LEGACY_SQLITE', 'project/date, reassignment, reschedule/cancel, custody/reload, stale draft PASS');
    await context.close();
  }
  assert.deepEqual(pageErrors, []); console.log('DAILY_COMPLETE_NO_PAGE_ERRORS');
} finally { await browser?.close();
  if (vite) { if (process.env.DAILY_BUILT === '1') await new Promise((resolve, reject) => vite.httpServer.close(error => error ? reject(error) : resolve())); else await vite.close(); }
  await server?.close();
  if (process.env.DAILY_TEST_PG_BIN) { const { closePgPool } = await import('../../backend/src/config/pg.js'); await closePgPool(); }
  await fixture?.close(); console.log('DAILY_CORRECTIONS_OWNED_SERVICES_AND_DATA_CLEANED'); }
