import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const moduleUrl = relative => new URL(relative, new URL('../', import.meta.url)).href;

test('parallel early-import fixtures own every opened database; restart children share only their parent fixture', { timeout: 60000 }, async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const temporary = await mkdtemp(path.join(process.env.DEADLINE_TEMP_ROOT, 'database-regression-'));
  const sockets = new Set();
  // All three real test processes must reach the barrier before any fixture migrates.
  const barrier = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', error => { throw error; });
    if (sockets.size === 3) for (const peer of sockets) peer.end('GO');
  });
  const listening = once(barrier, 'listening', { signal: AbortSignal.timeout(5000) });
  barrier.listen(0, '127.0.0.1'); await listening;
  const hook = path.join(temporary, 'trace.mjs');
  await writeFile(hook, `import {registerHooks} from 'node:module';
registerHooks({load(url, context, next) {
  const loaded = next(url, context);
  if (url.endsWith('/backend/src/config/db.js') && loaded.source) return {...loaded, source:String(loaded.source).replace('instance = new DatabaseSync(file);', 'instance = new DatabaseSync(file); console.error("DB_OPEN_TRACE", JSON.stringify({pid:process.pid, entry:process.argv[1] ?? "restart", requested:process.env.ORBITFLOW_DATABASE_FILE, actual:instance.prepare("PRAGMA database_list").get().file}));')};
  return loaded;
}});`);
  const entries = [];
  for (const seam of ['graph', 'security', 'jobs']) {
    const entry = path.join(temporary, `${seam}.test.mjs`); entries.push(entry);
    await writeFile(entry, `import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
// The exact early configuration captures implicated by graph/security and the Wiki seam test.
import {db} from ${JSON.stringify(moduleUrl('backend/src/config/db.js'))};
import ${JSON.stringify(moduleUrl('backend/src/services/knowledge-wiki-jobs.service.js'))};
import {${seam === 'jobs' ? 'startDeadlineServer' : 'startTestServer'} as start} from ${JSON.stringify(moduleUrl('backend/tests/' + (seam === 'jobs' ? 'deadline-fixture.js' : 'http.js')))};
import {startTestServer} from ${JSON.stringify(moduleUrl('backend/tests/http.js'))};
test(${JSON.stringify(seam)}, {timeout:45000}, async () => {
  const socket = new net.Socket();
  const released = once(socket, 'data', {signal:AbortSignal.timeout(10000)});
  socket.connect(${barrier.address().port}, '127.0.0.1'); await released;
  for (let lifetime=0; lifetime<2; lifetime++) {
    // startDeadlineServer owns the process-global PG pool and ends it on close.
    // A second SQLite lifetime uses the SQLite-only fixture, without re-ending PG.
    const fixture = await (lifetime === 0 ? start : startTestServer)();
    const requested = process.env.ORBITFLOW_DATABASE_FILE;
    try {
      const actual = db().prepare('PRAGMA database_list').get().file;
      assert.equal(path.resolve(actual), path.resolve(requested));
      db().exec('CREATE TABLE fixture_ownership (owner TEXT NOT NULL)');
      const owner = process.pid + ':' + lifetime;
      db().prepare('INSERT INTO fixture_ownership VALUES (?)').run(owner);
      const program = 'import {db,closeDb} from ' + ${JSON.stringify(JSON.stringify(moduleUrl('backend/src/config/db.js')))} + '; console.log(JSON.stringify({owner:db().prepare("SELECT owner FROM fixture_ownership").get().owner,actual:db().prepare("PRAGMA database_list").get().file})); closeDb();';
      const child = spawnSync(process.execPath, ['--import', ${JSON.stringify(pathToFileURL(hook).href)}, '--input-type=module', '-e', program], {env:{...process.env},encoding:'utf8',timeout:10000});
      process.stderr.write(child.stderr);
      assert.equal(child.status, 0, child.stderr);
      const receipt = JSON.parse(child.stdout.trim());
      assert.equal(receipt.owner, owner); assert.equal(path.resolve(receipt.actual), path.resolve(requested));
    } finally { await fixture.close(); }
    assert.equal(existsSync(requested), false, 'fixture must remove the database it actually opened');
  }
});`);
  }
  let child, stdout = '', stderr = '';
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // This is a new test runner, not its parent's test-file child.
    child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, '--test', ...entries], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const closed = once(child, 'close', { signal: AbortSignal.timeout(50000) });
    const [code] = await closed;
    const traces = [...(stdout + '\n' + stderr).matchAll(/DB_OPEN_TRACE (\{[^\r\n]+\})/g)].map(match => JSON.parse(match[1]));
    console.log(JSON.stringify({ traces, childExit: code }));
    const parents = traces.filter(trace => trace.entry !== 'restart');
    assert.equal(new Set(parents.map(trace => trace.pid)).size, 3, stdout + stderr);
    assert.ok(traces.every(trace => path.basename(trace.actual) !== 'isolated.db'), 'no operation may open the runner shared isolated.db: ' + JSON.stringify(traces));
    assert.equal(new Set(parents.map(trace => path.resolve(trace.actual))).size, 6, 'each of three processes must own two separate fixture lifetimes');
    assert.ok(traces.every(trace => path.resolve(trace.actual) === path.resolve(trace.requested)));
    assert.equal(traces.filter(trace => trace.entry === 'restart').length, 6);
    assert.equal(code, 0, stdout + stderr);
    assert.equal(existsSync(path.join(process.env.DEADLINE_TEMP_ROOT, 'isolated.db')), false);
  } finally {
    if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => barrier.close(error => error ? reject(error) : resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
