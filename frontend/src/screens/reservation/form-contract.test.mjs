import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
async function moduleAt(file) {
  const output = await build({ configFile: false, envFile: false, logLevel: 'error', build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL(file, import.meta.url)), formats: ['es'] } } });
  return import(`data:text/javascript;base64,${Buffer.from(output[0].output[0].code).toString('base64')}`);
}
const [time, model, clock] = await Promise.all([moduleAt('./formTime.ts'), moduleAt('./model.ts'), moduleAt('./useOccupancyNow.ts')]);

test('Given offset and Z instants, when a Seoul field is opened and saved, then preserve the exact instant including milliseconds', () => {
  for (const [input, field, expected] of [
    ['2032-01-31T00:20:00.000Z', '2032-01-31T09:20', '2032-01-31T00:20:00.000Z'],
    ['2032-01-31T23:59:59.123+09:00', '2032-01-31T23:59:59.123', '2032-01-31T14:59:59.123Z'],
    ['2032-02-28T20:00:00-05:00', '2032-02-29T10:00', '2032-02-29T01:00:00.000Z'],
    ['2032-12-31T15:00:00Z', '2033-01-01T00:00', '2032-12-31T15:00:00.000Z'],
    ['2032-01-31T00:20:00.001Z', '2032-01-31T09:20:00.001', '2032-01-31T00:20:00.001Z'],
  ]) {
    assert.equal(time.toDatetimeLocal(input), field);
    assert.equal(time.fromDatetimeLocal(field), expected);
  }
});

test('Given a typed occupancy, when comparing now, then use confirmed [start,end) rather than any booking on the date', () => {
  const row = { startTime: '2032-01-31T09:00:00+09:00', endTime: '2032-01-31T09:15:00+09:00', status: 'CONFIRMED' };
  for (const [now, expected] of [['2032-01-30T23:59:59.999Z', false], ['2032-01-31T00:00:00Z', true], ['2032-01-31T00:14:59.999Z', true], ['2032-01-31T00:15:00Z', false]]) assert.equal(clock.isCurrentlyBusy(row, Date.parse(now)), expected);
  assert.equal(clock.isCurrentlyBusy({ ...row, status: 'CANCELLED' }, Date.parse('2032-01-31T00:05:00Z')), false);
});

const reservation = { id: 12, spaceId: 3, userId: null, title: 'fixture', description: null, startTime: '2032-01-31T00:00:00Z', endTime: '2032-01-31T01:00:00Z', status: 'CONFIRMED', recurrenceRuleId: null, createdAt: '2032-01-01T00:00:00Z', updatedAt: '2032-01-01T00:00:00Z' };
const skipped = { startTime: '2032-02-01T00:00:00Z', endTime: '2032-02-01T01:00:00Z', code: 'RESERVATION_CONFLICT' };
test('Given a single creation array, when parsed, then preserve created records and zero skipped', () => {
  assert.deepEqual(model.reservationCreationSchema.parse([reservation]), { created: [reservation], skipped: [] });
});
test('Given partial or zero-created recurrence DTOs, when parsed, then preserve exact skipped intervals', () => {
  for (const created of [[reservation], []]) assert.deepEqual(model.reservationCreationSchema.parse({ created, skipped: [skipped] }), { created, skipped: [skipped] });
});
test('Given malformed recurrence responses, when parsed, then reject rather than report false zero-count success', () => {
  for (const raw of [{}, { created: [reservation] }, { created: [], skipped: [{ ...skipped, code: 'SERVER_ERROR' }] }, { created: [], skipped: [{ ...skipped, startTime: '2032-01-01T09:00:00' }] }]) assert.equal(model.reservationCreationSchema.safeParse(raw).success, false);
});
