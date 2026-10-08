import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { api, createOwnerOrg, startTestServer } from './http.js';
import { installProjectTaskFixture } from './project-task-fixture.js';

process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
let server, fixture, pg;
before(async () => {
  server = await startTestServer(); fixture = await installProjectTaskFixture();
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.identity.users[0].email, password: 'password-1234' } });
  assert.equal(login.status, 200); pg = { token: login.body.token, orgId: 'pg:77' };
});
after(async () => { await fixture.close(); await server.close(); });

test('PG task queries preserve association and intersect project/task/company filters', async () => {
  const a = fixture.project('동일 이름'), b = fixture.project('동일 이름'), foreign = fixture.project('비공개', '88');
  const aTask = fixture.task(a, 'A', 'done'), bTask = fixture.task(b, 'B'); fixture.task(foreign, 'SECRET', 'done');
  const list = await api(server.baseUrl, `/pg/tasks?project_id=${a}`, pg);
  assert.equal(list.status, 200); assert.equal(list.body.items.length, 1);
  assert.equal(String(list.body.items[0].project_id), a); assert.equal(String(list.body.items[0].__id), aTask);
  assert.equal((await api(server.baseUrl, `/pg/tasks?project_id=${a}&task_id=${bTask}`, pg)).body.items.length, 0);
  assert.equal((await api(server.baseUrl, `/pg/tasks?project_id=${foreign}`, pg)).body.items.length, 0);
  assert.equal((await api(server.baseUrl, `/pg/tasks?task_id=${aTask}`, pg)).body.items.length, 1);
  assert.equal((await api(server.baseUrl, '/pg/tasks?project_id=invalid', pg)).status, 400);
  const all = await api(server.baseUrl, '/pg/tasks', pg);
  assert.deepEqual(all.body.items.map(t => t.업무).sort(), ['A', 'B']);
});

test('PG task status writes persist, reject invalid values and enforce company and explicit grant', async () => {
  const p = fixture.project('상태'), id = fixture.task(p, '상태 업무');
  const foreign = fixture.task(fixture.project('외부', '88'), '외부 업무');
  const save = (id, status) => api(server.baseUrl, `/pg/records/tasks/${id}`, { ...pg, method: 'PATCH', body: { status, version: 1 } });
  assert.equal((await save(id, 'done')).status, 200);
  assert.equal((await api(server.baseUrl, `/pg/tasks?task_id=${id}`, pg)).body.items[0].status, 'done');
  assert.equal((await save(id, 'invented')).status, 400);
  assert.equal((await save(foreign, 'done')).status, 404);
  const grants = fixture.identity.state.permissions;
  fixture.identity.state.permissions = grants.filter(p => p.code !== 'task.write');
  assert.equal((await save(id, 'todo')).status, 403);
  fixture.identity.state.permissions = grants;
});

test('legacy project association cannot cross organization/tenant and filtered lists are complete', async () => {
  const owner = await createOwnerOrg(server.baseUrl, ['projects', 'tasks']);
  const other = await createOwnerOrg(server.baseUrl, ['projects', 'tasks']);
  const makeProject = async (session, name) => { const r = await api(server.baseUrl, '/projects', { ...session, method: 'POST', body: { name } }); assert.equal(r.status, 201); return r.body.id; };
  const a = await makeProject(owner, 'A'), b = await makeProject(owner, 'B'), foreign = await makeProject(other, '외부');
  const created = await api(server.baseUrl, '/tasks', { ...owner, method: 'POST', body: { project_id: foreign, title: 'LEAK' } });
  assert.equal(created.status, 404);
  // 같은 테넌트의 다른 조직도 거부한다.
  const sibling = await api(server.baseUrl, '/tenants', { token: owner.token, method: 'POST', body: { name: 'Sibling', type: 'custom', modules: ['projects', 'tasks'], departments: [] } });
  assert.equal(sibling.status, 201);
  const siblingProject = await makeProject({ ...owner, orgId: sibling.body.org_id }, '형제 조직');
  assert.equal((await api(server.baseUrl, '/tasks', { ...owner, method: 'POST', body: { project_id: siblingProject, title: 'LEAK' } })).status, 404);
  for (let i = 0; i < 55; i++) assert.equal((await api(server.baseUrl, '/tasks', { ...owner, method: 'POST', body: { project_id: a, title: `A-${i}` } })).status, 201);
  assert.equal((await api(server.baseUrl, '/tasks', { ...owner, method: 'POST', body: { project_id: b, title: 'B' } })).status, 201);
  const list = await api(server.baseUrl, `/tasks?project_id=${a}`, owner);
  assert.equal(list.body.items.length, 55); assert.ok(list.body.items.every(t => t.project_id === a));
  assert.equal((await api(server.baseUrl, `/tasks?project_id=${foreign}`, owner)).body.items.length, 0);
});
