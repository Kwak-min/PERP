const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { startSpaceFixture } = require('./space-fixture.cjs');
let authority, fixture;
before(async () => {
  authority = http.createServer((req, res) => {
    if (req.url !== '/auth/reservation-principal') return res.writeHead(404).end();
    const role = req.headers.authorization?.replace(/^Bearer /, '');
    const orgId = req.headers['x-org-id'];
    if (!role) return res.writeHead(401).end();
    if (!['org-a', 'org-b', 'org-failure'].includes(orgId)) return res.writeHead(403).end();
    res.setHeader('content-type', 'application/json');
    const permissions = role === 'owner' ? ['*'] : ['reservation.create', ...(['org_admin', 'no-module'].includes(role) ? ['reservation.manage'] : [])];
    res.end(JSON.stringify({ userId: 'user-a', tenantId: 'tenant-a', orgId, membershipId: 'membership-a', roles: [role], permissions, modules: role === 'no-module' ? [] : ['assets'] }));
  });
  const ready = once(authority, 'listening', { signal: AbortSignal.timeout(5000) }); authority.listen(0, '127.0.0.1'); await ready;
  fixture = await startSpaceFixture(`http://127.0.0.1:${authority.address().port}`);
});
after(async () => {
  await fixture.close(); const closed = once(authority, 'close', { signal: AbortSignal.timeout(5000) }); authority.close(); await closed;
});
async function request(path, { role = 'org_admin', orgId = 'org-a', method = 'POST', body = {} } = {}) {
  const response = await fetch(fixture.baseUrl + '/api/v1/spaces' + path, { method, signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${role}`, 'X-Org-Id': orgId, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const names = Array.from({ length: 5 }, (_, i) => `테스트 공간 ${i + 1}`);

test('explicit test-space action creates only missing selected-company names, is repeatable and preserves inactive/unrelated/foreign data', async () => {
  await fixture.insert({ tenantId: 'tenant-a', orgId: 'org-a', name: names[0], location: 'Existing', capacity: 3 });
  await fixture.insert({ tenantId: 'tenant-a', orgId: 'org-a', name: 'Unrelated', location: 'Existing', capacity: 2 });
  await fixture.insert({ tenantId: 'tenant-other', orgId: 'org-a', name: names[1], location: 'Foreign tenant', capacity: 2 });
  await fixture.insert({ tenantId: 'tenant-a', orgId: 'org-b', name: names[1], location: 'Foreign company', capacity: 2, isActive: false });
  const existing = structuredClone(fixture.rows);
  const first = await request('/test-spaces');
  assert.equal(first.status, 200); assert.equal(first.body.data.createdCount, 4);
  assert.deepEqual(first.body.data.spaces.map(row => row.name), names);
  assert.deepEqual(fixture.rows.slice(0, existing.length), existing);
  const again = await request('/test-spaces');
  assert.equal(again.status, 200); assert.equal(again.body.data.createdCount, 0);
  assert.deepEqual(again.body.data.spaces, first.body.data.spaces);
  const concurrent = await Promise.all([request('/test-spaces', { orgId: 'org-b', role: 'owner' }), request('/test-spaces', { orgId: 'org-b', role: 'owner' })]);
  assert.deepEqual(concurrent.map(r => r.status), [200, 200]);
  assert.equal(concurrent.reduce((sum, r) => sum + r.body.data.createdCount, 0), 4);
  assert.equal(fixture.rows.filter(row => row.tenantId === 'tenant-a' && row.orgId === 'org-b').length, 5);
  assert.equal(fixture.rows.find(row => row.id === existing[3].id).isActive, false);
  assert.ok(fixture.calls.filter(c => c.op === 'lock').every(c => c.values[0] === 'tenant-a'));
});

for (const role of ['member', 'admin', 'super_admin', 'other_org_admin', 'company_creator', 'no-module']) {
  test(`test-space action rejects ${role} before persistence`, async () => {
    const beforeCalls = fixture.calls.length;
    assert.equal((await request('/test-spaces', { role })).status, 403);
    assert.equal(fixture.calls.length, beforeCalls);
  });
}
test('test-space action rejects foreign company and supplied scope; normal create validates whitespace and spoofed scope', async () => {
  const before = fixture.rows.length;
  assert.equal((await request('/test-spaces', { orgId: 'org-foreign' })).status, 403);
  assert.equal((await request('/test-spaces', { body: { orgId: 'org-b' } })).status, 400);
  assert.equal((await request('', { body: { name: '  ', location: 'Here', capacity: 1 } })).status, 400);
  assert.equal((await request('', { body: { name: 'Spoof', location: 'Here', capacity: 1, tenantId: 'foreign' } })).status, 400);
  assert.equal(fixture.rows.length, before);
});
test('create/read/reload remains scoped and cross-company edit/delete is rejected', async () => {
  const created = await request('', { body: { name: 'Manual space', location: 'Here', capacity: 4 } });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  for (let i = 0; i < 2; i++) assert.ok((await request('', { method: 'GET' })).body.data.some(row => row.id === id));
  for (const method of ['GET', 'PATCH', 'DELETE']) assert.equal((await request('/' + id, { method, orgId: 'org-b', body: { name: 'Foreign edit' } })).status, 404);
});
test('test-space transaction failure rolls back rather than leaving a partial set', async () => {
  fixture.failName = names[2];
  try { assert.equal((await request('/test-spaces', { orgId: 'org-failure' })).status, 500); }
  finally { fixture.failName = null; }
  assert.equal(fixture.rows.filter(row => row.orgId === 'org-failure').length, 0);
});
