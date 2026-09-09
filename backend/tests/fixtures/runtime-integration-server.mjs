import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { once } from 'node:events';
import { Server } from 'node:http';
import { BroadcastChannel } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import * as wiki from '../../src/services/knowledge-wiki-worker.service.js';
import * as maintenance from '../../src/services/expense-import-maintenance.js';
import { pgPool } from '../../src/config/pg.js';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
const send = message => { if (process.connected) process.send(message); };
const intervals = new Map(), starts = [], stops = { wiki: 0, cleanup: 0 }, activeWorkers = new Set();
let httpListening = false, sqliteCloses = 0;
const stopGate = Promise.withResolvers();
const connectPg = pgPool.connect;
pgPool.connect = function (...args) { send({ type: 'pg-connect' }); return connectPg.apply(this, args); };
const execDb = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (...args) { send({ type: 'sqlite-exec' }); return execDb.apply(this, args); };
const emit = Server.prototype.emit;
Server.prototype.emit = function (name, ...args) {
  if (name === 'listening') httpListening = true;
  return emit.call(this, name, ...args);
};
globalThis.setInterval = (fn, ms) => {
  const handle = { unref() { return this; } };
  intervals.set(handle, { fn, ms }); return handle;
};
globalThis.clearInterval = handle => intervals.delete(handle);
const closeDb = DatabaseSync.prototype.close;
DatabaseSync.prototype.close = function (...args) { sqliteCloses++; return closeDb.apply(this, args); };
process.on('worker', worker => {
  activeWorkers.add(worker);
  worker.once('exit', code => { activeWorkers.delete(worker); send({ type: 'worker-exit', code }); });
});
const observer = new BroadcastChannel(process.env.RUNTIME_OBSERVER_CHANNEL);
observer.onmessage = ({ data }) => send(data); observer.unref();

// Transparent wrappers, not fake workers: actual starts, wake/drain/abort/stop,
// native threads and DB calls remain in the shipped implementations.
function observeStart(kind, start, args) {
  starts.push({ kind, httpListening });
  const worker = start(...args);
  if (kind === 'wiki') worker.wake()?.then(() => send({ type: 'wiki-idle' }));
  return { ...worker, stop() {
    stops[kind]++;
    const stopped = worker.stop();
    return Promise.resolve(stopped).then(async () => {
      send({ type: `${kind}-stopped` });
      if (process.env.RUNTIME_STOP_GATE === kind) {
        // Additional seam-only barrier AFTER real workers have stopped. Keep only
        // the fixture IPC alive so a premature DB teardown can be inspected.
        process.channel.ref(); await stopGate.promise; process.channel.unref();
      }
      if (process.env.RUNTIME_STOP_ERROR === kind) throw Object.assign(new Error('fixture stop failure'), { code: 'FIXTURE_STOP' });
    });
  } };
}
mock.module('../../src/services/knowledge-wiki-worker.service.js', {
  namedExports: { ...wiki, startWikiWorker: (...args) => observeStart('wiki', wiki.startWikiWorker, args) },
});
mock.module('../../src/services/expense-import-maintenance.js', {
  namedExports: { ...maintenance, startImportCleanup: (...args) => observeStart('cleanup', maintenance.startImportCleanup, args) },
});
const { server } = await import('../../src/server.js');
if (!server.listening) await once(server, 'listening', { signal: AbortSignal.timeout(10000) });
server.on('request', req => { if (req.headers['x-runtime-held']) send({ type: 'request-active' }); });
server.on('close', () => send({ type: 'http-closed' }));
if (process.env.RUNTIME_STOP_ERROR === 'http') {
  const close = server.close;
  server.close = function (callback) {
    return close.call(this, error => callback(error ?? Object.assign(new Error('fixture close failure'), { code: 'FIXTURE_CLOSE' })));
  };
}
process.on('message', message => {
  if (message === 'release-stop') stopGate.resolve();
  if (message === 'inspect') send({ type: 'inspected', pgEnded: pgPool.ended, sqliteCloses, listening: server.listening });
  if (message === 'tick') for (const { fn, ms } of [...intervals.values()]) if (ms === 3600000) void fn();
  if (message === 'shutdown' || message === 'close') {
    if (message === 'close') server.close();
    else { process.emit('SIGTERM'); process.emit('SIGTERM'); process.emit('SIGINT'); }
    send({ type: 'shutdown-requested', stops: { ...stops }, listening: server.listening,
      wikiListeners: process.listenerCount('orbitflow:wiki-job-queued'), intervalCount: intervals.size });
    // Stopped scheduler callbacks must not accept any more requested work.
    process.emit('orbitflow:wiki-job-queued');
    for (const { fn, ms } of [...intervals.values()]) if (ms === 3600000) void fn();
  }
});
let reported = false;
process.on('beforeExit', () => {
  if (reported) return; reported = true;
  send({ type: 'resources-closed', stops, activeWorkers: activeWorkers.size, intervalCount: intervals.size,
    wikiListeners: process.listenerCount('orbitflow:wiki-job-queued'), pgEnded: pgPool.ended, sqliteCloses, listening: server.listening });
  observer.close();
});
send({ type: 'ready', port: server.address().port, starts });
// IPC is an observation channel, not an application-owned keepalive.
process.channel.unref();
