import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { startDeadlineServer, createDeadlineFixture } from './deadline-fixture.js';
import { networkAudit } from '../../scripts/deadline-isolation-guard.mjs';

test('API-created companies, role actors and boundary resources remain isolated', { timeout: 60000 }, async () => {
  const server = await startDeadlineServer();
  try {
    const fixture = await createDeadlineFixture(server);
    assert.notEqual(fixture.A.id, fixture.B.id);
    assert.notEqual(fixture.A.tenantId, fixture.B.tenantId);
    assert.equal(fixture.members.length, 25); assert.equal(fixture.assets.length, 25);
    assert.equal(new Set(fixture.actors.map(actor => actor.userId)).size, 25);
    assert.equal(fixture.states.full.count, 25); assert.equal(fixture.states.empty.count, 0);
    assert.equal(fixture.states.denied.status, 403);
    const managerProjects = await server.request(fixture.actorManager, '/projects');
    assert.ok(managerProjects.items.some(project => project.id === fixture.project.id));
    const assigned = await server.request(fixture.actorMember, '/tasks');
    assert.ok(assigned.items.some(task => task.id === fixture.task.id));
    await server.request(fixture.B.actor, `/calendar/${fixture.events[0].id}`, 'GET', undefined, 404);
    await server.request(fixture.actorAdmin, '/hr/attendance', 'GET', undefined, 403);
    assert.deepEqual(networkAudit.blocked, []);
    assert.ok(server.http.every(record => !JSON.stringify(record.body).includes(fixture.actorAdmin.token)));
  } finally { await server.close(); }
  assert.equal(server.resource.closed, true);
  assert.equal(server.resource.temporaryRemoved, true);
  assert.equal(existsSync(server.resource.temporary), false);
});
