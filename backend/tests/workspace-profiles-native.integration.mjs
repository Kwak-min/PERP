import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { api, startTestServer } from './http.js';
import { startDailyNativePostgres } from './daily-native-fixture.js';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
let database, server;
try {
  // config/pg.js는 환경 설정 후 HTTP 서버가 불러온다.
  database = await startDailyNativePostgres();
  const { pool } = database;
  await pool.query(await readFile(new URL('../../db/perp_additions_v8.sql', import.meta.url), 'utf8'));
  server = await startTestServer();
  const { PG_CREATOR_PERMISSIONS } = await import('../src/middleware/pgAccess.js');
  const password = 'password-1234';
  const signup = await api(server.baseUrl, '/pg/auth/signup', { method: 'POST', body: { email: 'profiles-native@example.invalid', name: '인증된 이름', password } });
  assert.equal(signup.status, 201);
  const token = signup.body.token;
  assert.deepEqual((await api(server.baseUrl, '/pg/auth/workspace', { token })).body.organizations, []);
  const userBefore = (await pool.query('SELECT * FROM auth.users WHERE email=$1', ['profiles-native@example.invalid'])).rows;
  const oldRows = async () => (await pool.query('SELECT id,name FROM org.companies ORDER BY id')).rows;
  const old = await oldRows();
  for (const type of ['personal', 'club', 'lab']) {
    const missing = await api(server.baseUrl, '/pg/companies', { token, method: 'POST', body: { name: '스키마 없음', type } });
    assert.equal(missing.status, 503); assert.equal(missing.body.error.code, 'SERVICE_UNAVAILABLE');
    assert.deepEqual(await oldRows(), old);
  }
  const create = body => api(server.baseUrl, '/pg/companies', { token, method: 'POST', body });
  const legacy = await create({ name: '이전 회사', modules: ['finance'], features: [] });
  assert.equal(legacy.status, 201); assert.equal(legacy.body.type, 'perp_db');
  await pool.query(await readFile(new URL('../../db/perp_additions_v19_personal_organizations.sql', import.meta.url), 'utf8'));
  const personal = await create({ name: '무시할 이름', type: 'personal' });
  assert.equal(personal.status, 201); assert.equal(personal.body.name, '인증된 이름');
  for (const type of ['club', 'lab']) {
    const before = await oldRows();
    const missing = await create({ name: '이전 제약', type });
    assert.equal(missing.status, 503); assert.deepEqual(await oldRows(), before);
  }
  const tables = ['org.companies', 'auth.users', 'org.company_memberships', 'org.roles', 'org.user_roles', 'org.role_permissions', 'org.company_modules', 'org.company_feature_settings', 'org.departments', 'project.projects', 'project.tasks'];
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, (await pool.query(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows])));
  const beforeMigration = await snapshot();
  const migration = await readFile(new URL('../../db/perp_additions_v20_workspace_profiles.sql', import.meta.url), 'utf8');
  await pool.query(migration); await pool.query(migration);
  assert.deepEqual(await snapshot(), beforeMigration);
  console.log('PASS native v19 upgrade, v20 repeat and exact old-data preservation');

  for (const type of ['personal', 'company', 'club', 'lab']) {
    const response = await create({ name: '공간 ' + type, type, modules: ['finance', 'tasks'], features: [] });
    assert.equal(response.status, 201);
    const id = response.body.org_id.slice(3);
    assert.equal(response.body.type, type === 'company' ? 'perp_db' : type);
    assert.deepEqual((await pool.query('SELECT name,organization_type FROM org.companies WHERE id=$1', [id])).rows, [{ name: type === 'personal' ? '인증된 이름' : '공간 ' + type, organization_type: type }]);
    const workspace = await api(server.baseUrl, '/pg/auth/workspace', { token });
    assert.equal(workspace.status, 200);
    const org = workspace.body.organizations.find(o => o.org_id === response.body.org_id);
    assert.equal(org.org_type, response.body.type);
    assert.ok(org.modules.includes('finance') && !org.modules.includes('projects'));
    assert.deepEqual([...org.permissions].sort(), [...PG_CREATOR_PERMISSIONS].sort());
    assert.deepEqual(org.roles, ['company_creator']);
    for (const table of ['org.departments', 'project.projects', 'accounting.accounts', 'accounting.journal_entries']) {
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE company_id=$1`, [id])).rows[0].n, 0, table);
    }
    const access = await api(server.baseUrl, '/settings/access', { token, orgId: response.body.org_id });
    assert.equal(access.status, 200); assert.deepEqual(access.body.features, []);
    const foreign = await api(server.baseUrl, '/settings/access', { token, orgId: 'pg:' + database.companyId });
    assert.equal(foreign.status, 403);
    console.log('PASS native ' + type + ' type, money selection, empty business records and scoped creator');
  }
  assert.deepEqual((await pool.query('SELECT * FROM auth.users WHERE email=$1', ['profiles-native@example.invalid'])).rows, userBefore);
  const mutable = await create({ name: '명시적 기능', type: 'lab', modules: [], features: ['attendance', 'leave', 'approvals'] });
  assert.equal(mutable.status, 201); assert.deepEqual([...mutable.body.enabled_features].sort(), ['approvals', 'attendance', 'leave']);
  assert.deepEqual((await pool.query('SELECT module_key FROM org.company_modules WHERE company_id=$1', [mutable.body.org_id.slice(3)])).rows, [{ module_key: 'approvals' }]);
  for (const fields of [{ type: 'nonprofit' }, { type: 'perp_db' }, { user_id: userBefore[0].id }, { roles: ['platform.admin'] }, { is_admin: true }, { organization_type: 'personal' }, { modules: ['bogus'] }, { features: ['bogus'] }]) {
    const before = await snapshot();
    const response = await create({ name: '위조', ...fields });
    assert.equal(response.status, 400); assert.deepEqual(await snapshot(), before);
  }
  const afterCreation = await snapshot();
  for (const table of tables) for (const row of beforeMigration[table]) {
    assert.ok(afterCreation[table].some(current => JSON.stringify(current) === JSON.stringify(row)), `기존 행 보존: ${table}`);
  }
  await pool.query(migration);
  assert.deepEqual(await snapshot(), afterCreation, '새 유형 생성 뒤에도 마이그레이션 재적용은 데이터를 바꾸지 않는다');
  const relogin = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: 'profiles-native@example.invalid', password } });
  assert.equal(relogin.status, 200);
  const workspace = await api(server.baseUrl, '/pg/auth/workspace', { token: relogin.body.token });
  assert.equal(workspace.status, 200);
  assert.equal(workspace.body.organizations.find(o => o.org_id === legacy.body.org_id).org_type, 'perp_db');
  assert.equal(workspace.body.organizations.find(o => o.org_id === personal.body.org_id).org_type, 'personal');
  console.log('WORKSPACE_PROFILES_NATIVE_PASS');
} finally {
  await server?.close();
  if (server) { const { pgPool } = await import('../src/config/pg.js'); await pgPool.end(); }
  await database?.close();
}
