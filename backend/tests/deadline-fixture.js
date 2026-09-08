import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';

export function assertIsolated() {
  assert.equal(process.env.DEADLINE_ISOLATED, '1', 'Use scripts/run_deadline_isolated.mjs');
  assert.ok(process.env.DEADLINE_TEMP_ROOT);
  assert.equal(process.env.DATABASE_URL, '');
  assert.equal(process.env.PG_HOST, '127.0.0.1');
  assert.equal(process.env.PG_PORT, '1');
  assert.equal(process.env.DOTENV_CONFIG_PATH, path.join(process.env.DEADLINE_TEMP_ROOT, 'empty.env'));
}

// 기록은 합성 API 응답만 사용한다. 인증 토큰과 임시 비밀번호는 증거 파일에 남기지 않는다.
export function evidenceBody(value) {
  if (Array.isArray(value)) return value.map(evidenceBody);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|password|secret/i.test(key) ? '[redacted]' : evidenceBody(item)]));
  return value;
}

export async function startDeadlineServer(signal) {
  assertIsolated();
  const temporary = await mkdtemp(path.join(process.env.DEADLINE_TEMP_ROOT, 'fixture-'));
  process.env.ORBITFLOW_DATABASE_FILE = path.join(temporary, 'baseline.db');
  process.env.ORBITFLOW_AI_PROVIDER = 'echo';
  let server, closeDb, closePgPool;
  const resource = { kind: 'api', pid: process.pid, port: null, temporary, database: process.env.ORBITFLOW_DATABASE_FILE, closed: false, temporaryRemoved: false };
  async function close() {
    if (resource.closed) return;
    const errors = [];
    if (server?.listening) {
      try { await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); }
      catch (error) { errors.push(error); }
    }
    try { closeDb?.(); } catch (error) { errors.push(error); }
    try { await closePgPool?.(); } catch (error) { errors.push(error); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    resource.temporaryRemoved = !existsSync(temporary);
    resource.closed = !server?.listening && !errors.length;
    if (errors.length) throw new AggregateError(errors, 'API cleanup failed');
  }
  try {
    const [{ createApp }, { migrate }, database, pg] = await Promise.all([
      import('../src/app.js'), import('../src/config/migrate.js'), import('../src/config/db.js'), import('../src/config/pg.js'),
    ]);
    closeDb = database.closeDb; closePgPool = pg.closePgPool;
    signal?.throwIfAborted();
    migrate();
    server = createServer(createApp());
    const ready = once(server, 'listening', { signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]) });
    server.listen(0, '127.0.0.1');
    await ready;
    resource.port = server.address().port;
    assert.ok(!protectedPorts.has(resource.port));
    const baseUrl = `http://127.0.0.1:${resource.port}/api/v1`, http = [];
    async function request(actor, route, method = 'GET', body, expected = 200) {
      assert.ok(route.startsWith('/') && !route.startsWith('//'));
      const response = await fetch(baseUrl + route, {
        method,
        headers: { 'Content-Type': 'application/json', ...(actor?.token ? { Authorization: `Bearer ${actor.token}` } : {}), ...(actor?.orgId ? { 'X-Org-Id': actor.orgId } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
      });
      const text = await response.text(), result = text ? JSON.parse(text) : null;
      http.push({ method, route, actor: actor?.userId ?? null, orgId: actor?.orgId ?? null, status: response.status, body: evidenceBody(result) });
      assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(evidenceBody(result))}`);
      return result;
    }
    return { baseUrl, resource, http, request, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fixture setup and cleanup failed'); }
    throw error;
  }
}

export async function createDeadlineFixture(server) {
  const request = server.request;
  async function signup(name, email, invitation_token) {
    const response = await request(null, '/auth/signup', 'POST', { name, email, password: 'deadline-synthetic-password', ...(invitation_token ? { invitation_token } : {}) }, 201);
    return { token: response.access_token, userId: response.user.id, name: response.user.name, email: response.user.email };
  }
  async function company(name) {
    const actor = await signup(name + ' 관리자', name === 'DEADLINE_A' ? 'admin-a@example.invalid' : 'admin-b@example.invalid');
    const created = await request(actor, '/tenants', 'POST', {
      name, type: 'custom', modules: ['projects', 'tasks', 'calendar', 'finance', 'assets', 'hr', 'documents', 'agent', 'analytics', 'approvals'], features: ['approvals'], departments: [],
    }, 201);
    actor.orgId = created.org_id;
    return { actor, id: created.org_id, tenantId: created.tenant_id };
  }
  const A = await company('DEADLINE_A'), B = await company('DEADLINE_B');
  const managerRole = await request(A.actor, '/settings/roles', 'POST', { name: '검증 제한 관리자', scope: 'all', permissions: ['menu.home', 'menu.projects', 'project.read', 'task.read'] }, 201);
  const actors = [A.actor];
  for (let index = 1; index < 25; index++) {
    const email = `member-${String(index).padStart(2, '0')}@example.invalid`;
    const invitation = await request(A.actor, '/members/invites', 'POST', { email, roles: index === 1 ? [managerRole.key] : ['member'] }, 201);
    const actor = await signup(`검증 구성원 ${String(index).padStart(2, '0')}`, email, invitation.token);
    actor.orgId = A.id;
    actors.push(actor);
  }
  const members = await request(A.actor, '/members');
  assert.equal(members.items.length, 25);
  assert.equal(new Set(members.items.map(member => member.user_id)).size, 25);
  for (const actor of actors) {
    actor.membershipId = members.items.find(member => member.user_id === actor.userId).membership_id;
  }
  // 생성자의 기존 owner 권한을 API를 통해 유한 company_admin으로 바꾼다.
  await request(A.actor, `/settings/members/${A.actor.membershipId}/roles`, 'PUT', { roles: ['company_admin'] });
  const assets = [];
  for (let index = 1; index <= 25; index++) assets.push(await request(A.actor, '/assets', 'POST', { asset_no: `DEADLINE-${String(index).padStart(2, '0')}`, name: `검증 자산 ${String(index).padStart(2, '0')}`, location: '격리 공간', quantity: 1 }, 201));
  const project = await request(A.actor, '/projects', 'POST', { name: '검증 프로젝트', description: '실제 격리 API로 생성한 기준 자료' }, 201);
  for (const actor of [actors[1], actors[2]]) await request(A.actor, `/projects/${project.id}/members`, 'POST', { user_id: actor.userId }, 201);
  const task = await request(A.actor, '/tasks', 'POST', { project_id: project.id, title: '검증 배정 업무', assignee_id: actors[2].userId }, 201);
  const kst = new Date(Date.now() + 9 * 3600000);
  const year = kst.getUTCFullYear(), monthIndex = kst.getUTCMonth();
  const date = day => new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
  const period = { month: date(1).slice(0, 7), from: date(1), to: new Date(Date.UTC(year, monthIndex + 1, 1)).toISOString().slice(0, 10) };
  const events = [];
  for (const [title, start_at, end_at] of [
    ['월 시작 경계 일정', `${date(0)}T23:00:00+09:00`, `${date(1)}T01:00:00+09:00`],
    ['검증 긴 제목 '.repeat(12), `${date(1)}T09:00:00+09:00`, `${date(3)}T18:00:00+09:00`],
    ['다음 달 경계 일정', `${period.to}T00:00:00+09:00`, `${period.to}T01:00:00+09:00`],
  ]) events.push(await request(A.actor, '/calendar', 'POST', { title, start_at, end_at }, 201));
  const account = await request(A.actor, '/finance/accounts', 'POST', { code: 'DEADLINE_EXPENSE', name: '검증 지출', kind: 'expense' }, 201);
  const transactions = [];
  for (const occurred_on of [date(0), period.from, period.to]) {
    const transaction = await request(A.actor, '/finance/transactions', 'POST', { kind: 'expense', amount_minor: 10001, occurred_on, account_id: account.id, memo: '격리 기간 경계' }, 201);
    await request(A.actor, `/finance/transactions/${transaction.id}/confirm`, 'POST', {});
    transactions.push(transaction);
  }
  const approval = await request(A.actor, '/approvals/requests', 'POST', { title: '검증 결재', amount: 10001, due_at: `${period.to}T00:00:00+09:00`, steps: [{ approver_id: actors[2].userId }] }, 201);
  const full = await request(A.actor, '/assets');
  const empty = await request(B.actor, '/assets');
  const denied = await request(actors[1], '/assets', 'GET', undefined, 403);
  assert.equal(full.items.length, 25); assert.equal(empty.items.length, 0);
  await request(B.actor, `/projects/${project.id}`, 'GET', undefined, 404);
  const window = new URLSearchParams({ from: `${period.from}T00:00:00+09:00`, to: `${period.to}T00:00:00+09:00` });
  const inMonth = await request(A.actor, `/calendar?${window}`);
  assert.deepEqual(new Set(inMonth.items.map(item => item.id)), new Set(events.slice(0, 2).map(item => item.id)));
  for (const actor of [A.actor, B.actor, actors[1], actors[2]]) {
    const me = await request(actor, '/auth/me');
    actor.session = { token: actor.token, name: actor.name, email: actor.email, orgId: actor.orgId, organizations: me.organizations, mustChangePassword: false };
  }
  return {
    A, B, actorAdmin: A.actor, actorManager: actors[1], actorMember: actors[2], actors,
    members: members.items, assets, project, task, period, events, transactions, approval,
    states: { full: { status: 200, count: full.items.length }, empty: { status: 200, count: empty.items.length }, denied: { status: 403, code: denied.error.code } },
  };
}
