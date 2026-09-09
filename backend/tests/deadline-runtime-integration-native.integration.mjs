import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { request } from 'node:http';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { localProviderFixture } from './deadline-wiki-jobs-fixture.js';

const fixture = fileURLToPath(new URL('./fixtures/runtime-integration-server.mjs', import.meta.url));
const observer = fileURLToPath(new URL('./fixtures/runtime-maintenance-observer.cjs', import.meta.url)).replaceAll('\\', '/');
function launch(env) {
  const child = spawn(process.execPath, ['--experimental-test-module-mocks', fixture], {
    env: { ...process.env, ...env, NODE_OPTIONS: `${process.env.NODE_OPTIONS} --require="${observer}"` },
    cwd: process.env.DEADLINE_TEMP_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const events = new EventEmitter(), messages = [], logs = [], observations = [], gone = new AbortController();
  // Observe RED-path rejections immediately; normal assertions still await original promises.
  const observe = promise => { observations.push(Promise.allSettled([promise])); return promise; };
  child.once('exit', () => gone.abort());
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(25000) });
  const output = createInterface({ input: child.stdout });
  output.on('line', line => {
    logs.push(line);
    if (line.startsWith('{')) {
      const row = JSON.parse(line);
      if (row.event === 'expense_import_cleanup') events.emit(`cleanup:${row.status}`, row);
    }
  });
  child.stderr.on('data', bytes => logs.push(String(bytes)));
  child.on('message', message => { messages.push(message); events.emit(message.type, message); });
  // Ready/initial-drain are startup facts; subsequent actions always subscribe first.
  const wait = type => {
    const prior = messages.find(m => m.type === type);
    return prior ? Promise.resolve([prior]) : observe(once(events, type, { signal: AbortSignal.any([gone.signal, AbortSignal.timeout(15000)]) })
      .catch(error => { throw new Error(`Missing runtime event ${type}: ${logs.join('\n')}`, { cause: error }); }));
  };
  return { child, events, messages, logs, exited, wait, observe, async dispose() {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited; await Promise.all(observations); output.close();
  } };
}
async function api(base, actor, route, method = 'GET', body, status = 200) {
  const response = await fetch(base + (route === '/health' ? '' : '/api/v1') + route, { method, headers: {
    'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
    ...(actor?.orgId ? { 'X-Org-Id': actor.orgId } : {}),
    ...(route.endsWith('/jobs') ? { 'Idempotency-Key': randomUUID() } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
}
async function actorAndSource(base, store) {
  const prefix = store === 'pg' ? '/pg' : '';
  const signup = await api(base, null, prefix + '/auth/signup', 'POST', {
    name: 'Runtime fixture', email: `${randomUUID()}@example.invalid`, password: 'password-1234',
  }, 201);
  const actor = { token: signup.token ?? signup.access_token };
  const company = await api(base, actor, prefix ? '/pg/companies' : '/tenants', 'POST', {
    name: 'Runtime fixture', ...(prefix ? {} : { type: 'custom' }), modules: ['documents', 'agent', 'projects'], features: [], departments: [],
  }, 201);
  actor.orgId = company.org_id;
  const root = prefix + '/documents/wiki';
  const source = await api(base, actor, root + '/sources', 'POST', {
    kind: 'upload', filename: 'runtime.md', mime: 'text/markdown', content_base64: Buffer.from('Runtime evidence fixture').toString('base64'),
  }, 201);
  return { actor, root, source, userId: signup.user.id };
}

for (const scenario of [
  { name: 'legacy-both-blocked', store: 'legacy', imports: 'legacy', receipts: 'legacy', blocked: true },
  { name: 'pg-both-blocked', store: 'pg', imports: 'perp_db', receipts: 'perp_db', blocked: true },
  { name: 'imports-only', store: 'legacy', imports: 'legacy', receipts: '' },
  { name: 'receipts-only', store: 'pg', imports: '', receipts: 'perp_db' },
  { name: 'cleanup-disabled', store: 'legacy', imports: '', receipts: '' },
  { name: 'wiki-stop-error', store: 'legacy', imports: 'legacy', receipts: 'legacy', error: 'wiki' },
  { name: 'cleanup-stop-error', store: 'pg', imports: 'perp_db', receipts: '', error: 'cleanup' },
  { name: 'http-close-error', store: 'legacy', imports: '', receipts: 'legacy', error: 'http' },
  { name: 'http-closed-await-wiki', store: 'legacy', imports: 'legacy', receipts: '', gate: 'wiki', error: 'http' },
  { name: 'http-closed-await-cleanup', store: 'pg', imports: 'perp_db', receipts: '', gate: 'cleanup', error: 'wiki' },
]) test(`shipped server lifecycle: ${scenario.name}`, { timeout: 60000 }, async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const native = await startDailyNativePostgres(), provider = await localProviderFixture();
  const nativeData = (await native.pool.query('SHOW data_directory')).rows[0].data_directory;
  let runtime, db, claimant, heldRequest;
  try {
    for (const file of ['perp_additions_v15_knowledge_wiki.sql', 'perp_additions_v16_deadline_expense_imports.sql', 'perp_additions_v18_knowledge_invalidation.sql']) {
      await native.pool.query(await readFile(new URL(`../../db/${file}`, import.meta.url), 'utf8'));
    }
    const databaseFile = path.join(process.env.DEADLINE_TEMP_ROOT, `${scenario.name}.db`);
    const uploadRoot = path.join(process.env.DEADLINE_TEMP_ROOT, `${scenario.name}-uploads`);
    await mkdir(uploadRoot);
    runtime = launch({ PORT: '0', ORBITFLOW_DATABASE_FILE: databaseFile, ORBITFLOW_UPLOAD_DIR: uploadRoot,
      WIKI_LOCAL_MODEL_CONFIG: JSON.stringify(provider.config), ORBITFLOW_IMPORT_CLEANUP_STORES: scenario.imports,
      ORBITFLOW_RECEIPT_CLEANUP_STORES: scenario.receipts, RUNTIME_OBSERVER_CHANNEL: randomUUID(),
      RUNTIME_SQLITE_LOCK: scenario.blocked && scenario.store === 'legacy' ? '1' : '',
      RUNTIME_STOP_ERROR: scenario.error ?? '', RUNTIME_STOP_GATE: scenario.gate ?? '' });
    const [ready] = await runtime.wait('ready'); await runtime.wait('wiki-idle');
    assert.deepEqual(ready.starts, [{ kind: 'wiki', httpListening: true }, { kind: 'cleanup', httpListening: true }]);
    const base = `http://127.0.0.1:${ready.port}`;
    db = new DatabaseSync(databaseFile);
    assert.deepEqual(db.prepare('SELECT version FROM schema_migration ORDER BY version').all().map(r => r.version), Array.from({ length: 14 }, (_, i) => i + 1));
    const { actor, root, source, userId } = await actorAndSource(base, scenario.store);
    provider.gate.hold = Promise.withResolvers();
    const dispatched = provider.dispatched();
    const job = await api(base, actor, root + '/jobs', 'POST', { operation: 'query', question: 'Runtime',
      retrieval: { raw: true, published_wiki: false, source_revision_ids: [source.current_revision_id] } }, 202);
    await dispatched;
    assert.equal((await api(base, actor, root + '/jobs/' + job.id)).state, 'running');

    if (scenario.blocked) {
      if (scenario.store === 'legacy') db.exec('BEGIN IMMEDIATE');
      else {
        await native.pool.query('INSERT INTO accounting.expense_import_uploads(id,company_id,actor_id,raw,raw_sha256,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
          [randomUUID(), actor.orgId.slice(3), userId, Buffer.from('fixture'), 'a'.repeat(64), new Date('2000-01-01')]);
        claimant = await native.pool.connect(); await claimant.query('BEGIN');
        await claimant.query('SELECT id FROM org.companies WHERE id=$1 FOR UPDATE', [actor.orgId.slice(3)]);
      }
      const submitted = runtime.wait('maintenance-lock-submitted'); runtime.child.send('tick'); await submitted;
      const overlapping = once(runtime.events, 'cleanup:skipped', { signal: AbortSignal.timeout(10000) });
      runtime.child.send('tick'); assert.equal((await overlapping)[0].reason, 'overlap');
    } else if (scenario.imports || scenario.receipts) {
      const succeeded = once(runtime.events, 'cleanup:succeeded', { signal: AbortSignal.timeout(10000) });
      runtime.child.send('tick'); await succeeded;
    }
    assert.equal((await api(base, null, '/health')).status, 'ok');
    const active = runtime.wait('request-active');
    heldRequest = request(base + '/api/v1/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '2', 'X-Runtime-Held': '1' } });
    const response = runtime.observe(once(heldRequest, 'response', { signal: AbortSignal.timeout(15000) }));
    heldRequest.flushHeaders(); await active;
    const requested = runtime.wait('shutdown-requested'), wikiStopped = runtime.wait('wiki-stopped'), cleanupStopped = runtime.wait('cleanup-stopped');
    runtime.child.send('shutdown');
    const [snapshot] = await requested;
    // No polling: this IPC snapshot is taken synchronously after all repeated signals.
    assert.deepEqual(snapshot.stops, { wiki: 1, cleanup: 1 });
    assert.equal(snapshot.wikiListeners, 0); assert.equal(snapshot.listening, false);
    assert.equal(runtime.child.exitCode, null, 'open HTTP body must keep shutdown pending');
    if (scenario.blocked && scenario.store === 'legacy') db.exec('ROLLBACK');
    if (claimant) { await claimant.query('ROLLBACK'); claimant.release(); claimant = null; }
    await Promise.all([wikiStopped, cleanupStopped]);
    assert.equal(runtime.child.exitCode, null, 'both workers settled but HTTP still belongs to shutdown');
    const terminal = scenario.store === 'legacy' ? db.prepare('SELECT state, result_json, failure_code FROM knowledge_job WHERE id=?').get(job.id)
      : (await native.pool.query('SELECT state, result_json, failure_code FROM knowledge.job WHERE id=$1', [job.id])).rows[0];
    assert.equal(terminal.state, 'unavailable'); assert.equal(terminal.failure_code, 'MODEL_ABORTED'); assert.equal(terminal.result_json, null);
    assert.equal(provider.calls.length, 1, 'shutdown wake does not dispatch another job');
    heldRequest.end('{}'); const [res] = await response;
    const ended = once(res, 'end', { signal: AbortSignal.timeout(10000) }); res.resume(); await ended;
    assert.equal(res.statusCode, 400);
    if (scenario.gate) {
      await runtime.wait('http-closed');
      const inspected = runtime.wait('inspected'); runtime.child.send('inspect');
      const [pending] = await inspected;
      assert.equal(pending.listening, false); assert.equal(pending.pgEnded, false); assert.equal(pending.sqliteCloses, 0);
      runtime.child.send('release-stop');
    }
    const [resources] = await runtime.wait('resources-closed');
    assert.deepEqual(resources.stops, { wiki: 1, cleanup: 1 }); assert.equal(resources.activeWorkers, 0);
    assert.equal(resources.intervalCount, 0); assert.equal(resources.wikiListeners, 0);
    assert.equal(resources.pgEnded, true); assert.equal(resources.sqliteCloses, 1); assert.equal(resources.listening, false);
    assert.deepEqual(await runtime.exited, [scenario.error ? 1 : 0, null], runtime.logs.join('\n'));
    assert.equal(runtime.logs.some(line => line.includes('unhandledRejection')), false);
    console.log(JSON.stringify({ scenario: scenario.name, runtime: 'backend/src/server.js', starts: ready.starts,
      shutdown: snapshot, resources, actualModelDispatches: provider.calls.length, nativeData, exit: scenario.error ? 1 : 0 }));
  } finally {
    heldRequest?.destroy();
    if (db?.isTransaction) db.exec('ROLLBACK');
    if (claimant) { await claimant.query('ROLLBACK'); claimant.release(); }
    await runtime?.dispose(); db?.close(); await provider.close(); await native.close();
    assert.equal(existsSync(nativeData), false);
    console.log(JSON.stringify({ scenario: scenario.name, nativeRemoved: true }));
  }
});

for (const patch of [
  { ORBITFLOW_IMPORT_CLEANUP_STORES: 'pg' },
  { ORBITFLOW_RECEIPT_CLEANUP_STORES: 'pg' },
  { ORBITFLOW_IMPORT_CLEANUP_STORES: 'legacy,legacy' },
  { ORBITFLOW_IMPORT_CLEANUP_STORES: 'perp_db', PG_HOST: '', PG_PORT: '', PG_DATABASE: '', PG_USER: '' },
  { ORBITFLOW_RECEIPT_CLEANUP_STORES: 'legacy', ORBITFLOW_UPLOAD_DIR: './relative' },
  { ORBITFLOW_IMPORT_CLEANUP_TIMEOUT_MS: '0' },
  { ORBITFLOW_IMPORT_CLEANUP_STORES: 'legacy', ORBITFLOW_DATABASE_FILE: ':memory:' },
  { WIKI_LOCAL_MODEL_CONFIG: '{' },
  { WIKI_LOCAL_MODEL_CONFIG: '{"base_url":"https://example.invalid"}' },
]) test(`misconfiguration rejects before databases open: ${JSON.stringify(patch)}`, { timeout: 30000 }, async () => {
  const databaseFile = path.join(process.env.DEADLINE_TEMP_ROOT, `${randomUUID()}.db`);
  const runtime = launch({ ORBITFLOW_DATABASE_FILE: databaseFile, RUNTIME_OBSERVER_CHANNEL: randomUUID(), ...patch });
  try {
    assert.deepEqual(await runtime.exited, [1, null]);
    assert.equal(existsSync(databaseFile), false);
    assert.equal(runtime.messages.some(m => m.type === 'ready'), false);
    assert.ok(runtime.logs.join('\n').includes(patch.WIKI_LOCAL_MODEL_CONFIG ? 'LOCAL_MODEL_CONFIG' : 'IMPORT_CLEANUP_CONFIG'), runtime.logs.join('\n'));
    assert.equal(runtime.messages.some(m => ['pg-connect', 'sqlite-exec'].includes(m.type)), false);
    assert.equal(runtime.logs.join('\n').includes('DEADLINE_NETWORK_DENIED'), false, 'must not attempt even the isolated PG endpoint');
  } finally { await runtime.dispose(); }
});
