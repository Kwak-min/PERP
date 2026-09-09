import assert from 'node:assert/strict';
import path from 'node:path';
import { projectMemberRecovery } from './deadline-project-members-recovery.scenario.mjs';

// 정확한 DOM 상태 변경에 구독한다. 제한 시간은 실패 경계이며 지연/폴링이 아니다.
export async function observe(page, selector) {
  await page.evaluate(selector => new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`DOM state missing: ${selector}`)); }, 10000);
    function check() { if (document.querySelector(selector)) { clearTimeout(timeout); observer.disconnect(); resolve(); } }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true }); check();
  }), selector);
}
export async function projectMembers({ surface, api, fixture, rendered, result, attempt }) {
  const { actorAdmin: admin, actorManager: writer, actorMember: recipient, project, task } = fixture;
  const role = await api.request(admin, '/settings/roles', 'POST', { name: '프로젝트 제한 작성자', scope: 'all', permissions: ['menu.projects', 'project.read', 'project.write', 'task.read', 'task.write'] }, 201);
  const writerMembership = (await api.request(admin, '/settings/members')).items.find(row => row.membership_id === writer.membershipId);
  await api.request(admin, `/settings/members/${writer.membershipId}/roles`, 'PUT', { roles: [role.key], expected_roles_version: writerMembership.roles_version });
  await api.request(writer, '/members', 'GET', undefined, 403);
  const candidate = fixture.actors[24];
  const department = await api.request(admin, '/members/departments', 'POST', { name: '제품 개발' }, 201);
  await api.request(admin, `/members/${candidate.membershipId}/assignment`, 'PATCH', { department_id: department.id });
  const projectPath = `/projects/${project.id}`, taskPath = `/tasks/${task.id}`;
  const candidatesPath = `/api/v1${projectPath}/candidates`, assigneesPath = `/api/v1${taskPath}/assignees`;
  const rosterSelector = `[data-project-id="${project.id}"] [data-project-roster]`;
  async function shot(page, name) {
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('[role="dialog"]')?.scrollTo(0, 0); });
      const screenshot = path.join(attempt, `${name}-${width}.png`);
      await page.screenshot({ path: screenshot, animations: 'disabled' });
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
      result.surfaces.push({ name, width, screenshot: path.relative(path.dirname(path.dirname(attempt)), screenshot), geometry });
      assert.ok(geometry.documentWidth <= width, `${name}: horizontal overflow at ${width}`);
      const scrollable = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) { dialog.scrollTo(0, dialog.scrollHeight); return dialog.scrollHeight > dialog.clientHeight; }
        window.scrollTo(0, document.documentElement.scrollHeight); return document.documentElement.scrollHeight > innerHeight;
      });
      if (scrollable) {
        const bottom = path.join(attempt, `${name}-bottom-${width}.png`);
        await page.screenshot({ path: bottom, animations: 'disabled' });
        result.surfaces.push({ name: `${name}-bottom`, width, screenshot: path.relative(path.dirname(path.dirname(attempt)), bottom), geometry });
      }
      await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('[role="dialog"]')?.scrollTo(0, 0); });
    }
  }
  async function open(page, mode) {
    const endpoint = mode === 'member' ? candidatesPath : assigneesPath;
    const response = page.waitForResponse(response => new URL(response.url()).pathname === endpoint);
    await page.getByRole('button', { name: mode === 'member' ? '구성원 추가' : '담당자 배정', exact: true }).click();
    return response;
  }
  async function save(page, method, status) {
    const response = page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === `/api/v1${method === 'POST' ? projectPath + '/members' : taskPath}`);
    await page.locator('[role="dialog"] button[type="submit"]').click();
    const actual = await response; assert.equal(actual.status(), status); return actual.json();
  }
  await surface('project-writer-add', writer, projectPath, '[data-screen-id="PRJ-002"]', '/api/v1/projects', async page => {
    await rendered(page, '[data-task-id]');
    await shot(page, 'before-add');
    // Given: directory-denied writer. When: open candidates. Then: scoped API succeeds.
    const scoped = page.waitForResponse(response => new URL(response.url()).pathname === candidatesPath, { timeout: 10000 });
    await page.getByRole('button', { name: '구성원 추가', exact: true }).click();
    await shot(page, 'candidate-open');
    assert.equal((await scoped).status(), 200);
    await observe(page, '[role="dialog"] select[aria-label="추가할 구성원"]:not(:disabled)');
    await page.getByRole('searchbox', { name: '구성원 검색' }).fill('NO_MATCH_CANDIDATE');
    assert.equal(await page.locator('[role="dialog"] select[aria-label="추가할 구성원"] option:not([value=""])').count(), 0);
    await shot(page, 'candidate-search-empty');
    await page.getByRole('searchbox', { name: '구성원 검색' }).fill(candidate.name);
    await page.getByRole('combobox', { name: '부서' }).selectOption('제품 개발');
    assert.deepEqual(await page.locator('[role="dialog"] select[aria-label="추가할 구성원"] option:not([value=""])').evaluateAll(options => options.map(option => option.value)), [candidate.userId]);
    await page.getByRole('combobox', { name: '추가할 구성원' }).selectOption(candidate.userId);
    assert.equal(await page.locator('[data-recipient-access-warning]').count(), 0);
    await shot(page, 'candidate-filtered');
    assert.equal((await save(page, 'POST', 201)).created, true);
    await observe(page, `${rosterSelector} [data-member-id="${candidate.userId}"]`);
    await shot(page, 'roster-added');
    assert.equal((await api.request(admin, `${projectPath}/members`)).items.filter(item => item.value === candidate.userId).length, 1);
    await open(page, 'member');
    await observe(page, '[role="dialog"] select:not(:disabled)');
    await page.getByRole('combobox', { name: '추가할 구성원' }).selectOption(candidate.userId);
    assert.equal((await save(page, 'POST', 200)).created, false);
    await observe(page, '[data-member-result="existing"]');
    await shot(page, 'duplicate-existing');
    return { directoryDenied: true, addedUser: candidate.userId, duplicateCreated: false };
  });
  const beforeNotifications = await api.request(writer, '/notifications', 'GET', undefined, 403);
  assert.equal(beforeNotifications.error.code, 'PERMISSION_DENIED');
  const recipientRolesBefore = (await api.request(admin, '/members')).items.find(item => item.user_id === candidate.userId).roles;
  await surface('assignment-stale', writer, projectPath, '[data-task-id]', '/api/v1/tasks', async page => {
    await open(page, 'assignment');
    await observe(page, '[role="dialog"] select[aria-label="담당자"]:not(:disabled)');
    await page.getByRole('combobox', { name: '담당자', exact: true }).selectOption(candidate.userId);
    assert.equal(await page.locator('[data-recipient-access-warning]').count(), 0);
    const latest = await api.request(admin, taskPath);
    await api.request(admin, taskPath, 'PATCH', { version: latest.version, title: '다른 작성자가 변경한 업무' });
    await save(page, 'PATCH', 409);
    await observe(page, '[data-assignment-conflict]');
    assert.equal(await page.getByRole('combobox', { name: '담당자', exact: true }).inputValue(), candidate.userId);
    assert.equal(await page.locator('[role="dialog"] button[type="submit"]').isDisabled(), true);
    await shot(page, 'stale-draft');
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${taskPath}` && response.request().method() === 'GET');
    await page.getByRole('button', { name: '최신 업무 불러오기', exact: true }).click();
    const freshTask = await (await refreshed).json();
    await observe(page, '[data-latest-task-version]');
    assert.equal(await page.locator('[data-latest-task-version]').getAttribute('data-latest-task-version'), String(freshTask.version));
    assert.equal(await page.getByRole('combobox', { name: '담당자', exact: true }).inputValue(), candidate.userId);
    await shot(page, 'latest-reconfirmation');
    await save(page, 'PATCH', 200);
    await observe(page, '.project-tasks__task-name small');
    const notifications = await api.request(candidate, '/notifications');
    assert.equal(notifications.items.filter(item => item.link === taskPath).length, 1);
    const assigned = await api.request(admin, taskPath);
    assert.equal(assigned.assignee_id, candidate.userId);
    assert.deepEqual((await api.request(admin, '/members')).items.find(item => item.user_id === candidate.userId).roles, recipientRolesBefore);
    await open(page, 'assignment');
    await observe(page, '[role="dialog"] button[type="submit"]:not(:disabled)');
    await save(page, 'PATCH', 200);
    assert.equal((await api.request(candidate, '/notifications')).items.filter(item => item.link === taskPath).length, 1);
    assert.equal((await api.request(admin, taskPath)).version, assigned.version);
    return { draft: candidate.userId, refreshedVersion: freshTask.version, sameAssigneeNotifications: 1 };
  });
  // 실제 수신자 세션과 알림 링크에서 업무 상세까지 이동한다.
  const me = await api.request(candidate, '/auth/me');
  candidate.session = { ...recipient.session, token: candidate.token, name: candidate.name, email: candidate.email, organizations: me.organizations };
  await surface('recipient-destination', candidate, '/notifications', 'main tbody tr', '/api/v1/notifications', async page => {
    const link = page.locator(`main a[href="${taskPath}"]`);
    assert.equal(await link.count(), 1);
    const detailResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${taskPath}`);
    await link.click(); assert.equal((await detailResponse).status(), 200);
    await rendered(page, '.project-tasks__detail');
    assert.equal(await page.locator('.project-tasks__detail input[maxlength="300"]').inputValue(), '다른 작성자가 변경한 업무');
    await shot(page, 'notification-task-destination');
    return { link: taskPath, recipientId: candidate.userId };
  });
  await surface('reader-denied', fixture.actorMember, projectPath, '[data-task-id]', '/api/v1/projects', async page => {
    // 기본 member는 task.write를 가질 수 있어 서버에서 명시적으로 조회 전용 역할을 배정한다.
    const readRole = await api.request(admin, '/settings/roles', 'POST', { name: '프로젝트 조회 전용', scope: 'all', permissions: ['menu.projects', 'project.read', 'task.read'] }, 201);
    const recipientMembership = (await api.request(admin, '/settings/members')).items.find(row => row.membership_id === recipient.membershipId);
    await api.request(admin, `/settings/members/${recipient.membershipId}/roles`, 'PUT', { roles: [readRole.key], expected_roles_version: recipientMembership.roles_version });
    await page.reload({ waitUntil: 'domcontentloaded' }); await rendered(page, '[data-task-id]');
    assert.equal(await page.getByRole('button', { name: '구성원 추가', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '담당자 배정', exact: true }).isDisabled(), true);
    await api.request(recipient, `${projectPath}/candidates`, 'GET', undefined, 403);
    return { writeDenied: true };
  });
  await projectMemberRecovery({ surface, api, fixture, rendered, shot, open, save, candidate, role });
}
