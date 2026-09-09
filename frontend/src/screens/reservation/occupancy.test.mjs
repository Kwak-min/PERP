import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
const result = await build({ configFile: false, envFile: false, logLevel: 'error', build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL('./occupancy.ts', import.meta.url)), formats: ['es'] } } });
const api = await import(`data:text/javascript;base64,${Buffer.from(result[0].output[0].code).toString('base64')}`);
const day = '2032-01-31';
const interval = (start, end) => ({ startTime: `${day}T${start}:00+09:00`, endTime: `${day}T${end}:00+09:00` });
const booking = (id, start, end) => ({ ...interval(start, end), id, spaceId: 1, isMine: false, status: 'CONFIRMED' });

test('all independent bookings remain when a compatibility slot has only its first match', () => {
  const rows = [booking(1, '09:05', '09:20'), booking(2, '09:35', '09:50')];
  const raw = { spaceId: 1, date: day, reservations: rows, slots: [{ reservation: rows[0] }] };
  assert.deepEqual(api.completeTimetableSchema.parse(raw).reservations.map(row => row.id), [1, 2]);
  assert.equal(api.completeTimetableSchema.safeParse({ ...raw, reservations: undefined }).success, false);
});
test('exact free gaps survive when two bookings share the same hour', () => {
  const rows = [booking(2, '09:35', '09:50'), booking(1, '09:05', '09:20')];
  const bounds = { start: Date.parse(`${day}T09:00+09:00`), end: Date.parse(`${day}T10:00+09:00`) };
  const gaps = api.freeIntervals(rows, bounds);
  assert.deepEqual(gaps.map(row => [Date.parse(row.startTime), Date.parse(row.endTime)]), [['09:00', '09:05'], ['09:20', '09:35'], ['09:50', '10:00']].map(([a,b]) => [Date.parse(`${day}T${a}+09:00`), Date.parse(`${day}T${b}+09:00`)]));
  assert.deepEqual(rows.map(row => row.id), [2, 1]);
});
test('midnight overlap appears on both business days but not at the exclusive end', () => {
  const row = { ...booking(3, '23:30', '23:59'), endTime: '2032-02-01T00:30:00+09:00' };
  assert.equal(api.dayOccupancy([row], day).length, 1);
  assert.equal(api.dayOccupancy([row], '2032-02-01').length, 1);
  assert.equal(api.dayOccupancy([{ ...row, endTime: '2032-02-01T00:00:00+09:00' }], '2032-02-01').length, 0);
});
test('overlapping and adjacent bookings form one busy union and cancelled rows do not consume gaps', () => {
  const rows = [booking(1, '09:00', '10:00'), booking(2, '09:30', '11:00'), booking(3, '11:00', '12:00'), { ...booking(4, '12:00', '13:00'), status: 'CANCELLED' }];
  const bounds = { start: Date.parse(`${day}T08:00+09:00`), end: Date.parse(`${day}T14:00+09:00`) };
  assert.deepEqual(api.freeIntervals(rows, bounds).map(row => [row.startTime, row.endTime]), [['2032-01-30T23:00:00.000Z', '2032-01-31T00:00:00.000Z'], ['2032-01-31T03:00:00.000Z', '2032-01-31T05:00:00.000Z']]);
});
test('busy spanning a viewport consumes the full range; empty day leaves a full-day gap', () => {
  const bounds = api.dayBounds(day);
  const row = { ...booking(1, '00:00', '23:59'), startTime: '2032-01-30T10:00:00Z', endTime: '2032-02-01T10:00:00Z' };
  assert.deepEqual(api.freeIntervals([row], bounds), []);
  assert.deepEqual(api.freeIntervals([], bounds), [{ startTime: '2032-01-30T15:00:00.000Z', endTime: '2032-01-31T15:00:00.000Z' }]);
});
test('nonowner response accepts redaction and discards private fields instead of demanding owner data', () => {
  const row = api.occupancySchema.parse({ ...booking(1, '09:00', '10:00'), title: 'private', ownerId: 'secret', attendees: [{ email: 'private' }] });
  assert.equal('title' in row, false); assert.equal('ownerId' in row, false); assert.equal('attendees' in row, false);
  assert.equal(api.occupancySchema.safeParse({ ...row, startTime: '2032-01-31T09:00:00' }).success, false);
});
test('month/day arithmetic preserves leap and year boundaries regardless of local timezone', () => {
  assert.equal(api.shiftMonth('2032-01', 1), '2032-02');
  assert.equal(api.shiftMonth('2032-12', 1), '2033-01');
  assert.equal(api.shiftDay('2032-02-28', 1), '2032-02-29');
  assert.equal(api.shiftDay('2032-03-01', -1), '2032-02-29');
  assert.equal(api.seoulDay(new Date('2032-01-31T15:00:00Z')), '2032-02-01');
});
