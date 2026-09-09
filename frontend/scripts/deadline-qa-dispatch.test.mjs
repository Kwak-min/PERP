import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('QA CLI dispatches Wiki stores explicitly and preserves all existing scenario/probe branches', async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const temporary = await mkdtemp(path.join(process.env.DEADLINE_TEMP_ROOT, 'qa-dispatch-'));
  const hook = path.join(temporary, 'dispatch.mjs');
  // Replace only expensive leaf scenarios, not CLI parsing or the isolation guard.
  await writeFile(hook, `import {registerHooks} from 'node:module';
registerHooks({load(url, context, next) {
  if(url.endsWith('/task28-workflow.e2e.mjs')) return {format:'module',shortCircuit:true,source:'export async function task28Workflow(options={}) { console.log(JSON.stringify({dispatch:"wiki",...options})); }'};
  if(url.endsWith('/deadline-roles-qa.mjs')) return {format:'module',shortCircuit:true,source:'export async function rolesScenario() { console.log(JSON.stringify({dispatch:"roles"})); }'};
  if(url.endsWith('/deadline-graph-engine.scenario.mjs')) return {format:'module',shortCircuit:true,source:'export async function graphEngineScenario() { console.log(JSON.stringify({dispatch:"engine"})); }'};
  const loaded=next(url,context);
  if(url.endsWith('/deadline-qa.e2e.mjs') && loaded.source) return {...loaded,source:String(loaded.source).replace('async function baseline(probe, scenario) {','async function baseline(probe, scenario) { console.log(JSON.stringify({dispatch:"baseline",scenario,probe})); return;')};
  return loaded;
}});`);
  function invoke(args) {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, 'frontend/scripts/deadline-qa.e2e.mjs', ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  }
  try {
    for (const store of [undefined, 'legacy', 'pg']) {
      const result = invoke(['--scenario', 'knowledge-wiki', ...(store ? ['--store', store] : [])]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), { dispatch: 'wiki', mode: store ?? 'legacy', evidence: path.join(root, '.omo/evidence/task-28-gate-revision/browser', store ?? 'legacy') });
    }
    for (const scenario of ['baseline', 'recruitment-nav', 'roles', 'knowledge-graphs', 'graph-engine']) {
      const result = invoke(['--scenario', scenario]); assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), scenario === 'roles' ? {dispatch:'roles'} : scenario === 'graph-engine' ? {dispatch:'engine'} : scenario === 'knowledge-graphs' ? {dispatch:'wiki'} : {dispatch:'baseline',scenario});
    }
    for (const scenario of ['baseline', 'recruitment-nav', 'knowledge-graphs', 'graph-engine']) for (const probe of ['error', 'cancel']) {
      const result = invoke(['--scenario', scenario, '--probe', probe]); assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), scenario === 'graph-engine' ? {dispatch:'engine'} : {dispatch:'baseline',scenario,probe});
    }
    for (const args of [[], ['--scenario','unknown'], ['--scenario','knowledge-wiki','pg'], ['--scenario','knowledge-wiki','--store','native'], ['--scenario','knowledge-wiki','--probe','error'], ['--scenario','roles','--store','pg'], ['--scenario','knowledge-wiki','--store','pg','extra']]) {
      const result = invoke(args); assert.equal(result.status, 2, JSON.stringify({args,stderr:result.stderr})); assert.equal(result.stdout.trim(), '');
    }
  } finally { await rm(temporary, {recursive:true,force:true}); }
});
