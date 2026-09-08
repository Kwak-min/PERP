import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { COMPANY_PERMISSIONS } from '../src/config/rbac.js';
import { api, startTestServer } from './http.js';
import { installRoleFixture } from './pg-custom-role-fixture.js';

describe('task11 full-admin access DTO (PG SQL boundary, real HTTP)', { timeout: 30000 }, () => {
  let server, fixture, admin, delegate;
  const request = (actor, route, method = 'GET', body) => api(server.baseUrl, route, { ...actor, method, body });
  before(async () => { server = await startTestServer(); fixture = await installRoleFixture(); admin = fixture.actor(); delegate = fixture.actor('102'); });
  after(async () => { await server?.close(); await fixture?.close(); });
  it('requires the finite full permission union, not role names, three flags, or enabled-feature filtering', async () => {
    const roles = [];
    for (const [name, permissions] of [
      ['Limited administrator', ['role.assign', 'organization.settings', 'menu.roles']],
      ['Missing disabled grant', COMPANY_PERMISSIONS.filter(code => code !== 'attendance.read')],
      ['Union A', COMPANY_PERMISSIONS.filter((_, i) => i % 2 === 0)],
      ['Union B', COMPANY_PERMISSIONS.filter((_, i) => i % 2 === 1)],
    ]) {
      const created = await request(admin, '/settings/roles', 'POST', { name, permissions, scope: 'all' });
      assert.equal(created.status, 201, JSON.stringify(created.body)); roles.push(created.body.key);
    }
    for (const [grants, expected] of [[[roles[0]], false], [[roles[1]], false], [roles.slice(2), true]]) {
      assert.equal((await request(admin, '/settings/members/102/roles', 'PUT', { roles: grants })).status, 200);
      const access = await request(delegate, '/settings/access');
      assert.equal(access.status, 200);
      assert.equal(access.body.scope, 'all');
      assert.equal(access.body.features.includes('attendance'), false);
      assert.equal(access.body.permissions.includes('*'), false);
      assert.equal(access.body.is_company_administrator, expected);
    }
  });
});
