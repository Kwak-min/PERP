const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./reservation.native-fixture.cjs');
let f;
before(async () => { f = await fixture(); });
after(async () => { await f?.close(); });
const booking = (day, extra = {}) => ({ spaceId: f.spaceId, title: 'native-contract', startTime: `${day}T10:00:00+09:00`, endTime: `${day}T11:00:00+09:00`, ...extra });
const create = async body => {
  const response = await f.request(f.A, '/reservations', 'POST', body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
};
const count = async () => (await f.db.query('SELECT (SELECT count(*) FROM reservations)::int AS reservations, (SELECT count(*) FROM recurrence_rules)::int AS rules, (SELECT count(*) FROM attendees)::int AS attendees')).rows[0];

test('Given a booking, when PATCH merges an inverted endpoint, then return 400 without writes', async () => {
  const [r] = await create(booking('2031-03-01'));
  const before = (await f.db.query('SELECT * FROM reservations WHERE id=$1', [r.id])).rows;
  const response = await f.request(f.A, `/reservations/${r.id}`, 'PATCH', { startTime: '2031-03-01T11:00:00+09:00' });
  assert.equal(response.status, 400);
  assert.deepEqual((await f.db.query('SELECT * FROM reservations WHERE id=$1', [r.id])).rows, before);
});
test('Given cancelled past history and a midnight crossing, when selecting a Seoul period, then return overlapping history only', async () => {
  const [r] = await create(booking('2020-01-31', { startTime: '2020-01-31T23:30:00+09:00', endTime: '2020-02-01T00:30:00+09:00' }));
  assert.equal((await f.request(f.A, `/reservations/${r.id}`, 'DELETE')).status, 200);
  const query = new URLSearchParams({ spaceId: f.spaceId, from: '2020-02-01', to: '2020-02-02', status: 'CANCELLED' });
  const response = await f.request(f.A, `/reservations?${query}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.map(row => row.id), [r.id]);
});
test('Given an invalid cancelScope, when cancelling, then reject and preserve status', async () => {
  const [r] = await create(booking('2031-03-02'));
  const response = await f.request(f.A, `/reservations/${r.id}?cancelScope=garbage`, 'DELETE');
  assert.equal(response.status, 400);
  assert.equal((await f.db.query('SELECT status FROM reservations WHERE id=$1', [r.id])).rows[0].status, 'CONFIRMED');
});
test('Given adjacent instants, when creating then overlapping, then allow adjacency and reject true occupancy', async () => {
  await create(booking('2031-03-03'));
  await create(booking('2031-03-03', { startTime: '2031-03-03T02:00:00Z', endTime: '2031-03-03T03:00:00Z' }));
  const response = await f.request(f.A, '/reservations', 'POST', booking('2031-03-03', { startTime: '2031-03-03T01:30:00Z' }));
  assert.equal(response.status, 409);
});
test('Given another owner and company, when mutating, then forbid ownership and hide foreign rows', async () => {
  const [r] = await create(booking('2031-03-04'));
  for (const method of ['PATCH', 'DELETE']) {
    assert.equal((await f.request(f.member, `/reservations/${r.id}`, method, method === 'PATCH' ? { title: 'denied' } : undefined)).status, 403);
    assert.equal((await f.request(f.B, `/reservations/${r.id}`, method, method === 'PATCH' ? { title: 'denied' } : undefined)).status, 404);
  }
});
test('Given private reservation details, when another member reads occupancy, then expose busy time without title or identity', async () => {
  const [r] = await create(booking('2031-03-05', { title: 'private-title', description: 'private-description' }));
  for (const route of [`/reservations/${r.id}`, '/reservations?from=2031-03-05&to=2031-03-06', `/reservations/timetable?spaceId=${f.spaceId}&date=2031-03-05`]) {
    const result = await f.request(f.member, route);
    assert.equal(result.status, 200);
    const json = JSON.stringify(result.body);
    for (const secret of ['private-title', 'private-description', f.A.userId]) assert.equal(json.includes(secret), false);
  }
});
test('Given midnight and split-slot bookings, when reading timetable, then expose the full Seoul day and every busy interval', async () => {
  const [a] = await create(booking('2031-03-06', { startTime: '2031-03-06T00:10:00+09:00', endTime: '2031-03-06T00:20:00+09:00' }));
  const [b] = await create(booking('2031-03-06', { startTime: '2031-03-06T00:30:00+09:00', endTime: '2031-03-06T00:40:00+09:00' }));
  const response = await f.request(f.A, `/reservations/timetable?spaceId=${f.spaceId}&date=2031-03-06`);
  assert.equal(response.body.data.slots[0].startTime, '2031-03-05T15:00:00.000Z');
  assert.equal(response.body.data.slots.length, 24);
  assert.deepEqual(response.body.data.reservations.map(r => r.id), [a.id, b.id]);
});
test('Given recurrence attendees and a conflict, when creating, then return created/skipped and commit attendees before invitations', async () => {
  await create(booking('2031-04-02'));
  const result = await create(booking('2031-04-01', { recurrence: { frequency: 'DAILY', maxOccurrences: 3 }, attendees: [{ name: 'native-attendee', email: 'attendee@example.invalid' }] }));
  assert.equal(result.created.length, 2);
  assert.deepEqual(result.skipped, [{ startTime: '2031-04-02T01:00:00.000Z', endTime: '2031-04-02T02:00:00.000Z', code: 'RESERVATION_CONFLICT' }]);
  const attendees = (await f.db.query('SELECT "reservationId" FROM attendees WHERE "reservationId"=ANY($1::int[])', [result.created.map(r => r.id)])).rows;
  assert.equal(attendees.length, 2);
  await Promise.all(f.mailChecks);
});
for (const table of ['reservations', 'attendees']) {
  test(`Given a later ${table} write failure, when creating recurrence, then roll back rules/reservations/attendees and send nothing`, async () => {
    const day = table === 'reservations' ? '2031-05-01' : '2031-06-01';
    const condition = table === 'reservations' ? `NEW.title='rollback' AND NEW."startTime" >= '2031-05-02'::timestamp` : `EXISTS (SELECT 1 FROM reservations WHERE id=NEW."reservationId" AND title='rollback' AND "startTime">='2031-06-02'::timestamp)`;
    await f.db.query(`CREATE FUNCTION t13_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 't13 injected database failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER t13_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION t13_fail()`);
    try {
      const before = await count(), mails = f.report.mails.length;
      const response = await f.request(f.A, '/reservations', 'POST', booking(day, { title: 'rollback', recurrence: { frequency: 'DAILY', maxOccurrences: 3 }, attendees: [{ name: 'rollback', email: 'rollback@example.invalid' }] }));
      assert.equal(response.status, 500);
      assert.deepEqual(await count(), before);
      assert.equal(f.report.mails.length, mails);
    } finally { await f.db.query(`DROP TRIGGER t13_failure ON ${table}; DROP FUNCTION t13_fail()`); }
  });
}
test('Given SQL timestamp storage, when changing database timezone, then Prisma retains the UTC instant without converting legacy rows', async () => {
  const [r] = await create(booking('2031-07-01', { startTime: '2031-07-01T00:15:23.456+09:00', endTime: '2031-07-01T01:15:23.456+09:00' }));
  const raw = (await f.db.query('SELECT "startTime"::text AS value, pg_typeof("startTime")::text AS type FROM reservations WHERE id=$1', [r.id])).rows[0];
  assert.deepEqual(raw, { value: '2031-06-30 15:15:23.456', type: 'timestamp without time zone' });
  await f.db.query("ALTER DATABASE postgres SET timezone TO 'America/Los_Angeles'");
  await f.prisma.$disconnect();
  const reread = await f.request(f.A, `/reservations/${r.id}`);
  assert.equal(reread.body.data.startTime, '2031-06-30T15:15:23.456Z');
  f.report.timestamp = { raw, reread: reread.body.data.startTime, timezone: (await f.prisma.$queryRaw`SHOW timezone`)[0] };
});
test('Given a foreign organization header, when reusing the token for recurrence, then reject without writes', async () => {
  const before = await count();
  const response = await f.request({ ...f.A, orgId: f.B.orgId }, '/reservations', 'POST', booking('2031-08-01', { recurrence: { frequency: 'DAILY', maxOccurrences: 3 } }));
  assert.equal(response.status, 403);
  assert.deepEqual(await count(), before);
});

test('Given a concurrent writer after conflict precheck, when EXCLUDE rejects one occurrence, then savepoint recovery commits only the others', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let armed = true;
  f.prisma.$use(async (params, next) => {
    if (armed && params.model === 'Reservation' && params.action === 'create' && params.args.data.title === 'race' && params.args.data.startTime.toISOString().startsWith('2031-09-02')) {
      armed = false; entered.resolve(); await release.promise;
      try { return await next(params); } catch (error) { f.report.raceError = { name: error.name, code: error.code, meta: error.meta, message: error.message }; throw error; }
    }
    return next(params);
  });
  const request = f.request(f.A, '/reservations', 'POST', booking('2031-09-01', { title: 'race', recurrence: { frequency: 'DAILY', maxOccurrences: 3 }, attendees: [{ name: 'race', email: 'race@example.invalid' }] }));
  try {
    await Promise.race([entered.promise, request.then(() => { throw new Error('request completed before race gate'); }), new Promise((_, reject) => AbortSignal.timeout(10000).addEventListener('abort', () => reject(new Error('race gate timeout')), { once: true }))]);
    await f.db.query('INSERT INTO reservations ("tenantId","orgId","ownerId","spaceId",title,"startTime","endTime","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now())', [f.A.principal.tenantId, f.A.orgId, f.member.userId, f.spaceId, 'concurrent', '2031-09-02 01:00:00', '2031-09-02 02:00:00']);
  } finally { release.resolve(); }
  const response = await request;
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.created.length, 2);
  assert.equal(response.body.data.skipped.length, 1);
  assert.equal(f.report.raceError.name, 'PrismaClientUnknownRequestError');
  assert.match(f.report.raceError.message, /code: "23P01"/);
});

test('Given an unrelated database CHECK failure, when creating recurrence, then report 500 rather than occupancy 409 and roll back', async () => {
  await f.db.query(`ALTER TABLE reservations ADD CONSTRAINT t13_check CHECK (title <> 'check-failure' OR "startTime" < '2031-10-02'::timestamp)`);
  try {
    const before = await count();
    const response = await f.request(f.A, '/reservations', 'POST', booking('2031-10-01', { title: 'check-failure', recurrence: { frequency: 'DAILY', maxOccurrences: 3 } }));
    assert.equal(response.status, 500);
    assert.deepEqual(await count(), before);
  } finally { await f.db.query('ALTER TABLE reservations DROP CONSTRAINT t13_check'); }
});

test('Given non-occupancy P2004, when a later recurrence write fails, then return 500 and roll back', async () => {
  const { Prisma } = require('@prisma/client');
  let inserts = 0;
  f.prisma.$use(async (params, next) => {
    if (params.model === 'Reservation' && params.action === 'create' && params.args.data.title === 'p2004-other' && ++inserts === 2) {
      throw new Prisma.PrismaClientKnownRequestError('other constraint', { code: 'P2004', clientVersion: '5.22.0', meta: { database_error: 'other constraint failed' } });
    }
    return next(params);
  });
  const before = await count();
  const response = await f.request(f.A, '/reservations', 'POST', booking('2031-12-01', { title: 'p2004-other', recurrence: { frequency: 'DAILY', maxOccurrences: 3 } }));
  assert.equal(response.status, 500);
  assert.deepEqual(await count(), before);
});

test('Given a second attendee failure, when creating a single booking, then rollback its attendees and send no invitations', async () => {
  await f.db.query(`CREATE FUNCTION t13_single_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='single-fail' THEN RAISE EXCEPTION 'single attendee fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER t13_single_failure BEFORE INSERT ON attendees FOR EACH ROW EXECUTE FUNCTION t13_single_fail()`);
  try {
    const before = await count(), mails = f.report.mails.length;
    const response = await f.request(f.A, '/reservations', 'POST', booking('2032-01-01', { attendees: [{ name: 'first', email: 'first@example.invalid' }, { name: 'single-fail', email: 'fail@example.invalid' }] }));
    assert.equal(response.status, 500);
    assert.deepEqual(await count(), before);
    assert.equal(f.report.mails.length, mails);
  } finally { await f.db.query('DROP TRIGGER t13_single_failure ON attendees; DROP FUNCTION t13_single_fail()'); }
});

test('Given the request cap, when creating 366 occurrences then requesting 367, then commit the full allowed set and reject overflow without writes', async () => {
  const result = await create(booking('2040-01-01', { recurrence: { frequency: 'DAILY', maxOccurrences: 366 } }));
  assert.equal(result.created.length, 366);
  assert.equal(result.skipped.length, 0);
  const before = await count();
  for (const recurrence of [{ frequency: 'DAILY', maxOccurrences: 367 }, { frequency: 'DAILY', endDate: '2042-01-02' }]) {
    const response = await f.request(f.A, '/reservations', 'POST', booking('2041-01-01', { recurrence }));
    assert.equal(response.status, 400);
    assert.deepEqual(await count(), before);
  }
});

test('Given the existing scoped EXCLUDE, when native rows overlap across tenants, organizations or NULL legacy scope, then preserve isolation without global constraints', async () => {
  const sql = 'INSERT INTO reservations ("tenantId","orgId","ownerId","spaceId",title,"startTime","endTime","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now()) RETURNING id';
  const values = [f.A.principal.tenantId, f.A.orgId, f.A.userId, f.spaceId, 'scope-native', '2045-01-01 01:00:00', '2045-01-01 02:00:00'];
  await f.db.query(sql, values);
  await assert.rejects(f.db.query(sql, values), e => e.code === '23P01' && e.constraint === 'no_overlap_reservation_org');
  for (const [tenant, org] of [[f.B.principal.tenantId, f.A.orgId], [f.A.principal.tenantId, f.B.orgId], [null, null], [null, null]]) {
    assert.equal((await f.db.query(sql, [tenant, org, ...values.slice(2)])).rowCount, 1);
  }
  const constraints = (await f.db.query("SELECT conname FROM pg_constraint WHERE conrelid='reservations'::regclass AND contype='x'")).rows;
  assert.deepEqual(constraints, [{ conname: 'no_overlap_reservation_org' }]);
});

for (const failure of ['auth', 'disconnect']) {
  test(`Given ${failure} interruption at a later occurrence, when creating recurrence, then rollback all writes and invitations`, async () => {
    const title = `interrupt-${failure}`;
    let inserts = 0, armed = true;
    f.prisma.$use(async (params, next) => {
      if (armed && params.model === 'Reservation' && params.action === 'create' && params.args.data.title === title && ++inserts === 2) {
        armed = false;
        if (failure === 'auth') throw new (require('../../common/errors').ForbiddenError)('injected authority failure');
        const sessions = (await f.db.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND pid<>pg_backend_pid()")).rows;
        assert.equal(sessions.length, 1);
        await f.db.query('SELECT pg_terminate_backend($1)', [sessions[0].pid]);
      }
      return next(params);
    });
    const before = await count(), mails = f.report.mails.length;
    const response = await f.request(f.A, '/reservations', 'POST', booking('2031-11-01', { title, recurrence: { frequency: 'DAILY', maxOccurrences: 3 }, attendees: [{ name: title, email: 'interrupt@example.invalid' }] }));
    assert.equal(response.status, failure === 'auth' ? 403 : 500);
    assert.deepEqual(await count(), before);
    assert.equal(f.report.mails.length, mails);
  });
}
