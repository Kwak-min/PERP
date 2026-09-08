import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { COMPANY_PERMISSIONS } from '../src/config/rbac.js';
import { api, startTestServer } from './http.js';
import { installCompanyFixture } from './pg-company-fixture.js';

process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
let server, fixture;
before(async () => {
  server = await startTestServer(); fixture = await installCompanyFixture();
  fixture.users[0].is_admin = false;
  // 기존의 좁은 생성자 역할은 이름만으로 승격되지 않아야 한다.
  fixture.state.roles[0].name = 'company_creator';
});
after(async () => { await fixture?.close(); await server?.close(); });
const request = (actor, route, method = 'GET', body) => {
  const memberId = /^\/settings\/members\/([^/]+)\/roles$/.exec(route)?.[1];
  if (memberId && method === 'PUT' && body.expected_roles_version === undefined) body = { ...body, expected_roles_version: fixture.state.memberships.find(m => m.user_id === memberId)?.roles_version };
  return api(server.baseUrl, route, { ...actor, method, body });
};
async function login(email = fixture.users[0].email) {
  const response = await request({}, '/pg/auth/login', 'POST', { email, password: 'password-1234' });
  assert.equal(response.status, 200); return response.body.token;
}
async function createCompany() {
  const token = await login();
  const response = await request({ token }, '/pg/companies', 'POST', { name: 'Creator administrator', modules: [], features: [] });
  assert.equal(response.status, 201);
  return { token, orgId: response.body.org_id };
}
const roleBody = (name, permissions) => ({ name, permissions, scope: 'all' });
async function createMember(actor, email) {
  const response = await request(actor, '/pg/members', 'POST', { email, name: 'Delegate', password: 'password-1234' });
  assert.equal(response.status, 201); return response.body.id;
}

// 실제 생성 -> 설정 조회 -> 관리자 배정 경로를 검증한다. PG 엔진은 SQL 경계 픽스처다.
test('new native creator owns every canonical company permission and can assign/delegate full administration only in the new company', { timeout: 30000 }, async () => {
  const existing = structuredClone({ roles: fixture.state.roles, grants: fixture.state.grants, permissions: fixture.state.permissions, memberships: fixture.state.memberships, user: fixture.users[0] });
  const creator = await createCompany(), companyId = creator.orgId.slice(3);
  const access = await request(creator, '/settings/access');
  const roles = await request(creator, '/settings/roles');
  const members = await request(creator, '/settings/members');
  assert.equal(access.status, 200); assert.equal(roles.status, 200); assert.equal(members.status, 200);
  const creatorKeys = members.body.items.find(m => m.user_id === '101').roles;
  const assigned = await request(creator, '/settings/members/101/roles', 'PUT', { roles: [...creatorKeys, 'company_admin'] });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.deepEqual(access.body.permissions, COMPANY_PERMISSIONS);
  assert.deepEqual(roles.body.grantable, COMPANY_PERMISSIONS);
  assert.deepEqual(roles.body.items.find(r => r.key === 'company_admin').permissions, COMPANY_PERMISSIONS);
  assert.deepEqual(access.body.menus, COMPANY_PERMISSIONS.filter(code => code.startsWith('menu.')));
  assert.deepEqual(access.body.features, [], 'permission bootstrap does not enable optional features');
  const creatorRole = fixture.state.roles.find(r => r.company_id === companyId && r.name === 'company_creator');
  assert.deepEqual(fixture.state.permissions.filter(p => p.role_id === creatorRole.id).map(p => p.code).sort(), COMPANY_PERMISSIONS);
  assert.ok(assigned.body.roles.includes(creatorRole.id), 'preserve existing creator grant during self-assignment');
  assert.ok(!COMPANY_PERMISSIONS.some(code => code === '*' || code.startsWith('platform.')));

  const allRole = await request(creator, '/settings/roles', 'POST', roleBody('All company permissions', COMPANY_PERMISSIONS));
  assert.equal(allRole.status, 201, JSON.stringify(allRole.body));
  assert.deepEqual(allRole.body.permissions, COMPANY_PERMISSIONS);
  const email = 'full-creator-delegate@example.invalid', memberId = await createMember(creator, email);
  assert.equal((await request(creator, `/settings/members/${memberId}/roles`, 'PUT', { roles: ['company_admin'] })).status, 200);
  const delegate = { token: await login(email), orgId: creator.orgId };
  assert.deepEqual((await request(delegate, '/settings/access')).body.permissions, COMPANY_PERMISSIONS);
  assert.deepEqual((await request(delegate, '/settings/roles')).body.grantable, COMPANY_PERMISSIONS);
  const relogged = { ...creator, token: await login() };
  const workspaces = await request(relogged, '/pg/auth/workspace');
  assert.equal(workspaces.status, 200);
  assert.deepEqual(workspaces.body.organizations.find(org => org.org_id === creator.orgId).permissions.sort(), COMPANY_PERMISSIONS);
  assert.deepEqual((await request(relogged, '/settings/access')).body.permissions, COMPANY_PERMISSIONS);

  for (const actor of [{ ...creator, orgId: 'pg:77' }, { ...delegate, orgId: 'pg:77' }, { ...creator, orgId: 'pg:999' }]) {
    assert.equal((await request(actor, '/settings/roles')).status, 403);
    assert.equal((await request(actor, '/settings/members/101/roles', 'PUT', { roles: ['company_admin'] })).status, 403);
  }
  assert.equal((await request(creator, '/settings/members/102/roles', 'PUT', { roles: ['company_admin'], expected_roles_version: members.body.items[0].roles_version })).status, 404);
  for (const permissions of [['*'], ['platform.tenants']]) {
    assert.equal((await request(creator, '/settings/roles', 'POST', roleBody('Invalid authority', permissions))).status, 400);
  }
  const otherRoles = fixture.state.roles.filter(r => r.company_id !== companyId);
  const otherRoleIds = otherRoles.map(r => r.id);
  assert.deepEqual(otherRoles, existing.roles);
  assert.deepEqual(fixture.state.permissions.filter(p => otherRoleIds.includes(p.role_id)), existing.permissions);
  assert.deepEqual(fixture.state.grants.filter(g => otherRoleIds.includes(g.role_id)), existing.grants);
  assert.deepEqual(fixture.state.memberships.filter(m => m.company_id !== companyId), existing.memberships);
  assert.deepEqual(fixture.users[0], existing.user);
  assert.deepEqual((await request({ ...creator, orgId: 'pg:77' }, '/settings/access')).body.permissions, ['menu.projects', 'task.read']);
});

test('replacing full administration with a limited custom role restores strict delegation bounds', { timeout: 30000 }, async () => {
  const creator = await createCompany();
  const email = 'limited-creator-delegate@example.invalid', memberId = await createMember(creator, email);
  assert.equal((await request(creator, `/settings/members/${memberId}/roles`, 'PUT', { roles: ['company_admin'] })).status, 200);
  const delegate = { token: await login(email), orgId: creator.orgId };
  assert.deepEqual((await request(delegate, '/settings/access')).body.permissions, COMPANY_PERMISSIONS);
  const permissions = ['menu.projects', 'menu.roles', 'role.assign', 'task.read'];
  const limited = await request(creator, '/settings/roles', 'POST', roleBody('Limited delegator', permissions));
  assert.equal(limited.status, 201);
  assert.equal((await request(creator, `/settings/members/${memberId}/roles`, 'PUT', { roles: [limited.body.key] })).status, 200);
  assert.deepEqual((await request(delegate, '/settings/access')).body.permissions, permissions);
  assert.deepEqual((await request(delegate, '/settings/roles')).body.grantable, permissions);
  assert.equal((await request(delegate, '/settings/roles', 'POST', roleBody('Owned subset', ['menu.projects', 'task.read']))).status, 201);
  const before = structuredClone(fixture.state);
  const escalation = await request(delegate, '/settings/roles', 'POST', roleBody('Unowned analytics', ['analytics.read']));
  assert.equal(escalation.status, 403); assert.equal(escalation.body.error.code, 'PERMISSION_DENIED');
  const assignment = await request(delegate, `/settings/members/${memberId}/roles`, 'PUT', { roles: ['company_admin'] });
  assert.equal(assignment.status, 403); assert.equal(assignment.body.error.code, 'PERMISSION_DENIED');
  assert.equal((await request(delegate, '/settings/members/101/roles', 'PUT', { roles: [limited.body.key] })).status, 403);
  assert.deepEqual(fixture.state, before, 'rejected delegation leaves grants and audit state unchanged');
});
