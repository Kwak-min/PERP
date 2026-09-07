const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { access } = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:1/never_connect';
const { prisma } = require('../src/lib/prisma');
const app = require('../src/app').default;
const originalAuthority = process.env.ERP_API_URL;
const originals = [prisma.space.findFirst, prisma.reservation.findFirst, prisma.reservation.create, prisma.reservation.update];
const actors = {};
const bookings = [];
let erp, server, base, api, pool, originalQuery, databaseRoot;
let scope;
let dataCalls = 0;

before(async () => {
  const helpers = await import('../../../backend/tests/http.js');
  api = helpers.api;
  erp = await helpers.startTestServer();
  databaseRoot = path.dirname(process.env.ORBITFLOW_DATABASE_FILE);
  pool = (await import('../../../backend/src/config/pg.js')).pgPool;
  originalQuery = pool.query;
  const pgToken = randomUUID();
  const pgEmail = 'pg-admin-reservation@example.com';
  // PG 저장 경계만 대체한다. 브리지와 실제 SQLite 소속/RBAC/HTTP principal은 유지한다.
  pool.query = async (sql, values) => {
    assert.match(sql, /FROM auth\.sessions s/);
    return { rows: values[0] === pgToken ? [{
      session_id: 'pg-session', id: '9001', email: pgEmail, name: 'PG admin',
      is_admin: true, company_id: '77', account_status: 'active', approval_status: 'approved',
      login_at: new Date().toISOString(),
    }] : [] };
  };
  actors.owner = await helpers.createOwnerOrg(erp.baseUrl, ['assets']);
  for (const [label, role] of [['member', 'member'], ['guest', 'guest'], ['pgAdmin', 'guest']]) {
    const email = label === 'pgAdmin' ? pgEmail : `${label}-${randomUUID()}@example.com`;
    const invite = await api(erp.baseUrl, '/members/invites', {
      ...actors.owner, method: 'POST', body: { email, roles: [role] },
    });
    assert.equal(invite.status, 201);
    let token = pgToken;
    if (label !== 'pgAdmin') {
      const signup = await api(erp.baseUrl, '/auth/signup', {
        method: 'POST', body: { email, name: label, password: 'reservation-password-1234' },
      });
      assert.equal(signup.status, 201);
      token = signup.body.access_token;
    }
    const accepted = await api(erp.baseUrl, '/auth/invitations/accept', {
      token, method: 'POST', body: { token: invite.body.token },
    });
    assert.equal(accepted.status, 201);
    actors[label] = { token, orgId: actors.owner.orgId };
  }
  for (const actor of Object.values(actors)) {
    const response = await api(erp.baseUrl, '/auth/principal', actor);
    assert.equal(response.status, 200);
    actor.principal = response.body;
  }
  scope = { tenantId: actors.owner.principal.tenantId, orgId: actors.owner.orgId };
  process.env.ERP_API_URL = erp.baseUrl;
  // 인증/컨트롤러/서비스는 실제 실행하고 Prisma 저장 경계에 조직별 기록을 보관한다.
  prisma.space.findFirst = async ({ where }) => {
    dataCalls++;
    assert.deepEqual(where, { id: 1, ...scope, isActive: true });
    return { id: 1, ...scope, name: 'Fixture' };
  };
  prisma.reservation.findFirst = async ({ where }) => {
    dataCalls++;
    assert.equal(where.tenantId, scope.tenantId);
    assert.equal(where.orgId, scope.orgId);
    return bookings.find(row => row.tenantId === where.tenantId && row.orgId === where.orgId &&
      (typeof where.id === 'number' ? row.id === where.id :
        row.spaceId === where.spaceId && row.status === where.status &&
        row.startTime < where.startTime.lt && row.endTime > where.endTime.gt)) ?? null;
  };
  prisma.reservation.create = async ({ data }) => {
    dataCalls++;
    const row = { id: bookings.length + 1, status: 'CONFIRMED', ...data };
    bookings.push(row);
    return row;
  };
  prisma.reservation.update = async ({ where, data }) => {
    dataCalls++;
    const row = bookings.find(row => row.id === where.id);
    assert.ok(row);
    Object.assign(row, data);
    return row;
  };
  server = http.createServer(app);
  const ready = once(server, 'listening', { signal: AbortSignal.timeout(3000) });
  server.listen(0, '127.0.0.1');
  await ready;
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

beforeEach(() => { bookings.length = 0; dataCalls = 0; });
after(async () => {
  [prisma.space.findFirst, prisma.reservation.findFirst, prisma.reservation.create, prisma.reservation.update] = originals;
  if (originalAuthority === undefined) delete process.env.ERP_API_URL;
  else process.env.ERP_API_URL = originalAuthority;
  if (server?.listening) {
    const closed = once(server, 'close', { signal: AbortSignal.timeout(3000) });
    server.close();
    await closed;
  }
  if (pool) { pool.query = originalQuery; await pool.end(); }
  if (erp) {
    await erp.close();
    await assert.rejects(access(databaseRoot), { code: 'ENOENT' });
  }
  await prisma.$disconnect();
});

const booking = { spaceId: 1, title: 'Fixture', startTime: '2030-01-01T09:00:00Z', endTime: '2030-01-01T10:00:00Z' };
async function request(actor, route, method, body, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method, signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

for (const label of ['owner', 'member']) {
  test(`real ERP ${label} principal can create and update its reservation`, async () => {
    const actor = actors[label];
    if (label === 'owner') assert.deepEqual(actor.principal.permissions, ['*']);
    else {
      assert.ok(actor.principal.permissions.includes('reservation.create'));
      assert.ok(!actor.principal.permissions.includes('*'));
    }
    const created = await request(actor, '/reservations', 'POST', booking);
    assert.equal(created.status, 201);
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].ownerId, actor.principal.userId);
    assert.equal(bookings[0].tenantId, scope.tenantId);
    assert.equal(bookings[0].orgId, scope.orgId);
    const updated = await request(actor, `/reservations/${created.body.data[0].id}`, 'PATCH', { title: 'Updated' });
    assert.equal(updated.status, 200);
    assert.equal(bookings[0].title, 'Updated');
    assert.equal(updated.body.data.ownerId, actor.principal.userId);
  });
}

for (const label of ['guest', 'pgAdmin']) {
  test(`real ERP ${label} principal cannot mutate reservations, even with client wildcard/admin headers`, async () => {
    const actor = actors[label];
    assert.deepEqual(actor.principal.roles, ['guest']);
    assert.ok(!actor.principal.permissions.includes('*'));
    assert.ok(!actor.principal.permissions.includes('reservation.create'));
    for (const [route, method, body] of [
      ['/reservations', 'POST', booking], ['/reservations/1', 'PATCH', { title: 'Denied' }], ['/reservations/1', 'DELETE'],
    ]) {
      const result = await request(actor, route, method, body, {
        'X-Permissions': '*', 'X-Roles': 'owner', 'X-Is-Admin': 'true',
      });
      assert.equal(result.status, 403);
    }
    assert.equal(dataCalls, 0);
    assert.deepEqual(bookings, []);
  });
}

for (const spoof of [{ userId: 999 }, { ownerId: 'forged' }, { permissions: ['*'] }, { is_admin: true }]) {
  test(`reservation HTTP input rejects spoofed ${Object.keys(spoof)[0]}`, async () => {
    const result = await request(actors.owner, '/reservations', 'POST', { ...booking, ...spoof });
    assert.equal(result.status, 400);
    assert.equal(dataCalls, 0);
  });
}

test('a wildcard token and a foreign organization cannot forge ERP reservation authority', async () => {
  const invalid = await request({ ...actors.owner, token: '*' }, '/reservations', 'POST', booking);
  assert.equal(invalid.status, 401);
  const foreign = await request({ ...actors.owner, orgId: randomUUID() }, '/reservations', 'POST', booking);
  assert.equal(foreign.status, 403);
  assert.equal(dataCalls, 0);
});
