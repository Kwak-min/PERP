import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import { api, createOwnerOrg, startTestServer } from './http.js';

describe('company custom roles over real HTTP', { timeout: 30000 }, () => {
  let server, owner, member, db;
  const request = (actor, route, method = 'GET', body) => api(server.baseUrl, route, { ...actor, orgId: actor.orgId ?? owner.orgId, method, body });
  before(async () => {
    server = await startTestServer();
    ({ db } = await import('../src/config/db.js'));
    owner = await createOwnerOrg(server.baseUrl, ['projects', 'tasks', 'approvals']);
    const email = `role-${crypto.randomUUID()}@example.invalid`;
    const invite = await request(owner, '/members/invites', 'POST', { email, roles: ['member'] });
    assert.equal(invite.status, 201);
    const signup = await api(server.baseUrl, '/auth/signup', { method: 'POST', body: { email, name: '역할 테스트', password: 'password-1234' } });
    member = { token: signup.body.access_token, userId: signup.body.user.id };
    assert.equal((await request(member, '/auth/invitations/accept', 'POST', { token: invite.body.token })).status, 201);
    member.membershipId = db().prepare('SELECT id FROM membership WHERE user_id = ? AND org_id = ?').get(member.userId, owner.orgId).id;
  });
  after(async () => { if (server) await server.close(); });

  it('creates, assigns, changes and revokes exact action/menu grants without relogin', async () => {
    const created = await request(owner, '/settings/roles', 'POST', { name: '테스트2', scope: 'self', permissions: ['menu.projects', 'task.read'] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const role = created.body.key;
    assert.equal((await request(owner, `/settings/members/${member.membershipId}/roles`, 'PUT', { roles: [role] })).status, 200);
    assert.equal((await request(member, '/tasks')).status, 200);
    assert.equal((await request(member, '/projects')).status, 403);
    let access = await request(member, '/settings/access');
    assert.deepEqual(access.body.menus, ['menu.projects']);
    assert.equal((await request(member, '/settings/roles', 'POST', { name: '침입', permissions: [] })).status, 403);
    assert.equal((await request(owner, `/settings/roles/${role}`, 'PATCH', { name: '테스트2', scope: 'self', permissions: ['task.read'] })).status, 200);
    assert.equal((await request(member, '/tasks')).status, 403, 'action alone cannot bypass denied menu API');
    assert.equal((await request(owner, `/settings/roles/${role}`, 'DELETE')).status, 204);
    access = await request(member, '/settings/access');
    assert.deepEqual(access.body.permissions, []);
    assert.equal((await request(member, '/tasks')).status, 403);
  });

  it('bounds delegation and existing target authority, rejects unknown and cross-org IDs', async () => {
    const created = await request(owner, '/settings/roles', 'POST', { name: '제한 위임', scope: 'self', permissions: ['role.assign', 'menu.roles', 'menu.projects', 'task.read'] });
    assert.equal(created.status, 201);
    assert.equal((await request(owner, `/settings/members/${member.membershipId}/roles`, 'PUT', { roles: [created.body.key] })).status, 200);
    for (const permissions of [['*'], ['platform.tenants'], ['approval.decide'], ['not.real']]) {
      const result = await request(member, '/settings/roles', 'POST', { name: '초과', scope: 'self', permissions });
      assert.ok([400, 403].includes(result.status), JSON.stringify(result));
    }
    assert.equal((await request(member, '/settings/roles', 'POST', { name: '범위 초과', scope: 'all', permissions: ['task.read'] })).status, 403);
    const allowed = await request(member, '/settings/roles', 'POST', { name: '업무 읽기', scope: 'self', permissions: ['task.read', 'menu.projects'] });
    assert.equal(allowed.status, 201);
    const ownerMembership = db().prepare('SELECT id FROM membership WHERE user_id = ? AND org_id = ?').get(owner.userId, owner.orgId).id;
    assert.equal((await request(member, `/settings/members/${ownerMembership}/roles`, 'PUT', { roles: [allowed.body.key] })).status, 403);
    const other = await createOwnerOrg(server.baseUrl, []);
    assert.equal((await request(other, `/settings/roles/${allowed.body.key}`, 'PATCH', { name: '외부', scope: 'self', permissions: [] })).status, 404);
    assert.equal((await request(other, `/settings/members/${member.membershipId}/roles`, 'PUT', { roles: [] })).status, 404);
  });

  it('keeps the last administrator and provides finite explicit all-company authority', async () => {
    const own = db().prepare('SELECT id FROM membership WHERE user_id = ? AND org_id = ?').get(owner.userId, owner.orgId).id;
    assert.equal((await request(owner, `/settings/members/${own}/roles`, 'PUT', { roles: [] })).status, 409);
    assert.equal((await request(owner, `/members/${own}/roles`, 'PATCH', { roles: [] })).status, 409);
    assert.equal((await request(owner, `/members/${own}/status`, 'PATCH', { status: 'inactive' })).status, 409);
    const list = await request(owner, '/settings/roles');
    const admin = list.body.items.find(role => role.key === 'company_admin');
    assert.ok(admin.permissions.includes('approval.decide'));
    assert.ok(admin.permissions.includes('fiscal.close'));
    assert.ok(admin.permissions.includes('menu.roles'));
    assert.ok(!admin.permissions.some(code => code === '*' || code.startsWith('platform.')));
    assert.equal((await request(owner, `/settings/members/${member.membershipId}/roles`, 'PUT', { roles: ['company_admin'] })).status, 200);
    const access = await request(member, '/settings/access');
    assert.ok(access.body.permissions.includes('approval.decide'));
    assert.equal((await request(member, '/finance/transactions')).status, 403, 'admin does not enable unavailable modules');
  });

  it('supports custom-role invitation and refuses last-admin edits when another admin account is disabled', async () => {
    const isolated = await createOwnerOrg(server.baseUrl, []);
    const created = await request(isolated, '/settings/roles', 'POST', { name: '활성 관리자', scope: 'all', permissions: ['role.assign', 'organization.settings', 'menu.roles'] });
    assert.equal(created.status, 201);
    const email = `custom-admin-${crypto.randomUUID()}@example.invalid`;
    const invitation = await request(isolated, '/members/invites', 'POST', { email, roles: [created.body.key] });
    assert.equal(invitation.status, 201);
    const signup = await api(server.baseUrl, '/auth/signup', { method: 'POST', body: { email, name: '관리자', password: 'password-1234', invitation_token: invitation.body.token } });
    assert.equal(signup.status, 201);
    const admin = { token: signup.body.access_token, orgId: isolated.orgId };
    db().prepare("UPDATE app_user SET auth_status = 'inactive' WHERE id = ?").run(isolated.userId);
    const edited = await request(admin, `/settings/roles/${created.body.key}`, 'PATCH', { name: '활성 관리자', scope: 'all', permissions: ['role.assign', 'menu.roles'] });
    assert.equal(edited.status, 409);
    assert.equal((await request(admin, `/settings/roles/${created.body.key}`, 'DELETE')).status, 409);
    assert.ok((await request(admin, '/settings/access')).body.permissions.includes('organization.settings'));
  });
});
