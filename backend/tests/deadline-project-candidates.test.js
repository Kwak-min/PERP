import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assertIsolated, evidenceBody } from './deadline-fixture.js';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { startTestServer } from './http.js';

const evidence = path.resolve('.omo/evidence/task-10-deadline-erp-redesign', process.env.DEADLINE_RUN_ID);
const http = [], states = [];
let native, server, database, closePgPool, cluster, port, nativeVersion;
const password = 'deadline-candidates-password';
async function request(actor, route, method = 'GET', body, expected = 200) {
  const response = await fetch(server.baseUrl + route, { method,
    headers: { 'Content-Type': 'application/json', ...(actor?.token ? { Authorization: `Bearer ${actor.token}` } : {}), ...(actor?.orgId ? { 'X-Org-Id': actor.orgId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  http.push({ actor: actor?.userId ?? null, orgId: actor?.orgId ?? null, route, method, status: response.status, body: evidenceBody(result) });
  assert.ok([expected].flat().includes(response.status), `${method} ${route}: expected ${expected}, got ${response.status}: ${JSON.stringify(evidenceBody(result))}`);
  return result;
}
async function company(prefix, label) {
  const signup = await request(null, `${prefix}/auth/signup`, 'POST', { email: `${label}@example.invalid`, name: label, password }, 201);
  const actor = { token: signup.token ?? signup.access_token, userId: signup.user.id };
  const created = await request(actor, prefix ? '/pg/companies' : '/tenants', 'POST', {
    name: label, modules: ['projects', 'tasks'], features: [], departments: [], ...(!prefix ? { type: 'custom' } : {}),
  }, 201);
  actor.orgId = created.org_id;
  return actor;
}
async function assignRoles(state, membershipId, roles) {
  const current = (await request(state.admin, '/settings/members')).items.find(row => row.membership_id === membershipId);
  return request(state.admin, `/settings/members/${membershipId}/roles`, 'PUT', { roles, expected_roles_version: current.roles_version });
}
async function member(state, name, permissions) {
  const role = await request(state.admin, '/settings/roles', 'POST', { name, scope: 'all', permissions }, 201);
  const email = `${state.prefix ? 'pg' : 'legacy'}-${name}@example.invalid`;
  let userId, membershipId, token;
  if (state.prefix) {
    const created = await request(state.admin, '/pg/members', 'POST', { email, name, password }, 201);
    userId = created.id; membershipId = userId;
    await assignRoles(state, membershipId, [role.key]);
    token = (await request(null, '/pg/auth/login', 'POST', { email, password })).token;
  } else {
    const invite = await request(state.admin, '/members/invites', 'POST', { email, roles: [role.key] }, 201);
    const created = await request(null, '/auth/signup', 'POST', { email, name, password, invitation_token: invite.token }, 201);
    userId = created.user.id; token = created.access_token;
    membershipId = (await request(state.admin, '/members')).items.find(row => row.user_id === userId).membership_id;
  }
  return { userId, membershipId, token, orgId: state.admin.orgId, role: role.key };
}
before(async () => {
  assertIsolated();
  await mkdir(evidence, { recursive: true });
  native = await startDailyNativePostgres();
  await native.pool.query(await readFile(new URL('../../db/perp_additions_v11_deadline_roles.sql', import.meta.url), 'utf8'));
  cluster = path.dirname((await native.pool.query('SHOW data_directory')).rows[0].data_directory);
  port = Number(process.env.PG_PORT);
  nativeVersion = (await native.pool.query('SHOW server_version')).rows[0].server_version;
  assert.match(nativeVersion, /^18\.6(?:\s|$)/);
  server = await startTestServer();
  ({ db: database } = await import('../src/config/db.js'));
  ({ closePgPool } = await import('../src/config/pg.js'));
  for (const prefix of ['', '/pg']) {
    const state = { prefix, admin: await company(prefix, `${prefix ? 'pg' : 'legacy'}-candidates-a`), foreign: await company(prefix, `${prefix ? 'pg' : 'legacy'}-candidates-b`) };
    state.writer = await member(state, 'project-writer', ['menu.projects', 'project.write']);
    state.taskWriter = await member(state, 'task-writer', ['menu.projects', 'task.write']);
    state.reader = await member(state, 'reader', ['menu.projects', 'project.read', 'task.read']);
    state.noMenu = await member(state, 'no-menu', ['project.write', 'task.write']);
    state.candidate = await member(state, 'candidate', ['menu.home']);
    state.inactive = await member(state, 'inactive', ['menu.home']);
    state.pending = await member(state, 'pending', ['menu.home']);
    state.left = await member(state, 'left', ['menu.home']);
    states.push(state);
    const department = await request(state.admin, `${prefix}/members/departments`, 'POST', { name: 'Candidate department' }, 201);
    await request(state.admin, `${prefix}/members/${state.candidate.membershipId}/assignment`, 'PATCH', { department_id: department.id });
    // primary 회사가 달라도 선택 회사의 실제 membership/부서만 사용한다.
    if (prefix) await native.pool.query('UPDATE auth.users SET company_id=$1, department_id=NULL WHERE id=$2', [state.foreign.orgId.slice(3), state.candidate.userId]);
    await setAccount(state, state.inactive, false);
    await setApproval(state, state.pending, false);
    await setMembership(state, state.left, false);
  }
}, { timeout: 90000 });
after(async () => {
  const cleanup = { apiClosed: false, poolClosed: false, clusterRemoved: false, pid: process.pid, apiPort: server ? Number(new URL(server.baseUrl).port) : null, pgPort: port, cluster, errors: [] };
  try { await server?.close(); cleanup.apiClosed = true; } catch (error) { cleanup.errors.push(error.message); }
  try { await closePgPool?.(); cleanup.poolClosed = true; } catch (error) { cleanup.errors.push(error.message); }
  try { await native?.close(); cleanup.clusterRemoved = cluster ? !existsSync(cluster) : true; } catch (error) { cleanup.errors.push(error.message); }
  await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify({ nativeVersion, http }, null, 2));
  await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
  assert.deepEqual(cleanup.errors, []);
  assert.equal(cleanup.clusterRemoved, true);
});
async function setAccount(state, actor, active) {
  if (state.prefix) await native.pool.query('UPDATE auth.users SET account_status=$1 WHERE id=$2', [active ? 'active' : 'suspended', actor.userId]);
  else database().prepare('UPDATE app_user SET auth_status=? WHERE id=?').run(active ? 'active' : 'inactive', actor.userId);
}
async function setApproval(state, actor, approved) {
  if (state.prefix) await native.pool.query('UPDATE auth.users SET approval_status=$1 WHERE id=$2', [approved ? 'approved' : 'pending', actor.userId]);
  else database().prepare('UPDATE app_user SET auth_status=? WHERE id=?').run(approved ? 'active' : 'pending', actor.userId);
}
async function setMembership(state, actor, active) {
  if (state.prefix) await native.pool.query('UPDATE org.company_memberships SET status=$1 WHERE company_id=$2 AND user_id=$3', [active ? 'active' : 'left', state.admin.orgId.slice(3), actor.userId]);
  else database().prepare('UPDATE membership SET status=? WHERE id=?').run(active ? 'active' : 'left', actor.membershipId);
}
async function setup(state) {
  const project = await request(state.admin, `${state.prefix}/projects`, 'POST', { name: 'Candidate contract project' }, 201);
  const task = await request(state.admin, `${state.prefix}/tasks`, 'POST', { title: 'Candidate contract task', project_id: project.id, assignee_id: null }, 201);
  return { project, task, candidates: `${state.prefix}/projects/${project.id}/candidates`, members: `${state.prefix}/projects/${project.id}/members`, assignees: `${state.prefix}/tasks/${task.id}/assignees`, taskPath: `${state.prefix}/tasks/${task.id}` };
}
function dto(items) {
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), ['already_member', 'department_name', 'id', 'name']);
    assert.equal(typeof item.id, 'string'); assert.equal(typeof item.name, 'string'); assert.equal(typeof item.already_member, 'boolean');
    assert.ok(item.department_name === null || typeof item.department_name === 'string');
  }
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
}
async function snapshot(state) {
  if (state.prefix) return Promise.all([['project.project_members', 'project_id,user_id'], ['project.tasks', 'id'], ['org.daily_correction_events', 'id'], ['notice.notifications', 'id'], ['org.user_roles', 'user_id,role_id']].map(async ([table, order]) => (await native.pool.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows));
  return ['project_member', 'task', 'audit_event', 'notification', 'membership'].map(table => database().prepare(`SELECT * FROM ${table} ORDER BY id`).all());
}
for (const prefix of ['', '/pg']) {
  const label = prefix || 'legacy';
  test(`${label}: writer candidates are minimal, selected-company active accounts; duplicate/lead adds are idempotent`, async () => {
    const state = states.find(item => item.prefix === prefix), rows = await setup(state);
    const candidates = await request(state.writer, rows.candidates);
    dto(candidates.items);
    assert.deepEqual(new Set(candidates.items.map(item => item.id)), new Set([state.admin, state.writer, state.taskWriter, state.reader, state.noMenu, state.candidate].map(actor => actor.userId)));
    assert.equal(candidates.items.find(item => item.id === state.admin.userId).already_member, true);
    assert.equal(candidates.items.find(item => item.id === state.candidate.userId).already_member, false);
    assert.equal(candidates.items.find(item => item.id === state.candidate.userId).department_name, 'Candidate department');
    assert.equal(candidates.items.find(item => item.id === state.writer.userId).department_name, null);
    assert.equal((await request(state.writer, rows.members, 'POST', { user_id: state.candidate.userId }, 201)).created, true);
    const before = await snapshot(state);
    assert.equal((await request(state.writer, rows.members, 'POST', { user_id: state.candidate.userId })).created, false);
    assert.equal((await request(state.writer, rows.members, 'POST', { user_id: state.admin.userId })).created, false);
    assert.deepEqual(await snapshot(state), before);
    assert.equal((await request(state.writer, rows.candidates)).items.find(item => item.id === state.candidate.userId).already_member, true);
    assert.equal((await request(state.admin, rows.members)).items.filter(item => item.value === state.candidate.userId).length, 1);
  });
  test(`${label}: task writer without project/member read sees only project assignees and can assign without granting roles`, async () => {
    const state = states.find(item => item.prefix === prefix), rows = await setup(state);
    await request(state.writer, rows.members, 'POST', { user_id: state.candidate.userId }, 201);
    const assignees = await request(state.taskWriter, rows.assignees);
    dto(assignees.items);
    assert.deepEqual(new Set(assignees.items.map(item => item.id)), new Set([state.admin.userId, state.candidate.userId]));
    assert.ok(assignees.items.every(item => item.already_member));
    const rolesBefore = (await snapshot(state))[4];
    await request(state.taskWriter, rows.taskPath, 'PATCH', { version: 1, assignee_id: state.candidate.userId });
    const before = await snapshot(state);
    assert.deepEqual(before[4], rolesBefore);
    const same = await request(state.taskWriter, rows.taskPath, 'PATCH', { version: 2, assignee_id: state.candidate.userId });
    assert.equal(same.version, 2); assert.deepEqual(await snapshot(state), before);
    await request(state.candidate, rows.taskPath, 'GET', undefined, prefix ? 404 : 403);
    await request(state.candidate, prefix ? `/pg/records/tasks/${rows.task.id}` : rows.taskPath, 'GET', undefined, 403);
  });
  test(`${label}: action/menu/read/auth gates and foreign resource hiding are preserved`, async () => {
    const state = states.find(item => item.prefix === prefix), rows = await setup(state);
    for (const [actor, routes] of [[state.writer, [rows.members, prefix ? '/pg/members/options' : `/members/${state.candidate.userId}/profile`, `${prefix}/members`, rows.assignees]], [state.taskWriter, [rows.members, rows.candidates]], [state.reader, [rows.candidates, rows.assignees]], [state.noMenu, [rows.candidates, rows.assignees]]]) {
      for (const route of routes) await request(actor, route, 'GET', undefined, 403);
    }
    for (const route of [rows.candidates, rows.assignees]) {
      await request(state.foreign, route, 'GET', undefined, 404);
      await request(null, route, 'GET', undefined, 401);
      await request({ ...state.writer, orgId: state.foreign.orgId }, route, 'GET', undefined, 403);
    }
    await request(state.writer, `${prefix}/projects/not-an-id/candidates`, 'GET', undefined, 400);
    await request(state.taskWriter, `${prefix}/tasks/not-an-id/assignees`, 'GET', undefined, 400);
    const before = await snapshot(state);
    await request(state.reader, rows.members, 'POST', { user_id: state.candidate.userId }, 403);
    await request(state.writer, rows.members, 'POST', { user_id: state.foreign.userId }, 403);
    await request(state.foreign, rows.members, 'POST', { user_id: state.foreign.userId }, 404);
    for (const body of [{}, { user_id: null }, { user_id: '' }, { user_id: {} }, { user_id: state.candidate.userId, company_id: state.foreign.orgId }]) await request(state.writer, rows.members, 'POST', body, 400);
    await request(state.taskWriter, rows.taskPath, 'PATCH', { version: '1', assignee_id: state.candidate.userId }, 400);
    assert.deepEqual(await snapshot(state), before);
  });
  test(`${label}: POST/PATCH revalidate candidates after account, approval, membership and project-roster changes`, async () => {
    const state = states.find(item => item.prefix === prefix), rows = await setup(state);
    await request(state.writer, rows.candidates);
    for (const inactive of [state.inactive, state.pending, state.left]) await request(state.writer, rows.members, 'POST', { user_id: inactive.userId }, 403);
    for (const mutate of [setAccount, setApproval, setMembership]) {
      await mutate(state, state.candidate, false);
      try {
        const before = await snapshot(state);
        await request(state.writer, rows.members, 'POST', { user_id: state.candidate.userId }, 403);
        assert.deepEqual(await snapshot(state), before);
        assert.ok(!(await request(state.writer, rows.candidates)).items.some(item => item.id === state.candidate.userId));
      } finally { await mutate(state, state.candidate, true); }
    }
    await request(state.writer, rows.members, 'POST', { user_id: state.candidate.userId }, 201);
    await request(state.taskWriter, rows.assignees);
    for (const mutate of [setAccount, setApproval, setMembership]) {
      await mutate(state, state.candidate, false);
      try {
        const before = await snapshot(state);
        await request(state.taskWriter, rows.taskPath, 'PATCH', { version: 1, assignee_id: state.candidate.userId }, 403);
        await request(state.writer, rows.members, 'POST', { user_id: state.candidate.userId }, 403);
        assert.deepEqual(await snapshot(state), before);
        assert.ok(!(await request(state.taskWriter, rows.assignees)).items.some(item => item.id === state.candidate.userId));
      } finally { await mutate(state, state.candidate, true); }
    }
    if (prefix) await native.pool.query('DELETE FROM project.project_members WHERE project_id=$1 AND user_id=$2', [rows.project.id, state.candidate.userId]);
    else database().prepare('UPDATE project_member SET deleted_at=? WHERE project_id=? AND user_id=?').run(new Date().toISOString(), rows.project.id, state.candidate.userId);
    const before = await snapshot(state);
    await request(state.taskWriter, rows.taskPath, 'PATCH', { version: 1, assignee_id: state.candidate.userId }, 403);
    assert.deepEqual(await snapshot(state), before);
    assert.ok(!(await request(state.taskWriter, rows.assignees)).items.some(item => item.id === state.candidate.userId));
  });
  test(`${label}: member/audit and assignment/notification failures roll back native transactions`, async () => {
    const state = states.find(item => item.prefix === prefix), rows = await setup(state);
    let before = await snapshot(state);
    if (prefix) await native.pool.query("CREATE FUNCTION org.t10_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 't10 injected write failure'; END $$; CREATE TRIGGER t10_reject BEFORE INSERT ON org.daily_correction_events FOR EACH ROW EXECUTE FUNCTION org.t10_reject()");
    else database().exec("CREATE TRIGGER t10_reject BEFORE INSERT ON audit_event BEGIN SELECT RAISE(ABORT, 't10 injected write failure'); END");
    try {
      await request(state.writer, rows.members, 'POST', { user_id: state.candidate.userId }, 500);
      assert.deepEqual(await snapshot(state), before);
    } finally {
      if (prefix) await native.pool.query('DROP TRIGGER t10_reject ON org.daily_correction_events');
      else database().exec('DROP TRIGGER t10_reject');
    }
    await request(state.writer, rows.members, 'POST', { user_id: state.candidate.userId }, 201);
    before = await snapshot(state);
    if (prefix) await native.pool.query('CREATE TRIGGER t10_reject BEFORE INSERT ON notice.notifications FOR EACH ROW EXECUTE FUNCTION org.t10_reject()');
    else database().exec("CREATE TRIGGER t10_reject BEFORE INSERT ON notification BEGIN SELECT RAISE(ABORT, 't10 injected write failure'); END");
    try {
      await request(state.taskWriter, rows.taskPath, 'PATCH', { version: 1, assignee_id: state.candidate.userId }, 500);
      assert.deepEqual(await snapshot(state), before);
      await request(state.taskWriter, `${prefix}/tasks`, 'POST', { title: 'Rollback creation', project_id: rows.project.id, assignee_id: state.candidate.userId }, 500);
      assert.deepEqual(await snapshot(state), before);
    } finally {
      if (prefix) await native.pool.query('DROP TRIGGER t10_reject ON notice.notifications; DROP FUNCTION org.t10_reject()');
      else database().exec('DROP TRIGGER t10_reject');
    }
  });
  test(`${label}: simultaneous duplicate additions store one roster row and one audit event`, async () => {
    const state = states.find(item => item.prefix === prefix), rows = await setup(state);
    const before = await snapshot(state);
    const results = await Promise.all([1, 2].map(() => request(state.writer, rows.members, 'POST', { user_id: state.candidate.userId }, [200, 201])));
    assert.deepEqual(results.map(result => result.created).sort(), [false, true]);
    const after = await snapshot(state);
    assert.equal(after[0].length, before[0].length + 1);
    assert.equal(after[2].length, before[2].length + 1);
    assert.equal((await request(state.admin, rows.members)).items.filter(item => item.value === state.candidate.userId).length, 1);
  });
  test(`${label}: stale assignment and freshly revoked actor permission reject without mutation`, async () => {
    const state = states.find(item => item.prefix === prefix), rows = await setup(state);
    await request(state.writer, rows.members, 'POST', { user_id: state.candidate.userId }, 201);
    await request(state.taskWriter, rows.taskPath, 'PATCH', { version: 1, assignee_id: state.candidate.userId });
    let before = await snapshot(state);
    await request(state.taskWriter, rows.taskPath, 'PATCH', { version: 1, assignee_id: state.candidate.userId }, 409);
    assert.deepEqual(await snapshot(state), before);
    await request(state.taskWriter, rows.assignees);
    await assignRoles(state, state.taskWriter.membershipId, [state.reader.role]);
    try {
      before = await snapshot(state);
      await request(state.taskWriter, rows.taskPath, 'PATCH', { version: 1, assignee_id: state.candidate.userId }, 403);
      await request(state.taskWriter, rows.assignees, 'GET', undefined, 403);
      assert.deepEqual(await snapshot(state), before);
    } finally { await assignRoles(state, state.taskWriter.membershipId, [state.taskWriter.role]); }
  });
}
