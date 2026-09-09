import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateModelConfig } from './deadline-model-config.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const manifest = JSON.parse(readFileSync(new URL('./deadline-gate-manifest.json', import.meta.url), 'utf8'));
const fail = (code, detail) => Object.assign(new Error(detail), { code });

export function selectTargets(argv, inventory = manifest) {
  const options = { suite: 'all', targets: [], list: false, preflight: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--target' && seen.has(arg)) throw fail('INVALID_ARGUMENT', arg);
    seen.add(arg);
    if (arg === '--list' || arg === '--preflight') options[arg.slice(2)] = true;
    else if (['--suite', '--target', '--pg-bin', '--model-config'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw fail('INVALID_ARGUMENT', arg);
      if (arg === '--target') options.targets.push(value);
      else options[{ '--suite': 'suite', '--pg-bin': 'pgBin', '--model-config': 'modelConfig' }[arg]] = value;
    } else throw fail('UNKNOWN_ARGUMENT', arg);
  }
  if (!['all', ...inventory.phaseOrder].includes(options.suite)) throw fail('UNKNOWN_SCENARIO', options.suite);
  if (options.targets.length && options.suite !== 'all') throw fail('INVALID_ARGUMENT', 'Use --suite or --target, not both');
  for (const id of options.targets) if (!inventory.targets.some(target => target.id === id)) throw fail('UNKNOWN_TARGET', id);
  const selected = inventory.targets.filter(target => options.targets.length ? options.targets.includes(target.id) : options.suite === 'all' || target.suite === options.suite);
  if (!selected.length) throw fail('MISSING_REQUIRED_TARGET', options.suite);
  if (selected.some(target => target.capabilities.includes('built')) && !selected.some(target => target.id === 'build:frontend')) {
    selected.unshift(inventory.targets.find(target => target.id === 'build:frontend'));
  }
  return { ...options, selected };
}

export function requiredFiles(targets, inventory = manifest, directory = root) {
  const files = new Set(['scripts/run_deadline_isolated.mjs', 'scripts/deadline-isolation-guard.mjs']);
  for (const target of targets) for (const file of target.required) files.add(file);
  if (targets.some(target => target.suite === 'browser')) for (const file of inventory.requiredScenarioSources) files.add(file);
  return [...files].filter(file => !existsSync(path.join(directory, file)) || !statSync(path.join(directory, file)).isFile());
}

function capabilities(options) {
  const required = new Set(options.selected.flatMap(target => target.capabilities));
  const blocked = [];
  let model;
  if (required.has('pg18')) {
    if (!options.pgBin) blocked.push({ code: 'PG18_REQUIRED' });
    else for (const name of ['postgres', 'initdb', 'pg_ctl', 'psql']) {
      const executable = path.join(path.resolve(options.pgBin), name + (process.platform === 'win32' ? '.exe' : ''));
      const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      if (result.error || result.status !== 0 || !/\b18\./.test(result.stdout ?? '')) blocked.push({ code: 'PG18_BINARY_UNAVAILABLE', binary: name });
    }
  }
  if (required.has('reservation') && !existsSync(path.join(root, 'Reservation/backend/node_modules/ts-node/register/index.js'))) blocked.push({ code: 'RESERVATION_INSTALL_REQUIRED' });
  if (required.has('browser') && process.platform === 'win32' && ![
    path.join(process.env.PROGRAMFILES ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  ].some(existsSync)) blocked.push({ code: 'CHROME_REQUIRED' });
  if (required.has('model')) {
    try {
      if (!options.modelConfig || /(?:^|[\\/])(?:private\.env|\.env(?:\..*)?)$/i.test(options.modelConfig)) throw fail('MODEL_CONFIGURATION_REQUIRED', 'No private env');
      model = validateModelConfig(JSON.parse(readFileSync(path.resolve(options.modelConfig), 'utf8')));
    } catch (error) { blocked.push({ code: error.code === 'MODEL_CONFIGURATION_REQUIRED' ? error.code : 'MODEL_CONFIGURATION_INVALID' }); }
  }
  return { blocked, model };
}

// Each leaf gets a new wrapper, including when this gate already has an outer
// wrapper. The manifest contains leaves only: it never launches itself or all.
export async function executeTarget(target, { pgBin, model, signal } = {}) {
  for (const directory of target.prepare ?? []) await mkdir(path.join(root, directory), { recursive: true });
  const args = ['scripts/run_deadline_isolated.mjs', ...(pgBin ? ['--pg-bin', path.resolve(pgBin)] : []), target.command,
    ...target.args.map(arg => arg === '$MODEL_CONFIG' ? JSON.stringify(model) : arg)];
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '', timedOut = false, spawnError;
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
  const cancel = () => { if (child.connected) child.send({ type: 'deadline:cancel' }); };
  const timer = setTimeout(() => { timedOut = true; cancel(); }, 15 * 60 * 1000);
  // Wrapper has its own 20-second cleanup bound. This is an independent bound
  // for a wedged wrapper, restricted to the process tree this gate spawned.
  const hardStop = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') {
      const killed = spawnSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 10000 });
      if (killed.error || killed.status !== 0) process.stderr.write(killed.stderr || String(killed.error));
    } else child.kill('SIGKILL');
  }, 16 * 60 * 1000);
  const completed = new Promise(resolve => {
    child.once('error', error => { spawnError = error.code; });
    child.once('close', (code, childSignal) => resolve({ code: code ?? 1, signal: childSignal }));
  });
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let result;
  try { result = await completed; }
  finally { clearTimeout(timer); clearTimeout(hardStop); signal?.removeEventListener('abort', cancel); }
  const receiptPath = [...stderr.matchAll(/DEADLINE_RUN_RESULT ([^\r\n]+)/g)].at(-1)?.[1].trim();
  let receipt, receiptError;
  try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); }
  catch (error) { receiptError = error.code ?? 'MISSING_CLEANUP_RECEIPT'; }
  const cleanup = receipt?.temporaryRemoved === true && !existsSync(receipt.temporary) && receipt.forced === false;
  const code = timedOut || signal?.aborted ? 130 : result.code || (!cleanup ? 1 : 0);
  return { id: target.id, code, status: code === 0 ? 'passed' : 'failed', signal: result.signal, cleanup, receipt: receiptPath ?? null, receiptError, spawnError, timedOut,
    invocation: ['node', ...args.map(arg => arg === JSON.stringify(model) ? '$EXPLICIT_MODEL_CONFIG' : arg)] };
}

export async function runGate(argv) {
  let options;
  try { options = selectTargets(argv); }
  catch (error) { console.error(JSON.stringify({ status: 'blocked', code: error.code, detail: error.message })); return 2; }
  const missing = requiredFiles(options.selected);
  const plan = { schemaVersion: 1, status: 'planned', suite: options.suite, selection: options.targets, fullMatrix: options.suite === 'all' && !options.targets.length,
    base: manifest.base, parallelism: manifest.parallelism, targets: options.selected, aliases: manifest.aliases, realModel: manifest.realModel };
  if (options.list && !missing.length) { console.log(JSON.stringify(plan, null, 2)); return 0; }
  const check = capabilities(options);
  const blocked = [...missing.map(target => ({ code: 'MISSING_REQUIRED_TARGET', target })), ...check.blocked];
  const runId = randomUUID(), directory = path.join(root, '.omo/evidence/deadline-gates', runId);
  await mkdir(directory, { recursive: true });
  const report = { ...plan, runId, status: 'running', blocked, results: [], notRun: [], releaseCertified: false };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const onMessage = message => { if (message?.type === 'deadline:cancel') cancel(); };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel); process.on('message', onMessage); process.on('disconnect', cancel);
  let exitCode = 0;
  try {
    if (blocked.length) { report.status = 'blocked'; exitCode = 2; }
    else if (options.preflight) report.status = 'preflight-only';
    else {
      for (const phase of manifest.phaseOrder) {
        if (exitCode || controller.signal.aborted) break;
        const queue = options.selected.filter(target => target.suite === phase);
        const workers = Array.from({ length: Math.min(queue.length, ['root', 'browser', 'build', 'reservation', 'model'].includes(phase) ? 1 : manifest.parallelism.targets) }, async () => {
          while (queue.length && !exitCode && !controller.signal.aborted) {
            const target = queue.shift();
            try {
              const result = await executeTarget(target, { pgBin: options.pgBin, model: check.model, signal: controller.signal });
              report.results.push(result);
              if (result.code && !exitCode) exitCode = result.code;
            } catch (error) {
              // Other active leaves still finish and clean up before the phase settles.
              report.results.push({ id: target.id, code: 1, status: 'failed', cleanup: false, error: error.code ?? 'TARGET_ERROR' });
              exitCode ||= 1;
            }
          }
        });
        await Promise.all(workers);
      }
      if (controller.signal.aborted) exitCode = 130;
      report.status = exitCode ? 'failed' : report.fullMatrix ? 'passed' : 'partial-passed';
    }
  } catch (error) {
    report.status = 'failed'; report.error = { code: error.code ?? 'GATE_ERROR', message: error.message }; exitCode = 1;
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel); process.off('message', onMessage); process.off('disconnect', cancel);
    report.notRun = options.selected.filter(target => !report.results.some(result => result.id === target.id)).map(target => target.id);
    report.exitCode = exitCode;
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(report, null, 2));
    console.error(`DEADLINE_GATE_RESULT ${path.join(directory, 'manifest.json')}`);
    console.log(JSON.stringify({ status: report.status, code: exitCode, blocked, executed: report.results.length, notRun: report.notRun.length, releaseCertified: false }));
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runGate(process.argv.slice(2));
