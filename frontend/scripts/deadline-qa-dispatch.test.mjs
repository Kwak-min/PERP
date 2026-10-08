import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('QA CLI dispatches Wiki stores explicitly and preserves all primary scenario/probe branches', { timeout: 120000 }, async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const temporary = await mkdtemp(path.join(process.env.DEADLINE_TEMP_ROOT, 'qa-dispatch-'));
  const hook = path.join(temporary, 'dispatch.mjs');
  const leaves = {
    'task28-workflow.e2e.mjs': ['task28Workflow', 'wiki'],
    'deadline-roles-qa.mjs': ['rolesScenario', 'roles'],
    'deadline-graph-engine.scenario.mjs': ['graphEngineScenario', 'engine'],
    'deadline-reservation-conflict.scenario.mjs': ['reservationConflict', 'reservation-conflict-edit'],
    'deadline-reservation-calendar.scenario.mjs': ['reservationCalendar', 'reservation-space-calendar'],
    'deadline-role-toggles.e2e.mjs': ['roleTogglesScenario', 'role-toggles'],
    'deadline-disabled-hr-features-qa.mjs': ['disabledHrFeaturesScenario', 'disabled-hr-features'],
    'deadline-approval-workflow.scenario.mjs': ['approvalWorkflow', 'approval-workflow'],
    'deadline-analytics.e2e.mjs': ['analyticsScenario', 'analytics'],
    'deadline-month-summary.e2e.mjs': ['monthSummary', 'month-summary'],
    'deadline-nav-pref.e2e.mjs': ['navPrefScenario', 'nav-pref'],
  };
  // Replace expensive leaf scenarios only; execute the actual CLI and isolation guard.
  await writeFile(hook, `import {registerHooks} from 'node:module';
const leaves=${JSON.stringify(leaves)};
registerHooks({load(url, context, next) {
  const leaf=leaves[url.split('/').pop()];
  if(leaf) return {format:'module',shortCircuit:true,source:'export async function '+leaf[0]+'(...args) { console.log(JSON.stringify({dispatch:'+JSON.stringify(leaf[1])+',args})); }'};
  for(const [file,dispatch] of [['deadline-expense-import.scenario.mjs','expense-csv-import'],['deadline-expense-receipt.scenario.mjs','expense-receipt']]) if(url.endsWith('/'+file)) return {format:'module',shortCircuit:true,source:'console.log(JSON.stringify({dispatch:'+JSON.stringify(dispatch)+',args:[]}));'};
  const loaded=next(url,context);
  if(url.endsWith('/deadline-qa.e2e.mjs') && loaded.source) return {...loaded,source:String(loaded.source).replace('async function baseline(probe, scenario) {','async function baseline(probe, scenario) { console.log(JSON.stringify({dispatch:"baseline",scenario,probe})); return;')};
  return loaded;
}});`);
  function invoke(args) {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, 'frontend/scripts/deadline-qa.e2e.mjs', ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  }
  function dispatched(args, expected) {
    const result = invoke(['--scenario', ...args]);
    assert.equal(result.status, 0, JSON.stringify({ args, stderr: result.stderr }));
    assert.deepEqual(JSON.parse(result.stdout.trim()), expected);
  }
  try {
    for (const store of [undefined, 'legacy', 'pg']) dispatched(['knowledge-wiki', ...(store ? ['--store', store] : [])], { dispatch: 'wiki', args: [{ mode: store ?? 'legacy', evidence: path.join(root, '.omo/evidence/task-28-gate-revision/browser', store ?? 'legacy') }] });
    for (const scenario of ['baseline', 'recruitment-nav', 'members-pagination', 'assets-footer', 'sidebar', 'project-members', 'project-members-access', 'knowledge-graphs', 'nav-pref']) {
      dispatched([scenario], scenario === 'knowledge-graphs' ? { dispatch: 'wiki', args: [] } : scenario === 'nav-pref' ? { dispatch: scenario, args: [null] } : { dispatch: 'baseline', scenario });
      for (const probe of ['error', 'cancel']) dispatched([scenario, '--probe', probe], scenario === 'nav-pref' ? { dispatch: scenario, args: [probe] } : { dispatch: 'baseline', scenario, probe });
    }
    for (const scenario of ['roles', 'disabled-hr-features', 'reservation-conflict-edit', 'expense-receipt', 'expense-csv-import', 'approval-workflow', 'month-summary']) dispatched([scenario], { dispatch: scenario, args: [] });
    dispatched(['graph-engine'], { dispatch: 'engine', args: [] });
    for (const [scenario, dispatch, native] of [['role-toggles', 'role-toggles', false], ['role-toggles-native', 'role-toggles', true], ['analytics', 'analytics', false], ['analytics-pg', 'analytics', true]]) dispatched([scenario], { dispatch, args: [native] });
    for (const baseline of [false, true]) dispatched(['reservation-space-calendar', ...(baseline ? ['--baseline'] : [])], { dispatch: 'reservation-space-calendar', args: [baseline] });
    for (const args of [[], ['--scenario','unknown'], ['--scenario','knowledge-wiki','pg'], ['--scenario','knowledge-wiki','--store','native'], ['--scenario','knowledge-wiki','--probe','error'], ['--scenario','roles','--store','pg'], ['--scenario','graph-engine','--probe','error'], ['--scenario','analytics','--probe','cancel'], ['--scenario','knowledge-wiki','--store','pg','extra']]) {
      const result = invoke(args); assert.equal(result.status, 2, JSON.stringify({args,stderr:result.stderr})); assert.equal(result.stdout.trim(), '');
    }
  } finally { await rm(temporary, {recursive:true,force:true}); }
});
