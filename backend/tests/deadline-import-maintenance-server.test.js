import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 실제 server.js 진입점과 SIGTERM 경로. child의 cadence만 제어하고 worker/DB/HTTP는 실제 실행한다.
for (const selection of ['imports','receipts','both']) test(`server startup schedules ${selection}, real HTTP survives a tick, SIGTERM exits after owned cleanup stops`, { timeout: 30000 }, async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const databaseFile = path.join(process.env.DEADLINE_TEMP_ROOT, `maintenance-server-${selection}.db`);
  const uploadRoot = path.join(process.env.DEADLINE_TEMP_ROOT, `maintenance-server-${selection}-uploads`);
  await mkdir(path.join(uploadRoot,'receipts'), { recursive: true });
  const importsEnabled = selection !== 'receipts', receiptsEnabled = selection !== 'imports';
  const events = new EventEmitter(), records = [], lines = [];
  const scheduled = once(events, 'scheduled', { signal: AbortSignal.timeout(10000) });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/import-maintenance-server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '0', ORBITFLOW_DATABASE_FILE: databaseFile, ORBITFLOW_UPLOAD_DIR: uploadRoot,
      ORBITFLOW_IMPORT_CLEANUP_STORES: importsEnabled ? 'legacy' : '', ORBITFLOW_RECEIPT_CLEANUP_STORES: receiptsEnabled ? 'legacy' : '' },
    stdio: ['ignore','pipe','pipe','ipc'],
  });
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(25000) });
  const ready = once(child, 'message', { signal: AbortSignal.timeout(10000) });
  const output = createInterface({ input: child.stdout });
  output.on('line', line => {
    lines.push(line);
    if (!line.startsWith('{')) return;
    const record = JSON.parse(line);
    if (record.event === 'expense_import_cleanup') { records.push(record); events.emit(record.status, record); events.emit(`${record.status}:${record.kind}`, record); }
  });
  child.stderr.on('data', chunk => lines.push(String(chunk)));
  let db;
  try {
    const [[message], [configuration]] = await Promise.all([ready, scheduled]);
    assert.equal(message.ready, true); assert.ok(message.port > 0);
    assert.equal(configuration.interval_ms, 3600000);
    assert.deepEqual(configuration.stores, importsEnabled ? ['legacy'] : []);
    assert.deepEqual(configuration.receipt_stores, receiptsEnabled ? ['legacy'] : []);
    db = new DatabaseSync(databaseFile);
    const expired = randomUUID(), active = randomUUID();
    const insert = db.prepare('INSERT INTO expense_import_uploads(id,tenant_id,org_id,actor_id,raw,raw_sha256,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)');
    insert.run(expired,'fixture','fixture','fixture',Buffer.from('PRIVATE-RAW'),'hash','2000-01-01','2000-01-02');
    insert.run(active,'fixture','fixture','fixture',Buffer.from('ACTIVE-RAW'),'hash','2000-01-01','2999-01-01');
    const expiredReceipt = randomUUID(), activeReceipt = randomUUID();
    for (const [id,expiry] of [[expiredReceipt,'2000-01-01'],[activeReceipt,'2999-01-01']]) {
      db.prepare(`INSERT INTO receipt_upload(id,token_hash,source,tenant_id,org_id,actor_id,kind,storage_key,filename,mime,extension,size_bytes,checksum_sha256,state,created_at,expires_at)
        VALUES(?,?,'legacy','fixture','fixture','fixture','transaction',?,'PRIVATE-original.png','image/png','.png',1,'hash','ready','2000-01-01',?)`).run(id,id,`receipts/${id}.png`,expiry);
      await writeFile(path.join(uploadRoot,`receipts/${id}.png`),'PRIVATE-RECEIPT');
    }
    const kinds = [...(importsEnabled ? ['imports'] : []), ...(receiptsEnabled ? ['receipts'] : [])];
    const success = Promise.all(kinds.map(kind => once(events, `succeeded:${kind}`, { signal: AbortSignal.timeout(10000) })));
    child.send('tick'); const results = await success;
    for (const [result] of results) { assert.equal(result.deleted, 1); if (result.kind === 'imports') assert.equal(result.redacted, 0); else { assert.equal(result.failed, 0); assert.equal(result.shared, 0); } }
    assert.deepEqual(db.prepare('SELECT id FROM expense_import_uploads ORDER BY id').all().map(r => r.id), (importsEnabled ? [active] : [active,expired]).sort());
    assert.equal(db.prepare('SELECT state FROM receipt_upload WHERE id=?').get(expiredReceipt).state, receiptsEnabled ? 'deleted' : 'ready');
    assert.equal(existsSync(path.join(uploadRoot,`receipts/${expiredReceipt}.png`)),!receiptsEnabled);
    assert.equal(await readFile(path.join(uploadRoot,`receipts/${activeReceipt}.png`),'utf8'),'PRIVATE-RECEIPT');
    const response = await fetch(`http://127.0.0.1:${message.port}/health`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const stopped = once(events, 'stopped', { signal: AbortSignal.timeout(10000) });
    child.send('shutdown'); await stopped;
    assert.deepEqual(await exited, [0,null], lines.join('\n'));
    assert.equal(JSON.stringify(records).includes('PRIVATE-'), false);
    console.log(JSON.stringify({ runtime: 'backend/src/server.js', port: message.port, records, exit: 0 }));
  } finally {
    db?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited; output.close();
  }
});
