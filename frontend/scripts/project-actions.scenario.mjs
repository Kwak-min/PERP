import assert from 'node:assert/strict';
import { observe } from './deadline-project-members.scenario.mjs';

async function finishScenario({ page, prefix, project, admin, writer, excluded, request, responseFor, shot, taskCount, beforeTasks, assignRole, readerRole, writerRole, projectPath, detailPath, roster, task }) {
  // stale 프로젝트 완료는 거부하고 모든 업무/소속을 보존한다.
  await page.getByRole('button', { name: '프로젝트 완료', exact: true }).click();
  const initial = await request(admin, detailPath);
  await request(admin, projectPath, 'PATCH', { version: initial.version, name: project.name + ' updated' });
  const [stale] = await Promise.all([responseFor(projectPath, 'PATCH'), observe(page, '[role="dialog"] [role="alert"]'), page.getByRole('button', { name: '완료 처리', exact: true }).click()]);
  assert.equal(stale.status(), 409);
  assert.equal((await request(admin, detailPath)).status, initial.status);
  assert.equal(await taskCount(), beforeTasks + 1);
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click();
  await Promise.all([responseFor(`${prefix}/projects`), page.getByRole('button', { name: '새로고침', exact: true }).click()]);
  await observe(page, '[data-project-id] [data-project-status]');
  await page.getByRole('button', { name: '프로젝트 완료', exact: true }).click();
  // 열린 확인창에서 권한이 회수되어도 서버의 현재 권한이 우선한다.
  await assignRole(writer, readerRole.key);
  const [forbidden] = await Promise.all([responseFor(projectPath, 'PATCH'), observe(page, '[role="dialog"] [role="alert"]'), page.getByRole('button', { name: '완료 처리', exact: true }).click()]);
  assert.equal(forbidden.status(), 403);
  assert.equal((await request(admin, detailPath)).status, initial.status);
  await request(writer, `${prefix}/tasks`, 'POST', { project_id: project.id, title: 'forbidden task', assignee_id: null }, 403);
  await request(writer, `${projectPath}/members`, 'POST', { user_id: excluded.userId }, 403);
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click();
  await assignRole(writer, writerRole.key);
  await Promise.all([responseFor(`${prefix}/projects`), page.getByRole('button', { name: '새로고침', exact: true }).click()]);
  await observe(page, '[data-project-id] [data-project-status]');
  await page.getByRole('button', { name: '프로젝트 완료', exact: true }).click();
  for (const width of [375, 1280]) await shot('project-finish-confirmation', width);
  const [completed] = await Promise.all([responseFor(projectPath, 'PATCH'), observe(page, '.project-tasks:not(:has([role="dialog"]))'), page.getByRole('button', { name: '완료 처리', exact: true }).click()]);
  assert.equal(completed.status(), 200);
  assert.equal((await completed.json()).status, 'done');
  const storedProject = await request(admin, detailPath);
  assert.equal(storedProject.status, 'done');
  await request(writer, projectPath, 'PATCH', { version: initial.version, status: 'done' }, 409);
  assert.equal((await request(admin, detailPath)).version, storedProject.version);
  assert.equal(await taskCount(), beforeTasks + 1);
  assert.deepEqual((await request(admin, `${projectPath}/members`)).items, roster.items);
  await Promise.all([responseFor(`${prefix}/projects`), page.reload()]);
  await observe(page, `[data-project-id="${project.id}"] [data-project-status="done"]`);
  await page.locator(`[data-project-id="${project.id}"] .project-tasks__expand`).click();
  assert.equal(await page.getByRole('button', { name: '프로젝트 완료', exact: true }).isDisabled(), true);
  for (const width of [375, 1280]) await shot('completed-project-reloaded', width);
  return { selectedMembers: roster.items.length, excludedId: excluded.userId, taskId: task.id, status: storedProject.status, version: storedProject.version, stale: stale.status(), forbidden: forbidden.status() };
}

export async function projectActionsScenario({ page, prefix, project, admin, writer, target, excluded, candidates, request, responseFor, openCreate, shot, taskCount, assignRole, readerRole, writerRole }) {
  const projectPath = `${prefix}/projects/${project.id}`;
  const detailPath = prefix ? `/pg/records/projects/${project.id}` : projectPath;
  // 검색 중에도 팀 전체 선택은 첫 페이지/검색 결과가 아니라 전체 후보를 대상으로 한다.
  await openCreate();
  const search = page.getByRole('searchbox', { name: '구성원 검색', exact: true });
  await search.fill(`  ${target.name}  `);
  assert.equal(await page.locator('.project-task-members input[type="checkbox"]').count(), 1);
  await page.getByRole('button', { name: '팀 전체 선택', exact: true }).click();
  await search.fill('');
  assert.equal(await page.locator('.project-task-members input:checked').count(), candidates.items.length);
  await page.getByRole('button', { name: '팀 선택 해제', exact: true }).click();
  assert.equal(await page.locator('.project-task-members input:checked').count(), 0);
  await page.getByRole('button', { name: '팀 전체 선택', exact: true }).click();
  await search.fill(excluded.name);
  await page.getByRole('checkbox', { name: `함께할 구성원 ${excluded.name}`, exact: true }).uncheck();
  await search.fill(target.name);
  await page.getByRole('combobox', { name: '담당자', exact: true }).selectOption(target.userId);
  await search.fill('');
  assert.equal(await page.locator('.project-task-members input:checked').count(), candidates.items.length - 1);
  assert.equal(await page.getByRole('checkbox', { name: `함께할 구성원 ${excluded.name}`, exact: true }).isChecked(), false);
  await page.getByLabel('제목', { exact: true }).fill('One task for the selected team');
  for (const width of [375, 1280]) await shot('team-all-individual-deselection', width);
  const beforeTasks = await taskCount();
  const taskPattern = '**/api/v1' + prefix + '/tasks';
  let failedKey, failedBody;
  const interrupt = async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    failedKey = route.request().headers()['idempotency-key']; failedBody = route.request().postDataJSON();
    await route.abort('failed');
  };
  await page.route(taskPattern, interrupt);
  try {
    await Promise.all([page.waitForEvent('requestfailed', { predicate: item => item.method() === 'POST' && new URL(item.url()).pathname === '/api/v1' + prefix + '/tasks' }),
      observe(page, '[role="dialog"] > p[role="alert"]'), page.locator('[role="dialog"] button[type="submit"]').click()]);
    assert.equal(await taskCount(), beforeTasks);
    assert.equal((await request(admin, `${projectPath}/members`)).items.length, candidates.items.length - 1);
    for (const width of [375, 1280]) await shot('team-memberships-preserved', width);
  } finally { await page.unroute(taskPattern, interrupt); }
  await Promise.all([responseFor(`${prefix}/projects`), page.reload()]);
  await Promise.all([observe(page, '[data-task-create-pending]'), page.getByRole('button', { name: '업무 만들기', exact: true }).click()]);
  await observe(page, '.project-task-members input:checked');
  assert.equal(await page.locator('.project-task-members input:checked').count(), candidates.items.length - 1);
  assert.equal(await page.getByRole('checkbox', { name: `함께할 구성원 ${excluded.name}`, exact: true }).isChecked(), false);
  const [created] = await Promise.all([responseFor(`${prefix}/tasks`, 'POST'), observe(page, '.project-tasks:not(:has([role="dialog"]))'), page.locator('[role="dialog"] button[type="submit"]').click()]);
  assert.equal(created.status(), 201);
  assert.equal(created.request().headers()['idempotency-key'], failedKey);
  assert.deepEqual(created.request().postDataJSON(), failedBody);
  const task = await created.json();
  assert.equal(await taskCount(), beforeTasks + 1);
  assert.equal(created.request().postDataJSON().assignee_id, target.userId);
  const roster = await request(admin, `${projectPath}/members`);
  assert.equal(roster.items.length, candidates.items.length - 1);
  assert.equal(roster.items.some(item => item.value === excluded.userId), false);
  for (const candidate of candidates.items.filter(item => item.id !== excluded.userId)) assert.ok(roster.items.some(item => item.value === candidate.id));
  await Promise.all([responseFor(`${prefix}/projects`), page.reload()]);
  await observe(page, `[data-task-id="${task.id}"]`);
  await page.getByRole('searchbox', { name: '프로젝트 구성원 검색', exact: true }).fill(` ${target.name} `);
  assert.equal(await page.locator('[data-project-roster] [data-member-id]').count(), 1);
  assert.equal(await page.locator('[data-project-roster] [data-member-id]').getAttribute('data-member-id'), target.userId);
  await page.getByRole('searchbox', { name: '프로젝트 구성원 검색', exact: true }).fill('missing member');
  assert.equal(await page.locator('[data-project-roster] [data-member-id]').count(), 0);
  await page.getByRole('searchbox', { name: '프로젝트 구성원 검색', exact: true }).fill('');
  await page.getByRole('searchbox', { name: '프로젝트 검색', exact: true }).fill(`  ${project.name.toUpperCase()}  `);
  assert.equal(await page.locator(`[data-project-id="${project.id}"]`).count(), 1);
  for (const width of [375, 1280]) await shot('team-roster-reloaded', width);
  await Promise.all([responseFor(`${prefix}/tasks`), page.locator('.nav-group a[href="/tasks"]').click()]);
  await observe(page, `[data-task-id="${task.id}"]`);
  const taskSearch = page.getByRole('searchbox', { name: '업무 검색', exact: true });
  await taskSearch.fill('  ONE TASK FOR THE SELECTED TEAM  ');
  assert.equal(await page.locator('[data-task-id]').count(), 1);
  await taskSearch.fill(project.name);
  assert.ok(await page.locator('[data-task-id]').count() > 1);
  await page.getByRole('button', { name: '업무 만들기', exact: true }).click();
  await page.getByRole('dialog').getByRole('searchbox', { name: '프로젝트 검색', exact: true }).fill(`  ${project.name.toUpperCase()}  `);
  assert.equal(await page.getByRole('dialog').locator('select[required] option:not([value=""])').count(), 1);
  await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
  await Promise.all([responseFor(`${prefix}/projects`), page.locator('.nav-group a[href="/projects"]').click()]);
  await observe(page, `[data-project-id="${project.id}"]`);
  await page.locator(`[data-project-id="${project.id}"] .project-tasks__expand`).click();
  return await finishScenario({ page, prefix, project, admin, writer, excluded, request, responseFor, shot, taskCount, beforeTasks, assignRole, readerRole, writerRole, projectPath, detailPath, roster, task });
}
