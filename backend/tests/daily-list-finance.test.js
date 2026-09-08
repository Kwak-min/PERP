import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { api, startTestServer } from './http.js';
import { installDailyListFixture } from './daily-list-fixture.js';

process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
let server, fixture, session;
before(async () => {
  server = await startTestServer(); fixture = await installDailyListFixture();
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.identity.users[0].email, password: 'password-1234' } });
  assert.equal(login.status, 200);
  session = { token: login.body.token, orgId: 'pg:77' };
});
beforeEach(() => fixture.seed());
after(async () => { await fixture?.close(); await server?.close(); });
const request = (route, method, body, key) => api(server.baseUrl, '/pg' + route, { ...session, method, body, ...(key ? { headers: { 'Idempotency-Key': key } } : {}) });

test('list fixture executes budget versions and audit in the actual generic transaction boundary', async () => {
  const before = fixture.snapshot();
  for (const method of ['PATCH', 'DELETE']) {
    const body = { expected_version: 1, ...(method === 'PATCH' ? { name: 'Changed', amount: '10.01' } : {}) };
    fixture.failAudit = true;
    assert.equal((await request('/records/budgets/23', method, body)).status, 500);
    assert.deepEqual(fixture.snapshot(), before);
    assert.deepEqual(fixture.events(), []);
    fixture.failAudit = false;
  }
  assert.equal((await request('/records/budgets/23', 'PATCH', { name: 'Changed', expected_version: 1 })).status, 200);
  const updated = fixture.snapshot(), events = fixture.events();
  assert.equal(updated.find(row => row.id === 23).version, 2);
  assert.equal(events.length, 1);
  assert.equal((await request('/records/budgets/23', 'DELETE', { expected_version: 1 })).status, 409);
  assert.deepEqual(fixture.snapshot(), updated); assert.deepEqual(fixture.events(), events);
  assert.equal((await request('/records/budgets/23', 'DELETE', { expected_version: 2 })).status, 200);
  assert.equal(fixture.events().length, 2);
  assert.deepEqual(fixture.snapshot(), before.filter(row => row.id !== 23));
});

test('list fixture retains budget creation replay and rejects changed payload without another row', async () => {
  const body = { name: 'Replay budget', amount: '15.01' };
  const created = await request('/finance/budgets', 'POST', body, 'list-budget-replay');
  assert.equal(created.status, 201);
  const snapshot = fixture.snapshot();
  const replay = await request('/finance/budgets', 'POST', body, 'list-budget-replay');
  assert.equal(replay.status, 201); assert.deepEqual(replay.body, created.body);
  assert.equal((await request('/finance/budgets', 'POST', { ...body, amount: '20.01' }, 'list-budget-replay')).status, 409);
  assert.deepEqual(fixture.snapshot(), snapshot);
  assert.equal(fixture.identity.state.replays.length, 1);
});
