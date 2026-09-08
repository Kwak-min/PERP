import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { api, createOwnerOrg, startTestServer } from './http.js';
import { installDailyPgFixture } from './daily-pg-fixture.js';
process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
let server, fixture, db, legacy, pg;
before(async () => {
  server = await startTestServer(); fixture = await installDailyPgFixture();
  ({ db } = await import('../src/config/db.js')); const { insert } = await import('../src/models/base.js');
  const owner = await createOwnerOrg(server.baseUrl, ['projects','tasks']);
  const recipient = await createOwnerOrg(server.baseUrl, ['projects','tasks']);
  const tenant = db().prepare('SELECT tenant_id FROM membership WHERE org_id=?').get(owner.orgId).tenant_id;
  insert('membership', { tenant_id: tenant, org_id: owner.orgId, user_id: recipient.userId, status: 'active', created_by: owner.userId });
  const recipientEmail = db().prepare('SELECT email FROM app_user WHERE id=?').get(recipient.userId).email;
  const recipientLogin = await api(server.baseUrl, '/auth/login', { method: 'POST', body: { email: recipientEmail, password: 'password-1234' } }); assert.equal(recipientLogin.status, 200);
  legacy = { owner, recipient: { token: recipientLogin.body.access_token, orgId: owner.orgId }, recipientId: recipient.userId, ownerId: owner.userId, prefix: '' };
  const pgLogin = async user => { const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: user.email, password: 'password-1234' } }); assert.equal(login.status, 200); return { token: login.body.token, orgId: 'pg:77' }; };
  fixture.identity.state.roles.push({ id: '2', company_id: '77', name: 'recipient' });
  fixture.identity.state.grants.push({ user_id: '102', role_id: '2' }); fixture.identity.state.permissions.push({ role_id: '2', code: 'notification.read' });
  pg = { owner: await pgLogin(fixture.identity.users[0]), recipient: await pgLogin(fixture.identity.users[1]), recipientId: '102', ownerId: '101', prefix: '/pg' };
});
after(async () => { await server?.close(); await fixture?.close(); });
const request = (state, path, body, method = 'POST', actor = state.owner) => api(server.baseUrl, state.prefix + path, { ...actor, method, body });
async function setup(state) {
  const project = await request(state, '/projects', { name: 'Member project' }); assert.equal(project.status, 201);
  const task = await request(state, '/tasks', { project_id: project.body.id, title: 'Recipient task' }); assert.equal(task.status, 201);
  return { project: project.body.id, task: task.body.id };
}
for (const backend of ['legacy', 'pg']) {
  test(`${backend}: member addition is scoped and idempotent; assignees must belong to project`, async () => {
    const state = backend === 'pg' ? pg : legacy, rows = await setup(state);
    assert.equal((await request(state, `/tasks/${rows.task}`, { version: 1, assignee_id: state.recipientId }, 'PATCH')).status, 403);
    const added = await request(state, `/projects/${rows.project}/members`, { user_id: state.recipientId }); assert.equal(added.status, 201);
    assert.equal((await request(state, `/projects/${rows.project}/members`, { user_id: state.recipientId })).status, 200);
    const list = await request(state, `/projects/${rows.project}/members`, undefined, 'GET'); assert.equal(list.status, 200);
    assert.equal(list.body.items.filter(member => member.value === state.recipientId).length, 1);
    if (backend === 'pg') assert.equal((await request(state, `/projects/${rows.project}/members`, { user_id: '103' })).status, 403);
    assert.equal((await request(state, `/tasks/${rows.task}`, { version: 1, assignee_id: state.recipientId }, 'PATCH')).status, 200);
  });
  test(`${backend}: recipient login sees one durable notification, same assignment is idempotent, reassignment informs new recipient`, async () => {
    const state = backend === 'pg' ? pg : legacy, rows = await setup(state);
    assert.equal((await request(state, `/projects/${rows.project}/members`, { user_id: state.recipientId })).status, 201);
    assert.equal((await request(state, `/tasks/${rows.task}`, { version: 1, assignee_id: state.recipientId }, 'PATCH')).status, 200);
    const same = await request(state, `/tasks/${rows.task}`, { version: 2, assignee_id: state.recipientId }, 'PATCH');
    assert.equal(same.status, 200); assert.equal(same.body.version, 2);
    const recipient = await request(state, '/notifications', undefined, 'GET', state.recipient); assert.equal(recipient.status, 200);
    const related = recipient.body.items.filter(item => backend === 'pg' ? item.link === `/tasks/${rows.task}` : item.related_id === rows.task);
    assert.equal(related.length, 1); assert.equal(backend === 'pg' ? related[0].kind : related[0].type, 'task.assigned');
    assert.equal((await request(state, `/tasks/${rows.task}`, { version: 2, assignee_id: state.ownerId }, 'PATCH')).status, 200);
    const owner = await request(state, '/notifications', undefined, 'GET'); assert.equal(owner.status, 200);
    assert.ok(owner.body.items.some(item => backend === 'pg' ? item.link === `/tasks/${rows.task}` : item.related_id === rows.task));
    assert.ok(owner.body.items.every(item => backend === 'pg' ? item.__id !== related[0].__id : item.id !== related[0].id));
    if (backend === 'pg') {
      await fixture.engine.query("INSERT INTO notice.notifications(company_id,user_id,kind,title,link) VALUES (88,102,'task.assigned','FOREIGN_NOTIFICATION','/tasks/foreign')");
      const selected = await request(state, '/notifications', undefined, 'GET', state.recipient); assert.ok(selected.body.items.every(item => item.link !== '/tasks/foreign'));
    }
  });
  test(`${backend}: notification storage failure rolls back assignment and audit`, async () => {
    const state = backend === 'pg' ? pg : legacy, rows = await setup(state);
    assert.equal((await request(state, `/projects/${rows.project}/members`, { user_id: state.recipientId })).status, 201);
    if (backend === 'pg') await fixture.engine.exec("CREATE FUNCTION notice.reject_assignment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'notification failure'; END $$; CREATE TRIGGER reject_assignment BEFORE INSERT ON notice.notifications FOR EACH ROW EXECUTE FUNCTION notice.reject_assignment();");
    else db().exec("CREATE TRIGGER reject_assignment BEFORE INSERT ON notification BEGIN SELECT RAISE(ABORT,'notification failure'); END;");
    try {
      assert.equal((await request(state, `/tasks/${rows.task}`, { version: 1, assignee_id: state.recipientId }, 'PATCH')).status, 500);
      const current = backend === 'pg' ? (await fixture.engine.query('SELECT version,assignee_id FROM project.tasks WHERE id=$1', [rows.task])).rows[0] : db().prepare('SELECT version,assignee_id FROM task WHERE id=?').get(rows.task);
      assert.equal(current.version, 1); assert.notEqual(String(current.assignee_id), state.recipientId);
    } finally { if (backend === 'pg') await fixture.engine.exec('DROP TRIGGER reject_assignment ON notice.notifications'); else db().exec('DROP TRIGGER reject_assignment'); }
  });
}
