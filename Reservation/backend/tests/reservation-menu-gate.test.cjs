const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { access } = require('node:fs/promises');
const path = require('node:path');
const { startSpaceFixture } = require('./space-fixture.cjs');

process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
const actions = ['reservation.create', 'reservation.manage'];
const grants = [...actions, 'menu.reservations'];
const room = { name: 'Menu gate room', location: 'Fixture', capacity: 2 };
const booking = { spaceId: 1, title: 'Menu gate booking', startTime: '2030-01-01T09:00:00Z', endTime: '2030-01-01T10:00:00Z' };
const routes = [
  ['GET', '/spaces'], ['GET', '/spaces/1'],
  ['GET', '/spaces?startTime=2030-01-01T09:00:00Z&endTime=2030-01-01T10:00:00Z'],
  ['GET', '/reservations'], ['GET', '/reservations?mine=true'], ['GET', '/reservations/1'],
  ['GET', '/reservations/timetable?spaceId=1&date=2030-01-01'],
  ['GET', '/reservations/1/attendees'], ['GET', '/waitlist'],
  ['POST', '/spaces', room], ['POST', '/spaces/test-spaces', {}],
  ['PATCH', '/spaces/1', { capacity: 3 }], ['DELETE', '/spaces/1'],
  ['POST', '/reservations', booking], ['PATCH', '/reservations/1', { title: 'Changed' }], ['DELETE', '/reservations/1'],
  ['POST', '/reservations/1/attendees', { email: 'invite@example.invalid', name: 'Invite' }],
  ['DELETE', '/reservations/1/attendees/1'], ['POST', '/waitlist', booking], ['DELETE', '/waitlist/1'],
];
let erp, pg, reservation, api, databaseRoot, prisma;
const actors = {};
before(async () => {
  const helpers = await import('../../../backend/tests/http.js');
  api = helpers.api;
  erp = await helpers.startTestServer();
  databaseRoot = path.dirname(process.env.ORBITFLOW_DATABASE_FILE);
  pg = await (await import('../../../backend/tests/pg-company-fixture.js')).installCompanyFixture();
  const login = await api(erp.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: pg.users[0].email, password: 'password-1234' } });
  assert.equal(login.status, 200);
  const company = await api(erp.baseUrl, '/pg/companies', { token: login.body.token, method: 'POST', body: { name: 'Menu gate company', modules: ['assets'] } });
  assert.equal(company.status, 201);
  const nativeOwner = { token: login.body.token, orgId: company.body.org_id };
  const legacyOwner = await helpers.createOwnerOrg(erp.baseUrl, ['assets']);
  for (const [source, owner] of [['legacy', legacyOwner], ['PG', nativeOwner]]) {
    const roles = {};
    for (const [kind, permissions] of [['actionOnly', actions], ['full', grants], ['menuOnly', ['menu.reservations']]]) {
      const role = await api(erp.baseUrl, '/settings/roles', { ...owner, method: 'POST', body: { name: `${source} ${kind}`, scope: 'all', permissions } });
      assert.equal(role.status, 201); roles[kind] = role.body.key;
      if (source === 'PG') {
        assert.deepEqual(pg.state.permissions.filter(p => p.role_id === role.body.key).map(p => p.code), [...permissions, 'menu.configured']);
      }
    }
    const email = `menu-gate-${randomUUID()}@example.invalid`;
    let member, memberId;
    if (source === 'PG') {
      const created = await api(erp.baseUrl, '/pg/members', { ...owner, method: 'POST', body: { email, name: 'Menu delegate', password: 'password-1234' } });
      assert.equal(created.status, 201); memberId = created.body.id;
      const signedIn = await api(erp.baseUrl, '/pg/auth/login', { method: 'POST', body: { email, password: 'password-1234' } });
      assert.equal(signedIn.status, 200); member = { token: signedIn.body.token, orgId: owner.orgId };
    } else {
      const invitation = await api(erp.baseUrl, '/members/invites', { ...owner, method: 'POST', body: { email, roles: [roles.actionOnly] } });
      assert.equal(invitation.status, 201);
      const signup = await api(erp.baseUrl, '/auth/signup', { method: 'POST', body: { email, name: 'Menu delegate', password: 'password-1234', invitation_token: invitation.body.token } });
      assert.equal(signup.status, 201); member = { token: signup.body.access_token, orgId: owner.orgId };
      const principal = await api(erp.baseUrl, '/auth/principal', member);
      assert.equal(principal.status, 200); memberId = principal.body.membershipId;
    }
    actors[source] = { owner, member, memberId, roles };
    await assign(actors[source], 'actionOnly');
  }
  reservation = await startSpaceFixture(erp.baseUrl);
  prisma = require('../src/lib/prisma').prisma;
});
after(async () => {
  await reservation?.close(); await pg?.close(); await erp?.close();
  if (databaseRoot) await assert.rejects(access(databaseRoot), { code: 'ENOENT' });
});
async function assign(actor, kind) {
  const changed = await api(erp.baseUrl, `/settings/members/${actor.memberId}/roles`, { ...actor.owner, method: 'PUT', body: { roles: [actor.roles[kind]] } });
  assert.equal(changed.status, 200);
}
async function request(actor, method, route, body, headers = {}) {
  const response = await fetch(`${reservation.baseUrl}/api/v1${route}`, {
    method, signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function deniedBeforeDatabase(actor) {
  // 모든 데이터 접근을 감시한다. 인증/역할/라우터/서비스는 실제 실행하며 DB 우회 시 실패한다.
  const calls = [];
  const watches = [];
  for (const [model, methods] of Object.entries({
    space: ['findMany', 'findFirst', 'create', 'update'],
    reservation: ['findMany', 'findFirst', 'create', 'update', 'updateMany'],
    attendee: ['findMany', 'findUnique', 'create', 'update', 'delete'],
    waitlist: ['findMany', 'findFirst', 'count', 'create', 'delete'],
    recurrenceRule: ['create'],
  })) {
    for (const method of methods) {
      const original = prisma[model][method];
      watches.push(() => { prisma[model][method] = original; });
      prisma[model][method] = async () => {
        calls.push(`${model}.${method}`); throw new Error(`Menu denial reached Prisma: ${model}.${method}`);
      };
    }
  }
  const transaction = prisma.$transaction;
  watches.push(() => { prisma.$transaction = transaction; });
  prisma.$transaction = async () => { calls.push('$transaction'); throw new Error('Menu denial reached Prisma transaction'); };
  try {
    const results = [];
    for (const [method, route, body] of routes) {
      const response = await request(actor, method, route, body, { 'X-Permissions': '*', 'X-Roles': 'owner', 'X-Is-Admin': 'true', 'X-Menu-Permissions': 'menu.reservations' });
      results.push([method, route, response.status]);
    }
    assert.deepEqual({ results, calls }, { results: routes.map(([method, route]) => [method, route, 403]), calls: [] });
  } finally { for (const restore of watches) restore(); }
}
for (const source of ['legacy', 'PG']) {
  test(`${source} HTTP-created action-only custom role has no menu and cannot reach any authenticated Reservation data route`, async () => {
    const actor = actors[source];
    await assign(actor, 'actionOnly');
    const access = await api(erp.baseUrl, '/settings/access', actor.member);
    assert.equal(access.status, 200);
    assert.deepEqual(access.body.menus, []);
    assert.deepEqual(access.body.permissions, [...actions].sort());
    assert.ok(access.body.modules.includes('assets'));
    await deniedBeforeDatabase(actor.member);
    assert.equal((await api(erp.baseUrl, '/auth/reservation-principal', actor.member)).status, 403);
  });
  test(`${source} effective menu revocation denies the next request with the same token; restoring it restores access`, async () => {
    const actor = actors[source];
    await assign(actor, 'full');
    assert.equal((await request(actor.member, 'GET', '/spaces')).status, 200);
    assert.equal((await request(actor.member, 'POST', '/spaces', room)).status, 201);
    assert.equal((await request(actor.member, 'POST', '/spaces/test-spaces', {})).status, 200);
    await assign(actor, 'actionOnly');
    try { await deniedBeforeDatabase(actor.member); }
    finally { await assign(actor, 'full'); }
    assert.equal((await request(actor.member, 'GET', '/spaces')).status, 200);
    assert.equal((await request(actor.member, 'POST', '/spaces', room)).status, 201);
  });
  test(`${source} menu-only custom role can read but cannot mutate; menu does not replace action authority`, async () => {
    const actor = actors[source];
    await assign(actor, 'menuOnly');
    try {
      assert.equal((await request(actor.member, 'GET', '/spaces')).status, 200);
      const calls = reservation.calls.length;
      for (const [method, route, body] of routes.filter(([method]) => method !== 'GET')) {
        assert.equal((await request(actor.member, method, route, body)).status, 403, `${method} ${route}`);
      }
      assert.equal(reservation.calls.length, calls);
    } finally { await assign(actor, 'full'); }
  });
  test(`${source} legitimate company creator/owner retains space reads, creation and test-space bootstrap`, async () => {
    const actor = actors[source].owner;
    const principal = await api(erp.baseUrl, '/auth/reservation-principal', actor);
    assert.equal(principal.status, 200);
    if (source === 'legacy') assert.ok(principal.body.permissions.includes('*'));
    else assert.ok(!principal.body.permissions.some(p => p === '*' || p.startsWith('platform.')));
    assert.equal((await request(actor, 'GET', '/spaces')).status, 200);
    assert.equal((await request(actor, 'POST', '/spaces', room)).status, 201);
    assert.equal((await request(actor, 'POST', '/spaces/test-spaces', {})).status, 200);
  });
}
