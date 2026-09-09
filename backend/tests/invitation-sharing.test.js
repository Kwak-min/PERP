import assert from 'node:assert/strict';
import test from 'node:test';
import { api, createOwnerOrg, startTestServer } from './http.js';

test('recipient token joins once; wrong recipients and revoked/expired tokens cannot grant access', async () => {
  const server = await startTestServer();
  try {
    const owner = await createOwnerOrg(server.baseUrl, ['projects']);
    const signup = await api(server.baseUrl, '/auth/signup', { method: 'POST', body: { email: 'invite-receiver@example.invalid', name: 'Receiver', password: 'password-1234' } });
    const receiver = { token: signup.body.access_token, orgId: owner.orgId };
    const create = email => api(server.baseUrl, '/members/invites', { ...owner, method: 'POST', body: { email, roles: ['member'] } });
    const invite = await create('invite-receiver@example.invalid');
    assert.equal(invite.status, 201);
    assert.equal((await api(server.baseUrl, '/members', receiver)).status, 403);
    const check = await api(server.baseUrl, '/auth/invitations/verify', { ...owner, method: 'POST', body: { token: invite.body.token } });
    assert.equal(check.body.reason, 'email_mismatch');
    const accept = actor => api(server.baseUrl, '/auth/invitations/accept', { ...actor, orgId: null, method: 'POST', body: { token: `https://example.invalid/invitations?invite=${invite.body.token}` } });
    assert.equal((await accept(owner)).status, 400);
    assert.equal((await accept(receiver)).status, 201);
    assert.equal((await accept(receiver)).status, 201, 'safe replay returns the original organization without new grants');
    assert.equal((await api(server.baseUrl, '/members', receiver)).status, 200);
    const conn = (await import('../src/config/db.js')).db();
    assert.equal(conn.prepare('SELECT count(*) AS n FROM membership WHERE org_id = ? AND user_id = ?').get(owner.orgId, signup.body.user.id).n, 1);
    conn.prepare("UPDATE membership SET status = 'left' WHERE org_id = ? AND user_id = ?").run(owner.orgId, signup.body.user.id);
    assert.equal((await accept(receiver)).status, 400, 'replay cannot revive membership');
    for (const state of ['expired', 'revoked']) {
      const other = await create(`${state}@example.invalid`);
      assert.equal(other.status, 201);
      if (state === 'expired') conn.prepare("UPDATE invitation SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(other.body.id);
      else assert.equal((await api(server.baseUrl, `/members/invites/${other.body.id}/revoke`, { ...owner, method: 'POST' })).status, 200);
      assert.equal((await api(server.baseUrl, '/auth/invitations/verify', { ...owner, method: 'POST', body: { token: other.body.token } })).body.valid, false);
    }
  } finally { await server.close(); }
});
