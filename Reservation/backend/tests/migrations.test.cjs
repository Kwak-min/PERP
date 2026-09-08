const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile, readdir } = require('node:fs/promises');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { startDatabase, prismaCli, backend } = require('./postgres-fixture.cjs');

const baselineName = '20260907000000_reservation_baseline';
const scopeName = '20260907010000_add_organization_scope';
const migrations = path.join(backend, 'prisma/migrations');

test('Given an empty PostgreSQL engine, when deploying migrations, then match Prisma and replay without rewriting data', { timeout: 90000 }, async t => {
  const fixture = await startDatabase();
  t.after(() => fixture.close());
  await prismaCli(['migrate', 'deploy'], fixture.url);
  const history = await fixture.db.query('SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name');
  assert.deepEqual(history.rows.map(row => row.migration_name), [baselineName, scopeName]);
  assert.ok(history.rows.every(row => row.finished_at && row.rolled_back_at === null));
  const diff = await prismaCli(['migrate', 'diff', '--from-schema-datasource', 'prisma/schema.prisma', '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], fixture.url);
  assert.equal(diff.stderr, '');
  const prisma = new PrismaClient({ datasources: { db: { url: fixture.url } } });
  try {
    for (const model of ['space', 'recurrenceRule', 'reservation', 'attendee', 'waitlist']) {
      assert.deepEqual(await prisma[model].findMany(), []);
    }
    await prisma.space.create({ data: { name: 'Replay sentinel', location: 'Local fixture', capacity: 1, tenantId: 'fixture-a', orgId: 'fixture-a' } });
  } finally { await prisma.$disconnect(); }
  const before = await fixture.db.query('SELECT * FROM spaces');
  const records = await fixture.db.query('SELECT * FROM _prisma_migrations ORDER BY migration_name');
  // PGlite는 연결 간 세션을 공유한다. 종료한 Prisma Client의 prepared statement만 정리한다.
  // 데이터/스키마/마이그레이션 기록은 초기화하지 않는다.
  await fixture.db.exec('DEALLOCATE ALL');
  await prismaCli(['migrate', 'deploy'], fixture.url);
  assert.deepEqual((await fixture.db.query('SELECT * FROM spaces')).rows, before.rows);
  assert.deepEqual((await fixture.db.query('SELECT * FROM _prisma_migrations ORDER BY migration_name')).rows, records.rows);
  t.diagnostic('Fresh deploy: two completed migrations; Prisma diff exit 0; all five model reads; deploy replay preserves rows and migration records');
});

test('Given the baseline, when applying organization scope, then preserve legacy rows and enforce scoped overlap', { timeout: 60000 }, async t => {
  const fixture = await startDatabase();
  t.after(() => fixture.close());
  assert.deepEqual((await readdir(migrations)).filter(name => /^\d/.test(name)).sort(), [baselineName, scopeName]);
  await fixture.db.exec(await readFile(path.join(migrations, baselineName, 'migration.sql'), 'utf8'));
  const tables = await fixture.db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  assert.deepEqual(tables.rows.map(row => row.tablename), ['attendees', 'recurrence_rules', 'reservations', 'spaces', 'waitlists']);
  const enums = await fixture.db.query("SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid ORDER BY t.typname, e.enumsortorder");
  assert.deepEqual(enums.rows, [
    { typname: 'AttendeeStatus', enumlabel: 'INVITED' }, { typname: 'AttendeeStatus', enumlabel: 'ACCEPTED' }, { typname: 'AttendeeStatus', enumlabel: 'DECLINED' },
    { typname: 'RecurrenceFrequency', enumlabel: 'DAILY' }, { typname: 'RecurrenceFrequency', enumlabel: 'WEEKLY' }, { typname: 'RecurrenceFrequency', enumlabel: 'MONTHLY' },
    { typname: 'ReservationStatus', enumlabel: 'CONFIRMED' }, { typname: 'ReservationStatus', enumlabel: 'CANCELLED' },
  ]);
  const scopeColumns = await fixture.db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('tenantId','orgId','ownerId')");
  assert.deepEqual(scopeColumns.rows, []);
  const users = await fixture.db.query("SELECT table_name, is_nullable FROM information_schema.columns WHERE table_schema='public' AND column_name='userId' ORDER BY table_name");
  assert.deepEqual(users.rows, [{ table_name: 'reservations', is_nullable: 'NO' }, { table_name: 'waitlists', is_nullable: 'NO' }]);
  await fixture.db.exec(`INSERT INTO spaces (name, location, capacity, "updatedAt") VALUES ('Legacy fixture', 'Local', 1, '2035-01-01');
    INSERT INTO reservations ("spaceId", "userId", title, "startTime", "endTime", "updatedAt") VALUES (1, 17, 'Legacy', '2035-01-01 09:00', '2035-01-01 10:00', '2035-01-01');
    INSERT INTO waitlists ("spaceId", "userId", title, "startTime", "endTime") VALUES (1, 17, 'Legacy', '2035-01-01 09:00', '2035-01-01 10:00');`);
  const before = (await fixture.db.query('SELECT * FROM reservations')).rows[0];
  await fixture.db.exec(await readFile(path.join(migrations, scopeName, 'migration.sql'), 'utf8'));
  assert.deepEqual((await fixture.db.query('SELECT * FROM reservations')).rows[0], { ...before, tenantId: null, orgId: null, ownerId: null });
  assert.deepEqual((await fixture.db.query('SELECT "userId", "tenantId", "orgId", "ownerId" FROM waitlists')).rows, [{ userId: 17, tenantId: null, orgId: null, ownerId: null }]);
  const constraints = await fixture.db.query("SELECT conname FROM pg_constraint WHERE contype='x'");
  assert.deepEqual(constraints.rows, [{ conname: 'no_overlap_reservation_org' }]);
  const insert = (tenant, org, start, end, status = 'CONFIRMED') => fixture.db.query(`INSERT INTO reservations ("tenantId", "orgId", "ownerId", "spaceId", title, "startTime", "endTime", status, "updatedAt") VALUES ($1, $2, 'fixture-owner', 1, 'Overlap fixture', $3, $4, $5::"ReservationStatus", '2035-01-01')`, [tenant, org, `2035-01-01 ${start}`, `2035-01-01 ${end}`, status]);
  await insert('tenant-a', 'org-a', '09:00', '10:00');
  await assert.rejects(insert('tenant-a', 'org-a', '09:30', '10:30'), { code: '23P01' });
  await insert('tenant-a', 'org-a', '10:00', '11:00');
  await insert('tenant-a', 'org-b', '09:00', '10:00');
  await insert('tenant-b', 'org-a', '09:00', '10:00');
  await insert('tenant-a', 'org-a', '09:00', '10:00', 'CANCELLED');
  t.diagnostic('Baseline: five tables, three enums, required legacy userId; scope preserves legacy data; GiST rejects overlap and permits adjacent/cancelled/foreign-scope rows');
});
