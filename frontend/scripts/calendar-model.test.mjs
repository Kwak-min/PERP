import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarCells, calendarRecordsForDate, calendarInputSchema, localDateInput, monthWindow, parseCalendarRecords } from '../src/components/data/calendarModel.ts';

const record = (start_at, end_at, extra = {}) => ({ id: '42', title: 'CALENDAR_QA', start_at, end_at, location: null, ...extra });
for (const zone of ['Asia/Seoul', 'America/New_York', 'UTC']) test(`month boundaries and local create input preserve instants in ${zone}`, () => {
  // Given: a browser-local month and form fields in the same timezone.
  process.env.TZ = zone;
  const shown = new Date(2026, 8, 1);
  // When: producing query bounds and parsing the create form.
  const range = monthWindow(shown);
  const parsed = calendarInputSchema.parse({ title: 'NEW', start: '2026-09-10T09:00', end: '2026-09-10T10:00', location: '' });
  // Then: both boundaries and persisted instants round trip to local wall time.
  assert.equal(new Date(range.from).getDate(), 1);
  assert.equal(new Date(range.to).getMonth(), 9);
  assert.equal(new Date(range.to).getHours(), 0);
  assert.equal(new Date(parsed.start.toISOString()).getHours(), 9);
  assert.equal(localDateInput(parsed.start), '2026-09-10');
});
test('multi-day and cross-month intervals occupy every local day except an exclusive midnight end', () => {
  // Given: an event crossing August/September, in Seoul.
  process.env.TZ = 'Asia/Seoul';
  const events = [record('2026-08-31T23:00:00+09:00', '2026-09-03T00:00:00+09:00')];
  // When: projecting each month.
  const september = calendarCells(events, new Date(2026, 8, 1));
  const august = calendarCells(events, new Date(2026, 7, 1));
  // Then: Sep 1/2 and Aug 31, never Sep 3.
  assert.deepEqual(september.map(event => event.day), [1, 2]);
  assert.deepEqual(august.map(event => event.day), [31]);
  assert.equal(september[0].href, '/calendar/42');
});
test('UTC dates near midnight are placed on their local date, including instant events', () => {
  process.env.TZ = 'Asia/Seoul';
  // Given: September UTC timestamp that is already October in the browser.
  const events = [record('2026-09-30T15:30:00Z', '2026-09-30T15:30:00Z')];
  // When: projecting the boundary months.
  const september = calendarCells(events, new Date(2026, 8, 1));
  const october = calendarCells(events, new Date(2026, 9, 1));
  // Then: only October 1.
  assert.deepEqual(september, []);
  assert.deepEqual(october.map(event => event.day), [1]);
});
test('DST changes advance by calendar dates rather than fixed 24-hour intervals', () => {
  process.env.TZ = 'America/New_York';
  // Given: an interval spanning the 23-hour spring-forward day.
  const events = [record('2026-03-07T23:00:00-05:00', '2026-03-10T00:00:00-04:00')];
  // When: projecting March.
  const cells = calendarCells(events, new Date(2026, 2, 1));
  // Then: all three calendar dates occur once.
  assert.deepEqual(cells.map(event => event.day), [7, 8, 9]);
});
test('both wire DTOs normalize IDs and timestamps without timezone loss', () => {
  // Given: equivalent PG/legacy payloads.
  const legacy = record('2026-09-07T01:00:00Z', '2026-09-07T02:00:00Z');
  const pg = { __id: 42, 일정: legacy.title, 시작: legacy.start_at, 종료: legacy.end_at, 장소: null };
  // When: parsing each boundary.
  const pgRecords = parseCalendarRecords({ items: [pg] }, true);
  // Then: one normalized shape, and empty is really empty.
  assert.deepEqual(pgRecords, parseCalendarRecords({ items: [legacy] }, false));
  assert.deepEqual(parseCalendarRecords({ items: [] }, true), []);
  assert.throws(() => parseCalendarRecords({ items: [{ ...pg, 시작: 'not-a-date' }] }, true));
  assert.throws(() => parseCalendarRecords({ items: [{ ...pg, 시작: '2026-09-07T01:00' }] }, true));
});
for (const zone of ['Asia/Seoul', 'America/New_York', 'UTC']) test(`selected dates match grid overlap and preserve complete records in ${zone}`, () => {
  process.env.TZ = zone;
  const events = [
    record('2026-08-31T23:00:00+09:00', '2026-09-03T00:00:00+09:00', { id: 'cross-month', location: 'ROOM' }),
    record('2026-09-10T09:00:00+09:00', '2026-09-12T12:00:00+09:00', { id: 'multi-day' }),
    record('2026-09-30T15:30:00Z', '2026-09-30T15:30:00Z', { id: 'instant' }),
  ];
  for (const month of [7, 8, 9]) {
    const grid = calendarCells(events, new Date(2026, month, 1));
    for (let day = 1; day <= new Date(2026, month + 1, 0).getDate(); day++) {
      const selected = calendarRecordsForDate(events, new Date(2026, month, day, 15));
      assert.deepEqual(selected.map(event => event.id), grid.filter(cell => cell.day === day).map(cell => cell.id));
      for (const event of selected) assert.equal(event, events.find(source => source.id === event.id));
    }
  }
});
test('selected list has no preview limit and orders by instant then ID without changing source', () => {
  process.env.TZ = 'Asia/Seoul';
  const events = Array.from({ length: 105 }, (_, index) => record('2026-09-07T09:00:00+09:00', '2026-09-07T10:00:00+09:00', { id: String(105 - index) }));
  const original = [...events];
  const selected = calendarRecordsForDate(events, new Date(2026, 8, 7));
  assert.equal(selected.length, 105);
  assert.deepEqual(selected.map(event => event.id), events.map(event => event.id).sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(events, original);
  assert.deepEqual(calendarRecordsForDate(events, new Date(2026, 8, 8)), []);
});
test('selected dates honor exclusive midnight, instant boundaries and DST calendar days', () => {
  process.env.TZ = 'America/New_York';
  const events = [record('2026-03-07T23:00:00-05:00', '2026-03-10T00:00:00-04:00')];
  for (const day of [7, 8, 9]) assert.equal(calendarRecordsForDate(events, new Date(2026, 2, day)).length, 1);
  assert.deepEqual(calendarRecordsForDate(events, new Date(2026, 2, 10)), []);
  const instant = [record('2026-03-10T00:00:00-04:00', '2026-03-10T00:00:00-04:00')];
  assert.deepEqual(calendarRecordsForDate(instant, new Date(2026, 2, 9)), []);
  assert.equal(calendarRecordsForDate(instant, new Date(2026, 2, 10)).length, 1);
});
test('invalid create periods are rejected before sending a mutation', () => {
  // Given: a reversed period.
  const values = { title: 'NEW', start: '2026-09-10T10:00', end: '2026-09-10T09:00', location: '' };
  // When/Then: the form boundary rejects it.
  assert.equal(calendarInputSchema.safeParse(values).success, false);
});
