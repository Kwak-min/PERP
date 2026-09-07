const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startSpaceFixture } = require('./space-fixture.cjs');

process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
let erp, pg, reservation, api, creator, outsider, creatorPermissions;
const reservationGrants = ['reservation.create', 'reservation.manage', 'menu.reservations'];
before(async () => {
  const helpers = await import('../../../backend/tests/http.js');
  api = helpers.api;
  erp = await helpers.startTestServer();
  pg = await (await import('../../../backend/tests/pg-company-fixture.js')).installCompanyFixture();
  creatorPermissions = (await import('../../../backend/src/middleware/pgAccess.js')).PG_CREATOR_PERMISSIONS;
  pg.users[0].is_admin = false;
  async function login(user) {
    const response = await api(erp.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: user.email, password: 'password-1234' } });
    assert.equal(response.status, 200); return response.body.token;
  }
  const token = await login(pg.users[0]);
  const created = await api(erp.baseUrl, '/pg/companies', { token, method: 'POST', body: { name: 'Native reservation creator', modules: ['assets'] } });
  assert.equal(created.status, 201);
  creator = { token, orgId: created.body.org_id };
  outsider = { token: await login(pg.users[1]), orgId: creator.orgId };
  reservation = await startSpaceFixture(erp.baseUrl);
});
after(async () => { await reservation?.close(); await pg?.close(); await erp?.close(); });
async function space(actor, suffix = '', method = 'POST', body = { name: 'Creator room', location: 'Here', capacity: 2 }) {
  const response = await fetch(`${reservation.baseUrl}/api/v1/spaces${suffix}`, {
    method, signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId, 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test('native company creation grants exactly its finite SQL permission list and exposes reservation menu/create/manage without is_admin', async () => {
  const { COMPANY_PERMISSIONS } = await import('../../../backend/src/config/rbac.js');
  assert.deepEqual(creatorPermissions, COMPANY_PERMISSIONS);
  const role = pg.state.roles.find(r => r.company_id === creator.orgId.slice(3));
  assert.deepEqual(pg.state.permissions.filter(p => p.role_id === role.id).map(p => p.code), creatorPermissions);
  const write = pg.queries.find(q => q.sql.startsWith('INSERT INTO org.role_permissions') && q.values[0] === role.id);
  assert.deepEqual(write.values[1], creatorPermissions);
  assert.equal(pg.users[0].is_admin, false);
  const principal = await api(erp.baseUrl, '/auth/reservation-principal', creator);
  assert.equal(principal.status, 200);
  assert.equal(principal.body.orgId, creator.orgId);
  assert.deepEqual(principal.body.roles, ['company_creator']);
  assert.deepEqual(principal.body.permissions, [...creatorPermissions].sort());
  assert.ok(principal.body.modules.includes('assets'));
  assert.ok(!principal.body.permissions.some(p => p === '*' || p.startsWith('platform.')));
  const access = await api(erp.baseUrl, '/settings/access', creator);
  assert.equal(access.status, 200);
  assert.ok(access.body.menus.includes('menu.reservations'));
  for (const code of reservationGrants) assert.ok(access.body.permissions.includes(code), code);
  const roles = await api(erp.baseUrl, '/settings/roles', creator);
  assert.equal(roles.status, 200);
  for (const code of reservationGrants) assert.ok(roles.body.grantable.includes(code), code);
});

test('actual reservation space HTTP accepts the native creator and rejects unrelated company, missing membership and missing manage', async () => {
  const created = await space(creator);
  assert.equal(created.status, 201);
  assert.equal(created.body.data.orgId, creator.orgId);
  assert.equal(created.body.data.tenantId, creator.orgId);
  assert.equal((await space(creator, `/${created.body.data.id}`, 'PATCH', { capacity: 3 })).status, 200);
  const seeded = await space(creator, '/test-spaces', 'POST', {});
  assert.equal(seeded.status, 200); assert.equal(seeded.body.data.createdCount, 5);
  const other = await reservation.insert({ tenantId: 'pg:77', orgId: 'pg:77', name: 'Other company', location: 'Elsewhere', capacity: 1 });
  assert.equal((await space(creator, `/${other.id}`, 'PATCH', { capacity: 8 })).status, 404);
  const before = structuredClone(reservation.rows);
  for (const actor of [outsider, { ...creator, orgId: 'pg:999' }, { ...creator, orgId: 'pg:77' }]) {
    assert.equal((await space(actor)).status, 403);
  }
  assert.equal((await api(erp.baseUrl, '/auth/reservation-principal', outsider)).status, 403);
  const membership = pg.state.memberships.find(m => m.company_id === creator.orgId.slice(3));
  membership.status = 'suspended';
  try {
    assert.equal((await space(creator)).status, 403);
    assert.equal((await api(erp.baseUrl, '/auth/reservation-principal', creator)).status, 403);
  } finally { membership.status = 'active'; }
  const permissions = pg.state.permissions;
  const role = pg.state.roles.find(r => r.company_id === creator.orgId.slice(3));
  pg.state.permissions = permissions.filter(p => p.role_id !== role.id || p.code !== 'reservation.manage');
  try {
    assert.equal((await space(creator)).status, 403);
    assert.equal((await space(creator, '/test-spaces', 'POST', {})).status, 403);
  } finally { pg.state.permissions = permissions; }
  assert.deepEqual(reservation.rows, before);
  assert.deepEqual(pg.state.permissions.filter(p => p.role_id === '1'), [{ role_id: '1', code: 'task.read' }]);
});

test('native creator delegates only owned reservation grants via actual role creation/assignment HTTP', async () => {
  const created = await api(erp.baseUrl, '/settings/roles', { ...creator, method: 'POST', body: { name: '예약 담당자', scope: 'all', permissions: reservationGrants } });
  assert.equal(created.status, 201);
  const member = await api(erp.baseUrl, '/pg/members', { ...creator, method: 'POST', body: { email: 'creator-delegate@example.invalid', name: '예약 담당자', password: 'password-1234' } });
  assert.equal(member.status, 201);
  const assigned = await api(erp.baseUrl, `/settings/members/${member.body.id}/roles`, { ...creator, method: 'PUT', body: { roles: [created.body.key] } });
  assert.equal(assigned.status, 200);
  const login = await api(erp.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: 'creator-delegate@example.invalid', password: 'password-1234' } });
  assert.equal(login.status, 200);
  const delegate = { token: login.body.token, orgId: creator.orgId };
  const principal = await api(erp.baseUrl, '/auth/reservation-principal', delegate);
  assert.equal(principal.status, 200);
  assert.deepEqual(principal.body.permissions, [...reservationGrants].sort());
  assert.equal((await space(delegate)).status, 201);
  const analytics = await api(erp.baseUrl, '/settings/roles', { ...creator, method: 'POST', body: { name: 'Analytics delegate', permissions: ['analytics.read'] } });
  assert.equal(analytics.status, 201);
  assert.deepEqual(analytics.body.permissions, ['analytics.read']);
  for (const permissions of [['*'], ['platform.tenants']]) {
    const denied = await api(erp.baseUrl, '/settings/roles', { ...creator, method: 'POST', body: { name: 'Denied escalation', permissions } });
    assert.equal(denied.status, 400);
  }
  assert.equal((await api(erp.baseUrl, '/settings/roles', { ...delegate, method: 'POST', body: { name: 'Denied delegation', permissions: reservationGrants } })).status, 403);
});
