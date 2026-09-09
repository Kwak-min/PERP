import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { api, createOwnerOrg, startTestServer } from './http.js';
import { installCompanyFixture } from './pg-company-fixture.js';

process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
let server, fixture, db;
before(async () => {
  server = await startTestServer(); fixture = await installCompanyFixture();
  ({ db } = await import('../src/config/db.js'));
});
after(async () => { await fixture.close(); await server.close(); });
const keys = ['approvals', 'attendance', 'leave'];

async function create(nativePg) {
  if (!nativePg) return createOwnerOrg(server.baseUrl, [], []);
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.users[0].email, password: 'password-1234' } });
  assert.equal(login.status, 200);
  const token = login.body.token;
  const created = await api(server.baseUrl, '/pg/companies', { token, method: 'POST', body: { name: 'Isolated feature settings', modules: [], features: [] } });
  assert.equal(created.status, 201);
  return { token, orgId: created.body.org_id, userId: '101' };
}

for (const nativePg of [false, true]) {
  const store = nativePg ? 'PG SQL boundary fixture (not a PostgreSQL engine)' : 'SQLite';
  const settingsPath = nativePg ? '/pg/org/modules' : '/tenants/current';
  const catalogPath = nativePg ? '/pg/org/modules' : '/tenants/modules';
  const paths = nativePg ? { attendance: '/pg/hr/attendance', leave: '/pg/hr/leaves', approvals: '/pg/approvals' }
    : { attendance: '/hr/attendance', leave: '/hr/leaves', approvals: '/approvals/requests' };
  const modulesBody = modules => nativePg ? { enabled: modules } : { modules };
  const patch = (session, body) => api(server.baseUrl, settingsPath, { ...session, method: 'PATCH', body });
  const stored = session => nativePg
    ? fixture.state.featureSettings.find(row => row.company_id === session.orgId.slice(3))?.enabled_features
    : db().prepare('SELECT enabled_features FROM organization WHERE id = ?').get(session.orgId).enabled_features.split(',').filter(Boolean);
  async function check(session, features) {
    assert.deepEqual([...stored(session)].sort(), features);
    const access = await api(server.baseUrl, '/settings/access', session);
    assert.equal(access.status, 200);
    assert.deepEqual(access.body.features, features);
    const catalog = await api(server.baseUrl, catalogPath, session);
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.body.features.filter(feature => feature.enabled).map(feature => feature.key).sort(), features);
    for (const [key, path] of Object.entries(paths)) {
      const response = await api(server.baseUrl, path, session);
      assert.equal(response.status, features.includes(key) ? 200 : 403, JSON.stringify({ key, response }));
      if (!features.includes(key)) assert.equal(response.body.error.code, 'FEATURE_DISABLED');
    }
  }

  test(`${store}: settings must not silently drop explicit features`, async () => {
    const session = await create(nativePg);
    const saved = await patch(session, { ...modulesBody(['hr', 'approvals']), features: ['attendance', 'leave', 'approvals'] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.enabled_features, keys);
    await check(session, keys);
  });

  test(`${store}: each feature enables/disables independently, survives reads, preserves role grants and other companies`, async () => {
    const session = await create(nativePg), other = await create(nativePg);
    const before = (await api(server.baseUrl, '/settings/access', session)).body;
    for (const feature of keys) {
      const enabled = await patch(session, { features: [feature] });
      assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
      assert.deepEqual(enabled.body.enabled_features, [feature]);
      await check(session, [feature]);
      assert.equal((await patch(session, { features: [] })).status, 200);
      await check(session, []);
    }
    const after = (await api(server.baseUrl, '/settings/access', session)).body;
    assert.deepEqual(after.permissions, before.permissions);
    assert.deepEqual(after.menus, before.menus);
    await check(other, []);
  });

  test(`${store}: omitted features stay unchanged and recruitment is not attendance or leave`, async () => {
    const session = await create(nativePg);
    assert.equal((await patch(session, { features: keys })).status, 200);
    assert.equal((await patch(session, modulesBody([]))).status, 200);
    await check(session, keys);
    assert.equal((await patch(session, { ...modulesBody(['hr']), features: [] })).status, 200);
    await check(session, []);
    assert.equal((await api(server.baseUrl, nativePg ? '/pg/hr/postings' : '/hr/postings', session)).status, 200);
  });

  test(`${store}: unknown or malformed flags and grant injection are rejected without changes`, async () => {
    const session = await create(nativePg);
    for (const body of [{ features: ['not-a-feature'] }, { features: null }, { features: 'attendance' },
      modulesBody(['not-a-module']), { features: [], permissions: ['*'] }]) {
      const response = await patch(session, body);
      assert.equal(response.status, 400, JSON.stringify(response));
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      await check(session, []);
    }
    assert.equal((await patch({ orgId: session.orgId }, { features: keys })).status, 401);
  });

  test(`${store}: existing pre-feature organizations can explicitly opt out without legacy inference reopening features`, async () => {
    const session = await create(nativePg);
    assert.equal((await patch(session, modulesBody(['hr', 'approvals']))).status, 200);
    if (nativePg) fixture.state.featureSettings = fixture.state.featureSettings.filter(row => row.company_id !== session.orgId.slice(3));
    else db().prepare('UPDATE organization SET enabled_features = NULL WHERE id = ?').run(session.orgId);
    const catalog = await api(server.baseUrl, catalogPath, session);
    assert.deepEqual(catalog.body.features.filter(feature => feature.enabled).map(feature => feature.key).sort(), keys);
    assert.equal((await patch(session, { features: [] })).status, 200);
    await check(session, []);
  });

  test(`${store}: failed audit rolls back both modules and feature settings`, async () => {
    const session = await create(nativePg);
    const before = (await api(server.baseUrl, '/settings/access', session)).body;
    if (nativePg) fixture.failSettingsAudit = true;
    else db().exec("CREATE TRIGGER fail_feature_settings_audit BEFORE INSERT ON audit_event WHEN NEW.action = 'organization.updated' BEGIN SELECT RAISE(ABORT, 'injected settings audit failure'); END");
    try {
      assert.equal((await patch(session, { ...modulesBody(['hr']), features: keys })).status, 500);
    } finally {
      if (nativePg) fixture.failSettingsAudit = false;
      else db().exec('DROP TRIGGER fail_feature_settings_audit');
    }
    await check(session, []);
    assert.deepEqual((await api(server.baseUrl, '/settings/access', session)).body, before);
  });

  test(`${store}: organization.settings and menu remain independent of role delegation and feature action grants`, async () => {
    const owner = await create(nativePg);
    let actor, setPermissions;
    if (nativePg) {
      actor = owner;
      const roleId = fixture.state.roles.find(role => role.company_id === owner.orgId.slice(3)).id;
      setPermissions = async permissions => {
        fixture.state.permissions = fixture.state.permissions.filter(p => p.role_id !== roleId);
        fixture.state.permissions.push(...[...permissions, 'menu.configured'].map(code => ({ role_id: roleId, code })));
      };
    } else {
      const email = `feature-role-${crypto.randomUUID()}@example.invalid`;
      const role = await api(server.baseUrl, '/settings/roles', { ...owner, method: 'POST', body: { name: 'Settings only QA', permissions: [] } });
      assert.equal(role.status, 201);
      const invite = await api(server.baseUrl, '/members/invites', { ...owner, method: 'POST', body: { email, roles: [role.body.key] } });
      assert.equal(invite.status, 201);
      const signup = await api(server.baseUrl, '/auth/signup', { method: 'POST', body: { email, name: 'Settings QA', password: 'password-1234', invitation_token: invite.body.token } });
      assert.equal(signup.status, 201);
      actor = { token: signup.body.access_token, orgId: owner.orgId };
      setPermissions = async permissions => {
        const changed = await api(server.baseUrl, `/settings/roles/${role.body.key}`, { ...owner, method: 'PATCH', body: { name: 'Settings only QA', permissions, expected_version: role.body.version } });
        assert.equal(changed.status, 200, JSON.stringify(changed.body));
        role.body.version = changed.body.version;
      };
    }
    for (const permissions of [['role.assign', 'menu.organization'], ['organization.settings']]) {
      await setPermissions(permissions);
      assert.equal((await patch(actor, { features: keys })).status, 403);
      assert.deepEqual(stored(owner), []);
    }
    await setPermissions(['organization.settings', 'menu.organization', 'menu.attendance']);
    const before = (await api(server.baseUrl, '/settings/access', actor)).body.permissions;
    assert.equal((await patch(actor, { features: keys })).status, 200);
    assert.deepEqual((await api(server.baseUrl, '/settings/access', actor)).body.permissions, before);
    const privilegedRead = nativePg ? paths.attendance : `${paths.attendance}?member_id=${owner.userId}`;
    assert.equal((await api(server.baseUrl, privilegedRead, actor)).status, 403, 'availability must not grant attendance action authority');
  });
}

test('PG SQL boundary fixture: missing v6 fails explicitly and rolls back modules', async () => {
  const session = await create(true);
  const before = structuredClone(fixture.state.modules);
  fixture.featureSchemaAvailable = false;
  try {
    const response = await api(server.baseUrl, '/pg/org/modules', { ...session, method: 'PATCH', body: { enabled: ['hr'], features: keys } });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'SERVICE_UNAVAILABLE');
  } finally { fixture.featureSchemaAvailable = true; }
  assert.deepEqual(fixture.state.modules, before);
  assert.deepEqual(fixture.state.featureSettings.find(row => row.company_id === session.orgId.slice(3)).enabled_features, []);
});
