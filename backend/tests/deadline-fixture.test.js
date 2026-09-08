import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { startDeadlineServer, createDeadlineFixture } from './deadline-fixture.js';
import { networkAudit } from '../../scripts/deadline-isolation-guard.mjs';

function migrationEffects(conn) {
  const names = (type) => conn.prepare('SELECT name FROM sqlite_master WHERE type=? ORDER BY name').all(type).map(row => row.name);
  return {
    versions: conn.prepare('SELECT version FROM schema_migration ORDER BY version').all().map(row => row.version),
    membershipColumns: conn.prepare('PRAGMA table_info(membership)').all().map(column => column.name),
    transactionColumns: conn.prepare('PRAGMA table_info(transaction_record)').all().map(column => column.name),
    evidenceColumns: conn.prepare('PRAGMA table_info(transaction_evidence)').all().map(column => column.name),
    tables: names('table'),
    triggers: names('trigger'),
  };
}

function assertMigrationEffects(effects) {
  assert.deepEqual(effects.versions, [1,2,3,4,5,6,7,8,9,10]);
  assert.ok(effects.membershipColumns.includes('roles_version'));
  for (const column of ['counterparty','occurred_at','input_currency','no_receipt_reason']) assert.ok(effects.transactionColumns.includes(column));
  for (const column of ['org_id','receipt_upload_id']) assert.ok(effects.evidenceColumns.includes(column));
  for (const table of ['receipt_upload','approval_receipt_files','finance_request_replay']) assert.ok(effects.tables.includes(table));
  for (const trigger of ['receipt_evidence_scope','receipt_file_update','expense_original_update','expense_original_delete']) assert.ok(effects.triggers.includes(trigger));
}

test('API-created companies, role actors and boundary resources remain isolated', { timeout: 60000 }, async () => {
  const server = await startDeadlineServer();
  try {
    const { db } = await import('../src/config/db.js');
    assertMigrationEffects(migrationEffects(db()));
    const fixture = await createDeadlineFixture(server);
    const preserved = Object.fromEntries(['membership','company_role','transaction_record','audit_event'].map(table => [table, db().prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
    const { migrate } = await import('../src/config/migrate.js');
    migrate();
    migrate();
    assertMigrationEffects(migrationEffects(db()));
    for (const [table, rows] of Object.entries(preserved)) assert.deepEqual(db().prepare(`SELECT * FROM ${table} ORDER BY id`).all(), rows);

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
