import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const probe of ['error', 'cancel']) test(`assets-footer ${probe} closes owned resources and invalidates stale evidence`, { timeout: 90000 }, async () => {
  // Given: misleading previous success artifacts and a real isolated Chrome/API run.
  const evidence = path.join(root, '.omo/evidence/task-7-deadline-erp-redesign', `probe-${probe}`);
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify({ runId: 'stale', status: 'passed' }));
  await writeFile(path.join(evidence, 'screen.png'), 'stale');
  const child = spawn(process.execPath, ['scripts/run_deadline_isolated.mjs', 'node', 'frontend/scripts/deadline-qa.e2e.mjs', '--scenario', 'assets-footer', '--probe', probe], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '', ready;
  child.stdout.resume(); child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  // When: cancel only after the exact all-resources-ready event, or inject an error there.
  child.on('message', message => {
    if (message.type !== 'deadline:ready') return;
    ready = message;
    if (probe === 'cancel') child.send({ type: 'deadline:cancel' });
  });
  const deadline = setTimeout(() => { if (child.connected) child.send({ type: 'deadline:cancel' }); }, 60000);
  try {
    assert.equal(await closed, probe === 'cancel' ? 130 : 1, stderr);
    assert.ok(ready, stderr);
    const scenario = JSON.parse(await readFile(path.join(evidence, 'scenario.json'), 'utf8'));
    const cleanup = JSON.parse(await readFile(path.join(evidence, 'cleanup.json'), 'utf8'));
    // Then: neither stale success nor leaked ports/profiles/temp databases can pass.
    assert.notEqual(scenario.runId, 'stale'); assert.equal(scenario.runId, ready.runId); assert.equal(cleanup.runId, ready.runId);
    assert.equal(scenario.status, probe === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(existsSync(path.join(evidence, 'screen.png')), false);
    assert.equal(cleanup.status, 'complete'); assert.equal(cleanup.browserExited, true); assert.deepEqual(cleanup.errors, []);
    assert.ok(cleanup.resources.every(resource => resource.closed));
    for (const resource of cleanup.resources) {
      if (resource.temporary) assert.equal(existsSync(resource.temporary), false);
      if (resource.port) {
        const server = net.createServer();
        const listening = once(server, 'listening', { signal: AbortSignal.timeout(3000) });
        server.listen(resource.port, '127.0.0.1'); await listening;
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
    const receipt = JSON.parse(await readFile(stderr.match(/DEADLINE_RUN_RESULT (.+)/)[1].trim(), 'utf8'));
    assert.equal(receipt.forced, false); assert.equal(receipt.temporaryRemoved, true);
  } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill(); }
});

test('legacy all-record asset query returns 101 exact scoped IDs without changing the default limit', { timeout: 60000 }, async () => {
  const { startDeadlineServer, createDeadlineFixture } = await import('../../backend/tests/deadline-fixture.js');
  const server = await startDeadlineServer();
  try {
    // Given: two API-created companies; the second has more than the default page size.
    const fixture = await createDeadlineFixture(server);
    const actor = fixture.B.actor, created = [];
    for (let index = 1; index <= 101; index++) created.push(await server.request(actor, '/assets', 'POST', { asset_no: `ALL-${index}`, name: `All-record asset ${index}` }, 201));
    // When: request the existing SQLite unbounded LIMIT contract explicitly.
    const full = await server.request(actor, '/assets?limit=-1');
    const limited = await server.request(actor, '/assets');
    // Then: completeness does not change the default, identity, tenant/company, or action gates.
    assert.deepEqual(new Set(full.items.map(row => row.id)), new Set(created.map(row => row.id)));
    assert.equal(full.items.length, 101); assert.equal(limited.items.length, 100);
    const other = await server.request(fixture.actorAdmin, '/assets?limit=-1');
    assert.deepEqual(new Set(other.items.map(row => row.id)), new Set(fixture.assets.map(row => row.id)));
    await server.request(fixture.actorManager, '/assets?limit=-1', 'GET', undefined, 403);
    await server.request(fixture.actorAdmin, `/assets/${created[0].id}`, 'GET', undefined, 404);
    await server.request(actor, `/assets/${created[0].id}/actions`, 'POST', { action: 'dispose' });
    const filtered = await server.request(actor, '/assets?limit=-1&status=disposed');
    assert.deepEqual(filtered.items.map(row => row.id), [created[0].id]);
  } finally { await server.close(); }
  assert.equal(server.resource.closed, true); assert.equal(server.resource.temporaryRemoved, true);
});

test('assets-footer rejects malformed CLI options before allocating resources', async () => {
  const child = spawn(process.execPath, ['scripts/run_deadline_isolated.mjs', 'node', 'frontend/scripts/deadline-qa.e2e.mjs', '--scenario', 'assets-footer', '--probe', 'unknown'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  child.stdout.resume(); child.stderr.resume();
  let allocated = false;
  child.on('message', message => { if (message.type === 'deadline:ready') allocated = true; });
  const [code] = await once(child, 'close', { signal: AbortSignal.timeout(15000) });
  assert.equal(code, 2); assert.equal(allocated, false);
});
