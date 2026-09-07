import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { api, startTestServer, createOwnerOrg } from './http.js';
import { installCompanyFixture } from './pg-company-fixture.js';
process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
let server, fixture, token;
before(async () => {
  server = await startTestServer(); fixture = await installCompanyFixture();
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.users[0].email, password: 'password-1234' } });
  assert.equal(login.status, 200); token = login.body.token;
  fixture.state.modules.push({ company_id: '77', module_key: 'assets' });
  fixture.state.permissions = [{ role_id: '1', code: 'reservation.manage' }];
});
after(async () => { await fixture.close(); await server.close(); });
const principal = (orgId, bearer = token) => api(server.baseUrl, '/auth/reservation-principal', { token: bearer, orgId });

test('reservation principal preserves verified PG company roles and isolates identity without changing legacy auth', async () => {
  const response = await principal('pg:77');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { userId: 'pg:101', tenantId: 'pg:77', orgId: 'pg:77', membershipId: 'pg:77:101', roles: ['member'], permissions: ['reservation.manage'], modules: response.body.modules });
  assert.ok(response.body.modules.includes('assets'));
  assert.equal((await api(server.baseUrl, '/auth/principal', { token, orgId: 'pg:77' })).status, 403);
  assert.deepEqual((await api(server.baseUrl, '/auth/me', { token })).body.organizations, []);
  fixture.state.roles[0].name = 'company_creator';
  assert.deepEqual((await principal('pg:77')).body.roles, ['company_creator']);
  fixture.state.roles[0].name = 'org_admin';
  assert.deepEqual((await principal('pg:77')).body.roles, ['org_admin']);
  fixture.state.roles[0].name = 'member';
});

test('reservation principal uses effective PG menus, not raw action permissions or role names', async () => {
  const permissions = fixture.state.permissions;
  try {
    // 기존 회사 생성자의 메뉴는 원시 권한에 없어도 호환 규칙으로 계산된다.
    fixture.state.roles[0].name = 'company_creator';
    assert.equal((await principal('pg:77')).status, 200);
    fixture.state.permissions = [...permissions, { role_id: '1', code: 'menu.configured' }];
    assert.equal((await principal('pg:77')).status, 403);
    fixture.state.permissions.push({ role_id: '1', code: 'menu.reservations' });
    assert.equal((await principal('pg:77')).status, 200);
    fixture.state.permissions = [{ role_id: '1', code: 'task.read' }];
    assert.equal((await principal('pg:77')).status, 403);
  } finally { fixture.state.permissions = permissions; fixture.state.roles[0].name = 'member'; }
});

test('reservation principal rejects foreign, suspended and inactive native companies and unauthenticated access', async () => {
  assert.equal((await principal('pg:78')).status, 403);
  assert.equal((await principal('pg:77', null)).status, 401);
  assert.equal((await principal(null)).status, 400);
  fixture.state.memberships[0].status = 'suspended';
  try { assert.equal((await principal('pg:77')).status, 403); }
  finally { fixture.state.memberships[0].status = 'active'; }
  fixture.state.companies[0].is_active = false;
  try { assert.equal((await principal('pg:77')).status, 403); }
  finally { fixture.state.companies[0].is_active = true; }
});

test('reservation principal preserves legacy tenant membership and rejects PG company selection by a legacy session', async () => {
  const owner = await createOwnerOrg(server.baseUrl, ['assets']);
  const original = await api(server.baseUrl, '/auth/principal', owner);
  const response = await principal(owner.orgId, owner.token);
  assert.equal(response.status, 200); assert.deepEqual(response.body, original.body);
  assert.equal((await principal('pg:77', owner.token)).status, 401);
});
