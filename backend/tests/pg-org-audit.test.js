import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { api, startTestServer } from './http.js';
import { installCompanyFixture } from './pg-company-fixture.js';

// SQL 경계 회귀 검사. 잠금/트리거 검증은 pg-org-audit.integration.mjs의 실제 PG에서 수행한다.
process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
let fixture, server, session;
before(async () => {
  server = await startTestServer(); fixture = await installCompanyFixture();
  fixture.state.permissions.push(...['member.read', 'department.write', 'audit.read', 'menu.members'].map(code => ({ role_id: '1', code })));
  for (const id of ['103', '104']) {
    fixture.state.users.push({ ...fixture.users[0], id, name: `F8 ${id}`, email: `${id}@example.invalid` });
    fixture.state.memberships.push({ company_id: '77', user_id: id, department_id: null, position_id: null, status: 'active' });
  }
  fixture.state.departments.push({ id: '901', company_id: '77', name: 'F8 seat', parent_id: null, manager_id: null });
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.users[0].email, password: 'password-1234' } });
  assert.equal(login.status, 200); session = { token: login.body.token, orgId: 'pg:77' };
});
after(async () => { await fixture?.close(); await server?.close(); });
const call = (path, body) => api(server.baseUrl, `/pg/members${path}`, { ...session, ...(body ? { method: 'PATCH', body } : {}) });

test('seat stores manager and two assignments with scoped audit, then rejects a stale draft', async () => {
  const chart = await call('/org-chart'); assert.equal(chart.status, 200);
  const body = { expected_revision: chart.body.revision, leader_id: '101', assigned: ['103', '104'] };
  const saved = await call('/departments/901/seat', body); assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal(fixture.state.departments[0].manager_id, '101');
  assert.deepEqual(fixture.state.memberships.slice(1).map(m => m.department_id), ['901', '901']);
  const activity = await call('/activity'); assert.equal(activity.status, 200); assert.equal(activity.body.items.length, 3);
  assert.ok(activity.body.items.every(e => e.actor_id === '101' && e.actor_kind === 'user' && e.before && e.after && e.request_id));
  assert.equal((await call('/activity?member_id=103')).body.items.length, 1);
  const state = structuredClone(fixture.state);
  assert.equal((await call('/departments/901/seat', body)).status, 409);
  assert.deepEqual(fixture.state, state);
});

test('foreign and malformed IDs are denied before writes and never throw a parser 500', async () => {
  const revision = (await call('/org-chart')).body.revision;
  for (const bad of ['102', 'foreign', '0', '9223372036854775808']) {
    const start = fixture.queries.length;
    const result = await call('/departments/901/seat', { expected_revision: revision, leader_id: '101', assigned: ['103', bad] });
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.ok(!fixture.queries.slice(start).some(q => /^(UPDATE|INSERT|DELETE)/.test(q.sql)));
  }
  assert.equal((await call('/activity?limit=0')).status, 400);
  assert.equal((await call('/activity?member_id=foreign')).status, 400);
});

test('menu and action grants remain independent for activity and seat writes', async () => {
  fixture.state.permissions.push({ role_id: '1', code: 'menu.configured' });
  const removed = fixture.state.permissions.findIndex(p => p.code === 'menu.members');
  const [menu] = fixture.state.permissions.splice(removed, 1);
  try { assert.equal((await call('/activity')).status, 403); }
  finally { fixture.state.permissions.push(menu); }
  const index = fixture.state.permissions.findIndex(p => p.code === 'audit.read');
  const [permission] = fixture.state.permissions.splice(index, 1);
  try { assert.equal((await call('/activity')).status, 403); }
  finally { fixture.state.permissions.push(permission); }
});
