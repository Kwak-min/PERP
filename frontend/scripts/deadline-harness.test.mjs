import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const [scenarioName, taskId] of [['baseline', 1], ['recruitment-nav', 3], ['sidebar', 5], ['knowledge-graphs', 26]])
for (const probe of ['error', 'cancel']) test(`${scenarioName}: real Chrome/API resources close on ${probe}; stale artifacts cannot pass`, { timeout: 90000 }, async () => {
  const evidence = path.join(root, `.omo/evidence/task-${taskId}-deadline-erp-redesign`, `probe-${probe}`);
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify({ runId: 'stale', status: 'passed' }));
  await writeFile(path.join(evidence, 'screen.png'), 'stale');
  const child = spawn(process.execPath, [path.join(root, 'scripts/run_deadline_isolated.mjs'), 'node', 'frontend/scripts/deadline-qa.e2e.mjs', '--scenario', scenarioName, '--probe', probe], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let stdout = '', stderr = '', ready;
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  child.on('message', message => {
    if (message.type !== 'deadline:ready') return;
    ready = message;
    if (probe === 'cancel') child.send({ type: 'deadline:cancel' });
  });
  const timeout = setTimeout(() => child.send({ type: 'deadline:cancel' }), 60000);
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
      // 해제 사실은 connect/polling 대신 해당 owned port를 한 번 다시 bind해서 확인한다.
      if (resource.port) {
        const server = net.createServer();
        const listening = once(server, 'listening', { signal: AbortSignal.timeout(3000) });
        server.listen(resource.port, '127.0.0.1'); await listening;
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
    const runnerReceipt = JSON.parse(await readFile(stderr.match(/DEADLINE_RUN_RESULT (.+)/)[1].trim(), 'utf8'));
    assert.equal(runnerReceipt.forced, false); assert.equal(runnerReceipt.temporaryRemoved, true);
    assert.match(stdout, /deadline:complete/);
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); }
});
