const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { access } = require('node:fs/promises');
const path = require('node:path');
const { startSpaceFixture } = require('./space-fixture.cjs');

process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
let erp, pg, reservation, api, owner, member, customRole, databaseRoot, native;
const grants = ['reservation.manage', 'menu.reservations'];
before(async () => {
  const helpers = await import('../../../backend/tests/http.js');
  api = helpers.api;
  erp = await helpers.startTestServer();
  databaseRoot = path.dirname(process.env.ORBITFLOW_DATABASE_FILE);
  pg = await (await import('../../../backend/tests/pg-company-fixture.js')).installCompanyFixture();
  // PG 엔진이 없는 환경에서 SQL 경계만 대체하며 실제 ERP 인증/권한 해석은 실행한다.
  pg.state.roles[0].name = 'Facilities coordinator';
  pg.state.permissions = grants.map(code => ({ role_id: '1', code }));
  pg.state.modules.push({ company_id: '77', module_key: 'assets' });
  const login = await api(erp.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: pg.users[0].email, password: 'password-1234' } });
  assert.equal(login.status, 200);
  native = { token: login.body.token, orgId: 'pg:77' };
  owner = await helpers.createOwnerOrg(erp.baseUrl, ['assets']);
  const created = await api(erp.baseUrl, '/settings/roles', { ...owner, method: 'POST', body: { name: '시설 담당자', scope: 'all', permissions: grants } });
  assert.equal(created.status, 201); customRole = created.body.key;
  const email = `facilities-${randomUUID()}@example.invalid`;
  const invitation = await api(erp.baseUrl, '/members/invites', { ...owner, method: 'POST', body: { email, roles: [customRole] } });
  assert.equal(invitation.status, 201);
  const signup = await api(erp.baseUrl, '/auth/signup', { method: 'POST', body: { email, name: '시설 담당자', password: 'password-1234', invitation_token: invitation.body.token } });
  assert.equal(signup.status, 201);
  member = { token: signup.body.access_token, orgId: owner.orgId };
  reservation = await startSpaceFixture(erp.baseUrl);
});
after(async () => {
  await reservation?.close(); await pg?.close(); await erp?.close();
  if (databaseRoot) await assert.rejects(access(databaseRoot), { code: 'ENOENT' });
});
async function request(actor, suffix = '', method = 'POST', body = { name: 'Scoped room', location: 'Here', capacity: 2 }, headers = {}) {
  const response = await fetch(`${reservation.baseUrl}/api/v1/spaces${suffix}`, {
    method, signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId, 'Content-Type': 'application/json', ...headers },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
for (const source of ['legacy', 'PG']) {
  test(`Given ${source} custom grants, when managing spaces over real HTTP, then role names are irrelevant`, async () => {
    const actor = source === 'legacy' ? member : native;
    const principal = await api(erp.baseUrl, '/auth/reservation-principal', actor);
    assert.equal(principal.status, 200);
    assert.deepEqual(principal.body.permissions, [...grants].sort());
    assert.ok(!principal.body.roles.some(role => ['owner', 'org_admin'].includes(role)));
    const created = await request(actor);
    assert.equal(created.status, 201);
    assert.equal(created.body.data.orgId, actor.orgId);
    assert.equal(created.body.data.tenantId, principal.body.tenantId);
    assert.equal((await request(actor, `/${created.body.data.id}`, 'PATCH', { capacity: 3 })).status, 200);
    assert.equal((await request(actor, '/test-spaces', 'POST', {})).status, 200);
    assert.equal((await request(actor, `/${created.body.data.id}`, 'DELETE', {})).status, 200);
  });
}
test('Given trusted legacy wildcard owner, when creating a space, then creation remains allowed', async () => {
  const { permissionsFor } = await import('../../../backend/src/config/rbac.js');
  assert.deepEqual((await api(erp.baseUrl, '/auth/reservation-principal', owner)).body.permissions, [...permissionsFor(['owner'])].sort());
  assert.equal((await request(owner)).status, 201);
});
test('Given a custom role changed to a misleading admin name without manage, when reusing the same token, then every mutation is denied', async () => {
  const route = `/settings/roles/${customRole}`;
  const changed = await api(erp.baseUrl, route, { ...owner, method: 'PATCH', body: { name: 'super_admin', scope: 'all', permissions: ['menu.reservations'] } });
  assert.equal(changed.status, 200);
  try {
    const principal = await api(erp.baseUrl, '/auth/reservation-principal', member);
    assert.deepEqual(principal.body.permissions, ['menu.reservations']);
    const before = reservation.calls.length;
    for (const [suffix, method, body] of [['', 'POST', { name: 'Denied', location: 'Here', capacity: 1 }], ['/test-spaces', 'POST', {}], ['/1', 'PATCH', { capacity: 4 }], ['/1', 'DELETE', {}]]) {
      assert.equal((await request(member, suffix, method, body, { 'X-Permissions': '*', 'X-Roles': 'owner', 'X-Is-Admin': 'true' })).status, 403);
    }
    assert.equal(reservation.calls.length, before);
  } finally {
    assert.equal((await api(erp.baseUrl, route, { ...owner, method: 'PATCH', body: { name: '시설 담당자', scope: 'all', permissions: grants } })).status, 200);
  }
});
test('Given PG role named org_admin without manage or with untrusted wildcard, when reusing the token, then no cached authority survives', async () => {
  const permissions = pg.state.permissions;
  const name = pg.state.roles[0].name;
  pg.state.roles[0].name = 'org_admin';
  try {
    for (const codes of [['menu.reservations'], ['*', 'platform.tenants', 'menu.reservations']]) {
      pg.state.permissions = codes.map(code => ({ role_id: '1', code }));
      assert.deepEqual((await api(erp.baseUrl, '/auth/reservation-principal', native)).body.permissions, ['menu.reservations']);
      const before = reservation.calls.length;
      assert.equal((await request(native)).status, 403);
      assert.equal((await request(native, '/test-spaces', 'POST', {})).status, 403);
      assert.equal(reservation.calls.length, before);
    }
  } finally { pg.state.permissions = permissions; pg.state.roles[0].name = name; }
});
test('Given verified manage, when spoofing selected organization or body scope, then foreign authority and row mutations are denied', async () => {
  const foreign = await reservation.insert({ tenantId: 'foreign-tenant', orgId: member.orgId, name: 'Other tenant', location: 'Foreign', capacity: 1 });
  const before = structuredClone(reservation.rows);
  assert.equal((await request({ ...native, orgId: 'pg:78' })).status, 403);
  assert.equal((await request({ ...member, orgId: randomUUID() })).status, 403);
  assert.equal((await request({ ...member, token: '*' })).status, 401);
  for (const spoof of [{ tenantId: 'foreign-tenant' }, { orgId: 'pg:77' }, { permissions: ['*'] }, { roles: ['owner'] }]) {
    assert.equal((await request(member, '', 'POST', { name: 'Spoof', location: 'Here', capacity: 1, ...spoof })).status, 400);
    assert.equal((await request(member, '/test-spaces', 'POST', spoof)).status, 400);
  }
  for (const method of ['GET', 'PATCH', 'DELETE']) assert.equal((await request(member, `/${foreign.id}`, method, { capacity: 5 })).status, 404);
  assert.deepEqual(reservation.rows, before);
});
test('Given a previously authorized PG token, when assets or active membership is removed, then the next mutation is denied', async () => {
  const modules = pg.state.modules;
  const before = reservation.calls.length;
  try {
    pg.state.modules = [];
    assert.equal((await request(native)).status, 403);
    pg.state.modules = modules;
    pg.state.memberships[0].status = 'suspended';
    assert.equal((await request(native)).status, 403);
    assert.equal(reservation.calls.length, before);
  } finally { pg.state.modules = modules; pg.state.memberships[0].status = 'active'; }
});
