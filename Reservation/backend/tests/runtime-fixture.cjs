const { fork } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { fixtureEnv, backend } = require('./postgres-fixture.cjs');

function startRuntime(databaseUrl, overrides = {}) {
  const env = { ...fixtureEnv(databaseUrl), PORT: '0', ERP_API_URL: 'http://127.0.0.1:1', ...overrides };
  if (!Object.hasOwn(overrides, 'HOST')) delete env.HOST;
  const built = process.env.RESERVATION_TEST_ENTRY === 'dist';
  // --import guard를 유지하면서 ts-node의 CommonJS hook으로 실제 엔트리를 실행한다.
  const child = fork(path.join(__dirname, 'fixtures/listener-observer.cjs'), [path.join(backend, built ? 'dist/server.js' : 'src/server.ts')], {
    cwd: backend, env, silent: true,
    execArgv: built ? [] : ['-r', require.resolve('ts-node/register')],
  });
  let output = '';
  const messages = [];
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('message', message => messages.push(message));
  // fork의 비동기 자식 이벤트보다 먼저 구독하며 출력 문구나 폴링에 의존하지 않는다.
  const closed = once(child, 'close');
  let revokeEndpoint, closing = false;
  child.once('exit', () => revokeEndpoint?.());
  const ready = Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(15000) }).then(async ([message]) => {
      if (message.kind !== 'listening' || message.address.address !== (env.HOST || '127.0.0.1')) throw new Error('Unexpected runtime listener');
      if (process.env.DEADLINE_ISOLATED === '1' && message.address.address !== '127.0.0.1') {
        const { registerFixtureEndpoint } = await import(pathToFileURL(path.join(backend, '../../scripts/deadline-isolation-guard.mjs')).href);
        if (closing || child.exitCode !== null || child.signalCode !== null) throw new Error('Runtime closed before endpoint registration');
        revokeEndpoint = registerFixtureEndpoint(message.address);
      }
      return message;
    }),
    closed.then(([code, signal]) => { throw new Error(`Runtime exited before listening (${code}, ${signal}): ${output}`); }),
  ]);
  return {
    child, ready, closed, messages, get output() { return output; },
    async close() {
      closing = true;
      revokeEndpoint?.();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.race([closed, new Promise((_, reject) => {
        const signal = AbortSignal.timeout(5000);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })]);
    },
  };
}
module.exports = { startRuntime };
