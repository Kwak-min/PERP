import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { readImportCleanupConfig, startImportCleanup, runImportCleanupStore } from '../src/services/expense-import-maintenance.js';

function controlledTimers() {
  let interval, deadline;
  return {
    setInterval(fn, ms) { assert.equal(interval, undefined); interval = { fn, ms }; return interval; },
    clearInterval(handle) { assert.equal(handle, interval); interval = undefined; },
    setTimeout(fn, ms) { assert.equal(deadline, undefined); deadline = { fn, ms }; return deadline; },
    clearTimeout(handle) { assert.equal(handle, deadline); deadline = undefined; },
    tick() { return interval?.fn(); },
    expire() { deadline.fn(); },
    get interval() { return interval; },
    get deadline() { return deadline; },
  };
}
const legacyEnv = { ORBITFLOW_IMPORT_CLEANUP_STORES: 'legacy', ORBITFLOW_DATABASE_FILE: 'D:/fixture/imports.db' };
const pgEnv = { PG_HOST: '127.0.0.1', PG_PORT: '54399', PG_DATABASE: 'fixture', PG_USER: 'fixture' };

test('configuration is explicit, bounded, and never chooses a fallback store', () => {
  assert.deepEqual(readImportCleanupConfig({}).stores, []);
  const config = readImportCleanupConfig(legacyEnv);
  assert.deepEqual(config.stores, ['legacy']); assert.equal(config.intervalMs, 3600000); assert.equal(config.timeoutMs, 30000);
  assert.deepEqual(readImportCleanupConfig({ ...legacyEnv, ...pgEnv, ORBITFLOW_IMPORT_CLEANUP_STORES: 'legacy,perp_db' }).stores, ['legacy','perp_db']);
  assert.deepEqual(readImportCleanupConfig({ ...pgEnv, ORBITFLOW_IMPORT_CLEANUP_STORES: 'perp_db' }).stores, ['perp_db']);
  for (const patch of [
    { ORBITFLOW_IMPORT_CLEANUP_STORES: 'auto' }, { ORBITFLOW_IMPORT_CLEANUP_STORES: 'legacy,legacy' },
    { ORBITFLOW_DATABASE_FILE: '' }, { ORBITFLOW_DATABASE_FILE: ':memory:' },
    { ORBITFLOW_IMPORT_CLEANUP_INTERVAL_MS: '0' }, { ORBITFLOW_IMPORT_CLEANUP_INTERVAL_MS: '2147483648' },
    { ORBITFLOW_IMPORT_CLEANUP_TIMEOUT_MS: 'NaN' }, { ORBITFLOW_IMPORT_CLEANUP_TIMEOUT_MS: '3600001' },
    { ORBITFLOW_IMPORT_CLEANUP_STORES: 'perp_db' },
  ]) assert.throws(() => readImportCleanupConfig({ ...legacyEnv, ...patch }), { code: 'IMPORT_CLEANUP_CONFIG' });
});

test('scheduled ticks do not overlap, failure retries only next tick, shutdown owns the timer', { timeout: 10000 }, async () => {
  const timers = controlledTimers(), records = [], events = new EventEmitter(), calls = [];
  let finish;
  const config = readImportCleanupConfig({ ...legacyEnv, ...pgEnv, ORBITFLOW_IMPORT_CLEANUP_STORES: 'legacy,perp_db' });
  const job = startImportCleanup(config, { timers, log: record => records.push(record), runStore: async (store, _config, signal) => {
    calls.push(store); events.emit('entered');
    if (calls.length === 1) return new Promise(resolve => { finish = resolve; });
    assert.equal(signal.aborted, false); return { status: 'succeeded', deleted: 0, redacted: 0 };
  } });
  assert.equal(calls.length, 0); assert.equal(timers.interval.ms, 3600000);
  const entered = once(events, 'entered', { signal: AbortSignal.timeout(5000) });
  const first = timers.tick(); await entered;
  await timers.tick(); assert.deepEqual(calls, ['legacy']);
  finish({ status: 'failed', reason: 'busy' }); await first;
  assert.deepEqual(calls, ['legacy','perp_db']);
  assert.equal(records.find(r => r.status === 'failed').retry, 'next_tick');
  await timers.tick(); assert.deepEqual(calls, ['legacy','perp_db','legacy','perp_db']);
  await job.stop(); await job.stop(); assert.equal(timers.interval, undefined); assert.equal(timers.deadline, undefined);
  assert.equal(records.filter(r => r.status === 'stopped').length, 1);
});

test('disabled maintenance owns no timer; stop aborts the active store and never starts the second', { timeout: 10000 }, async () => {
  const timers = controlledTimers();
  await startImportCleanup(readImportCleanupConfig({}), { timers, log() {} }).stop();
  assert.equal(timers.interval, undefined);
  const calls = [], events = new EventEmitter();
  const config = readImportCleanupConfig({ ...legacyEnv, ...pgEnv, ORBITFLOW_IMPORT_CLEANUP_STORES: 'legacy,perp_db' });
  const job = startImportCleanup(config, { timers, log() {}, runStore: (store, _config, signal) => new Promise(resolve => {
    calls.push(store); signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }); events.emit('entered');
  }) });
  const entered = once(events, 'entered', { signal: AbortSignal.timeout(5000) });
  const running = timers.tick(); await entered; await job.stop(); await running;
  assert.deepEqual(calls, ['legacy']); assert.equal(timers.interval, undefined);
});

test('bounded worker timeout and shutdown wait for actual worker exit, with no orphan deadline', { timeout: 15000 }, async () => {
  for (const kind of ['imports','receipts']) for (const action of ['timeout','cancelled']) {
    const timers = controlledTimers(), controller = new AbortController();
    let online, worker, exited = false;
    const config = readImportCleanupConfig({ ...legacyEnv, ORBITFLOW_UPLOAD_DIR: process.env.DEADLINE_TEMP_ROOT,
      ORBITFLOW_RECEIPT_CLEANUP_STORES: kind === 'receipts' ? 'legacy' : '' });
    const result = runImportCleanupStore('legacy', config, controller.signal, { kind, timers, createWorker(_url, options) {
      assert.equal(options.workerData.kind, kind); assert.equal(options.env.ORBITFLOW_UPLOAD_DIR, config.uploadRoot);
      worker = new Worker("require('node:worker_threads').parentPort.on('message', () => {});", { eval: true });
      online = once(worker, 'online', { signal: AbortSignal.timeout(5000) });
      worker.once('exit', () => { exited = true; }); return worker;
    } });
    try {
      await online;
      assert.equal(timers.deadline.ms, 30000);
      if (action === 'timeout') timers.expire(); else controller.abort();
      assert.deepEqual(await result, action === 'timeout' ? { status: 'failed', reason: 'timeout' } : { status: 'cancelled' });
      assert.equal(exited, true); assert.equal(timers.deadline, undefined);
    } finally { await worker.terminate(); }
  }
});

test('receipt configuration is independent and requires the explicit API upload root and selected DB', () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const receiptEnv = { ORBITFLOW_RECEIPT_CLEANUP_STORES: 'legacy', ORBITFLOW_DATABASE_FILE: legacyEnv.ORBITFLOW_DATABASE_FILE, ORBITFLOW_UPLOAD_DIR: process.env.DEADLINE_TEMP_ROOT };
  assert.deepEqual(readImportCleanupConfig(legacyEnv).receiptStores, []);
  const receipt = readImportCleanupConfig(receiptEnv);
  assert.deepEqual(receipt.stores, []); assert.deepEqual(receipt.receiptStores, ['legacy']);
  assert.equal(receipt.uploadRoot, process.env.DEADLINE_TEMP_ROOT);
  for (const patch of [
    { ORBITFLOW_RECEIPT_CLEANUP_STORES: 'auto' }, { ORBITFLOW_RECEIPT_CLEANUP_STORES: 'legacy,legacy' },
    { ORBITFLOW_RECEIPT_CLEANUP_STORES: 'legacy,' }, { ORBITFLOW_UPLOAD_DIR: '' },
    { ORBITFLOW_UPLOAD_DIR: './relative-uploads' }, { ORBITFLOW_UPLOAD_DIR: `${process.env.DEADLINE_TEMP_ROOT}/absent-root` },
    { ORBITFLOW_DATABASE_FILE: '' }, { ORBITFLOW_RECEIPT_CLEANUP_STORES: 'perp_db' },
  ]) assert.throws(() => readImportCleanupConfig({ ...receiptEnv, ...patch }), { code: 'IMPORT_CLEANUP_CONFIG' });
  assert.deepEqual(readImportCleanupConfig({ ...receiptEnv, ...pgEnv, ORBITFLOW_RECEIPT_CLEANUP_STORES: 'perp_db' }).receiptStores, ['perp_db']);
});

test('receipt-only and combined jobs share one nonoverlapping clock, retry and shutdown owner', { timeout: 10000 }, async () => {
  for (const imports of ['', 'legacy']) {
    const timers = controlledTimers(), records = [], calls = [], events = new EventEmitter();
    const config = readImportCleanupConfig({ ...legacyEnv, ...pgEnv, ORBITFLOW_IMPORT_CLEANUP_STORES: imports,
      ORBITFLOW_RECEIPT_CLEANUP_STORES: 'legacy,perp_db', ORBITFLOW_UPLOAD_DIR: process.env.DEADLINE_TEMP_ROOT });
    let finish;
    const job = startImportCleanup(config, { timers, log: r => records.push(r), runStore: (store, _config, signal, { kind }) => {
      calls.push([kind,store]); events.emit('entered');
      if (calls.length === 1) return new Promise(resolve => { finish = resolve; signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }); });
      return Promise.resolve(kind === 'receipts' ? { status: 'failed', reason: 'unlink_failed', deleted: 1, failed: 1, shared: 1, raw: 'PRIVATE-RECEIPT' }
        : { status: 'succeeded', deleted: 0, redacted: 0 });
    } });
    assert.ok(timers.interval, 'receipt-only configuration installs the same owned timer');
    const entered = once(events, 'entered', { signal: AbortSignal.timeout(5000) });
    const first = timers.tick(); await entered; await timers.tick(); assert.equal(calls.length, 1);
    finish({ status: 'succeeded', deleted: 0, redacted: 0, failed: 0, shared: 0 }); await first;
    const expected = [...(imports ? [['imports','legacy']] : []), ['receipts','legacy'], ['receipts','perp_db']];
    assert.deepEqual(calls, expected);
    const failure = records.find(r => r.kind === 'receipts' && r.status === 'failed');
    assert.equal(failure.retry, 'next_tick'); assert.equal(failure.deleted, 1); assert.equal(failure.failed, 1); assert.equal(failure.shared, 1);
    assert.equal(JSON.stringify(records).includes('PRIVATE-RECEIPT'), false);
    await timers.tick(); assert.deepEqual(calls, [...expected,...expected]);
    await job.stop(); assert.equal(timers.interval, undefined); assert.equal(timers.deadline, undefined);
  }
});

test('receipt-only shutdown aborts current worker and never starts the remaining store', { timeout: 10000 }, async () => {
  const timers = controlledTimers(), calls = [], events = new EventEmitter();
  const config = readImportCleanupConfig({ ...legacyEnv, ...pgEnv, ORBITFLOW_IMPORT_CLEANUP_STORES: '',
    ORBITFLOW_RECEIPT_CLEANUP_STORES: 'legacy,perp_db', ORBITFLOW_UPLOAD_DIR: process.env.DEADLINE_TEMP_ROOT });
  const job = startImportCleanup(config, { timers, log() {}, runStore: (store, _config, signal, { kind }) => new Promise(resolve => {
    calls.push([kind,store]); signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }); events.emit('entered');
  }) });
  assert.ok(timers.interval);
  const entered = once(events, 'entered', { signal: AbortSignal.timeout(5000) });
  const running = timers.tick(); await entered; await job.stop(); await running;
  assert.deepEqual(calls, [['receipts','legacy']]); assert.equal(timers.interval, undefined);
});

test('unexpected errors are bounded operational fields, never exception content', { timeout: 10000 }, async () => {
  const timers = controlledTimers(), records = [];
  const job = startImportCleanup(readImportCleanupConfig(legacyEnv), { timers, log: record => records.push(record), runStore() {
    throw new Error('SECRET-RAW SQL password://credentials');
  } });
  await timers.tick(); await job.stop();
  assert.equal(records.find(r => r.status === 'failed').reason, 'worker_error');
  assert.equal(JSON.stringify(records).includes('SECRET-RAW'), false);
});
