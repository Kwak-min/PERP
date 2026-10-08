import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPANY_PERMISSIONS } from '../src/config/rbac.js';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { assertIsolated } from './deadline-fixture.js';
import { startTestServer } from './http.js';

const password = 'deadline-admin-projection-password';

test('native PG access projects administration only from active scope-all role unions', { timeout: 90000 }, async () => {
  assertIsolated();
  let native, server, closePgPool;
  try {
    native = await startDailyNativePostgres();
    assert.match((await native.pool.query('SHOW server_version')).rows[0].server_version, /^18\.6(?:\s|$)/);
    server = await startTestServer();
    ({ closePgPool } = await import('../src/config/pg.js'));

    const request = async (actor, route, method = 'GET', body, expected = 200) => {
      const response = await fetch(server.baseUrl + route, {
        method,
        headers: { 'Content-Type': 'application/json', ...(actor?.token ? { Authorization: `Bearer ${actor.token}` } : {}), ...(actor?.orgId ? { 'X-Org-Id': actor.orgId } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      });
      const value = await response.json();
      assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(value)}`);
      return value;
    };

    const signup = await request(null, '/pg/auth/signup', 'POST', { email: 'native-admin-owner@example.invalid', name: 'Native admin owner', password }, 201);
    const admin = { token: signup.token, userId: signup.user.id };
    const company = await request(admin, '/pg/companies', 'POST', { name: 'Native admin projection', modules: ['projects', 'tasks'], features: [], departments: [] }, 201);
    admin.orgId = company.org_id;
    const member = await request(admin, '/pg/members', 'POST', { email: 'native-admin-member@example.invalid', name: 'Native admin member', password }, 201);
    const delegate = { token: (await request(null, '/pg/auth/login', 'POST', { email: 'native-admin-member@example.invalid', password })).token, userId: member.id, orgId: admin.orgId };

    const roles = [];
    for (const index of [0, 1]) {
      roles.push(await request(admin, '/settings/roles', 'POST', {
        name: `Native finite union ${index}`,
        permissions: COMPANY_PERMISSIONS.filter((_, permissionIndex) => permissionIndex % 2 === index),
        scope: 'all',
      }, 201));
    }
    const current = (await request(admin, '/settings/members')).items.find(row => row.membership_id === member.id);
    await request(admin, `/settings/members/${member.id}/roles`, 'PUT', { roles: roles.map(role => role.key), expected_roles_version: current.roles_version });

    const access = () => request(delegate, '/settings/access');
    assert.equal((await access()).is_company_administrator, true, 'two active scope-all roles whose finite union is complete must qualify');

    await native.pool.query("UPDATE org.roles SET scope = 'self' WHERE id = $1", [roles[0].key]);
    const narrow = (await access()).is_company_administrator;

    await native.pool.query("UPDATE org.roles SET scope = 'all', deleted_at = now() WHERE id = ANY($1::bigint[])", [roles.map(role => role.key)]);
    const retained = await native.pool.query('SELECT count(*)::int AS count FROM org.user_roles WHERE user_id = $1 AND role_id = ANY($2::bigint[])', [member.id, roles.map(role => role.key)]);
    assert.equal(retained.rows[0].count, roles.length, 'the deleted-role case must retain historical user-role links');
    const deleted = (await access()).is_company_administrator;
    assert.deepEqual({ narrow, deleted }, { narrow: false, deleted: false }, 'narrow and soft-deleted role grants must not qualify');
  } finally {
    await server?.close();
    await closePgPool?.();
    await native?.close();
  }
});
