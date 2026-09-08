import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const probe of ['error', 'cancel']) test(`members-pagination ${probe} closes owned Chrome/API resources and invalidates stale evidence`, { timeout: 90000 }, async () => {
  // Given: stale success artifacts cannot represent the current named scenario.
  const evidence = path.join(root, '.omo/evidence/task-6-deadline-erp-redesign', `probe-${probe}`);
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify({ runId: 'stale', status: 'passed' }));
  await writeFile(path.join(evidence, 'screen.png'), 'stale');
  const child = spawn(process.execPath, ['scripts/run_deadline_isolated.mjs', 'node', 'frontend/scripts/deadline-qa.e2e.mjs', '--scenario', 'members-pagination', '--probe', probe], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '', ready;
  child.stderr.on('data', data => { stderr += data; }); child.stdout.resume();
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  // When: inject failure or cancel only after the exact owned-resource ready event.
  child.on('message', message => {
    if (message.type !== 'deadline:ready') return;
    ready = message;
    if (probe === 'cancel') child.send({ type: 'deadline:cancel' });
  });
  const timeout = setTimeout(() => { if (child.connected) child.send({ type: 'deadline:cancel' }); }, 60000);
  try {
    assert.equal(await closed, probe === 'cancel' ? 130 : 1, stderr);
    assert.ok(ready, stderr);
    const scenario = JSON.parse(await readFile(path.join(evidence, 'scenario.json'), 'utf8'));
    const cleanup = JSON.parse(await readFile(path.join(evidence, 'cleanup.json'), 'utf8'));
    assert.equal(scenario.scenario, 'members-pagination');
    assert.notEqual(scenario.runId, 'stale'); assert.equal(scenario.runId, ready.runId); assert.equal(cleanup.runId, ready.runId);
    assert.equal(scenario.status, probe === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(existsSync(path.join(evidence, 'screen.png')), false);
    assert.equal(cleanup.status, 'complete'); assert.equal(cleanup.browserExited, true); assert.deepEqual(cleanup.errors, []);
    assert.ok(cleanup.resources.every(resource => resource.closed));
    for (const resource of cleanup.resources) {
      if (resource.temporary) assert.equal(existsSync(resource.temporary), false);
      if (resource.port) {
        const server = net.createServer();
        try {
          const listening = once(server, 'listening', { signal: AbortSignal.timeout(3000) });
          server.listen(resource.port, '127.0.0.1'); await listening;
        } finally { if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      }
    }
    const runner = JSON.parse(await readFile(stderr.match(/DEADLINE_RUN_RESULT (.+)/)[1].trim(), 'utf8'));
    assert.equal(runner.forced, false); assert.equal(runner.temporaryRemoved, true);
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); }
});
