import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { setupJobs } from './deadline-wiki-jobs-fixture.js';

// The fixture and shipped runtime must not own the same process-global DB/pool.
// Observe natural child exit, not a mocked process.exit that runtime no longer calls.
const fixture = await setupJobs('pg');
const databaseFile = path.join(process.env.DEADLINE_TEMP_ROOT, `wiki-runtime-${process.pid}.db`);
let child, exited, observations, health, exitCode;
const logs = [], reports = [];
try {
  child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { once } from 'node:events';
    import { pgPool } from ${JSON.stringify(new URL('../src/config/pg.js', import.meta.url).href)};
    const { server } = await import(${JSON.stringify(new URL('../src/server.js', import.meta.url).href)});
    if (!server.listening) await once(server, 'listening', { signal: AbortSignal.timeout(10000) });
    process.on('message', message => { if (message === 'shutdown') process.emit('SIGTERM'); });
    let reported = false;
    process.on('beforeExit', () => {
      if (!reported) { reported = true; process.send({ type: 'closed', pgEnded: pgPool.ended,
        listening: server.listening, wikiListeners: process.listenerCount('orbitflow:wiki-job-queued') }); }
    });
    process.send({ type: 'ready', port: server.address().port, databaseFile: process.env.ORBITFLOW_DATABASE_FILE });
    process.channel.unref();
  `], { cwd: process.env.DEADLINE_TEMP_ROOT,
    env: { ...process.env, PORT: '0', ORBITFLOW_DATABASE_FILE: databaseFile },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const ready = once(child, 'message', { signal: AbortSignal.timeout(10000) });
  exited = once(child, 'exit', { signal: AbortSignal.timeout(20000) });
  observations = Promise.allSettled([ready, exited]);
  child.on('message', message => reports.push(message));
  child.stdout.on('data', bytes => logs.push(String(bytes)));
  child.stderr.on('data', bytes => logs.push(String(bytes)));
  const [listening] = await ready;
  assert.equal(listening.type, 'ready'); assert.equal(listening.databaseFile, databaseFile);
  assert.notEqual(databaseFile, fixture.api.resource.database);
  const response = await fetch(`http://127.0.0.1:${listening.port}/health`, { signal: AbortSignal.timeout(10000) });
  health = await response.json(); assert.equal(response.status, 200); assert.equal(health.status, 'ok');
  child.send('shutdown');
  const exit = await exited; assert.deepEqual(exit, [0, null], logs.join('\n')); [exitCode] = exit;
  assert.deepEqual(reports.find(report => report.type === 'closed'), { type: 'closed', pgEnded: true, listening: false, wikiListeners: 0 });
  // Runtime shutdown must leave fixture-owned SQLite and PG handles usable.
  assert.equal(fixture.db().prepare('SELECT 1 AS alive').get().alive, 1);
  const { pgPool } = await import('../src/config/pg.js');
  assert.equal((await pgPool.query('SELECT 1 AS alive')).rows[0].alive, 1);
  console.log(JSON.stringify({ entry: 'backend/src/server.js', health, exitCode,
    worker_shutdown_awaited: true, naturalChildExit: true, databaseFile,
    fixtureDatabase: fixture.api.resource.database, fixtureHandlesPreserved: true, reports }));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  try { await exited; await observations; }
  finally { await fixture.close({ runtime: true, health, exitCode }); }
}
