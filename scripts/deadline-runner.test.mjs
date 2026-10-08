import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('./run_deadline_isolated.mjs', import.meta.url));
const invoke = args => spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', timeout: 30000 });
const receipt = result => JSON.parse(readFileSync(result.stderr.match(/DEADLINE_RUN_RESULT (.+)/)[1].trim(), 'utf8'));

test('isolated child cannot inherit database, provider, dotenv or Node injection settings', () => {
  // 부트스트랩 이후 오염: NODE_OPTIONS가 launcher 자체를 실행하기 전에 해석되는 것을 구분한다.
  const poison = {
    DATABASE_URL: 'postgres://poison.invalid/live', PGHOST: 'poison.invalid', PG_PORT: '55432',
    PGUSER: 'synthetic-poison', PGPASSWORD: 'synthetic-poison', PGSSLKEY: 'synthetic-poison',
    OPENROUTER_API_KEY: 'synthetic-poison', OPENAI_API_KEY: 'synthetic-poison', ANTHROPIC_API_KEY: 'synthetic-poison',
    OLLAMA_BASE_URL: 'https://poison.invalid', NODE_OPTIONS: '--require=missing-poison-module',
    DOTENV_CONFIG_PATH: 'backend/.env', UNRELATED_SECRET: 'synthetic-poison',
    ORG_TEST_PG_BIN: 'inherited-poison', DAILY_TEST_PG_BIN: 'inherited-poison', FINANCE_TEST_PG_BIN: 'inherited-poison',
  };
  const driver = `Object.assign(process.env, ${JSON.stringify(poison)}); process.argv = [process.execPath, ${JSON.stringify(runner)}, 'node', '-e', 'console.log(JSON.stringify(process.env))']; await import(${JSON.stringify(new URL('./run_deadline_isolated.mjs', import.meta.url).href)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const child = JSON.parse(result.stdout.trim().split('\n').find(line => line.startsWith('{')));
  for (const [key, value] of Object.entries(poison)) assert.notEqual(child[key], value, key);
  assert.equal(child.PG_HOST, '127.0.0.1'); assert.equal(child.PG_PORT, '1'); assert.equal(child.DATABASE_URL, '');
  assert.equal(child.PG_CONNECTION_TIMEOUT_MS, '100', 'Unavailable dependencies retain the fail-fast deadline');
  assert.ok(child.DOTENV_CONFIG_PATH.endsWith('empty.env')); assert.equal(child.DEADLINE_ISOLATED, '1');
  assert.equal(existsSync(child.DEADLINE_TEMP_ROOT), false);
  assert.equal(receipt(result).temporaryRemoved, true);
});

test('malformed commands are rejected without shell interpretation', () => {
  for (const args of [[], ['node'], ['sh', '-c', 'exit 0'], ['npm', 'exec', 'anything'], ['--pg-bin', 'missing', 'node', '-e', '0']]) {
    const result = invoke(args); assert.equal(result.status, 2, JSON.stringify({ args, stderr: result.stderr }));
  }
});

test('nonzero child status and both output streams are retained in unique artifacts', () => {
  const args = ['node', '-e', 'console.log("child-out");console.error("child-err");process.exitCode=7'];
  const first = invoke(args), second = invoke(args);
  for (const result of [first, second]) {
    assert.equal(result.status, 7); assert.match(result.stdout, /child-out/); assert.match(result.stderr, /child-err/);
    const saved = receipt(result); assert.equal(saved.code, 7); assert.equal(saved.temporaryRemoved, true);
  }
  assert.notEqual(receipt(first).runId, receipt(second).runId);
});

test('network guard rejects protected loopback ports and external hosts before connecting', () => {
  const result = invoke(['node', '--input-type=module', '-e', `import net from 'node:net'; import assert from 'node:assert/strict'; for(const port of [8000,5174,8080,55432,1]) assert.throws(()=>net.connect({host:'127.0.0.1',port}),{code:'DEADLINE_NETWORK_DENIED'}); assert.throws(()=>net.connect({host:'example.invalid',port:443}),{code:'DEADLINE_NETWORK_DENIED'}); console.log('GUARD_PASS');`]);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /GUARD_PASS/);
});

test('fixture registration permits only its listener endpoint until revoked', () => {
  const result = invoke(['node', '--input-type=module', '-e', `
    import net from 'node:net';
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    import { spawnSync } from 'node:child_process';
    import { registerFixtureEndpoint, protectedPorts } from './scripts/deadline-isolation-guard.mjs';
    const denied = (host, port) => assert.throws(() => net.connect({host, port}), {code:'DEADLINE_NETWORK_DENIED'});
    const server = net.createServer(socket => socket.end());
    let revoke;
    try {
      const listening = once(server, 'listening', {signal:AbortSignal.timeout(5000)});
      server.listen(0, '127.0.0.2'); await listening;
      const address = server.address();
      denied(address.address, address.port);
      for (const port of [...protectedPorts, 0, 1, 80, 65536, 1.5]) {
        assert.throws(() => registerFixtureEndpoint({...address, port}), {code:'DEADLINE_FIXTURE_ENDPOINT_DENIED'});
      }
      for (const host of ['127.0.0.3', '127.1.2.3', '0.0.0.0', 'example.invalid', '192.0.2.1']) {
        assert.throws(() => registerFixtureEndpoint({...address, address:host}), {code:'DEADLINE_FIXTURE_ENDPOINT_DENIED'});
        denied(host, address.port);
      }
      revoke = registerFixtureEndpoint(address);
      // 다른 소유자가 등록 수명을 바꾸거나 자식 프로세스가 등록을 상속하지 않는다.
      assert.throws(() => registerFixtureEndpoint(address), {code:'DEADLINE_FIXTURE_ENDPOINT_DENIED'});
      const foreignChild = spawnSync(process.execPath, ['-e',
        'const assert=require("node:assert/strict");const net=require("node:net");assert.throws(()=>net.connect('+JSON.stringify({host:address.address, port:address.port})+'),{code:"DEADLINE_NETWORK_DENIED"});'
      ], {encoding:'utf8', timeout:5000, env:process.env});
      assert.equal(foreignChild.status, 0, foreignChild.stderr);
      denied('127.0.0.2', address.port === 65535 ? 65534 : address.port + 1);
      for (const port of [...protectedPorts, 1]) denied('127.0.0.2', port);
      const socket = new net.Socket();
      const connected = once(socket, 'connect', {signal:AbortSignal.timeout(5000)});
      const closed = once(socket, 'close', {signal:AbortSignal.timeout(5000)});
      socket.connect({host:address.address, port:address.port}); await connected;
      socket.destroy(); await closed;
      revoke(); revoke();
      denied(address.address, address.port);
      console.log(JSON.stringify({address, preDenied:true, connected:true, postRevokeDenied:true}));
    } finally {
      revoke?.();
      if (server.listening) {
        const closed = once(server, 'close', {signal:AbortSignal.timeout(5000)});
        server.close(); await closed;
      }
    }
  `]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).postRevokeDenied, true);
});

test('legacy fixture children inherit the active runner guard, not just an environment marker', () => {
  const result = invoke(['node', '-e', `
    const assert = require('node:assert/strict');
    const {spawnSync} = require('node:child_process');
    const {fixtureEnv} = require('./Reservation/backend/tests/postgres-fixture.cjs');
    const env = fixtureEnv('postgresql://fixture:fixture@127.0.0.1:1/offline');
    assert.equal(env.NODE_OPTIONS, process.env.NODE_OPTIONS);
    const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(`
      const assert = require('node:assert/strict');
      const net = require('node:net');
      assert.equal(process.env.DEADLINE_ISOLATED, '1');
      for (const [host, port] of [['127.0.0.2', 60000], ['example.invalid', 443], ...[8000,5174,8080,55432,1].map(port => ['127.0.0.1', port])]) {
        assert.throws(() => net.connect({host, port}), {code:'DEADLINE_NETWORK_DENIED'});
      }
      console.log('CHILD_GUARD_ACTIVE');
    `)}], {env, encoding:'utf8', timeout:5000});
    assert.equal(child.status, 0, child.stderr);
    process.stdout.write(child.stdout);
  `]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CHILD_GUARD_ACTIVE/);
});

test('native binary paths require explicit CLI configuration, never ambient propagation', () => {
  const bin = mkdtempSync(path.join(tmpdir(), 'deadline-bin-config-'));
  try {
    for (const name of ['postgres', 'initdb', 'pg_ctl']) writeFileSync(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), '');
    const result = invoke(['--pg-bin', bin, 'node', '-e', 'console.log(JSON.stringify(process.env))']);
    assert.equal(result.status, 0, result.stderr);
    const env = JSON.parse(result.stdout.trim());
    for (const key of ['ORG_TEST_PG_BIN', 'DAILY_TEST_PG_BIN', 'FINANCE_TEST_PG_BIN']) assert.equal(env[key], bin);
    assert.equal(env.PG_PORT, '1'); assert.equal(env.DATABASE_URL, '');
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test('cancellation is delivered to the owned child, acknowledged, and cleaned without force', { timeout: 30000 }, async () => {
  const program = `process.on('message',m=>{if(m.type==='deadline:cancel'){console.log('CHILD_CLEANED');process.disconnect();}});process.send({type:'deadline:ready'});`;
  const child = spawn(process.execPath, [runner, 'node', '-e', program], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  const timer = setTimeout(() => child.kill(), 25000);
  child.on('message', message => { if (message.type === 'deadline:ready') child.send({ type: 'deadline:cancel' }); });
  try {
    assert.equal(await closed, 130, stderr); assert.match(stdout, /CHILD_CLEANED/);
    const saved = receipt({ stderr }); assert.equal(saved.forced, false); assert.equal(saved.temporaryRemoved, true); assert.equal(saved.cancelReason, 'ipc');
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
});
