import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { api, startTestServer } from './http.js';
import { installCompanyFixture } from './pg-company-fixture.js';

process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
let server, fixture;
before(async () => { server = await startTestServer(); fixture = await installCompanyFixture(); });
after(async () => { await fixture.close(); await server.close(); });

for (const native of [false, true]) test(`${native ? 'PG' : 'SQLite'} personal creation uses authenticated name and persists type without departments`, async () => {
  const auth = await api(server.baseUrl, native ? '/pg/auth/login' : '/auth/signup', {
    method: 'POST', body: native
      ? { email: fixture.users[1].email, password: 'password-1234' }
      : { email: 'personal@example.invalid', name: '개인 사용자', password: 'password-1234' },
  });
  assert.equal(auth.status, native ? 200 : 201);
  const token = native ? auth.body.token : auth.body.access_token;
  const created = await api(server.baseUrl, native ? '/pg/companies' : '/tenants', {
    token, method: 'POST', body: { type: 'personal', name: '클라이언트가 보낸 다른 이름', modules: ['projects', 'tasks'], features: [] },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, auth.body.user.name);
  assert.equal(created.body.type, 'personal');
  const login = await api(server.baseUrl, native ? '/pg/auth/login' : '/auth/login', {
    method: 'POST', body: { email: auth.body.user.email, password: 'password-1234' },
  });
  assert.equal(login.status, 200);
  const nextToken = native ? login.body.token : login.body.access_token;
  const workspace = await api(server.baseUrl, native ? '/pg/auth/workspace' : '/auth/me', { token: nextToken });
  assert.equal(workspace.status, 200);
  const organization = workspace.body.organizations.find(org => org.org_id === created.body.org_id);
  assert.equal(organization.org_name, auth.body.user.name);
  assert.equal(organization.org_type, 'personal');
  const departments = await api(server.baseUrl, native ? '/pg/members/departments' : '/members/departments', { token: nextToken, orgId: created.body.org_id });
  assert.equal(departments.status, 200);
  assert.deepEqual(departments.body.items, []);
});

test('PG rejects unsupported organization types before writing', async () => {
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.users[1].email, password: 'password-1234' } });
  assert.equal(login.status, 200);
  const count = fixture.state.companies.length;
  const response = await api(server.baseUrl, '/pg/companies', { token: login.body.token, method: 'POST', body: { name: 'Unsupported', type: 'club' } });
  assert.equal(response.status, 400);
  assert.equal(fixture.state.companies.length, count);
});
