import assert from 'node:assert/strict';
import test from 'node:test';
import { api, createOwnerOrg, startTestServer } from './http.js';

process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';

test('calendar month window returns every overlapping event within the selected organization', async () => {
  // Given: 101 records in one month and a record belonging to another tenant.
  const server = await startTestServer();
  try {
    const owner = await createOwnerOrg(server.baseUrl, ['calendar']);
    const other = await createOwnerOrg(server.baseUrl, ['calendar']);
    const create = (session, body) => api(server.baseUrl, '/calendar', { ...session, method: 'POST', body: { title: 'MONTH_QA', start_at: '2026-09-10T00:00:00Z', end_at: '2026-09-10T01:00:00Z', ...body } });
    for (let index = 0; index < 101; index++) assert.equal((await create(owner, {})).status, 201);
    const boundary = await create(owner, { title: 'OFFSET_BOUNDARY', start_at: '2026-09-01T00:30:00+09:00', end_at: '2026-09-01T01:30:00+09:00' });
    assert.equal(boundary.status, 201);
    assert.equal((await create(other, { title: 'OTHER_ORG' })).status, 201);
    // When: requesting the complete local September in UTC bounds.
    const result = await api(server.baseUrl, '/calendar?from=2026-08-31T15%3A00%3A00Z&to=2026-09-30T15%3A00%3A00Z', owner);
    // Then: no 100-record truncation or organization leakage.
    assert.equal(result.status, 200);
    assert.equal(result.body.items.length, 102);
    assert.equal(result.body.items.some(row => row.title === 'OTHER_ORG'), false);
    assert.equal(result.body.items.some(row => row.id === boundary.body.id), true);
    const malformed = await api(server.baseUrl, '/calendar?from=no&to=2026-09-30T15%3A00%3A00Z', owner);
    assert.equal(malformed.status, 400);
  } finally { await server.close(); }
});
