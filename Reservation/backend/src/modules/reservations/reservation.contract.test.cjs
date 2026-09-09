const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createReservationSchema, updateReservationSchema, timetableQuerySchema, listQuerySchema } = require('./reservation.schema');
const { calcRecurrenceDates } = require('./reservation.utils');
const body = { spaceId: 1, title: 'contract', startTime: '2031-01-31T10:15:23.456+09:00', endTime: '2031-01-31T11:15:23.456+09:00' };
for (const value of ['2031-02-29T10:00:00+09:00', '2030-04-31T10:00:00Z', '2031-01-31T10:00:00', '2031-01-31', 123, null]) {
  test(`Given invalid/non-instant ${value}, when parsing create and PATCH, then reject`, () => {
    assert.equal(createReservationSchema.safeParse({ ...body, startTime: value }).success, false);
    assert.equal(updateReservationSchema.safeParse({ startTime: value }).success, false);
  });
}
test('Given offset and Z, when parsing the same instant, then retain milliseconds', () => {
  const a = createReservationSchema.parse(body);
  const b = createReservationSchema.parse({ ...body, startTime: '2031-01-31T01:15:23.456Z' });
  assert.equal(a.startTime.getTime(), b.startTime.getTime());
});
test('Given impossible business dates, when parsing timetable and period, then reject', () => {
  assert.equal(timetableQuerySchema.safeParse({ spaceId: 1, date: '2031-02-29' }).success, false);
  assert.equal(listQuerySchema.safeParse({ from: '2031-04-31' }).success, false);
});
test('Given business date range, when parsing, then use Seoul midnight and reject reversed bounds', () => {
  assert.equal(listQuerySchema.parse({ from: '2031-02-01' }).from.toISOString(), '2031-01-31T15:00:00.000Z');
  assert.equal(listQuerySchema.safeParse({ from: '2031-02-02', to: '2031-02-01' }).success, false);
});
for (const [year, feb] of [[2031, 28], [2032, 29]]) {
  test(`Given January 31 ${year}, when repeating monthly, then clamp February and restore March anchor`, () => {
    const start = new Date(`${year}-01-31T23:15:23.456+09:00`);
    const actual = calcRecurrenceDates(start, { frequency: 'MONTHLY', interval: 1, maxOccurrences: 3 });
    assert.deepEqual(actual.map(d => d.toISOString()), [`${year}-01-31T14:15:23.456Z`, `${year}-02-${feb}T14:15:23.456Z`, `${year}-03-31T14:15:23.456Z`].map(s => new Date(s).toISOString()));
  });
}
test('Given selected first weekday and end date, when repeating weekly, then include both business dates at the original time', () => {
  const dto = createReservationSchema.parse({ ...body, startTime: '2031-02-03T00:15:23.456+09:00', endTime: '2031-02-03T01:15:23.456+09:00', recurrence: { frequency: 'WEEKLY', daysOfWeek: ['MON'], endDate: '2031-02-10' } });
  assert.deepEqual(calcRecurrenceDates(dto.startTime, dto.recurrence).map(d => d.toISOString()), ['2031-02-02T15:15:23.456Z', '2031-02-09T15:15:23.456Z']);
});
test('Given daily end date without a count, when exceeding 366, then reject rather than truncate', () => {
  const dto = createReservationSchema.parse({ ...body, recurrence: { frequency: 'DAILY', endDate: '2032-02-01' } });
  assert.throws(() => calcRecurrenceDates(dto.startTime, dto.recurrence), e => e.statusCode === 400);
});
test('Given occurrence limits, when parsing count, then accept 366 and reject 367', () => {
  assert.equal(createReservationSchema.safeParse({ ...body, recurrence: { frequency: 'DAILY', maxOccurrences: 366 } }).success, true);
  assert.equal(createReservationSchema.safeParse({ ...body, recurrence: { frequency: 'DAILY', maxOccurrences: 367 } }).success, false);
});
test('Given native and P2004 exclusion envelopes, when classifying conflict, then accept only the scoped occupancy constraint', () => {
  const { Prisma } = require('@prisma/client');
  const { isOccupancyConflict } = require('./reservation.booking');
  const known = message => new Prisma.PrismaClientKnownRequestError('db failed', { code: 'P2004', clientVersion: '5.22.0', meta: { database_error: message } });
  assert.equal(isOccupancyConflict(known('ERROR: conflicting key value violates exclusion constraint "no_overlap_reservation_org"')), true);
  assert.equal(isOccupancyConflict(known('ERROR: violates check constraint "no_overlap_reservation_org"')), false);
  assert.equal(isOccupancyConflict(new Error('violates exclusion constraint "no_overlap_reservation_org"')), false);
  const unknown = code => new Prisma.PrismaClientUnknownRequestError(`PostgresError { code: "${code}", message: "failure", detail: Some("code: \\"23P01\\", violates exclusion constraint \\"no_overlap_reservation_org\\"") }`, { clientVersion: '5.22.0' });
  assert.equal(isOccupancyConflict(unknown('23514')), false);
});
