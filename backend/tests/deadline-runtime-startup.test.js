import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startOrgPostgres } from './pg-org-native-fixture.js';

for (const mode of ['bind-failure', 'external-close']) test(`actual server ${mode} owns worker startup and resource teardown`, { timeout: 30000 }, async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const native = await startOrgPostgres();
  const reservation = createServer();
  const reserved = once(reservation, 'listening', { signal: AbortSignal.timeout(10000) });
  reservation.listen(0, '127.0.0.1'); await reserved;
  const databaseFile = path.join(process.env.DEADLINE_TEMP_ROOT, `${randomUUID()}.db`);
  const script = `
    import { once } from 'node:events';
    import { DatabaseSync } from 'node:sqlite';
    import { pgPool } from ${JSON.stringify(new URL('../src/config/pg.js', import.meta.url).href)};
    let installed=0,cleared=0,sqliteCloses=0,pgConnections=0,reported=false;
    const interval=setInterval,clear=clearInterval,close=DatabaseSync.prototype.close,connect=pgPool.connect;
    globalThis.setInterval=(...args)=>{installed++;return interval(...args);};
    globalThis.clearInterval=(...args)=>{cleared++;return clear(...args);};
    DatabaseSync.prototype.close=function(...args){sqliteCloses++;return close.apply(this,args);};
    pgPool.connect=function(...args){pgConnections++;return connect.apply(this,args);};
    process.on('beforeExit',()=>{if(!reported){reported=true;process.send({installed,cleared,sqliteCloses,pgConnections,pgEnded:pgPool.ended});}});
    const {server}=await import(${JSON.stringify(new URL('../src/server.js', import.meta.url).href)});
    if(process.env.RUNTIME_MODE==='external-close') {
      if(!server.listening)await once(server,'listening',{signal:AbortSignal.timeout(10000)});
      server.close();
    }
    process.channel.unref();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.env.DEADLINE_TEMP_ROOT,
    env: { ...process.env, PORT: mode === 'bind-failure' ? String(reservation.address().port) : '0',
      RUNTIME_MODE: mode, ORBITFLOW_DATABASE_FILE: databaseFile,
      ORBITFLOW_IMPORT_CLEANUP_STORES: 'legacy', ORBITFLOW_RECEIPT_CLEANUP_STORES: 'legacy', ORBITFLOW_UPLOAD_DIR: process.env.DEADLINE_TEMP_ROOT },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(20000) }), reports = [], logs = [];
  child.on('message', message => reports.push(message));
  child.stdout.on('data', bytes => logs.push(String(bytes))); child.stderr.on('data', bytes => logs.push(String(bytes)));
  try {
    assert.deepEqual(await exited, [mode === 'bind-failure' ? 1 : 0, null], logs.join('\n'));
    assert.equal(reports.length, 1, logs.join('\n'));
    const result = reports[0];
    assert.equal(result.sqliteCloses, 1); assert.equal(result.pgEnded, true); assert.equal(existsSync(databaseFile), true);
    assert.equal(result.installed, mode === 'bind-failure' ? 0 : 2); assert.equal(result.cleared, result.installed);
    if (mode === 'bind-failure') { assert.equal(result.pgConnections, 0); assert.ok(logs.join('\n').includes('EADDRINUSE')); }
    console.log(JSON.stringify({ mode, ...result, exit: mode === 'bind-failure' ? 1 : 0 }));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    await native.close();
  }
});
