import assert from 'node:assert/strict';
import { observe } from './deadline-project-members.scenario.mjs';

// 이미 실제 서버가 생성한 응답만 보류한다. 성공 payload를 합성하지 않는다.
async function holdResponse(page, pattern) {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const pending = new Set(), errors = [];
  const handler = route => {
    const operation = (async () => {
      const response = await route.fetch();
      entered.resolve(response);
      await release.promise;
      await route.fulfill({ response });
    })();
    const tracked = operation.catch(error => { errors.push(error); });
    pending.add(tracked); void tracked.then(() => pending.delete(tracked));
    return tracked;
  };
  await page.route(pattern, handler);
  return { entered: () => Promise.race([entered.promise, new Promise((_, reject) => {
    const signal = AbortSignal.timeout(10000); signal.addEventListener('abort', () => reject(new Error('Real response gate deadline')), { once: true });
  })]), release: () => release.resolve(), close: async () => { release.resolve(); await Promise.all(pending); await page.unroute(pattern, handler); if (errors.length) throw new AggregateError(errors, 'Response gate failed'); } };
}
export async function projectMemberRecovery({ surface, api, fixture, rendered, shot, open, save, candidate, role }) {
  const { actorAdmin: admin, actorManager: writer, project, task } = fixture;
  const projectPath = `/projects/${project.id}`, taskPath = `/tasks/${task.id}`;
  const pattern = `**/api/v1${projectPath}/candidates`;
  const roster = `[data-project-id="${project.id}"] [data-project-roster]`;
  await surface('candidate-loading-retry', writer, projectPath, '[data-task-id]', '/api/v1/tasks', async page => {
    const gate = await holdResponse(page, pattern);
    try {
      await page.getByRole('button', { name: '구성원 추가', exact: true }).click();
      assert.equal((await gate.entered()).status(), 200);
      await observe(page, '[role="dialog"] select[aria-label="추가할 구성원"]:disabled');
      assert.equal(await page.locator('[role="dialog"] button[type="submit"]').isDisabled(), true);
      await shot(page, 'candidate-loading');
      gate.release();
      await observe(page, '[role="dialog"] select[aria-label="추가할 구성원"]:not(:disabled)');
    } finally { await gate.close(); }
    await page.getByRole('combobox', { name: '추가할 구성원', exact: true }).selectOption(candidate.userId);
    // Given: selected draft. When: real network failure. Then: preserve selection, lock submit.
    const abort = route => route.abort('failed');
    await page.route(pattern, abort);
    try {
      await page.getByRole('button', { name: '목록 다시 불러오기', exact: true }).click();
      await observe(page, '[role="dialog"] .field-error');
      assert.equal(await page.locator('[role="dialog"] button[type="submit"]').isDisabled(), true);
      assert.equal(await page.getByRole('combobox', { name: '추가할 구성원', exact: true }).inputValue(), candidate.userId);
      await shot(page, 'candidate-network-error');
    } finally { await page.unroute(pattern, abort); }
    const response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${projectPath}/candidates`);
    await page.getByRole('button', { name: '목록 다시 불러오기', exact: true }).click(); assert.equal((await response).status(), 200);
    await observe(page, '[role="dialog"] button[type="submit"]:not(:disabled)');
    assert.equal((await save(page, 'POST', 200)).created, false);
    await observe(page, `${roster} [data-member-id="${candidate.userId}"]`);
    return { loadingLocked: true, transportFailureLocked: true, retrySucceeded: true };
  });
  await surface('candidate-permission-retry', writer, projectPath, '[data-task-id]', '/api/v1/tasks', async page => {
    const reader = await api.request(admin, '/settings/roles', 'POST', { name: '후보 권한 회수 검증', scope: 'all', permissions: ['menu.projects', 'project.read', 'task.read'] }, 201);
    const current = (await api.request(admin, '/settings/members')).items.find(row => row.membership_id === writer.membershipId);
    const revoked = await api.request(admin, `/settings/members/${writer.membershipId}/roles`, 'PUT', { roles: [reader.key], expected_roles_version: current.roles_version });
    try {
      assert.equal((await open(page, 'member')).status(), 403);
      await observe(page, '[role="dialog"] .field-error');
      assert.equal(await page.locator('[role="dialog"] button[type="submit"]').isDisabled(), true);
      await shot(page, 'candidate-permission-denied');
    } finally { await api.request(admin, `/settings/members/${writer.membershipId}/roles`, 'PUT', { roles: [role.key], expected_roles_version: revoked.roles_version }); }
    await page.getByRole('button', { name: '목록 다시 불러오기', exact: true }).click();
    await observe(page, '[role="dialog"] select[aria-label="추가할 구성원"]:not(:disabled)');
    await page.getByRole('combobox', { name: '추가할 구성원', exact: true }).selectOption(candidate.userId);
    assert.equal((await save(page, 'POST', 200)).created, false);
    return { deniedStatus: 403, restoredExplicitlyByAdmin: true };
  });
  await surface('task-detail-draft', writer, taskPath, '.project-tasks__detail', `/api/v1${taskPath}`, async page => {
    await observe(page, '.project-tasks__detail button[type="submit"]:not(:disabled)');
    await page.getByRole('textbox', { name: '제목', exact: true }).fill('보존할 상세 편집 초안');
    await page.getByRole('combobox', { name: '담당자', exact: true }).selectOption(writer.userId);
    const current = await api.request(admin, taskPath);
    await api.request(admin, taskPath, 'PATCH', { version: current.version, title: '상세 편집 중 서버 변경' });
    const stale = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/v1${taskPath}`);
    await page.getByRole('button', { name: '변경 저장', exact: true }).click(); assert.equal((await stale).status(), 409);
    await observe(page, '[data-assignment-conflict]');
    assert.equal(await page.getByRole('textbox', { name: '제목', exact: true }).inputValue(), '보존할 상세 편집 초안');
    await shot(page, 'detail-stale-draft');
    const abort = route => route.abort('failed');
    await page.route(`**/api/v1${taskPath}`, abort);
    try {
      await page.getByRole('button', { name: '최신 업무 불러오기', exact: true }).click();
      await observe(page, '.project-tasks__detail > .field-error');
      assert.equal(await page.locator('.project-tasks__detail button[type="submit"]').isDisabled(), true);
      assert.equal(await page.getByRole('textbox', { name: '제목', exact: true }).inputValue(), '보존할 상세 편집 초안');
    } finally { await page.unroute(`**/api/v1${taskPath}`, abort); }
    await page.getByRole('button', { name: '최신 업무 불러오기', exact: true }).click();
    await observe(page, '.project-tasks__detail button[type="submit"]:not(:disabled)');
    assert.equal(await page.getByRole('textbox', { name: '제목', exact: true }).inputValue(), '보존할 상세 편집 초안');
    assert.equal(await page.getByRole('combobox', { name: '담당자', exact: true }).inputValue(), writer.userId);
    await shot(page, 'detail-latest-reconfirmation');
    const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/v1${taskPath}`);
    await page.getByRole('button', { name: '확인 후 변경 저장', exact: true }).click(); assert.equal((await saved).status(), 200);
    await rendered(page, '.project-tasks__detail');
    const record = await api.request(admin, taskPath);
    assert.equal(record.title, '보존할 상세 편집 초안'); assert.equal(record.assignee_id, writer.userId);
    return { preservedTitle: record.title, selectedAssignee: record.assignee_id };
  });
  // 관리자에게만 조건부 접근 준비 안내를 보여주며, 수신자의 권한을 조회/부여하지 않는다.
  const rolesBefore = (await api.request(admin, '/members')).items.map(item => ({ id: item.user_id, roles: item.roles }));
  await surface('administrator-warning', admin, projectPath, '[data-task-id]', '/api/v1/tasks', async page => {
    await open(page, 'assignment');
    await observe(page, '[role="dialog"] select[aria-label="담당자"]:not(:disabled)');
    await page.getByRole('combobox', { name: '담당자', exact: true }).selectOption(writer.userId);
    await observe(page, '[data-recipient-access-warning] a[href="/settings/roles"]');
    await shot(page, 'admin-access-warning');
    await save(page, 'PATCH', 200);
    assert.deepEqual((await api.request(admin, '/members')).items.map(item => ({ id: item.user_id, roles: item.roles })), rolesBefore);
    return { noAutomaticRoles: true, recipientNotificationReadDenied: true };
  });
  // 동일 사용자의 실제 두 회사 세션. 늦은 A 후보 응답은 B 화면을 되살릴 수 없다.
  const companyB = await api.request(writer, '/tenants', 'POST', { name: '작성자 회사 B', type: 'custom', modules: ['projects', 'tasks'], features: [], departments: [] }, 201);
  const me = await api.request(writer, '/auth/me'); writer.session = { ...writer.session, organizations: me.organizations };
  await surface('scope-switch-late-candidates', writer, projectPath, '[data-task-id]', '/api/v1/tasks', async page => {
    const gate = await holdResponse(page, pattern);
    try {
      await page.getByRole('button', { name: '구성원 추가', exact: true }).click(); await gate.entered();
      await page.getByRole('button', { name: '닫기', exact: true }).click();
      await page.locator('.workspace-picker__button').click();
      const switched = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/projects' && response.request().headers()['x-org-id'] === companyB.org_id);
      await page.getByRole('menuitemradio', { name: /작성자 회사 B/ }).click(); assert.equal((await switched).status(), 200);
      await rendered(page, '.project-tasks__empty');
      gate.release(); await gate.close();
      assert.equal(await page.locator('[role="dialog"]').count(), 0);
      assert.equal(await page.locator('[data-member-id]').count(), 0);
      assert.equal(await page.locator(`[data-project-id="${project.id}"]`).count(), 0);
      await api.request({ ...writer, orgId: companyB.org_id }, `${projectPath}/candidates`, 'GET', undefined, 404);
      await shot(page, 'company-b-after-late-response');
      return { oldCompany: writer.orgId, selectedCompany: companyB.org_id, lateOptionsVisible: 0 };
    } finally { await gate.close(); }
  });
  const writerInB = { ...writer, orgId: companyB.org_id, session: { ...writer.session, orgId: companyB.org_id } };
  await surface('notification-company-b', writerInB, '/notifications', 'main .state-card:not([role])', '/api/v1/notifications', async page => {
    assert.equal((await api.request(writerInB, '/notifications')).items.length, 0);
    assert.equal(await page.locator(`main a[href="${taskPath}"]`).count(), 0);
    return { foreignNotifications: 0 };
  });
}
