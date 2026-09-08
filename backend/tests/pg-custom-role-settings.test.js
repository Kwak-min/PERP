import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, startTestServer } from './http.js';
import { installRoleFixture } from './pg-custom-role-fixture.js';

describe('PG custom company roles (SQL boundary fixture, real HTTP)', { timeout: 30000 }, () => {
  let server, fixture, admin, member, foreign;
  const request = (actor, route, method = 'GET', body) => {
    const roleId = /^\/settings\/roles\/([^/]+)$/.exec(route)?.[1];
    const memberId = /^\/settings\/members\/([^/]+)\/roles$/.exec(route)?.[1];
    if (roleId && ['PATCH','DELETE'].includes(method)) body = { ...body, expected_version: fixture.state.roles.find(role => role.id === roleId)?.version };
    if (memberId && method === 'PUT') body = { ...body, expected_roles_version: fixture.state.memberships.find(member => member.user_id === memberId)?.roles_version };
    return api(server.baseUrl, route, { ...actor, method, body });
  };
  const create = (name, permissions, actor = admin) => request(actor, '/settings/roles', 'POST', { name, permissions, scope: 'all' });
  before(async () => { server = await startTestServer(); fixture = await installRoleFixture(); admin = fixture.actor(); member = fixture.actor('102'); foreign = fixture.actor('103', '88'); });
  after(async () => { await server?.close(); await fixture?.close(); });

  it('creates/assigns/revokes and checks each new request rather than cached session roles', async () => {
    assert.equal((await request(member, '/settings/roles')).status, 403, 'is_admin is not a grant');
    const created = await create('테스트2', ['task.read', 'menu.projects']);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const role = created.body.key;
    assert.equal((await request(admin, '/settings/members/102/roles', 'PUT', { roles: [role] })).status, 200);
    assert.equal((await request(member, '/pg/tasks')).status, 200);
    assert.equal((await request(member, '/pg/projects')).status, 403);
    assert.deepEqual((await request(member, '/settings/access')).body.menus, ['menu.projects']);
    assert.equal((await request(admin, `/settings/roles/${role}`, 'PATCH', { name: '테스트2', permissions: ['task.read'], scope: 'all' })).status, 200);
    assert.equal((await request(member, '/pg/tasks')).status, 403, 'direct API requires explicit menu as well as action');
    assert.equal((await request(admin, `/settings/roles/${role}`, 'DELETE')).status, 204);
    assert.deepEqual((await request(member, '/settings/access')).body.permissions, []);
    assert.equal((await create('테스트2', ['task.read', 'menu.projects'])).status, 201, 'deleted display names can be reused without reviving assignments');
    assert.deepEqual((await request(member, '/settings/access')).body.permissions, []);
  });

  it('bounds delegation, isolates company/member IDs, and rolls back on audit failure', async () => {
    const delegated = await create('한정 위임', ['role.assign', 'menu.roles', 'task.read', 'menu.projects']);
    assert.equal((await request(admin, '/settings/members/102/roles', 'PUT', { roles: [delegated.body.key] })).status, 200);
    assert.equal((await create('초과', ['approval.decide'], member)).status, 403);
    assert.equal((await create('허용', ['task.read', 'menu.projects'], member)).status, 201);
    assert.equal((await create('플랫폼', ['platform.tenants'])).status, 400);
    assert.equal((await create('와일드카드', ['*'])).status, 400);
    assert.equal((await create('_perp_company_admin_v1', [])).status, 400);
    assert.equal((await request(member, '/settings/members/101/roles', 'PUT', { roles: [] })).status, 403);
    assert.equal((await request(admin, '/settings/members/103/roles', 'PUT', { roles: [] })).status, 404);
    assert.equal((await request(foreign, `/settings/roles/${delegated.body.key}`, 'DELETE')).status, 404);
    assert.equal((await request({ ...admin, orgId: 'pg:88' }, '/settings/roles')).status, 403);
    fixture.failAudit = true;
    const before = structuredClone(fixture.state);
    assert.equal((await create('감사 실패', ['task.read'])).status, 500);
    assert.deepEqual(fixture.state, before);
    fixture.failAudit = false;
  });

  it('prevents last admin lockout, serializes mutations, and never changes unrelated workspace grants', async () => {
    assert.equal((await request(admin, '/settings/members/101/roles', 'PUT', { roles: [] })).status, 409);
    assert.equal((await request(admin, '/settings/members/102/roles', 'PUT', { roles: ['company_admin'] })).status, 200);
    const access = (await request(member, '/settings/access')).body;
    assert.ok(access.permissions.includes('approval.decide') && access.permissions.includes('reservation.manage'));
    assert.ok(!access.permissions.includes('*') && !access.permissions.some(p => p.startsWith('platform.')));
    assert.equal((await request(member, '/pg/assets')).status, 403, 'admin cannot enable unavailable module');
    fixture.state.grants.push({ user_id: '102', role_id: '2', workspace_id: '901' });
    const results = await Promise.all([request(admin, '/settings/members/101/roles', 'PUT', { roles: [] }), request(member, '/settings/members/102/roles', 'PUT', { roles: [] })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.ok(fixture.state.grants.some(g => g.workspace_id === '901' && g.role_id === '2'));
    assert.ok(fixture.queries.some(q => q.text.endsWith('FOR UPDATE') && q.text.includes('org.companies')));
  });

  it('enforces approval.decide and approval menu independently of feature availability', async () => {
    const activeAdmin = fixture.state.grants.some(g => g.user_id === '101' && g.role_id === '1') ? admin : member;
    const target = activeAdmin === admin ? member : admin;
    const targetId = activeAdmin === admin ? '102' : '101';
    const denied = await create('신청만', ['approval.request', 'menu.approvals'], activeAdmin);
    assert.equal((await request(activeAdmin, `/settings/members/${targetId}/roles`, 'PUT', { roles: [denied.body.key] })).status, 200);
    assert.equal((await request(target, '/pg/approvals/501/decide', 'POST', { decision: 'approve' })).status, 403);
    const allowed = await create('승인자', ['approval.decide', 'menu.approvals'], activeAdmin);
    assert.equal((await request(activeAdmin, `/settings/members/${targetId}/roles`, 'PUT', { roles: [allowed.body.key] })).status, 200);
    assert.equal((await request(target, '/pg/approvals/502/decide', 'POST', { decision: 'approve' })).status, 404);
    fixture.state.features = [];
    assert.equal((await request(target, '/pg/approvals/501/decide', 'POST', { decision: 'approve' })).status, 403);
    fixture.state.features = ['approvals'];
    assert.equal((await request(target, '/pg/approvals/501/decide', 'POST', { decision: 'approve' })).status, 200);
    assert.equal(fixture.state.approvals[0].status, 'approved');
    assert.equal((await request(target, '/pg/approvals/501/decide', 'POST', { decision: 'approve' })).status, 409);
  });
});
