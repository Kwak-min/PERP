import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { startTestServer, createOwnerOrg } from '../../backend/tests/http.js';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';
import { assertIsolated } from '../../backend/tests/deadline-fixture.js';
import { observe } from './deadline-project-members.scenario.mjs';
import { projectActionsScenario } from './project-actions.scenario.mjs';

assertIsolated();
const evidence = path.resolve('.omo/evidence/project-task-create-assignee', process.env.DEADLINE_RUN_ID);
await mkdir(evidence, { recursive: true });
const results = [], http = [], cleanup = {}, lostResponseResults = [];
let native, server, vite, browser, closePgPool, cluster;
async function request(actor, route, method = 'GET', body, expected = 200) {
  const response = await fetch(server.baseUrl + route, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const payload = await response.json();
  http.push({ route, method, status: response.status });
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(payload)}`);
  return payload;
}
try {
  native = await startDailyNativePostgres();
  cluster = path.dirname((await native.pool.query('SHOW data_directory')).rows[0].data_directory);
  server = await startTestServer();
  const { db } = await import('../../backend/src/config/db.js');
  const { insert } = await import('../../backend/src/models/base.js');
  ({ closePgPool } = await import('../../backend/src/config/pg.js'));
  const legacy = await createOwnerOrg(server.baseUrl, ['projects', 'tasks']);
  const signup = await request(null, '/pg/auth/signup', 'POST', { email: 'create-pg@example.invalid', name: 'Create owner', password: 'password-1234' }, 201);
  const pgOwner = { token: signup.token, userId: signup.user.id, orgId: '' };
  pgOwner.orgId = (await request(pgOwner, '/pg/companies', 'POST', { name: 'CREATE_PG', modules: ['projects', 'tasks'], features: [], departments: [] }, 201)).org_id;
  vite = await preview({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), preview: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(server.baseUrl).origin } } });
  const origin = `http://project-actions.test:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome' });
  console.log('CHROME_VERSION ' + browser.version());
  for (const [prefix, admin] of [['', legacy], ['/pg', pgOwner]]) {
    const label = prefix ? 'native-pg' : 'sqlite';
    const role = await request(admin, '/settings/roles', 'POST', { name: 'Create scoped writer', scope: 'all', permissions: ['menu.projects', 'project.read', 'project.write', 'task.read', 'task.write'] }, 201);
    const taskOnlyRole = await request(admin, '/settings/roles', 'POST', { name: 'Create task-only writer', scope: 'all', permissions: ['menu.projects', 'project.read', 'task.read', 'task.write'] }, 201);
    const readerRole = await request(admin, '/settings/roles', 'POST', { name: 'Create recipient', scope: 'all', permissions: ['menu.projects', 'task.read', 'project.read', 'menu.notifications', 'notification.read'] }, 201);
    const writerEmail = `${label}-writer@example.invalid`;
    let writer;
    if (prefix) {
      const member = await request(admin, '/pg/members', 'POST', { email: writerEmail, name: 'Scoped writer', password: 'password-1234' }, 201);
      writer = { userId: member.id, membershipId: member.id, orgId: admin.orgId };
    } else {
      const invite = await request(admin, '/members/invites', 'POST', { email: writerEmail, roles: [role.key] }, 201);
      const member = await request(null, '/auth/signup', 'POST', { email: writerEmail, name: 'Scoped writer', password: 'password-1234', invitation_token: invite.token }, 201);
      writer = { userId: member.user.id, membershipId: (await request(admin, '/members')).items.find(row => row.user_id === member.user.id).membership_id, orgId: admin.orgId };
    }
    async function assignRole(actor, key) {
      const current = (await request(admin, '/settings/members')).items.find(row => row.membership_id === actor.membershipId);
      await request(admin, `/settings/members/${actor.membershipId}/roles`, 'PUT', { roles: [key], expected_roles_version: current.roles_version });
    }
    await assignRole(writer, role.key);
    const login = await request(null, `${prefix}/auth/login`, 'POST', { email: writerEmail, password: 'password-1234' });
    writer.token = login.token ?? login.access_token;
    await request(writer, `${prefix}/members`, 'GET', undefined, 403);
    // 첫 페이지(50) 밖 마지막 구성원을 포함한 실제 저장소 fixture. 디렉터리 응답을 mock하지 않는다.
    const members = [];
    for (let index = 0; index < 62; index++) {
      const name = `ZZ company member ${String(index).padStart(3, '0')}`, email = `${label}-bulk-${index}@example.invalid`;
      if (prefix) {
        const user = (await native.pool.query(`INSERT INTO auth.users(company_id,email,name,password_hash,approval_status)
          SELECT $1,$2,$3,password_hash,'approved' FROM auth.users WHERE id=$4 RETURNING id`, [admin.orgId.slice(3), email, name, admin.userId])).rows[0];
        await native.pool.query('INSERT INTO org.company_memberships(company_id,user_id) VALUES ($1,$2)', [admin.orgId.slice(3), user.id]);
        members.push({ userId: String(user.id), membershipId: String(user.id), name, email, orgId: admin.orgId });
      } else {
        const ownerMembership = db().prepare('SELECT * FROM membership WHERE user_id=? AND org_id=?').get(admin.userId, admin.orgId);
        const hash = db().prepare('SELECT password_hash FROM app_user WHERE id=?').get(admin.userId).password_hash;
        const user = insert('app_user', { name, email, password_hash: hash });
        const membership = insert('membership', { tenant_id: ownerMembership.tenant_id, org_id: admin.orgId, user_id: user.id, roles: readerRole.key });
        members.push({ userId: user.id, membershipId: membership.id, name, email, orgId: admin.orgId });
      }
    }
    const target = members.at(-1), denied = members.at(-2);
    await assignRole(target, readerRole.key);
    const targetLogin = await request(null, `${prefix}/auth/login`, 'POST', { email: target.email, password: 'password-1234' });
    target.token = targetLogin.token ?? targetLogin.access_token;
    const projectName = `Company assignment ${label}`;
    const project = { ...await request(admin, `${prefix}/projects`, 'POST', { name: projectName }, 201), name: projectName };
    const projectPath = `${prefix}/projects/${project.id}`;
    const candidates = await request(writer, `${projectPath}/task-assignees`);
    assert.ok(candidates.items.findIndex(item => item.id === target.userId) > 50);
    assert.equal(candidates.items.at(-1).id, target.userId);
    assert.deepEqual(Object.keys(candidates.items.at(-1)).sort(), ['already_member', 'department_name', 'id', 'name']);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // 브라우저는 실제 비보안 HTTP origin으로 실행한다. DNS/외부 접속 없이 로컬 fixture로만 중계한다.
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'project-actions.test') return route.abort();
      url.hostname = '127.0.0.1';
      return route.fulfill({ response: await route.fetch({ url: url.href }) });
    });
    await context.addInitScript(session => localStorage.setItem('orbitflow.session.v1', JSON.stringify(session)), { token: writer.token, orgId: writer.orgId, name: 'Scoped writer', email: writerEmail, mustChangePassword: false, organizations: [{ org_id: writer.orgId, org_name: label, org_type: prefix ? 'perp_db' : 'custom', roles: [role.key] }] });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const responseFor = (route, method = 'GET') => page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${route}` && response.request().method() === method, { timeout: 10000 });
    async function openCreate() {
      const [response] = await Promise.all([responseFor(`${projectPath}/task-assignees`),
        observe(page, '[role="dialog"] select[aria-label="담당자"]:not(:disabled)'),
        page.getByRole('button', { name: '업무 만들기', exact: true }).click()]);
      assert.equal(response.status(), 200);
    }
    async function shot(name, width) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}/${name}: horizontal overflow`);
      await page.screenshot({ path: path.join(evidence, `${label}-${name}-${width}.png`), fullPage: true, animations: 'disabled' });
      const submit = page.locator('[role="dialog"] button[type="submit"]');
      if (await submit.count()) {
        await submit.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
        assert.equal(await submit.evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)); }), true, 'dialog save control remains reachable');
        await page.screenshot({ path: path.join(evidence, `${label}-${name}-bottom-${width}.png`), fullPage: true, animations: 'disabled' });
        await page.locator('[role="dialog"]').evaluate(element => element.scrollTo(0, 0));
      }
    }
    try {
      await Promise.all([responseFor(`${prefix}/projects`), page.goto(`${origin}/projects/${project.id}`)]);
      assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues })), { secure: false, uuid: 'undefined', random: 'function' });
      await observe(page, '.project-tasks__project-meta button:not(:disabled)');
      await observe(page, '.nav-group a[href="/tasks"]');
      assert.equal(await page.locator('.nav-group a[href="/projects"]').count(), 1);
      assert.equal(await page.locator('.nav-group a[href="/tasks"]').count(), 1);
      await Promise.all([responseFor(`${prefix}/tasks`), page.locator('.nav-group a[href="/tasks"]').click()]);
      await observe(page, '[data-screen-id="TSK-001"].project-tasks');
      await shot('separate-task-navigation', 1280);
      await Promise.all([responseFor(`${prefix}/projects`), page.locator('.nav-group a[href="/projects"]').click()]);
      await observe(page, '[data-screen-id="PRJ-001"].project-tasks');
      await shot('separate-project-navigation', 1280);
      await Promise.all([responseFor(`${prefix}/projects`), page.goto(`${origin}/projects/${project.id}`)]);
      await observe(page, '.project-tasks__project-meta button:not(:disabled)');
      await openCreate();
      const search = page.getByRole('searchbox', { name: '구성원 검색', exact: true });
      await search.fill('NO_MATCH_MEMBER');
      assert.equal(await page.locator('select[aria-label="담당자"] option:not([value=""])').count(), 0);
      await search.fill(target.name);
      assert.deepEqual(await page.locator('select[aria-label="담당자"] option:not([value=""])').evaluateAll(items => items.map(item => item.value)), [target.userId]);
      await Promise.all([observe(page, '[data-project-member-add-note]'), page.getByRole('combobox', { name: '담당자', exact: true }).selectOption(target.userId)]);
      await search.fill(denied.name);
      assert.equal(await page.getByRole('combobox', { name: '담당자', exact: true }).inputValue(), target.userId);
      await page.getByLabel('제목', { exact: true }).fill('Company member assigned at creation');
      for (const width of [375, 1280]) await shot('selected', width);
      await page.setViewportSize({ width: 375, height: 900 });
      const creationRequests = [], creationResponses = [];
      const captureCreation = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1${prefix}/tasks`) creationRequests.push(request.postDataJSON()); };
      const captureResponse = response => { if (response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1${prefix}/tasks`) creationResponses.push(response); };
      page.on('request', captureCreation);
      page.on('response', captureResponse);
      const [memberResponse] = await Promise.all([responseFor(`${projectPath}/members`, 'POST'),
        observe(page, '.project-tasks:not(:has([role="dialog"])), [role="dialog"] > p[role="alert"]'), page.locator('[role="dialog"] button[type="submit"]').click()]);
      page.off('request', captureCreation);
      page.off('response', captureResponse);
      const persisted = await request(admin, `${prefix}/tasks?limit=-1`);
      console.log('CREATE_SEAM ' + JSON.stringify({ engine: label, membershipStatus: memberResponse.status(), taskRequests: creationRequests,
        tasks: persisted.items, error: await page.locator('[role="dialog"] > p[role="alert"]').allTextContents() }));
      assert.equal(creationRequests.length, 1, 'membership success must be followed by the keyed task request without secure-context-only APIs');
      assert.equal(await page.locator('[role="dialog"]').count(), 0);
      const taskResponse = creationResponses[0];
      assert.equal(memberResponse.status(), 201); assert.equal(taskResponse.status(), 201);
      assert.deepEqual(memberResponse.request().postDataJSON(), { user_id: target.userId });
      assert.equal(taskResponse.request().postDataJSON().assignee_id, target.userId);
      const task = await taskResponse.json();
      const detailPath = prefix ? `/pg/records/tasks/${task.id}` : `/tasks/${task.id}`;
      assert.equal(String((await request(admin, detailPath)).assignee_id), target.userId);
      assert.equal((await request(target, `${prefix}/notifications`)).items.filter(item => item.link === `/tasks/${task.id}`).length, 1);
      await Promise.all([responseFor(`${prefix}/tasks`), page.reload({ waitUntil: 'domcontentloaded' })]);
      await observe(page, `[data-task-id="${task.id}"]`);
      for (const width of [375, 1280]) await shot('saved-reloaded', width);
      // 동일 담당자/버전 CAS/다른 담당자로 변경/재배정 알림 계약을 실제 API로 확인한다.
      await request(writer, `${prefix}/tasks/${task.id}`, 'PATCH', { version: 1, assignee_id: target.userId });
      assert.equal((await request(admin, detailPath)).version, 1);
      await request(writer, `${prefix}/tasks/${task.id}`, 'PATCH', { version: 1, assignee_id: admin.userId });
      await request(writer, `${prefix}/tasks/${task.id}`, 'PATCH', { version: 1, assignee_id: target.userId }, 409);
      await request(writer, `${prefix}/tasks/${task.id}`, 'PATCH', { version: 2, assignee_id: target.userId });
      assert.equal((await request(target, `${prefix}/notifications`)).items.filter(item => item.link === `/tasks/${task.id}`).length, 2);
      assert.equal((await request(admin, `${projectPath}/members`)).items.filter(item => item.value === target.userId).length, 1);
      // 실제 서버 commit 뒤 전송 실패/잘린 JSON을 재현한다. 재전송은 같은 작업/알림이어야 한다.
      let originalRequest;
      for (const loss of ['aborted', 'truncated-json', 'missing-version']) {
        await openCreate();
        await page.getByRole('combobox', { name: '담당자', exact: true }).selectOption(target.userId);
        await page.getByLabel('제목', { exact: true }).fill(`Lost response operation ${loss}`);
        let committed;
        const taskPattern = '**/api/v1' + prefix + '/tasks';
        const loseResponse = async route => {
          if (route.request().method() !== 'POST') return route.continue();
          originalRequest = { key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() };
          const response = await route.fetch({ url: route.request().url().replace('project-actions.test', '127.0.0.1') }); assert.equal(response.status(), 201);
          committed = await response.json();
          if (loss === 'aborted') await route.abort('failed');
          else await route.fulfill({ status: 201, contentType: 'application/json', body: loss === 'missing-version' ? JSON.stringify({ id: committed.id }) : '{"id":' });
        };
        await page.route(taskPattern, loseResponse);
        try {
          await Promise.all([loss === 'aborted'
            ? page.waitForEvent('requestfailed', { predicate: request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1' + prefix + '/tasks' })
            : responseFor(prefix + '/tasks', 'POST'),
            observe(page, '.project-tasks:not(:has([role="dialog"])), [role="dialog"] > p[role="alert"]'), page.locator('[role="dialog"] button[type="submit"]').click()]);
        } finally { await page.unroute(taskPattern, loseResponse); }
        assert.ok(committed?.id);
        assert.equal(await page.locator('[data-task-create-pending]').count(), 1, `${label}/${loss}: unconfirmed response must preserve the keyed operation`);
        assert.equal(await page.getByLabel('제목', { exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole('combobox', { name: '담당자', exact: true }).isDisabled(), true);
        assert.equal(await page.locator('[role="dialog"] input[type="date"]').isDisabled(), true);
        for (const width of [375, 1280]) await shot(`uncertain-operation-${loss}`, width);
        // 닫기/새로고침으로 새 키를 발급해서는 안 된다.
        await Promise.all([responseFor(`${prefix}/projects`), page.reload({ waitUntil: 'domcontentloaded' })]);
        await Promise.all([observe(page, '[data-task-create-pending]'), page.getByRole('button', { name: '업무 만들기', exact: true }).click()]);
        assert.equal(await page.getByLabel('제목', { exact: true }).inputValue(), originalRequest.body.title);
        assert.equal(await page.getByLabel('제목', { exact: true }).isDisabled(), true);
        const [retryResponse] = await Promise.all([responseFor(prefix + '/tasks', 'POST'), observe(page, '.project-tasks:not(:has([role="dialog"]))'), page.locator('[role="dialog"] button[type="submit"]').click()]);
        assert.equal(retryResponse.status(), 201);
        const replayed = await retryResponse.json();
        const notificationCount = (await request(target, prefix + '/notifications')).items.filter(item => [committed.id, replayed.id].some(id => item.link === '/tasks/' + id)).length;
        lostResponseResults.push({ engine: label, loss, committedId: committed.id, replayedId: replayed.id, notificationCount, originalRequest,
          replayRequest: { key: retryResponse.request().headers()['idempotency-key'], body: retryResponse.request().postDataJSON() } });
        console.log('LOST_RESPONSE_RESULT ' + JSON.stringify(lostResponseResults.at(-1)));
      }
      // 확정된 rollback도 원래 키로 재시도한다. 소속 추가만 남고 task/replay/알림은 롤백된다.
      await openCreate();
      await page.getByRole('combobox', { name: '담당자', exact: true }).selectOption(denied.userId);
      await page.getByLabel('제목', { exact: true }).fill('Known rollback operation');
      const taskCount = async () => prefix ? Number((await native.pool.query('SELECT count(*) AS n FROM project.tasks')).rows[0].n) : db().prepare('SELECT count(*) AS n FROM task').get().n;
      const beforeRollback = await taskCount();
      if (prefix) await native.pool.query("CREATE FUNCTION org.create_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'create rollback'; END $$; CREATE TRIGGER create_reject BEFORE INSERT ON notice.notifications FOR EACH ROW EXECUTE FUNCTION org.create_reject()");
      else db().exec("CREATE TRIGGER create_reject BEFORE INSERT ON notification BEGIN SELECT RAISE(ABORT, 'create rollback'); END");
      let rejectedRequest;
      try {
        const [rejected] = await Promise.all([responseFor(prefix + '/tasks', 'POST'), observe(page, '[role="dialog"] > p[role="alert"]'), page.locator('[role="dialog"] button[type="submit"]').click()]);
        assert.equal(rejected.status(), 500); rejectedRequest = rejected.request();
        assert.equal(await taskCount(), beforeRollback);
        assert.equal((await request(admin, projectPath + '/members')).items.filter(item => item.value === denied.userId).length, 1);
        assert.equal(await page.getByLabel('제목', { exact: true }).inputValue(), 'Known rollback operation');
      } finally {
        if (prefix) await native.pool.query('DROP TRIGGER create_reject ON notice.notifications; DROP FUNCTION org.create_reject()');
        else db().exec('DROP TRIGGER create_reject');
      }
      const [retryMember, retryTask] = await Promise.all([responseFor(projectPath + '/members', 'POST'), responseFor(prefix + '/tasks', 'POST'), observe(page, '.project-tasks:not(:has([role="dialog"]))'), page.locator('[role="dialog"] button[type="submit"]').click()]);
      assert.equal(retryMember.status(), 200); assert.equal(retryTask.status(), 201);
      assert.equal(retryTask.request().headers()['idempotency-key'], rejectedRequest.headers()['idempotency-key']);
      assert.notEqual(retryTask.request().headers()['idempotency-key'], originalRequest.key, 'new explicit task after a known outcome uses a new operation key');
      assert.deepEqual(retryTask.request().postDataJSON(), rejectedRequest.postDataJSON());
      assert.equal(await taskCount(), beforeRollback + 1);
      const excluded = members.at(-3);
      const actions = await projectActionsScenario({ page, prefix, project, admin, writer, target, excluded, candidates, request, responseFor, openCreate, shot, taskCount, assignRole, readerRole, writerRole: role });
      await assignRole(writer, taskOnlyRole.key);
      await Promise.all([responseFor(`${prefix}/projects`), page.goto(`${origin}/projects/${project.id}`)]);
      await openCreate();
      // 제외한 새 구성원으로 권한 경계를 확인한다. 기존 소속/기록을 삭제하지 않는다.
      await page.getByRole('searchbox', { name: '구성원 검색', exact: true }).fill(excluded.name);
      await Promise.all([observe(page, '[data-project-membership-boundary]'), page.getByRole('combobox', { name: '담당자', exact: true }).selectOption(excluded.userId)]);
      assert.equal(await page.locator('[role="dialog"] button[type="submit"]').isDisabled(), true);
      for (const width of [375, 1280]) await shot('permission-boundary', width);
      await Promise.all([observe(page, '[role="dialog"] button[type="submit"]:not(:disabled)'), page.getByRole('combobox', { name: '담당자', exact: true }).selectOption('')]);
      await page.getByLabel('제목', { exact: true }).fill('Unassigned without project write');
      const [unassignedSaved] = await Promise.all([responseFor(`${prefix}/tasks`, 'POST'), page.locator('[role="dialog"] button[type="submit"]').click()]);
      assert.equal(unassignedSaved.status(), 201);
      assert.deepEqual(errors, []);
      results.push({ engine: label, actions, count: candidates.items.length, targetIndex: candidates.items.findIndex(item => item.id === target.userId), taskId: task.id, userId: target.userId, membershipId: target.membershipId, widths: [375, 1280], directoryDenied: true, selectedSavedReloaded: true, boundaryAndUnassigned: true, reassignmentNotifications: 2 });
    } catch (error) { await page.screenshot({ path: path.join(evidence, `${label}-failure.png`), fullPage: true }); throw error; }
    finally { await context.close(); }
  }
  assert.equal(lostResponseResults.length, 6);
  assert.ok(lostResponseResults.every(result => result.committedId === result.replayedId && result.notificationCount === 1), 'committed response loss must replay the same task ID with one notification on both stores');
  for (const result of lostResponseResults) { assert.ok(result.originalRequest.key); assert.deepEqual(result.replayRequest, result.originalRequest); }
  console.log('PROJECT_TASK_CREATE_ASSIGNEE_PASS ' + JSON.stringify(results));
} finally {
  await browser?.close(); cleanup.browserClosed = true;
  if (vite) await new Promise((resolve, reject) => vite.httpServer.close(error => error ? reject(error) : resolve())); cleanup.viteClosed = true;
  await server?.close(); cleanup.apiClosed = true;
  await closePgPool?.(); cleanup.poolClosed = true;
  await native?.close(); cleanup.clusterRemoved = cluster ? !existsSync(cluster) : true;
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ surface: 'production-built dist via Vite preview', results, lostResponseResults, http, cleanup }, null, 2));
}
