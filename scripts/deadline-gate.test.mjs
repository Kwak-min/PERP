import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { manifest, selectTargets, requiredFiles, executeTarget } from './run_deadline_gate.mjs';
import { validateModelConfig } from './deadline-model-config.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const invoke = args => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30000 });
const gateReceipt = result => JSON.parse(readFileSync([...result.stderr.matchAll(/DEADLINE_GATE_RESULT ([^\r\n]+)/g)].at(-1)[1].trim(), 'utf8'));
const runnerReceipt = result => JSON.parse(readFileSync([...result.stderr.matchAll(/DEADLINE_RUN_RESULT ([^\r\n]+)/g)].at(-1)[1].trim(), 'utf8'));
const integrationNative = ['deadline-cleanup-pg-limits-native', 'deadline-import-maintenance-native', 'deadline-receipt-maintenance-native', 'deadline-runtime-integration-native'];
const integrationRoot = ['deadline-import-maintenance-server', 'deadline-import-maintenance', 'deadline-runtime-startup'].map(name => `backend/tests/${name}.test.js`);
const integrationBrowser = 'frontend/scripts/deadline-final-ui-fixes.e2e.mjs';

test('promised scenario all enumerates required Wiki stores without running browser leaves', () => {
  const child = invoke(['frontend/scripts/deadline-qa.e2e.mjs', '--scenario', 'all', '--list']);
  const missing = requiredFiles(selectTargets(['--suite', 'browser']).selected);
  assert.equal(child.status, missing.length ? 2 : 0, child.stderr);
  const manifest = missing.length ? gateReceipt(child) : JSON.parse(child.stdout);
  if (missing.length) {
    assert.deepEqual(manifest.blocked.filter(item => item.code === 'MISSING_REQUIRED_TARGET').map(item => item.target), missing);
    assert.equal(manifest.results.length, 0);
    assert.equal(manifest.releaseCertified, false);
  }
  for (const store of ['legacy', 'pg']) {
    const target = manifest.targets.find(target => target.id === `browser:knowledge-wiki:${store}`);
    assert.ok(target);
    assert.deepEqual(target.coverage, [`wiki:personal:${store}`, `wiki:company:${store}`]);
  }
  assert.equal(manifest.status, missing.length ? 'blocked' : 'planned');
  const finalUI = manifest.targets.find(target => target.id === 'browser:final-ui-fixes');
  assert.deepEqual(finalUI.args, [integrationBrowser]);
  assert.deepEqual(finalUI.required, [integrationBrowser]);
  assert.deepEqual(finalUI.capabilities, ['browser']);
  assert.ok(manifest.targets.some(target => target.id === 'browser:renderer-lifecycle'));
  assert.ok(manifest.targets.some(target => target.id === 'browser:import-built-regression'));
  assert.ok(manifest.targets.some(target => target.id === 'build:frontend'));
});

test('every delivered native file and root test is explicit, with separate Reservation contracts', () => {
  const native = readdirSync(path.join(root, 'backend/tests')).filter(file => file.endsWith('.integration.mjs')).sort();
  const actual = manifest.targets.filter(target => target.id.startsWith('native:'));
  assert.deepEqual(actual.map(target => path.basename(target.required[0])).sort(), [...new Set([...native, ...integrationNative.map(name => `${name}.integration.mjs`)])].sort());
  assert.deepEqual(manifest.integrationRequired.nativeTargets, integrationNative.map(name => `native:${name}`));
  assert.deepEqual(manifest.integrationRequired.rootRequiredTests, integrationRoot);
  assert.deepEqual(manifest.integrationRequired.browserTargets, ['browser:final-ui-fixes']);
  for (const target of actual) {
    assert.equal(target.command, 'node');
    assert.equal(target.args.length, 2);
    assert.equal(target.args[0], '--test');
    assert.ok(target.capabilities.includes('pg18'));
  }
  const rootTarget = manifest.targets.find(target => target.id === 'root:parallel');
  for (const file of readdirSync(path.join(root, 'backend/tests')).filter(file => file.endsWith('.test.js'))) assert.ok(rootTarget.required.includes(`backend/tests/${file}`));
  for (const file of integrationRoot) assert.ok(rootTarget.required.includes(file));
  assert.ok(rootTarget.capabilities.includes('pg18'));
  assert.deepEqual(manifest.targets.find(target => target.id === 'unit:frontend/scripts/deadline-browser-session.test.mjs').capabilities, ['browser']);
  for (const id of ['reservation:parallel', 'reservation:contract', 'reservation:native', 'model:real-compile-query', 'wiki:runtime']) assert.ok(manifest.targets.some(target => target.id === id));
  for (const target of manifest.targets) {
    assert.ok(!target.args.includes('--test-concurrency=1'));
    assert.ok(!target.args.includes('all'));
    assert.ok(!target.args.includes('test:deadline'));
    assert.ok(!target.args.includes('scripts/run_deadline_gate.mjs'));
  }
  const integrationFiles = [...integrationNative.map(name => `backend/tests/${name}.integration.mjs`), ...integrationRoot, integrationBrowser];
  assert.deepEqual(requiredFiles(manifest.targets).sort(), integrationFiles.filter(file => !existsSync(path.join(root, file))).sort());
});

test('bundle repair is mandatory once in native and root inventories; chart repairs reuse existing targets', () => {
  assert.equal(new Set(manifest.targets.map(target => target.id)).size, manifest.targets.length);
  const id = 'native:deadline-wiki-bundle-native';
  const source = 'backend/tests/deadline-wiki-bundle-native.integration.mjs';
  const scenarios = 'backend/tests/deadline-wiki-bundle-scenarios.js';
  const target = manifest.targets.find(target => target.id === id);
  assert.deepEqual(target, { id, suite: 'native', command: 'node', args: ['--test', source], required: [source, scenarios], coverage: [id], capabilities: ['pg18'] });
  for (const args of [[], ['--suite', 'native'], ['--target', id]]) {
    assert.equal(selectTargets(args).selected.filter(target => target.id === id).length, 1);
  }
  const rootTarget = manifest.targets.find(target => target.id === 'root:parallel');
  for (const file of ['backend/tests/deadline-wiki-bundle.test.js', scenarios, 'backend/tests/deadline-analytics.test.js']) {
    assert.equal(rootTarget.required.filter(required => required === file).length, 1);
  }
  assert.deepEqual(rootTarget.args, ['test']);
  for (const id of ['native:deadline-analytics-native', 'native:deadline-analytics-feature-failure-native', 'unit:frontend/scripts/deadline-analytics-model.test.mjs', 'browser:analytics', 'browser:analytics-pg']) {
    assert.equal(selectTargets([]).selected.filter(target => target.id === id).length, 1);
  }
  assert.ok(manifest.requiredScenarioSources.includes('frontend/scripts/deadline-analytics.e2e.mjs'));
});

test('current direct tests, dispatcher imports and shipped runtime prerequisites cannot drift from preflight', () => {
  const browser = selectTargets(['--suite', 'browser']).selected;
  const sources = new Set([...manifest.requiredScenarioSources, ...browser.flatMap(target => target.required)]);
  const dispatcher = readFileSync(path.join(root, 'frontend/scripts/deadline-qa.e2e.mjs'), 'utf8');
  for (const match of dispatcher.matchAll(/import\(['"]\.\/([^'"]+)['"]\)/g)) {
    const source = `frontend/scripts/${match[1]}`;
    assert.ok(sources.has(source), `Missing dispatcher prerequisite: ${source}`);
  }
  for (const directory of ['frontend/scripts', 'frontend/src/screens/reservation', 'frontend/src/services', 'scripts']) {
    for (const file of readdirSync(path.join(root, directory)).filter(file => file.endsWith('.test.mjs'))) {
      const source = `${directory}/${file}`;
      const target = manifest.targets.find(target => target.id === `unit:${source}`);
      assert.ok(target, `Missing direct test: ${source}`);
      assert.deepEqual(target.args, ['--test', source]);
      assert.ok(target.required.includes(source));
    }
  }
  const runtime = manifest.targets.find(target => target.id === 'wiki:runtime');
  assert.deepEqual(runtime.args, ['backend/tests/deadline-wiki-runtime-smoke.mjs']);
  assert.deepEqual(runtime.capabilities, ['pg18']);
  const result = invoke(['scripts/run_deadline_gate.mjs', '--target', runtime.id, '--preflight']);
  assert.equal(result.status, 2, result.stderr);
  const receipt = gateReceipt(result);
  assert.deepEqual(receipt.blocked, [{ code: 'PG18_REQUIRED' }]);
  assert.equal(receipt.results.length, 0);
});

test('unknown scenarios/targets and malformed all options propagate exit 2', () => {
  for (const args of [['--suite', 'unknown'], ['--target', 'unknown'], ['--pg-bin'], ['--suite', 'browser', '--suite', 'all']]) {
    const result = invoke(['scripts/run_deadline_gate.mjs', ...args]);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).status, 'blocked');
  }
  for (const args of [['--scenario', 'unknown'], ['--scenario', 'all', '--probe', 'error']]) assert.equal(invoke(['frontend/scripts/deadline-qa.e2e.mjs', ...args]).status, 2);
});

test('missing required target cannot become an empty successful suite', () => {
  const target = { ...manifest.targets[0], required: ['scripts/required-target-does-not-exist.mjs'] };
  assert.deepEqual(requiredFiles([target]), ['scripts/required-target-does-not-exist.mjs']);
  assert.throws(() => selectTargets(['--suite', 'native'], { ...manifest, targets: [] }), { code: 'MISSING_REQUIRED_TARGET' });
  const result = invoke(['--input-type=module', '-e', `import {manifest,runGate} from './scripts/run_deadline_gate.mjs'; manifest.targets.find(target=>target.id==='unit:frontend/scripts/deadline-approval-model.test.mjs').required.push('scripts/required-target-does-not-exist.mjs'); process.exitCode=await runGate(['--target','unit:frontend/scripts/deadline-approval-model.test.mjs','--preflight']);`]);
  assert.equal(result.status, 2, result.stderr);
  const receipt = gateReceipt(result);
  assert.equal(receipt.results.length, 0);
  assert.deepEqual(receipt.blocked, [{ code: 'MISSING_REQUIRED_TARGET', target: 'scripts/required-target-does-not-exist.mjs' }]);
});

test('gate CLI propagates an actual failing logical child rather than just recording it', () => {
  const result = invoke(['--input-type=module', '-e', `import {manifest,runGate} from './scripts/run_deadline_gate.mjs'; Object.assign(manifest.targets.find(target=>target.id==='unit:frontend/scripts/deadline-approval-model.test.mjs'),{command:'node',args:['-e','process.exitCode=7']}); process.exitCode=await runGate(['--target','unit:frontend/scripts/deadline-approval-model.test.mjs']);`]);
  assert.equal(result.status, 7, result.stderr);
  const receipt = gateReceipt(result);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.results[0].code, 7);
  assert.equal(receipt.results[0].cleanup, true);
});

test('missing native/model capabilities are blocked, never skipped green', () => {
  for (const suite of ['native', 'model']) {
    const result = invoke(['scripts/run_deadline_gate.mjs', '--suite', suite, '--preflight']);
    assert.equal(result.status, 2, result.stderr);
    const receipt = gateReceipt(result);
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.results.length, 0);
    assert.ok(receipt.notRun.length > 0);
    assert.ok(receipt.blocked.some(item => item.code === (suite === 'native' ? 'PG18_REQUIRED' : 'MODEL_CONFIGURATION_REQUIRED')));
    assert.equal(receipt.releaseCertified, false);
  }
});

test('real model configuration requires explicit safe endpoint, opt-in and isolated ownership', () => {
  const valid = { opt_in: true, ownership: 'caller-owned-isolated', configuration: { base_url: 'http://127.0.0.1:12345', model: 'gate-owned-smoke', context_tokens: 8192, output_tokens: 1024, timeout_ms: 30000, temperature: 0 } };
  assert.deepEqual(validateModelConfig(valid), valid);
  for (const value of [null, { ...valid, opt_in: false }, { ...valid, ownership: 'default' }, { ...valid, api_key: 'not-a-secret' }, ...['http://127.0.0.1:8000', 'https://example.invalid', 'http://user:pass@127.0.0.1:12345', 'http://127.0.0.1:12345/?token=x'].map(base_url => ({ ...valid, configuration: { ...valid.configuration, base_url } }))]) assert.throws(() => validateModelConfig(value), { code: 'MODEL_CONFIGURATION_REQUIRED' });
});

test('leaf nonzero status propagates and real child temporary resources are removed', { timeout: 30000 }, async () => {
  const target = { id: 'logical-failure', command: 'node', args: ['-e', 'const fs=require("node:fs");fs.writeFileSync(process.env.DEADLINE_TEMP_ROOT+"/owned-marker", "fixture");process.exitCode=7;'] };
  const failed = await executeTarget(target);
  assert.equal(failed.code, 7);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.cleanup, true);
  const receipt = JSON.parse(readFileSync(failed.receipt));
  assert.equal(receipt.code, 7);
  assert.equal(existsSync(receipt.temporary), false);
  const passed = await executeTarget({ ...target, id: 'logical-success', args: ['-e', 'process.exitCode=0'] });
  assert.equal(passed.code, 0);
  assert.equal(passed.cleanup, true);
  assert.notEqual(passed.receipt, failed.receipt);
});

test('already isolated invocation adds only a fresh leaf wrapper and retains child cleanup', { timeout: 30000 }, () => {
  const result = invoke(['scripts/run_deadline_isolated.mjs', 'node', 'scripts/run_deadline_gate.mjs', '--target', 'unit:frontend/scripts/deadline-approval-model.test.mjs']);
  assert.equal(result.status, 0, result.stderr);
  const outer = runnerReceipt(result), gate = gateReceipt(result);
  assert.equal(outer.temporaryRemoved, true);
  assert.equal(gate.status, 'partial-passed');
  assert.equal(gate.fullMatrix, false);
  assert.equal(gate.results.length, 1);
  assert.equal(gate.results[0].cleanup, true);
  const leaf = JSON.parse(readFileSync(gate.results[0].receipt));
  assert.notEqual(leaf.runId, outer.runId);
  assert.notEqual(leaf.temporary, outer.temporary);
  assert.equal(existsSync(leaf.temporary), false);
});

test('root default test retains its existing actual parallel workspace contract', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json')));
  assert.equal(pkg.scripts.test, 'npm run test --workspace backend && npm run test --workspace frontend');
  assert.equal(JSON.parse(readFileSync(path.join(root, 'backend/package.json'))).scripts.test, 'node --test tests/*.test.js');
  const finalCommands = [
    ['npm', 'run', 'build', '--prefix', 'Reservation/backend'],
    ['npm', 'audit', '--json'],
    ['npm', 'audit', '--prefix', 'Reservation/backend', '--json'],
    ['node', 'scripts/check_structure.mjs'],
    ['python', 'scripts/check_docs_coverage.py'],
    ['python', 'scripts/check_deliverables.py'],
  ];
  assert.deepEqual(manifest.mandatoryFinalChecks.map(check => check.invocation), finalCommands.map(args => ['node', 'scripts/run_deadline_isolated.mjs', ...args]));
  for (const check of manifest.mandatoryFinalChecks) {
    assert.equal(check.mandatory, true);
    assert.equal(check.execution, 'separate-from-gate');
    assert.ok(!manifest.targets.some(target => target.id === check.id));
  }
  assert.deepEqual(manifest.independentFinalReviews, ['F1', 'F2', 'F3', 'F4']);
});
