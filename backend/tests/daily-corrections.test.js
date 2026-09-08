import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { api, createOwnerOrg, startTestServer } from './http.js';
process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
let server, owner, foreign, db, insert;
before(async () => {
  server = await startTestServer();
  owner = await createOwnerOrg(server.baseUrl, ['projects', 'tasks', 'calendar', 'assets']);
  foreign = await createOwnerOrg(server.baseUrl, ['projects', 'tasks', 'calendar', 'assets']);
  ({ db } = await import('../src/config/db.js')); ({ insert } = await import('../src/models/base.js'));
});
after(async () => { await server?.close(); });
const request = (path, body, method = 'PATCH') => api(server.baseUrl, path, { ...owner, method, body });
async function project() { return (await request('/projects', { name: 'Original', start_date: '2026-09-01', end_date: '2026-09-30' }, 'POST')).body; }
async function event() { return (await request('/calendar', { title: 'Meeting', start_at: '2026-09-08T09:00:00Z', end_at: '2026-09-08T10:00:00Z' }, 'POST')).body; }
async function asset() { return (await request('/assets', { name: 'Laptop', asset_no: crypto.randomUUID() }, 'POST')).body; }
test('project correction persists title and date range and rejects stale versions', async () => {
  const p = await project();
  const saved = await request(`/projects/${p.id}`, { version: p.version, name: 'Corrected', start_date: '2026-10-01', end_date: '2026-10-31' });
  assert.equal(saved.status, 200); assert.equal(saved.body.start_date, '2026-10-01');
  assert.equal((await request(`/projects/${p.id}`, { version: p.version, name: 'Stale' })).status, 409);
  assert.equal((await api(server.baseUrl, `/projects/${p.id}`, owner)).body.name, 'Corrected');
});
test('project correction rejects an inverted merged date range', async () => {
  const p = await project(); assert.equal((await request(`/projects/${p.id}`, { version: p.version, start_date: '2026-10-01' })).status, 400);
});
test('task reassignment accepts actual same-org membership and rejects foreign users', async () => {
  const p = await project(); const task = (await request('/tasks', { title: 'Task', project_id: p.id }, 'POST')).body;
  const tenantId = db().prepare('SELECT tenant_id FROM membership WHERE org_id = ? AND user_id = ?').get(owner.orgId, owner.userId).tenant_id;
  insert('membership', { tenant_id: tenantId, org_id: owner.orgId, user_id: foreign.userId, status: 'active', created_by: owner.userId });
  const saved = await request(`/tasks/${task.id}`, { version: task.version, assignee_id: foreign.userId });
  assert.equal(saved.status, 200); assert.equal(saved.body.assignee_id, foreign.userId);
  db().prepare('UPDATE membership SET status = ? WHERE org_id = ? AND user_id = ?').run('inactive', owner.orgId, foreign.userId);
  assert.equal((await request(`/tasks/${task.id}`, { version: saved.body.version, assignee_id: foreign.userId })).status, 403);
});
test('calendar reschedule rejects stale edits and records before and after', async () => {
  const e = await event(); const saved = await request(`/calendar/${e.id}`, { version: e.version, start_at: '2026-09-09T09:00:00Z', end_at: '2026-09-09T10:00:00Z' });
  assert.equal(saved.status, 200);
  assert.equal((await request(`/calendar/${e.id}`, { version: e.version, title: 'Stale' })).status, 409);
  const audit = db().prepare("SELECT * FROM audit_event WHERE resource_id = ? AND action = 'event.updated'").get(e.id);
  assert.equal(JSON.parse(audit.before_json).start_at, e.start_at); assert.equal(JSON.parse(audit.after_json).start_at, saved.body.start_at);
});
test('calendar cancel retains row and audit and conflicts on stale version', async () => {
  const e = await event(); assert.equal((await request(`/calendar/${e.id}/cancel`, { version: e.version + 1 }, 'POST')).status, 409);
  assert.equal((await request(`/calendar/${e.id}/cancel`, { version: e.version }, 'POST')).status, 200);
  assert.ok(db().prepare('SELECT deleted_at FROM event WHERE id = ?').get(e.id).deleted_at);
  assert.ok(db().prepare("SELECT id FROM audit_event WHERE resource_id = ? AND action = 'event.cancelled'").get(e.id));
});
test('asset custody and status persist together, stale and foreign assignments fail', async () => {
  const a = await asset(); const saved = await request(`/assets/${a.id}/custody`, { version: a.version, custodian_id: owner.userId, status: 'loaned' });
  assert.equal(saved.status, 200); assert.equal(saved.body.custodian_id, owner.userId); assert.equal(saved.body.status, 'loaned');
  assert.equal((await request(`/assets/${a.id}/custody`, { version: a.version, status: 'lost' })).status, 409);
  assert.equal((await request(`/assets/${a.id}/custody`, { version: saved.body.version, custodian_id: foreign.userId })).status, 403);
  const current = (await api(server.baseUrl, `/assets/${a.id}`, owner)).body; assert.equal(current.status, 'loaned'); assert.ok(current.history.some(item => item.action === 'custody.updated'));
});
for (const resource of ['projects', 'tasks']) test(`${resource} correction rolls back when its audit insert fails`, async () => {
  const p = await project();
  const row = resource === 'projects' ? p : (await request('/tasks', { title: 'Original', project_id: p.id }, 'POST')).body;
  db().exec("CREATE TRIGGER reject_daily_audit BEFORE INSERT ON audit_event WHEN NEW.action IN ('project.updated','task.updated') BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;");
  try {
    const saved = await request(`/${resource}/${row.id}`, { version: row.version, ...(resource === 'projects' ? { name: 'Failed' } : { title: 'Failed' }) });
    assert.equal(saved.status, 500);
    const reloaded = (await api(server.baseUrl, `/${resource}/${row.id}`, owner)).body;
    assert.equal(reloaded.version, row.version); assert.equal(resource === 'projects' ? reloaded.name : reloaded.title, 'Original');
  } finally { db().exec('DROP TRIGGER reject_daily_audit'); }
});
test('legacy delete event route cannot bypass stale cancellation guard', async () => {
  const e = await event();
  assert.equal((await request(`/calendar/${e.id}`, { version: 2 }, 'DELETE')).status, 409);
  assert.equal((await request(`/calendar/${e.id}`, { version: 1 }, 'DELETE')).status, 200);
});
test('legacy asset actions cannot resurrect a disposed correction', async () => {
  const a = await asset();
  assert.equal((await request(`/assets/${a.id}/custody`, { version: 1, status: 'disposed' })).status, 200);
  assert.equal((await request(`/assets/${a.id}/actions`, { action: 'return' }, 'POST')).status, 409);
});
test('foreign organizations cannot correct project, task, calendar or custody', async () => {
  const p = await project(), e = await event(), a = await asset(), t = (await request('/tasks', { title: 'Task', project_id: p.id }, 'POST')).body;
  for (const [path, body] of [[`/projects/${p.id}`, { name: 'Foreign' }], [`/tasks/${t.id}`, { assignee_id: foreign.userId }], [`/calendar/${e.id}`, { title: 'Foreign' }], [`/assets/${a.id}/custody`, { status: 'lost' }]]) {
    assert.equal((await api(server.baseUrl, path, { ...foreign, method: 'PATCH', body: { version: 1, ...body } })).status, 404);
  }
});
