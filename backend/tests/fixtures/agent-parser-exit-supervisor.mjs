import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';

// 실제 파서 실행 경계에만 치명적 종료를 주입한다. 외부 테스트 process는 살아 있어야 한다.
const mode = process.argv[2];
const secret = 'SYNTHETIC_PARSER_SECRET';
const actions = {
  kill: "process.kill(process.pid, 'SIGKILL');",
  exit: 'process.exit(23);',
  'result-exit': "process.send({text:'UNCOMMITTED_RESULT'}, () => process.exit(23));",
  hang: "process.on('message', () => {}); await new Promise(() => {});",
  'secret-error': `throw new Error('${secret}');`,
};
assert.ok(Object.hasOwn(actions, mode));
const preload = 'data:text/javascript,' + encodeURIComponent(actions[mode]);
const originalFork = childProcess.fork, OriginalWorker = workerThreads.Worker;
let parser, spawnOptions;
const exits = [];
childProcess.fork = (url, args, options) => {
  assert.equal(url.href, new URL('../../src/services/agent-attachment-parser.worker.js', import.meta.url).href);
  spawnOptions = options;
  parser = originalFork(url, args, {...options, execArgv:[...options.execArgv, '--import', preload]});
  parser.once('exit', (code, signal) => exits.push({code, signal}));
  return parser;
};
workerThreads.Worker = class extends OriginalWorker {
  constructor(url, options) {
    super(url, {...options, execArgv:['--import', preload]});
  }
};
syncBuiltinESMExports();
const { extractAttachmentText } = await import('../../src/services/agent-attachments.service.js');
// 부모 provider 비밀과 임의 Node preload가 파서에게 전달되면 안 된다.
process.env.OPENROUTER_API_KEY = secret;
process.env.AWS_SECRET_ACCESS_KEY = secret;
process.env.NODE_OPTIONS = '--no-warnings';
try {
  await assert.rejects(extractAttachmentText({filename:'crash.pdf', mime:'application/pdf', content_base64:Buffer.from('%PDF-1.7').toString('base64')}), {
    code:mode === 'hang' ? 'DOCUMENT_PARSE_TIMEOUT' : 'DOCUMENT_PARSE_FAILED', status:422,
  });
  assert.ok(parser, 'document parsing must be isolated from process-wide termination');
  assert.equal(exits.length, 1, 'the parser must exit before the caller settles');
  assert.deepEqual(spawnOptions.execArgv, ['--max-old-space-size=128']);
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.equal(spawnOptions.shell, false);
  assert.equal(spawnOptions.execPath, process.execPath);
  assert.ok(Object.keys(spawnOptions.env).every(key => ['systemroot','windir'].includes(key.toLowerCase())));
  assert.ok(!Object.values(spawnOptions.env).includes(secret));
  assert.equal((await extractAttachmentText({filename:'alive.txt', mime:'text/plain', content_base64:Buffer.from('PARENT_ALIVE').toString('base64')})).text, 'PARENT_ALIVE');
  process.send({mode, exits, parentAlive:true});
} finally {
  if (parser && parser.exitCode === null && parser.signalCode === null) parser.kill('SIGKILL');
  process.disconnect();
}
