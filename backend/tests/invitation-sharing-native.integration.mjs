import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { startOrgPostgres } from './pg-org-native-fixture.js';
import { api, createOwnerOrg, startTestServer } from './http.js';

test('native PG recipient creation, acceptance, company reads and grant boundaries', { timeout: 120000 }, async () => {
  const native = await startOrgPostgres();
  let server;
  try {
    for (const file of ['perp_additions_v8.sql', 'perp_additions_v9_daily_corrections.sql', 'perp_additions_v11_deadline_roles.sql']) await native.pool.query(await readFile(new URL(`../../db/${file}`, import.meta.url), 'utf8'));
    server = await startTestServer();
    const request = (actor, route, method = 'GET', body) => api(server.baseUrl, route, { ...actor, method, body });
    const signup = async email => {
      const r = await request(null, '/pg/auth/signup', 'POST', { email, name: email.split('@')[0], password: 'password-1234' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return { token: r.body.token, userId: r.body.user.id, email };
    };
    const sender = await signup('sender@example.invalid'), receiver = await signup('receiver@example.invalid'), outsider = await signup('outsider@example.invalid');
    const company = await request(sender, '/pg/companies', 'POST', { name: 'Invitation company', modules: ['projects'], features: [], departments: [] });
    assert.equal(company.status, 201, JSON.stringify(company.body)); sender.orgId = company.body.org_id;
    const role = await request(sender, '/settings/roles', 'POST', { name: 'Shared project reader', scope: 'all', permissions: ['menu.projects', 'project.read', 'menu.members', 'member.read'] });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    const create = (email, roles = [role.body.key]) => request(sender, '/pg/members/invites', 'POST', { email, roles });
    const invited = await create(receiver.email); assert.equal(invited.status, 201, JSON.stringify(invited.body));
    const token = invited.body.token;
    // 동일 이메일의 두 계정도 각 저장소의 자격 증명과 소속을 유지한다.
    const legacyOwner = await createOwnerOrg(server.baseUrl, ['projects']);
    const legacySignup = await request(null, '/auth/signup', 'POST', { email: receiver.email, name: 'Separate SQLite receiver', password: 'password-1234' });
    assert.equal(legacySignup.status, 201);
    const legacyReceiver = { token: legacySignup.body.access_token };
    const legacyInvite = await request(legacyOwner, '/members/invites', 'POST', { email: receiver.email, roles: ['member'] });
    assert.equal(legacyInvite.status, 201);
    const conn = (await import('../src/config/db.js')).db();
    for (const action of ['verify', 'accept']) {
      const crossLegacy = await request(receiver, `/auth/invitations/${action}`, 'POST', { token: legacyInvite.body.token });
      assert.equal(crossLegacy.status, 403, `PG identity cannot ${action} SQLite invitation: ${JSON.stringify(crossLegacy.body)}`);
      assert.equal(crossLegacy.body.error.details.reason, 'store_mismatch');
      assert.equal((await request(legacyReceiver, `/pg/auth/invitations/${action}`, 'POST', { token })).status, 401);
    }
    assert.equal(conn.prepare('SELECT status FROM invitation WHERE id = ?').get(legacyInvite.body.id).status, 'pending');
    assert.equal(conn.prepare('SELECT count(*) AS n FROM membership WHERE org_id = ? AND user_id != ?').get(legacyOwner.orgId, legacyOwner.userId).n, 0);
    assert.equal((await native.pool.query('SELECT status FROM org.member_invites WHERE id = $1', [invited.body.invitation_id])).rows[0].status, 'pending');
    assert.equal((await request(legacyReceiver, '/auth/invitations/verify', 'POST', { token: legacyInvite.body.token })).body.valid, true);
    assert.equal((await request(legacyReceiver, '/auth/invitations/accept', 'POST', { token: legacyInvite.body.token })).status, 201);
    assert.equal(conn.prepare('SELECT user_id FROM membership WHERE org_id = ? AND user_id != ?').get(legacyOwner.orgId, legacyOwner.userId).user_id, legacySignup.body.user.id);
    const bridge = conn.prepare("SELECT user_id FROM auth_identity WHERE provider = 'perp_db' AND subject = ?").get(receiver.userId);
    assert.notEqual(bridge.user_id, legacySignup.body.user.id);
    assert.equal(conn.prepare('SELECT count(*) AS n FROM membership WHERE user_id = ?').get(bridge.user_id).n, 0);
    const check = await request(receiver, '/pg/auth/invitations/verify', 'POST', { token });
    assert.equal(check.status, 200, JSON.stringify(check.body)); assert.equal(check.body.valid, true);
    const wrong = await request(outsider, '/pg/auth/invitations/accept', 'POST', { token });
    assert.equal(wrong.status, 400); assert.equal(wrong.body.error.details.reason, 'email_mismatch');
    assert.equal((await request({ ...receiver, orgId: sender.orgId }, '/pg/projects')).status, 403);
    const accept = () => request(receiver, '/pg/auth/invitations/accept', 'POST', { token });
    const accepted = await Promise.all([accept(), accept()]);
    assert.deepEqual(accepted.map(r => r.status), [201, 201], JSON.stringify(accepted));
    assert.equal(accepted[0].body.org_id, sender.orgId); receiver.orgId = sender.orgId;
    const project = await request(sender, '/pg/projects', 'POST', { name: 'Shared from sender' }); assert.equal(project.status, 201);
    const shared = await request(receiver, '/pg/projects'); assert.equal(shared.status, 200); assert.ok(shared.body.items.some(r => r.__id === project.body.id));
    assert.equal((await request(sender, `/pg/projects/${project.body.id}`, 'PATCH', { version: 1, name: 'Updated on server' })).status, 200);
    assert.ok((await request(receiver, '/pg/projects')).body.items.some(r => r['프로젝트'] === 'Updated on server'));
    assert.equal((await request(receiver, '/pg/projects', 'POST', { name: 'Not allowed' })).status, 403);
    assert.equal((await request({ ...receiver, orgId: `pg:${native.otherCompanyId}` }, '/pg/projects')).status, 403);
    const note = await request(sender, '/pg/vault/notes', 'POST', { title: 'Sender private', content: 'not shared' }); assert.equal(note.status, 201, JSON.stringify(note.body));
    assert.equal((await request(receiver, `/pg/vault/notes/${note.body.id}`)).status, 404);
    const login = await request(null, '/pg/auth/login', 'POST', { email: receiver.email, password: 'password-1234' }); assert.equal(login.status, 200);
    assert.ok((await request({ token: login.body.token }, '/pg/auth/workspace')).body.organizations.some(o => o.org_id === sender.orgId));
    assert.equal((await request({ ...receiver, token: login.body.token }, '/pg/projects')).status, 200);
    assert.equal((await create('bad-role@example.invalid', ['platform_admin'])).status, 403);
    const foreignRole = (await native.pool.query('SELECT id FROM org.roles WHERE company_id = $1 LIMIT 1', [native.otherCompanyId])).rows[0].id;
    assert.equal((await create('foreign-role@example.invalid', [String(foreignRole)])).status, 400);
    assert.equal((await request(receiver, '/pg/members/invites', 'POST', { email: outsider.email, roles: [role.body.key] })).status, 403);
    assert.equal((await request(outsider, '/pg/auth/invitations/accept', 'POST', { invitation_id: invited.body.invitation_id })).status, 400);
    assert.equal((await request(null, '/pg/auth/invitations/verify', 'POST', { token })).status, 401);
    assert.equal((await request(outsider, '/pg/auth/invitations/verify', 'POST', { token: 'http://example.invalid/?invite=%ZZ' })).status, 400);
    assert.deepEqual((await native.pool.query('SELECT company_id, is_admin FROM auth.users WHERE id = $1', [receiver.userId])).rows[0], { company_id: null, is_admin: false });
    assert.equal((await native.pool.query('SELECT count(*)::int AS n FROM org.user_roles WHERE user_id = $1 AND role_id = $2', [receiver.userId, role.body.key])).rows[0].n, 1);
    assert.equal((await native.pool.query("SELECT count(*)::int AS n FROM org.role_change_events WHERE company_id = $1 AND action = 'member.invitation.accepted'", [sender.orgId.slice(3)])).rows[0].n, 1);
    for (const state of ['expired', 'revoked']) {
      const invited = await create(outsider.email); assert.equal(invited.status, 201);
      if (state === 'expired') await native.pool.query("UPDATE org.member_invites SET expires_at = now() - interval '1 second' WHERE id = $1", [invited.body.invitation_id]);
      else assert.equal((await request(sender, `/pg/members/invites/${invited.body.invitation_id}/revoke`, 'POST')).status, 200);
      const r = await request(outsider, '/pg/auth/invitations/accept', 'POST', { token: invited.body.token });
      assert.equal(r.status, 400); assert.equal(r.body.error.details.reason, state);
    }
    // Pending invitations re-evaluate the inviter's current grants under the company lock.
    const limited = await signup('limited-inviter@example.invalid');
    const managerRole = await request(sender, '/settings/roles', 'POST', { name: 'Invitation manager', scope: 'all', permissions: ['menu.members', 'member.read', 'member.write', 'role.assign', 'menu.projects', 'project.read'] });
    assert.equal(managerRole.status, 201);
    const managerInvite = await create(limited.email, [managerRole.body.key]); assert.equal(managerInvite.status, 201);
    assert.equal((await request(limited, '/pg/auth/invitations/accept', 'POST', { token: managerInvite.body.token })).status, 201); limited.orgId = sender.orgId;
    const pending = await request(limited, '/pg/members/invites', 'POST', { email: outsider.email, roles: [role.body.key] }); assert.equal(pending.status, 201);
    const roleChange = await request(sender, `/settings/roles/${managerRole.body.key}`, 'PATCH', { expected_version: managerRole.body.version, name: 'Invitation manager', scope: 'all', permissions: ['menu.members', 'member.read', 'member.write', 'role.assign'] });
    assert.equal(roleChange.status, 200);
    assert.equal((await request(outsider, '/pg/auth/invitations/accept', 'POST', { token: pending.body.token })).status, 403);
    assert.equal((await native.pool.query('SELECT count(*)::int AS n FROM org.company_memberships WHERE user_id = $1', [outsider.userId])).rows[0].n, 0);
    assert.equal((await request(sender, `/pg/members/invites/${pending.body.invitation_id}/revoke`, 'POST')).status, 200);
    // A failed audit cannot leave a membership or partially consume the token.
    const atomic = await create(outsider.email); assert.equal(atomic.status, 201);
    await native.pool.query("CREATE FUNCTION org.invite_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'member.invitation.accepted' THEN RAISE EXCEPTION 'isolated invitation audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER invite_test_failure BEFORE INSERT ON org.role_change_events FOR EACH ROW EXECUTE FUNCTION org.invite_test_failure()");
    assert.equal((await request(outsider, '/pg/auth/invitations/accept', 'POST', { token: atomic.body.token })).status, 500);
    assert.equal((await native.pool.query('SELECT count(*)::int AS n FROM org.company_memberships WHERE user_id = $1', [outsider.userId])).rows[0].n, 0);
    assert.equal((await native.pool.query('SELECT status FROM org.member_invites WHERE id = $1', [atomic.body.invitation_id])).rows[0].status, 'pending');
    await native.pool.query('DROP TRIGGER invite_test_failure ON org.role_change_events; DROP FUNCTION org.invite_test_failure()');
    await native.pool.query("UPDATE org.company_memberships SET status = 'left' WHERE company_id = $1 AND user_id = $2", [sender.orgId.slice(3), receiver.userId]);
    assert.equal((await accept()).status, 400);
  } finally {
    await server?.close();
    const { pgPool } = await import('../src/config/pg.js'); await pgPool.end();
    await native.close();
  }
});
