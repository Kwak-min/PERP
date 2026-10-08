import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const guard = new URL('./deadline-isolation-guard.mjs', import.meta.url).href;

export async function runIsolated(argv) {
  let pgBin;
  if (argv[0] === '--pg-bin') {
    pgBin = path.resolve(argv[1] ?? '');
    if (!['postgres', 'initdb', 'pg_ctl'].every(name => existsSync(path.join(pgBin, name + (process.platform === 'win32' ? '.exe' : ''))))) throw new Error('Explicit --pg-bin must contain postgres, initdb and pg_ctl');
    argv = argv.slice(2);
  }
  const [command, ...args] = argv;
  if (!['node', 'npm', 'python'].includes(command) || !args.length || args.some(arg => arg.includes('\0'))) {
    throw new Error('Usage: node scripts/run_deadline_isolated.mjs <node|npm|python> <arguments...>');
  }
  // 셸 문자열/사용자 npmrc/임의 실행 경로를 해석하지 않는다.
  if (command === 'npm' && !['ci', 'run', 'test', 'audit'].includes(args[0])) throw new Error('Unsupported npm operation');
  const runId = randomUUID();
  const artifact = path.join(root, '.omo/evidence/deadline-runs', runId);
  await mkdir(artifact, { recursive: true });
  const temporary = await mkdtemp(path.join(tmpdir(), 'deadline-run-'));
  const emptyEnv = path.join(temporary, 'empty.env');
  await writeFile(emptyEnv, '');
  const env = {};
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'systemdrive', 'programfiles', 'programfiles(x86)', 'programw6432', 'number_of_processors', 'processor_architecture', 'userprofile', 'appdata', 'localappdata', 'homedrive', 'homepath']);
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase())) env[key] = value;
  Object.assign(env, {
    // Chrome의 Windows known-folder 판정에는 원래 OS 경로가 필요하다. 브라우저 profile은 Playwright의 새 임시 경로다.
    HOME: temporary,
    TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    DOTENV_CONFIG_PATH: emptyEnv, DOTENV_CONFIG_QUIET: 'true',
    DATABASE_URL: '', PG_HOST: '127.0.0.1', PG_PORT: '1', PG_DATABASE: 'deadline_unused',
    PG_USER: 'deadline_unused', PG_PASSWORD: '', PG_CONNECTION_TIMEOUT_MS: '100',
    ORBITFLOW_DATABASE_FILE: path.join(temporary, 'isolated.db'), ORBITFLOW_AI_PROVIDER: 'echo',
    ORBITFLOW_CORS_ORIGINS: 'http://127.0.0.1', PORT: '0',
    DEADLINE_ISOLATED: '1', DEADLINE_RUN_ID: runId, DEADLINE_TEMP_ROOT: temporary,
    DEADLINE_NETWORK: command === 'npm' && ['ci', 'audit'].includes(args[0]) ? 'dependencies' : 'loopback',
    NODE_OPTIONS: `--import="${guard}"`,
    npm_config_userconfig: emptyEnv, npm_config_globalconfig: path.join(temporary, 'no-global-npmrc'),
    npm_config_cache: path.join(temporary, 'npm-cache'), npm_config_update_notifier: 'false',
  });
  if (pgBin) for (const key of ['ORG_TEST_PG_BIN', 'DAILY_TEST_PG_BIN', 'FINANCE_TEST_PG_BIN']) env[key] = pgBin;
  let executable = command === 'node' ? process.execPath : command;
  let childArgs = args;
  if (command === 'npm') {
    const cli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (!existsSync(cli)) throw new Error(`npm CLI not found beside Node: ${cli}`);
    executable = process.execPath;
    childArgs = [cli, ...args];
  }
  const stdout = createWriteStream(path.join(artifact, 'stdout.log'));
  const stderr = createWriteStream(path.join(artifact, 'stderr.log'));
  let child, hardStop, cancelReason = null, forced = false;
  const cancel = reason => {
    if (cancelReason) return;
    cancelReason = reason;
    if (child?.connected) child.send({ type: 'deadline:cancel', reason });
    // 종료 유예는 상태 polling이 아닌 cleanup의 상한이다.
    hardStop = setTimeout(() => {
      forced = true;
      if (process.platform === 'win32') {
        const killer = spawn(path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { env, shell: false, stdio: 'inherit' });
        killer.on('error', error => console.error(error));
      } else child.kill('SIGKILL');
    }, 20000);
  };
  const onInterrupt = () => cancel('SIGINT');
  const onTerminate = () => cancel('SIGTERM');
  const onMessage = message => { if (message?.type === 'deadline:cancel') cancel('ipc'); };
  const onDisconnect = () => cancel('parent-disconnect');
  let result;
  try {
    child = spawn(executable, childArgs, { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.pipe(stdout); child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(stderr); child.stderr.pipe(process.stderr, { end: false });
    child.on('message', message => { if (process.connected) process.send(message); });
    process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
    process.on('message', onMessage); process.on('disconnect', onDisconnect);
    const deadline = setTimeout(() => cancel('execution-timeout'), 15 * 60 * 1000);
    try {
      result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
    } finally { clearTimeout(deadline); }
  } catch (error) {
    result = { code: 1, error: error.message };
  } finally {
    clearTimeout(hardStop);
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
    process.off('message', onMessage); process.off('disconnect', onDisconnect);
    stdout.end(); stderr.end();
    await Promise.all([finished(stdout), finished(stderr)]);
    await rm(temporary, { recursive: true, force: true });
    await writeFile(path.join(artifact, 'result.json'), JSON.stringify({ runId, command, args, childPid: child?.pid, ...result, cancelReason, forced, temporary, temporaryRemoved: !existsSync(temporary) }, null, 2));
    console.error(`DEADLINE_RUN_RESULT ${path.join(artifact, 'result.json')}`);
  }
  return cancelReason ? 130 : result.code ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runIsolated(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
