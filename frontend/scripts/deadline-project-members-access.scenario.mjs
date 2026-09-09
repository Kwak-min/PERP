import assert from 'node:assert/strict';
import { observe } from './deadline-project-members.scenario.mjs';

// All actors/roles come from the real isolated API; no grant or candidate payload is mocked.
export async function projectMemberAccess({ surface, api, fixture, result }) {
  const { actorAdmin: admin, actorMember: reader, actorManager: delegate, project, task } = fixture;
  const memberRows = (await api.request(admin, '/settings/members')).items;
  const original = actor => memberRows.find(row => row.user_id === actor.userId).roles;
  const createRole = (name, permissions, scope = 'all') => api.request(admin, '/settings/roles', 'POST', { name, permissions, scope }, 201);
  const assign = async (actor, roles) => {
    const current = (await api.request(admin, '/settings/members')).items.find(row => row.membership_id === actor.membershipId);
    return api.request(admin, `/settings/members/${actor.membershipId}/roles`, 'PUT', { roles, expected_roles_version: current.roles_version });
  };
  const catalog = (await api.request(admin, '/settings/roles')).catalog.map(item => item.code);
  const taskPath = `/tasks/${task.id}`;
  const checks = [];
  try {
    const readRole = await createRole('Task11 real task reader', ['menu.projects', 'project.read', 'task.read']);
    await assign(reader, [readRole.key]);
    const record = await api.request(reader, taskPath);
    const roster = await api.request(reader, `/projects/${project.id}/members`);
    const expected = roster.items.find(item => item.value === record.assignee_id).label;
    // Test both the former project reader and task.read without a project.read/directory grant.
    for (const taskOnly of [false, true]) {
      if (taskOnly) {
        const role = await createRole('Task11 task-only reader', ['menu.projects', 'task.read']);
        await assign(reader, [role.key]);
        await api.request(reader, `/projects/${project.id}/members`, 'GET', undefined, 403);
      }
      const name = taskOnly ? 'task-only-readable-assignee' : 'readonly-readable-assignee';
      const start = result.browserAllowedRequests.length;
      await surface(name, reader, taskPath, '.project-tasks__detail', `/api/v1${taskPath}`, async page => {
        await observe(page, '.project-tasks__detail input[maxlength="300"]:disabled');
        // DOM completion, including the old buggy selector, is event-gated before inspection.
        await observe(page, '.project-tasks__detail [data-assignee-display], .project-tasks__detail .field-error');
        const label = await page.locator('[data-assignee-display], .project-tasks__detail select[aria-label="담당자"] option:checked').textContent();
        const observation = { name, expectedLabel: expected, actualLabel: label, errors: await page.locator('.project-tasks__detail .field-error').count(), disabled: await page.locator('.project-tasks__detail button[type="submit"]').isDisabled() };
        checks.push(observation); return observation;
      });
      checks.at(-1).candidateCalls = result.browserAllowedRequests.slice(start).filter(request => /\/(assignees|candidates)(\?|$)/.test(request.url)).length;
    }
    const write = ['menu.projects', 'project.read', 'project.write', 'task.read', 'task.write'];
    const limited = await createRole('company_admin', [...write, 'role.assign', 'organization.settings', 'menu.roles']);
    const split = [catalog.filter((_, i) => i % 2 === 0), catalog.filter((_, i) => i % 2 === 1)];
    const halves = await Promise.all(split.map((permissions, i) => createRole(`Task11 full union ${i}`, permissions)));
    const withoutDisabled = await createRole('Task11 missing disabled grant', catalog.filter(code => code !== 'attendance.read'));
    const narrow = await createRole('Task11 all grants narrow scope', catalog, 'self');
    for (const [name, actor, roles, expectedWarnings] of [
      ['limited-delegate-no-notice', delegate, [limited.key], 0],
      ['disabled-grant-required', delegate, [withoutDisabled.key], 0],
      ['scope-all-required', delegate, [narrow.key], 0],
      ['full-effective-union-notice', delegate, halves.map(role => role.key), 1],
      ['finite-full-admin-notice', admin, null, 1],
    ]) {
      if (roles) await assign(actor, roles);
      const access = await api.request(actor, '/settings/access');
      assert.equal(access.features.includes('attendance'), false);
      await surface(name, actor, taskPath, '.project-tasks__detail', `/api/v1${taskPath}`, async page => {
        await observe(page, '.project-tasks__detail button[type="submit"]:not(:disabled)');
        const observation = { name, expectedWarnings, actualWarnings: await page.locator('[data-recipient-access-warning] a[href="/settings/roles"]').count(), access };
        checks.push(observation); return observation;
      });
    }
  } finally {
    await assign(reader, original(reader));
    await assign(delegate, original(delegate));
  }
  result.accessRevision = checks;
  const failures = checks.flatMap(check => 'expectedLabel' in check
    ? [check.actualLabel !== check.expectedLabel && `${check.name}: readable label ${JSON.stringify(check.actualLabel)} != ${JSON.stringify(check.expectedLabel)}`, check.errors !== 0 && `${check.name}: ${check.errors} write errors`, check.candidateCalls !== 0 && `${check.name}: ${check.candidateCalls} write candidate calls`, !check.disabled && `${check.name}: writable reader`]
    : [check.actualWarnings !== check.expectedWarnings && `${check.name}: notice count ${check.actualWarnings} != ${check.expectedWarnings}`]).filter(Boolean);
  assert.deepEqual(failures, [], 'Read-only assignee and full administrator contract');
}
