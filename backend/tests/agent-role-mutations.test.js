import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startDeadlineServer } from './deadline-fixture.js';

let server;
let db;

before(async () => {
  server = await startDeadlineServer();
  ({ db } = await import('../src/config/db.js'));
});

after(async () => {
  await server?.close();
});

const request = (...args) => server.request(...args);
const agentPermissions = ['menu.agent', 'agent.chat', 'approval.request', 'menu.approvals'];
const row = id => db().prepare('SELECT id, roles, status, version, roles_version FROM membership WHERE id = ?').get(id);

async function raw(actor, route, body) {
  const response = await fetch(server.baseUrl + route, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${actor.token}`,
      'X-Org-Id': actor.orgId,
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const signup = await request(null, '/auth/signup', 'POST', {
    email: `owner-${suffix}@example.invalid`,
    name: 'Owner',
    password: 'password-1234',
  }, 201);
  const owner = { token: signup.access_token, userId: signup.user.id };
  const company = await request(owner, '/tenants', 'POST', {
    name: suffix,
    type: 'custom',
    modules: ['agent', 'approvals', 'hr', 'tasks'],
    features: ['approvals'],
    departments: [],
  }, 201);
  owner.orgId = company.org_id;

  const basic = await request(owner, '/settings/roles', 'POST', {
    name: `Basic ${suffix}`,
    scope: 'all',
    permissions: ['task.read'],
  }, 201);
  const next = await request(owner, '/settings/roles', 'POST', {
    name: `Next ${suffix}`,
    scope: 'all',
    permissions: ['task.read', 'task.write'],
  }, 201);
  const operator = await request(owner, '/settings/roles', 'POST', {
    name: `Agent operator ${suffix}`,
    scope: 'all',
    permissions: [...agentPermissions, 'menu.members', 'member.write', 'role.assign', 'task.read', 'task.write'],
  }, 201);
  const fallback = await request(owner, '/settings/roles', 'POST', {
    name: `Agent fallback ${suffix}`,
    scope: 'all',
    permissions: agentPermissions,
  }, 201);
  const statusOnly = await request(owner, '/settings/roles', 'POST', {
    name: `Status only ${suffix}`,
    scope: 'all',
    permissions: [...agentPermissions, 'menu.members', 'member.write'],
  }, 201);

  async function join(label, role) {
    const email = `${label}-${suffix}@example.invalid`;
    const invitation = await request(owner, '/members/invites', 'POST', { email, roles: [role.key] }, 201);
    const joined = await request(null, '/auth/signup', 'POST', {
      email,
      name: label,
      password: 'password-1234',
      invitation_token: invitation.token,
    }, 201);
    return { token: joined.access_token, userId: joined.user.id, orgId: owner.orgId };
  }

  const actor = await join('operator', operator);
  const limited = await join('status-only', statusOnly);
  const target = await join('target', basic);
  const members = (await request(owner, '/settings/members')).items;
  const membership = actorValue => members.find(item => item.user_id === actorValue.userId);
  return {
    owner,
    actor,
    limited,
    target,
    own: membership(owner),
    actorMembership: membership(actor),
    targetMembership: membership(target),
    basic,
    next,
    operator,
    fallback,
  };
}

async function approved(actor, approver, tool, input) {
  const action = await request(actor, '/agent/actions', 'POST', {
    tool,
    input,
    approver_id: approver.userId,
  }, 201);
  await request(approver, `/approvals/requests/${action.approval_id}/actions`, 'POST', { decision: 'approve' });
  return action;
}

const execute = (actor, action) => raw(actor, `/agent/actions/${action.id}/execute`, { reauth_password: 'password-1234' });
const rollback = (actor, action) => raw(actor, `/agent/actions/${action.id}/rollback`, {});

test('agent role execution requires CAS, rejects non-company roles, and preserves denied writes', async () => {
  const f = await fixture();
  const id = f.targetMembership.membership_id;

  const missing = await approved(f.actor, f.owner, 'change.permission', {
    membership_id: id,
    roles: [f.next.key],
  });
  const missingBefore = row(id);
  assert.equal((await execute(f.actor, missing)).status, 400);
  assert.deepEqual(row(id), missingBefore);

  for (const [roles, expectedStatus] of [
    [['owner'], 403],
    [['platform_admin'], 403],
    [['unknown-role'], 400],
  ]) {
    const current = row(id);
    const action = await approved(f.actor, f.owner, 'change.permission', {
      membership_id: id,
      roles,
      expected_roles_version: current.roles_version,
    });
    const response = await execute(f.actor, action);
    assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
    assert.deepEqual(row(id), current);
  }
});

test('authorized agent role execution and rollback use membership CAS and transactional audit', async () => {
  const f = await fixture();
  const id = f.targetMembership.membership_id;
  const action = await approved(f.actor, f.owner, 'change.permission', {
    membership_id: id,
    roles: [f.next.key],
    expected_roles_version: f.targetMembership.roles_version,
  });

  const executed = await execute(f.actor, action);
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.deepEqual(executed.body.result.roles, [f.next.key]);
  assert.equal(executed.body.result.roles_version, f.targetMembership.roles_version + 1);
  assert.equal(row(id).roles_version, f.targetMembership.roles_version + 1);
  assert.deepEqual(executed.body.rollback_ref, {
    kind: 'restore_member_roles',
    resource: 'membership',
    id,
    roles: [f.basic.key],
    expected_roles_version: f.targetMembership.roles_version + 1,
  });

  const roleAudit = db().prepare("SELECT * FROM audit_event WHERE action = 'member.roles.changed' AND resource_id = ? ORDER BY seq DESC LIMIT 1").get(id);
  assert.equal(roleAudit.resource_type, 'membership');

  const rolledBack = await rollback(f.actor, action);
  assert.equal(rolledBack.status, 200, JSON.stringify(rolledBack.body));
  assert.equal(row(id).roles, f.basic.key);
  assert.equal(row(id).roles_version, f.targetMembership.roles_version + 2);
  assert.equal(db().prepare("SELECT count(*) AS count FROM audit_event WHERE action = 'member.roles.changed' AND resource_id = ?").get(id).count, 2);
});

test('agent role execution rejects stale versions and audit failure rolls back the membership write', async () => {
  const f = await fixture();
  const id = f.targetMembership.membership_id;
  const stale = await approved(f.actor, f.owner, 'change.permission', {
    membership_id: id,
    roles: [f.next.key],
    expected_roles_version: f.targetMembership.roles_version,
  });
  await request(f.owner, `/settings/members/${id}/roles`, 'PUT', {
    roles: [f.next.key],
    expected_roles_version: f.targetMembership.roles_version,
  });
  const staleBefore = row(id);
  assert.equal((await execute(f.actor, stale)).status, 409);
  assert.deepEqual(row(id), staleBefore);

  const action = await approved(f.actor, f.owner, 'change.permission', {
    membership_id: id,
    roles: [f.basic.key],
    expected_roles_version: staleBefore.roles_version,
  });
  const beforeFailure = row(id);
  db().exec(`CREATE TRIGGER fail_agent_role_audit BEFORE INSERT ON audit_event
    WHEN NEW.action = 'member.roles.changed'
    BEGIN SELECT RAISE(ABORT, 'forced role audit failure'); END`);
  try {
    assert.equal((await execute(f.actor, action)).status, 500);
  } finally {
    db().exec('DROP TRIGGER fail_agent_role_audit');
  }
  assert.deepEqual(row(id), beforeFailure);
  assert.equal(db().prepare('SELECT status FROM agent_action WHERE id = ?').get(action.id).status, 'awaiting_approval');
});

test('agent status execution requires fresh role authority, protects the last admin, and supports authorized rollback', async () => {
  const f = await fixture();

  const denied = await approved(f.limited, f.owner, 'change.member_status', {
    membership_id: f.own.membership_id,
    status: 'inactive',
    expected_roles_version: f.own.roles_version,
  });
  const ownerBefore = row(f.own.membership_id);
  assert.equal((await execute(f.limited, denied)).status, 403);
  assert.deepEqual(row(f.own.membership_id), ownerBefore);

  const lastAdmin = await approved(f.owner, f.owner, 'change.member_status', {
    membership_id: f.own.membership_id,
    status: 'inactive',
    expected_roles_version: f.own.roles_version,
  });
  assert.equal((await execute(f.owner, lastAdmin)).status, 409);
  assert.deepEqual(row(f.own.membership_id), ownerBefore);

  const targetId = f.targetMembership.membership_id;
  const status = await approved(f.owner, f.owner, 'change.member_status', {
    membership_id: targetId,
    status: 'inactive',
    expected_roles_version: f.targetMembership.roles_version,
  });
  const executed = await execute(f.owner, status);
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.equal(row(targetId).status, 'inactive');
  assert.equal(row(targetId).roles_version, f.targetMembership.roles_version + 1);

  const rolledBack = await rollback(f.owner, status);
  assert.equal(rolledBack.status, 200, JSON.stringify(rolledBack.body));
  assert.equal(row(targetId).status, 'active');
  assert.equal(row(targetId).roles_version, f.targetMembership.roles_version + 2);
});

test('agent rollback uses the post-execution roles version and rejects intervening writes', async () => {
  const f = await fixture();
  const id = f.targetMembership.membership_id;
  const action = await approved(f.actor, f.owner, 'change.permission', {
    membership_id: id,
    roles: [f.next.key],
    expected_roles_version: f.targetMembership.roles_version,
  });
  assert.equal((await execute(f.actor, action)).status, 200);
  await request(f.owner, `/settings/members/${id}/roles`, 'PUT', {
    roles: [f.basic.key],
    expected_roles_version: f.targetMembership.roles_version + 1,
  });
  const beforeRollback = row(id);

  const response = await rollback(f.actor, action);
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.deepEqual(row(id), beforeRollback);
  assert.equal(db().prepare('SELECT status FROM agent_action WHERE id = ?').get(action.id).status, 'executed');
});

test('legacy membership rollback references cannot bypass the canonical role service', async () => {
  const f = await fixture();
  const id = f.targetMembership.membership_id;
  const action = await approved(f.actor, f.owner, 'change.permission', {
    membership_id: id,
    roles: [f.next.key],
    expected_roles_version: f.targetMembership.roles_version,
  });
  assert.equal((await execute(f.actor, action)).status, 200);
  const beforeRollback = row(id);
  db().prepare('UPDATE agent_action SET rollback_ref = ? WHERE id = ?').run(JSON.stringify({
    kind: 'restore_field',
    resource: 'membership',
    id,
    field: 'roles',
    value: 'owner,platform_admin,unknown-role',
  }), action.id);

  const response = await rollback(f.actor, action);
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.deepEqual(row(id), beforeRollback);
});

test('agent rollback rechecks current actor authority before restoring administrator roles', async () => {
  const f = await fixture();
  const id = f.actorMembership.membership_id;
  const action = await approved(f.actor, f.owner, 'change.permission', {
    membership_id: id,
    roles: [f.fallback.key],
    expected_roles_version: f.actorMembership.roles_version,
  });
  const executed = await execute(f.actor, action);
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  const beforeRollback = row(id);
  assert.equal(beforeRollback.roles, f.fallback.key);

  const response = await rollback(f.actor, action);
  assert.equal(response.status, 403, JSON.stringify(response.body));
  assert.deepEqual(row(id), beforeRollback);
  assert.equal(db().prepare('SELECT status FROM agent_action WHERE id = ?').get(action.id).status, 'executed');
});
