import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { api, startTestServer } from './http.js';
import { installCompanyFixture } from './pg-company-fixture.js';
import { ORG_TEMPLATES } from '../src/config/org-templates.js';
import { PG_CREATOR_PERMISSIONS } from '../src/middleware/pgAccess.js';

process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
let server, fixture, token;
before(async () => {
  server = await startTestServer(); fixture = await installCompanyFixture();
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.users[1].email, password: 'password-1234' } });
  assert.equal(login.status, 200); token = login.body.token;
});
after(async () => { await fixture.close(); await server.close(); });

test('small-team recommendation is exactly the lean project and money preset, with advanced modules still available', async () => {
  const expected = ['projects', 'tasks', 'calendar', 'documents', 'finance', 'agent'];
  assert.deepEqual(ORG_TEMPLATES.company.modules, expected);
  const before = structuredClone(fixture.state);
  const templates = await api(server.baseUrl, '/tenants/templates', { token });
  assert.equal(templates.status, 200);
  assert.deepEqual(templates.body.items.find(item => item.type === 'company').modules, expected);
  const catalog = await api(server.baseUrl, '/tenants/modules/catalog', { token });
  assert.equal(catalog.status, 200);
  for (const key of ['hr', 'automations', 'analytics', 'assets', 'handover']) {
    assert.equal(catalog.body.items.find(item => item.key === key).core, false);
  }
  assert.deepEqual(fixture.state, before, 'recommendation reads do not change stored organizations or grants');
});

test('lean recommendation never replaces explicit advanced company selections in either backend', async () => {
  const modules = ['projects', 'finance', 'hr', 'automations', 'analytics', 'assets', 'handover'];
  for (const native of [true, false]) {
    const signup = native ? null : await api(server.baseUrl, '/auth/signup', { method: 'POST', body: { name: '기존 팀', email: 'advanced-team@profiles.invalid', password: 'password-1234' } });
    if (signup) assert.equal(signup.status, 201);
    const actorToken = native ? token : signup.body.access_token;
    const created = await api(server.baseUrl, native ? '/pg/companies' : '/tenants', { token: actorToken, method: 'POST', body: { name: '고급 기능 팀', type: 'company', modules, features: [] } });
    assert.equal(created.status, 201);
    const stored = async () => {
      if (native) return fixture.state.modules.filter(row => row.company_id === created.body.org_id.slice(3)).map(row => row.module_key).sort();
      const { db } = await import('../src/config/db.js');
      return db().prepare('SELECT modules FROM organization WHERE id=?').get(created.body.org_id).modules.split(',').sort();
    };
    assert.deepEqual(await stored(), [...modules].sort());
    assert.equal((await api(server.baseUrl, '/tenants/templates', { token: actorToken })).status, 200);
    assert.deepEqual(await stored(), [...modules].sort());
  }
});

for (const type of ['personal', 'company', 'club', 'lab']) {
  test(`${type}: recommendations include money and explicit PG creation preserves identity and scoped grants`, async () => {
    assert.ok(ORG_TEMPLATES[type].modules.includes('finance'));
    const oldCompany = structuredClone(fixture.state.companies[0]);
    const oldMemberships = structuredClone(fixture.state.memberships);
    const users = structuredClone(fixture.state.users);
    const created = await api(server.baseUrl, '/pg/companies', { token, method: 'POST', body: {
      name: '선택한 공간', type, modules: ['finance', 'tasks'], features: [],
    } });
    assert.equal(created.status, 201);
    assert.equal(created.body.type, type === 'company' ? 'perp_db' : type);
    assert.equal(created.body.name, type === 'personal' ? users[1].name : '선택한 공간');
    const companyId = created.body.org_id.slice(3);
    assert.equal(fixture.state.companies.find(c => c.id === companyId).organization_type, type);
    assert.deepEqual(fixture.state.users, users);
    assert.deepEqual(fixture.state.companies[0], oldCompany);
    assert.deepEqual(fixture.state.memberships.slice(0, oldMemberships.length), oldMemberships);
    assert.deepEqual(fixture.state.departments, []);
    assert.deepEqual(fixture.state.projects, []);
    assert.deepEqual(fixture.state.tasks, []);
    const workspace = await api(server.baseUrl, '/pg/auth/workspace', { token });
    const org = workspace.body.organizations.find(o => o.org_id === created.body.org_id);
    assert.equal(org.org_type, created.body.type);
    assert.ok(org.modules.includes('finance') && org.modules.includes('tasks'));
    assert.ok(!org.modules.includes('approvals') && !org.modules.includes('projects'));
    assert.deepEqual([...org.permissions].sort(), [...PG_CREATOR_PERMISSIONS].sort());
    assert.deepEqual(org.roles, ['company_creator']);
    const foreign = await api(server.baseUrl, '/settings/access', { token, orgId: 'pg:77' });
    assert.equal(foreign.status, 403);
  });
}

test('PG explicit empty selection and opt-in features are not replaced by recommendations', async () => {
  for (const features of [[], ['attendance', 'leave', 'approvals']]) {
    const response = await api(server.baseUrl, '/pg/companies', { token, method: 'POST', body: { name: '선택 유지', type: 'company', modules: [], features } });
    assert.equal(response.status, 201);
    assert.deepEqual(response.body.enabled_features, features);
    assert.deepEqual(fixture.state.modules.filter(m => m.company_id === response.body.org_id.slice(3)).map(m => m.module_key), features.length ? ['approvals'] : []);
  }
});

test('PG rejects forged identity, memberships, roles and unsupported legacy type before writes', async () => {
  for (const fields of [{ user_id: '101' }, { is_admin: true }, { roles: ['platform.admin'] }, { organization_type: 'personal' }, { type: 'nonprofit' }]) {
    const before = structuredClone(fixture.state);
    const response = await api(server.baseUrl, '/pg/companies', { token, method: 'POST', body: { name: '위조', ...fields } });
    assert.equal(response.status, 400);
    assert.deepEqual(fixture.state, before);
  }
});

for (const type of Object.keys(ORG_TEMPLATES)) test(`SQLite ${type} remains compatible with explicit selection and template accounts`, async () => {
  const signup = await api(server.baseUrl, '/auth/signup', { method: 'POST', body: { name: '기존 사용자', email: `${type}@profiles.invalid`, password: 'password-1234' } });
  assert.equal(signup.status, 201);
  const created = await api(server.baseUrl, '/tenants', { token: signup.body.access_token, method: 'POST', body: { name: '기존 공간', type, modules: ['finance'], features: [] } });
  assert.equal(created.status, 201);
  assert.equal(created.body.type, type);
  const { db } = await import('../src/config/db.js');
  assert.equal(db().prepare('SELECT count(*) AS n FROM department WHERE org_id=?').get(created.body.org_id).n, 0);
  assert.deepEqual(db().prepare('SELECT code,name,kind FROM account WHERE org_id=? ORDER BY code').all(created.body.org_id).map(r => [r.code,r.name,r.kind]), [...ORG_TEMPLATES[type].accounts].sort((a,b) => a[0].localeCompare(b[0])));
});
