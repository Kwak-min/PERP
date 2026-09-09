// Observation only: retain native Worker/SQLite/PG execution and worker result channel.
const { isMainThread, BroadcastChannel } = require('node:worker_threads');
if (!isMainThread && process.env.RUNTIME_OBSERVER_CHANNEL) {
  const channel = new BroadcastChannel(process.env.RUNTIME_OBSERVER_CHANNEL);
  channel.unref();
  const send = type => channel.postMessage({ type });
  const { DatabaseSync } = require('node:sqlite');
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql, ...args) {
    if (sql === 'BEGIN IMMEDIATE' && process.env.RUNTIME_SQLITE_LOCK === '1') {
      // A fixture-owned external write lock is released by the shutdown observation,
      // not a sleep. The native call stays on the real cleanup worker thread.
      exec.call(this, 'PRAGMA busy_timeout=30000');
      send('maintenance-lock-submitted');
    }
    return exec.call(this, sql, ...args);
  };
  const { Client } = require('pg');
  const query = Client.prototype.query;
  Client.prototype.query = function (sql, ...args) {
    const result = query.call(this, sql, ...args);
    if (sql === 'SELECT id FROM org.companies WHERE id=$1 FOR UPDATE') send('maintenance-lock-submitted');
    return result;
  };
}
