import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const probe of ['error', 'cancel']) test(`nav-pref ${probe} closes owned resources and invalidates stale evidence`, { timeout: 90000 }, async () => {
  const evidence = path.join(root, '.omo/evidence/task-4-deadline-erp-redesign', `probe-${probe}`);
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify({ runId: 'stale', status: 'passed' }));
  await writeFile(path.join(evidence, 'screen.png'), 'stale');
  const child = spawn(process.execPath, [path.join(root, 'scripts/run_deadline_isolated.mjs'), 'node', 'frontend/scripts/deadline-qa.e2e.mjs', '--scenario', 'nav-pref', '--probe', probe], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let stdout = '', stderr = '', ready;
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
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
    assert.notEqual(scenario.runId, 'stale'); assert.equal(scenario.runId, ready.runId); assert.equal(cleanup.runId, ready.runId);
    assert.equal(scenario.status, probe === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(existsSync(path.join(evidence, 'screen.png')), false);
    assert.equal(cleanup.status, 'complete'); assert.equal(cleanup.browserExited, true); assert.deepEqual(cleanup.errors, []);
    assert.ok(cleanup.resources.every(resource => resource.closed));
    for (const resource of cleanup.resources) {
      if (resource.temporary) assert.equal(existsSync(resource.temporary), false);
      if (resource.profile) assert.equal(existsSync(resource.profile), false);
      if (resource.port) {
        const server = net.createServer();
        const listening = once(server, 'listening', { signal: AbortSignal.timeout(3000) });
        server.listen(resource.port, '127.0.0.1');
        try { await listening; }
        finally { if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      }
    }
    const receipt = JSON.parse(await readFile(stderr.match(/DEADLINE_RUN_RESULT (.+)/)[1].trim(), 'utf8'));
    assert.equal(receipt.forced, false); assert.equal(receipt.temporaryRemoved, true);
    assert.match(stdout, /deadline:complete/);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.connected) { child.send({ type: 'deadline:cancel' }); await closed; }
  }
});
