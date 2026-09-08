const { fork } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { fixtureEnv, backend } = require('./postgres-fixture.cjs');

function startRuntime(databaseUrl, overrides = {}) {
  const env = { ...fixtureEnv(databaseUrl), PORT: '0', ERP_API_URL: 'http://127.0.0.1:1', ...overrides };
  if (!Object.hasOwn(overrides, 'HOST')) delete env.HOST;
  const built = process.env.RESERVATION_TEST_ENTRY === 'dist';
  const child = fork(path.join(backend, built ? 'dist/server.js' : 'src/server.ts'), {
    cwd: backend, env, silent: true,
    execArgv: [...(built ? [] : ['-r', require.resolve('ts-node/register')]), '-r', path.join(__dirname, 'fixtures/listener-observer.cjs')],
  });
  let output = '';
  const messages = [];
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('message', message => messages.push(message));
  // fork의 비동기 자식 이벤트보다 먼저 구독하며 출력 문구나 폴링에 의존하지 않는다.
  const closed = once(child, 'close');
  const ready = Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(15000) }).then(([message]) => message),
    closed.then(([code, signal]) => { throw new Error(`Runtime exited before listening (${code}, ${signal}): ${output}`); }),
  ]);
  return {
    child, ready, closed, messages, get output() { return output; },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.race([closed, new Promise((_, reject) => {
        const signal = AbortSignal.timeout(5000);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })]);
    },
  };
}
module.exports = { startRuntime };
