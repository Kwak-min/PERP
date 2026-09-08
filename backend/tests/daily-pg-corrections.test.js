import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync } from 'node:fs';
import { installDailyPgFixture } from './daily-pg-fixture.js';
import { api, startTestServer } from './http.js';
process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
let server, fixture, session;
before(async () => {
  server = await startTestServer();
  fixture = await installDailyPgFixture({ migration: existsSync(new URL('../../db/perp_additions_v9_daily_corrections.sql', import.meta.url)) });
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.identity.users[0].email, password: 'password-1234' } });
  assert.equal(login.status, 200); session = { token: login.body.token, orgId: 'pg:77' };
});
after(async () => { await server?.close(); await fixture?.close(); });
const request = (path, body, method = 'PATCH') => api(server.baseUrl, `/pg${path}`, { ...session, method, body });
async function project() { return (await request('/projects', { name: 'Original', starts_on: '2026-09-01', ends_on: '2026-09-30' }, 'POST')).body.id; }
test('PG project title and dates persist with mandatory optimistic version', async () => {
  const id = await project();
  const saved = await request(`/projects/${id}`, { version: 1, name: 'Corrected', starts_on: '2026-10-01', ends_on: '2026-10-31' });
  assert.equal(saved.status, 200); assert.equal(saved.body.version, 2);
  assert.equal((await request(`/projects/${id}`, { version: 1, name: 'Stale' })).status, 409);
  const list = await api(server.baseUrl, '/pg/projects', session); assert.equal(list.body.items.find(row => String(row.__id) === id).프로젝트, 'Corrected');
});
test('PG reassignment uses actual company membership, not global user company', async () => {
  const project_id = await project(); const id = (await request('/tasks', { project_id, title: 'Task' }, 'POST')).body.id;
  assert.equal((await request(`/projects/${project_id}/members`, { user_id: '102' }, 'POST')).status, 201);
  const saved = await request(`/tasks/${id}`, { version: 1, assignee_id: '102' }); assert.equal(saved.status, 200); assert.equal(saved.body.assignee_id, '102');
  assert.equal((await request(`/tasks/${id}`, { version: 2, assignee_id: '103' })).status, 403);
  assert.equal((await request(`/tasks/${id}`, { version: 1, assignee_id: null })).status, 409);
});
test('PG reschedule then cancel retains event and before/after audit', async () => {
  const id = (await request('/calendar', { title: 'Meeting', starts_at: '2026-09-08T09:00:00Z', ends_at: '2026-09-08T10:00:00Z' }, 'POST')).body.id;
  assert.equal((await request(`/calendar/${id}`, { version: 1, starts_at: '2026-09-09T09:00:00Z', ends_at: '2026-09-09T10:00:00Z' })).status, 200);
  assert.equal((await request(`/calendar/${id}/cancel`, { version: 1 }, 'POST')).status, 409);
  assert.equal((await request(`/calendar/${id}/cancel`, { version: 2 }, 'POST')).status, 200);
  const row = (await fixture.engine.query('SELECT * FROM calendar.events WHERE id=$1', [id])).rows[0]; assert.ok(row.cancelled_at); assert.equal(row.version, 3);
  assert.equal((await api(server.baseUrl, `/pg/calendar?event_id=${id}`, session)).body.items.length, 0);
  const audit = (await fixture.engine.query('SELECT * FROM org.daily_correction_events WHERE resource_type=$1 AND resource_id=$2 ORDER BY id', ['calendar', id])).rows;
  assert.equal(audit.length, 2); assert.equal(audit[1].before_data.version, 2); assert.equal(audit[1].after_data.version, 3);
});
test('PG asset custody is atomic, rejects foreign users and stale saves', async () => {
  const id = (await request('/assets', { name: 'Laptop' }, 'POST')).body.id;
  const saved = await request(`/assets/${id}/custody`, { version: 1, assignee_id: '102', status: 'stored' }); assert.equal(saved.status, 200); assert.equal(saved.body.status, 'stored');
  assert.equal((await request(`/assets/${id}/custody`, { version: 1, status: 'lost' })).status, 409);
  assert.equal((await request(`/assets/${id}/custody`, { version: 2, assignee_id: '103' })).status, 403);
  await fixture.engine.exec("CREATE FUNCTION asset.reject_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected history failure'; END $$; CREATE TRIGGER reject_history BEFORE INSERT ON asset.history FOR EACH ROW EXECUTE FUNCTION asset.reject_history();");
  assert.equal((await request(`/assets/${id}/custody`, { version: 2, status: 'repair' })).status, 500);
  await fixture.engine.exec('DROP TRIGGER reject_history ON asset.history;');
  const row = (await fixture.engine.query('SELECT * FROM asset.assets WHERE id=$1', [id])).rows[0]; assert.equal(row.version, 2); assert.equal(row.status, 'stored');
});
test('PG correction rejects foreign resources and missing explicit action grants', async () => {
  const foreignProject = (await fixture.engine.query("INSERT INTO project.projects(company_id,name) VALUES (88,'Foreign') RETURNING id")).rows[0].id;
  const foreignTask = (await fixture.engine.query("INSERT INTO project.tasks(project_id,title) VALUES ($1,'Foreign') RETURNING id", [foreignProject])).rows[0].id;
  const foreignEvent = (await fixture.engine.query("INSERT INTO calendar.events(company_id,owner_id,title,starts_at,ends_at) VALUES (88,103,'Foreign',now(),now()+interval '1 hour') RETURNING id")).rows[0].id;
  const foreignAsset = (await fixture.engine.query("INSERT INTO asset.assets(company_id,name) VALUES (88,'Foreign') RETURNING id")).rows[0].id;
  for (const [path, body] of [[`/projects/${foreignProject}`, { name: 'Changed' }], [`/tasks/${foreignTask}`, { assignee_id: '102' }], [`/calendar/${foreignEvent}`, { title: 'Changed' }], [`/assets/${foreignAsset}/custody`, { status: 'lost' }]]) {
    assert.equal((await request(path, { version: 1, ...body })).status, 404);
  }
  const grants = fixture.identity.state.permissions;
  fixture.identity.state.permissions = grants.filter(grant => !grant.code.endsWith('.write'));
  try {
    for (const [path, body] of [[`/projects/${foreignProject}`, { name: 'Changed' }], [`/tasks/${foreignTask}`, { assignee_id: '102' }], [`/calendar/${foreignEvent}`, { title: 'Changed' }], [`/assets/${foreignAsset}/custody`, { status: 'lost' }]]) assert.equal((await request(path, { version: 1, ...body })).status, 403);
  } finally { fixture.identity.state.permissions = grants; }
});
test('generic correction routes cannot bypass version checks or erase retained records', async () => {
  const id = await project();
  assert.equal((await request(`/projects/${id}`, { version: 1, name: 'Changed' })).status, 200);
  assert.equal((await request(`/records/projects/${id}`, { version: 1, name: 'Stale bypass' })).status, 409);
  assert.equal((await request(`/records/projects/${id}`, { version: 2 }, 'DELETE')).status, 409);
  const detail = await api(server.baseUrl, `/pg/records/projects/${id}`, session); assert.equal(detail.body.version, 2);
  const e = (await request('/calendar', { title: 'Cancel alias', starts_at: '2026-09-08T09:00:00Z', ends_at: '2026-09-08T10:00:00Z' }, 'POST')).body.id;
  assert.equal((await request(`/records/calendar/${e}`, { version: 1 }, 'DELETE')).status, 200);
  assert.ok((await fixture.engine.query('SELECT cancelled_at FROM calendar.events WHERE id=$1', [e])).rows[0].cancelled_at);
});
test('PG corrections reject invalid merged dates, absent versions and terminal asset transitions', async () => {
  const id = await project();
  assert.equal((await request(`/projects/${id}`, { name: 'No version' })).status, 400);
  assert.equal((await request(`/projects/${id}`, { version: 1, starts_on: '2026-10-01' })).status, 400);
  assert.equal((await request(`/projects/${id}`, { version: 1, starts_on: 'not-a-date' })).status, 400);
  const a = (await request('/assets', { name: 'Retired' }, 'POST')).body.id;
  assert.equal((await request(`/assets/${a}/custody`, { version: 1, status: 'disposed' })).status, 200);
  assert.equal((await request(`/assets/${a}/custody`, { version: 2, status: 'in_use' })).status, 409);
});
