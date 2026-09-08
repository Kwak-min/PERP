import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { COMPANY_PERMISSIONS } from '../src/config/rbac.js';
import { createDeadlineFixture, startDeadlineServer } from './deadline-fixture.js';

describe('task11 minimal authorized display DTOs (real SQLite HTTP)', { timeout: 60000 }, () => {
  let api, fixture;
  before(async () => { api = await startDeadlineServer(); fixture = await createDeadlineFixture(api); });
  after(async () => { await api?.close(); });
  const role = (name, permissions, scope = 'all') => api.request(fixture.actorAdmin, '/settings/roles', 'POST', { name, permissions, scope }, 201);
  const assign = (actor, roles) => api.request(fixture.actorAdmin, `/settings/members/${actor.membershipId}/roles`, 'PUT', { roles });

  it('returns only the assigned name with task.read, without directory/project/write permission', async () => {
    const { actorManager: reader, actorMember: assigned, task, project, B } = fixture;
    await assign(reader, [(await role('Task-only display', ['menu.projects', 'task.read'])).key]);
    const detail = await api.request(reader, `/tasks/${task.id}`);
    assert.equal(detail.assignee_id, assigned.userId);
    assert.equal(detail.assignee_name, assigned.name);
    assert.equal(Object.hasOwn(detail, 'assignee_email'), false);
    await api.request(reader, '/members', 'GET', undefined, 403);
    await api.request(reader, `/projects/${project.id}/members`, 'GET', undefined, 403);
    await api.request(reader, `/tasks/${task.id}/assignees`, 'GET', undefined, 403);
    await api.request(reader, `/tasks/${task.id}`, 'PATCH', { version: detail.version, assignee_id: reader.userId }, 403);
    await api.request(B.actor, `/tasks/${task.id}`, 'GET', undefined, 404);
  });

  it('does not use a foreign or inactive membership as the display identity', async () => {
    const { actorAdmin: admin, actorManager: reader, actorMember: assigned, task } = fixture;
    await api.request(admin, `/members/${assigned.membershipId}/status`, 'PATCH', { status: 'inactive' });
    assert.equal((await api.request(reader, `/tasks/${task.id}`)).assignee_name, null);
    await api.request(admin, `/members/${assigned.membershipId}/status`, 'PATCH', { status: 'active' });
    assert.equal((await api.request(reader, `/tasks/${task.id}`)).assignee_name, assigned.name);
    const unassigned = await api.request(admin, '/tasks', 'POST', { title: 'Unassigned display', assignee_id: null }, 201);
    assert.equal((await api.request(reader, `/tasks/${unassigned.id}`)).assignee_name, null);
  });

  it('computes full effective union plus scope all, retaining disabled-feature grants and owner compatibility', async () => {
    const { actorAdmin: admin, actorManager: delegate, B } = fixture;
    for (const actor of [admin, B.actor]) assert.equal((await api.request(actor, '/settings/access')).is_company_administrator, true);
    const limited = await role('Administrator label is not authority', ['role.assign', 'organization.settings', 'menu.roles']);
    const missing = await role('Missing disabled attendance', COMPANY_PERMISSIONS.filter(code => code !== 'attendance.read'));
    const narrow = await role('Narrow full permissions', COMPANY_PERMISSIONS, 'self');
    const halves = await Promise.all([0, 1].map(i => role(`Union ${i}`, COMPANY_PERMISSIONS.filter((_, index) => index % 2 === i))));
    for (const [roles, expected] of [[[limited.key], false], [[missing.key], false], [[narrow.key], false], [halves.map(item => item.key), true]]) {
      await assign(delegate, roles);
      const access = await api.request(delegate, '/settings/access');
      assert.equal(access.features.includes('attendance'), false);
      assert.equal(access.is_company_administrator, expected);
    }
  });
});
