import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { api, startTestServer } from './http.js';
import { installCompanyFixture } from './pg-company-fixture.js';
process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
let server, fixture;
before(async () => { server = await startTestServer(); fixture = await installCompanyFixture(); });
after(async () => { await fixture.close(); await server.close(); });
async function login() {
  const result = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.users[0].email, password: 'password-1234' } });
  assert.equal(result.status, 200); return result.body.token;
}
const create = (token, body = { name: 'Native second company', modules: ['members', 'tasks', 'projects', 'approvals', 'finance', 'agent'], features: ['approvals'] }) => api(server.baseUrl, '/pg/companies', { token, method: 'POST', body });

test('native company creation preserves primary identity and records discoverable scoped creator membership', async () => {
  // Given: 기존 PG 회사의 사용자. When: native 회사 추가. Then: primary 변경 없이 새 소속/권한이 commit된다.
  const token = await login(), primary = structuredClone(fixture.users[0]);
  const created = await create(token);
  assert.equal(created.status, 201);
  assert.match(created.body.org_id, /^pg:\d+$/);
  const companyId = created.body.org_id.slice(3);
  assert.deepEqual(fixture.users[0], primary);
  assert.equal(fixture.state.departments.filter(d => d.company_id === companyId).length, 0);
  assert.ok(fixture.state.memberships.some(m => m.company_id === companyId && m.user_id === '101' && m.status === 'active'));
  const again = await login();
  const workspaces = await api(server.baseUrl, '/pg/auth/workspace', { token: again });
  assert.equal(workspaces.status, 200);
  assert.deepEqual(workspaces.body.organizations.map(org => org.org_id), ['pg:77', created.body.org_id]);
  const members = await api(server.baseUrl, '/pg/members', { token, orgId: created.body.org_id });
  assert.equal(members.status, 200);
  assert.equal(members.body.items[0].user_id, '101');
  assert.deepEqual(members.body.items[0].roles, ['company_creator']);
  const legacy = await api(server.baseUrl, '/auth/me', { token });
  assert.deepEqual(legacy.body.organizations, [], 'native create must not create SQLite membership');
});

test('selected company creator can be assigned without rewriting primary department or weakening foreign-member checks', async () => {
  // Given: 새 회사 creator 소속. When: 부서/담당/결재대상 지정. Then: 해당 회사 membership으로만 검증한다.
  const token = await login(), created = await create(token), orgId = created.body.org_id;
  assert.equal(created.status, 201);
  const department = await api(server.baseUrl, '/pg/members/departments', { token, orgId, method: 'POST', body: { name: 'Explicit department' } });
  assert.equal(department.status, 201);
  assert.equal((await api(server.baseUrl, '/pg/members/departments/' + department.body.id, { token, orgId, method: 'PATCH', body: { leader_id: '101' } })).status, 200);
  assert.equal((await api(server.baseUrl, '/pg/members/101/assignment', { token, orgId, method: 'PATCH', body: { department_id: department.body.id } })).status, 200);
  assert.equal(fixture.users[0].department_id, null);
  const project = await api(server.baseUrl, '/pg/projects', { token, orgId, method: 'POST', body: { name: 'Native project' } });
  assert.equal(project.status, 201);
  assert.equal((await api(server.baseUrl, '/pg/tasks', { token, orgId, method: 'POST', body: { project_id: project.body.id, title: 'Own task', assignee_id: '101' } })).status, 201);
  assert.equal((await api(server.baseUrl, '/pg/tasks', { token, orgId, method: 'POST', body: { project_id: project.body.id, title: 'Foreign task', assignee_id: '102' } })).status, 400);
  assert.equal((await api(server.baseUrl, '/pg/approvals', { token, orgId, method: 'POST', body: { request_type: 'review', target_user_id: '101' } })).status, 201);
  assert.equal((await api(server.baseUrl, '/pg/finance/dues', { token, orgId, method: 'POST', body: { target_user_id: '101', amount: 100 } })).status, 201);
});

test('roles alone, suspended membership and inactive companies never establish company entry', async () => {
  // Given: 역할은 있지만 active 소속/회사가 없음. When: 명시 회사 선택. Then: 조회 전에 거절한다.
  const token = await login(), created = await create(token);
  assert.equal(created.status, 201);
  const membership = fixture.state.memberships.find(m => m.company_id === created.body.org_id.slice(3));
  membership.status = 'left';
  assert.equal((await api(server.baseUrl, '/pg/projects', { token, orgId: created.body.org_id })).status, 403);
  const workspaces = await api(server.baseUrl, '/pg/auth/workspace', { token });
  assert.ok(!workspaces.body.organizations.some(org => org.org_id === created.body.org_id));
  membership.status = 'suspended';
  assert.equal((await api(server.baseUrl, '/pg/projects', { token, orgId: created.body.org_id })).status, 403);
  membership.status = 'active';
  fixture.state.companies.find(c => c.id === membership.company_id).is_active = false;
  assert.equal((await api(server.baseUrl, '/pg/projects', { token, orgId: created.body.org_id })).status, 403);
});

test('new member provisioning records membership atomically in the selected native company', async () => {
  // Given: 두 번째 회사 creator. When: 구성원 등록. Then: 선택 회사 소속을 만들고 실패 시 계정도 rollback한다.
  const token = await login(), company = await create(token), orgId = company.body.org_id;
  assert.equal(company.status, 201);
  const body = { email: 'provisioned@example.invalid', name: 'Provisioned', password: 'password-1234' };
  const created = await api(server.baseUrl, '/pg/members', { token, orgId, method: 'POST', body });
  assert.equal(created.status, 201);
  assert.ok(fixture.state.memberships.some(m => m.company_id === orgId.slice(3) && m.user_id === created.body.id));
  const list = await api(server.baseUrl, '/pg/members', { token, orgId });
  assert.ok(list.body.items.some(m => m.user_id === created.body.id));
  fixture.failMembership = true;
  try { assert.equal((await api(server.baseUrl, '/pg/members', { token, orgId, method: 'POST', body: { ...body, email: 'rollback-member@example.invalid' } })).status, 500); }
  finally { fixture.failMembership = false; }
  assert.ok(!fixture.users.some(user => user.email === 'rollback-member@example.invalid'));
});

test('native company accepts only explicit departments and rejects client-owned identity or grants', async () => {
  // Given: 명시적 부서 입력. When: 생성. Then: 입력한 부서만 저장하고 권한/신원 주입은 거절한다.
  const token = await login();
  const created = await create(token, { name: 'Explicit company', departments: [' Engineering ', 'Engineering', 'Finance'] });
  assert.equal(created.status, 201);
  assert.deepEqual(fixture.state.departments.filter(d => d.company_id === created.body.org_id.slice(3)).map(d => d.name), ['Engineering', 'Finance']);
  const count = fixture.state.companies.length;
  assert.equal((await create(token, { name: 'Spoof', user_id: '102', roles: ['owner'] })).status, 400);
  assert.equal(fixture.state.companies.length, count);
});

test('native workspace preserves legacy feature availability when no settings row exists', async () => {
  const token = await login();
  fixture.state.modules.push(
    { company_id: '77', module_key: 'hr' },
    { company_id: '77', module_key: 'approvals' },
  );
  try {
    const workspaces = await api(server.baseUrl, '/pg/auth/workspace', { token });
    assert.equal(workspaces.status, 200);
    const legacy = workspaces.body.organizations.find(org => org.org_id === 'pg:77');
    assert.deepEqual(legacy.enabled_features, ['approvals', 'attendance', 'leave']);
  } finally {
    fixture.state.modules.splice(1);
  }
});

test('native feature selection persists across login and gates each direct API independently', async () => {
  const token = await login();
  const created = await create(token, { name: 'Attendance only company', modules: [], features: ['attendance'] });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.enabled_features, ['attendance']);
  const companyId = created.body.org_id.slice(3);
  assert.deepEqual(fixture.state.featureSettings.find(row => row.company_id === companyId)?.enabled_features, ['attendance']);

  const reloggedToken = await login();
  assert.equal((await api(server.baseUrl, '/pg/hr/attendance', { token: reloggedToken, orgId: created.body.org_id })).status, 200);
  for (const path of ['/pg/hr/leaves', '/pg/approvals']) {
    const response = await api(server.baseUrl, path, { token: reloggedToken, orgId: created.body.org_id });
    assert.equal(response.status, 403, path);
    assert.equal(response.body.error.code, 'FEATURE_DISABLED', path);
  }

  const empty = await create(token, { name: 'No feature company', modules: ['hr'], features: [] });
  assert.equal(empty.status, 201);
  assert.deepEqual(fixture.state.featureSettings.find(row => row.company_id === empty.body.org_id.slice(3))?.enabled_features, []);
  assert.ok(!fixture.state.modules.some(row => row.company_id === empty.body.org_id.slice(3) && row.module_key === 'approvals'));
  for (const path of ['/pg/hr/attendance', '/pg/hr/leaves', '/pg/approvals']) {
    const response = await api(server.baseUrl, path, { token, orgId: empty.body.org_id });
    assert.equal(response.status, 403, path);
    assert.equal(response.body.error.code, 'FEATURE_DISABLED', path);
  }
  assert.equal((await api(server.baseUrl, '/pg/hr/postings', { token, orgId: empty.body.org_id })).status, 200);
});

test('native company rejects unknown feature keys before transaction writes', async () => {
  const token = await login(), count = fixture.state.companies.length;
  const response = await create(token, { name: 'Unknown feature', features: ['not-a-feature'] });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  assert.equal(fixture.state.companies.length, count);
});

test('native company creation preserves authentication guards for invalid and expired sessions', async () => {
  // Given: 미인증/만료 세션. When: native 생성 요청. Then: 회사 쓰기 전에 거절한다.
  const count = fixture.state.companies.length;
  assert.equal((await create(null)).status, 401);
  const token = await login();
  fixture.state.sessions.find(s => s.token === token).login_at = '2000-01-01T00:00:00Z';
  assert.equal((await create(token)).status, 401);
  assert.equal(fixture.state.companies.length, count);
});

test('native creation errors rollback rather than fallback to SQLite and missing migration is explicit', async () => {
  // Given: 기능/소속 migration 누락 또는 membership 쓰기 실패. When: native 생성. Then: 전체 rollback 및 명시 오류다.
  const token = await login(), before = structuredClone(fixture.state.companies);
  fixture.featureSchemaAvailable = false;
  try {
    const result = await create(token);
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'SERVICE_UNAVAILABLE');
    assert.match(result.body.error.message, /perp_additions_v6\.sql/);
  } finally { fixture.featureSchemaAvailable = true; }
  assert.deepEqual(fixture.state.companies, before);
  fixture.failMembership = true;
  try { assert.equal((await create(token)).status, 500); } finally { fixture.failMembership = false; }
  assert.deepEqual(fixture.state.companies, before);
  fixture.schemaAvailable = false;
  try {
    const result = await create(token);
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'SERVICE_UNAVAILABLE');
  } finally { fixture.schemaAvailable = true; }
  assert.deepEqual(fixture.state.companies, before);
  assert.deepEqual((await api(server.baseUrl, '/auth/me', { token })).body.organizations, []);
});
