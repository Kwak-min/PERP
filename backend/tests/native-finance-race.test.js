import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { competeNative } from './native-finance-race.js';

// These stubs exercise only observer/barrier failure handling. The finance
// integration retains real pg.Pool, native SQL, authorization and HTTP.
function fixture({ acquisitionError, callbackError, queryError } = {}) {
  const pool = new EventEmitter(), clients = [], reports = [];
  Object.assign(pool, { options: { connectionTimeoutMillis: 5000 }, totalCount: 0, idleCount: 0, waitingCount: 0 });
  pool.connect = function(callback) {
    const error = callback ? callbackError : clients.length === 1 ? acquisitionError : null;
    if (error) {
      if (callback) { queueMicrotask(() => callback(error)); return; }
      return Promise.reject(error);
    }
    const client = { processID: clients.length + 1, _connectionTimeoutMillis: 5000, released: false,
      connection: { stream: { destroy() { client.destroyed = true; } } },
      query() { return queryError ? Promise.reject(queryError) : Promise.resolve({ rows: [] }); },
      release() { assert.equal(client.released, false); client.released = true; pool.emit('release', null, client); },
    };
    clients.push(client); pool.totalCount++;
    pool.emit('connect', client); pool.emit('acquire', client);
    if (callback) { queueMicrotask(() => callback(null, client, () => client.release())); return; }
    return Promise.resolve(client);
  };
  const original = pool.connect;
  const database = { async query() { return { rows: clients.map(client => ({ pid: client.processID, state: 'idle', blockers: [] })) }; } };
  const request = async signal => {
    signal.throwIfAborted();
    let client;
    try {
      client = await pool.connect();
      assert.equal(clients.length, 2, 'no transaction starts before both clients are acquired');
      await client.query('SELECT id FROM org.companies FOR UPDATE');
      return { status: 201, body: { id: 'same-native-test-id' } };
    } catch (error) { return { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE', driverCode: error.code ?? null } } }; }
    finally { client?.release(); }
  };
  return { pool, clients, reports, request,
    run(first = request, second = request) { return competeNative(pool, database, first, second, value => reports.push(value.NATIVE_FINANCE_RACE)); },
    checkCleanup() {
      assert.equal(pool.connect, original);
      for (const event of ['connect', 'acquire', 'release']) assert.equal(pool.listenerCount(event), 0);
      assert.ok(clients.every(client => client.released || client.destroyed));
      assert.equal(reports.length, 1);
    },
  };
}

test('finance observer retains both transaction clients, lock events and HTTP bodies', { timeout: 2000 }, async () => {
  const f = fixture();
  assert.deepEqual((await f.run()).map(row => row.status), [201, 201]);
  f.checkCleanup();
  const report = f.reports[0];
  assert.deepEqual(report.nativeBackendPids, [1, 2]);
  assert.equal(report.trace[0].phase, 'subscribed');
  assert.equal(report.trace.filter(row => row.phase === 'lock-dispatched').length, 2);
  assert.deepEqual(report.settlements.map(row => row.value.body), [{ id: 'same-native-test-id' }, { id: 'same-native-test-id' }]);
  assert.equal(report.failure, null);
});

test('second acquisition error stays primary and releases the first client without a barrier timeout', { timeout: 2000 }, async () => {
  const cause = Object.assign(new Error('synthetic socket failure'), { code: 'ECONNREFUSED' });
  const error = new Error('synthetic acquisition failure', { cause });
  const f = fixture({ acquisitionError: error });
  await assert.rejects(f.run(), value => value === error);
  f.checkCleanup();
  assert.equal(f.clients.length, 1);
  assert.equal(f.reports[0].failure.cause.code, 'ECONNREFUSED');
  assert.deepEqual(f.reports[0].settlements.map(row => row.value.status), [503, 503]);
  assert.ok(f.reports[0].trace.some(row => row.phase === 'transaction-acquisition-error'));
});

test('early HTTP response retains its original body instead of becoming a PID-count assertion', { timeout: 2000 }, async () => {
  const f = fixture(), response = { status: 403, body: { error: { code: 'FORBIDDEN', details: { reason: 'synthetic-authority-denial' } } } };
  await assert.rejects(f.run(f.request, async () => response), /HTTP 403/);
  f.checkCleanup();
  assert.deepEqual(f.reports[0].settlements[1].value, response);
  assert.equal(f.reports[0].settlements[0].value.status, 503);
});

test('callback authorization acquisition errors preserve callback behavior and root error', { timeout: 2000 }, async () => {
  const error = Object.assign(new Error('synthetic callback acquisition failure'), { code: '08006' });
  const f = fixture({ callbackError: error });
  const callbackRequest = () => new Promise(resolve => {
    const returned = f.pool.connect(actual => {
      assert.equal(actual, error);
      resolve({ status: 503, body: { error: { code: actual.code } } });
    });
    assert.equal(returned, undefined);
  });
  await assert.rejects(f.run(f.request, callbackRequest), actual => actual === error);
  f.checkCleanup();
  assert.ok(f.reports[0].trace.some(row => row.phase === 'callback-acquisition-error' && row.error.code === '08006'));
  assert.equal(f.reports[0].settlements[1].value.body.error.code, '08006');
});

test('query errors keep actual driver fields even when both HTTP requests settle', { timeout: 2000 }, async () => {
  const error = Object.assign(new Error('synthetic SQL failure'), { code: 'P0001', severity: 'ERROR', where: 'synthetic trigger' });
  const f = fixture({ queryError: error });
  await assert.rejects(f.run(), actual => actual === error);
  f.checkCleanup();
  assert.equal(f.reports[0].failure.code, 'P0001');
  assert.equal(f.reports[0].failure.where, 'synthetic trigger');
  assert.deepEqual(f.reports[0].settlements.map(row => row.value.status), [503, 503]);
});
