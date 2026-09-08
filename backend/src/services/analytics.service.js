import { ApiError } from '../utils/errors.js';
import { decimal, executionRate, assertExportSize, reportKey } from './analytics-contract.service.js';

export const REPORT_COLUMNS = {
  members: ['id', 'user_id', 'status'],
  tasks: ['id', 'title', 'status', 'created_at', 'due'],
  transactions: ['id', 'date', 'revenue', 'expense', 'unit'],
  budgets: ['id', 'amount', 'unit', 'status'],
  approvals_created: ['id', 'status', 'created_at'],
  approvals_decided: ['id', 'status', 'decided_at'],
};
const SOURCES = {
  members: { permissions: ['member.read', 'menu.members'] },
  tasks: { permissions: ['task.read', 'menu.projects'], module: 'tasks' },
  transactions: { permissions: ['transaction.read', 'menu.finance'], module: 'finance' },
  budgets: { permissions: ['budget.read', 'menu.finance'], module: 'finance' },
  execution: { permissions: ['budget.read', 'transaction.read', 'menu.finance'], module: 'finance' },
  approvals: { permissions: ['menu.approvals'], any: ['approval.request', 'approval.decide'], feature: 'approvals' },
  ai: { permissions: ['agent.chat', 'menu.agent'], module: 'agent' },
  audit: { permissions: ['audit.read'] },
};
export function sourceState(context, source) {
  const spec = SOURCES[source], p = context.principal;
  if (!spec.permissions.every(permission => p.has(permission)) || (spec.any && !spec.any.some(permission => p.has(permission)))) return 'forbidden';
  if (context.queryFailed?.has(source)) return 'unavailable';
  if ((spec.module && !context.modules.has(spec.module)) || (spec.feature && !context.features.has(spec.feature))) return 'disabled';
  if (context.unsupported.has(source)) return 'unavailable';
  return null;
}
function metricsFor(source) {
  return {
    members: [['members.active', 'count', 'current_snapshot', '현재 활성 계정의 활성 회사 소속 수']],
    tasks: [
      ['tasks.created', 'count', 'period_flow', 'created_at의 시간대 변환 [from,to) 안에 생성된 현재 남아 있는 업무 수'],
      ['tasks.open', 'count', 'current_snapshot', '현재 status IN (todo,in_progress,blocked) 업무 수; 기간과 무관'],
      ['tasks.overdue', 'count', 'current_snapshot', '현재 열린 업무 중 due가 현재 instant보다 이전(시간) 또는 오늘보다 이전(DATE)인 수'],
    ],
    transactions: [
      ['finance.revenue', 'money', 'period_flow', '기간 DATE 전표: PG posted 수익계정 credit-debit; legacy confirmed income minor/100'],
      ['finance.expense', 'money', 'period_flow', '기간 DATE 전표: PG posted 비용계정 debit-credit; legacy confirmed expense minor/100'],
      ['finance.net', 'money', 'period_flow', '동일 인가/기간 장부의 revenue-expense'],
      ['finance.journals', 'count', 'period_flow', '기간 DATE posted/confirmed distinct 전표 ID 수; line 수가 아님'],
    ],
    budgets: [
      ['budgets.active', 'count', 'current_snapshot', '현재 PG active/legacy approved 예산 수; 역사적 말일 상태가 아님'],
      ['budgets.amount', 'money', 'current_snapshot', '현재 활성 예산의 실제 편성 금액 합; spent cache 미사용'],
    ],
    execution: [
      ['budgets.executed', 'money', 'period_flow_current_budget', '현재 활성 예산에 budget_id로 연결된 기간 posted/confirmed 비용 장부 합'],
      ['budgets.execution_rate', 'percent', 'period_flow_current_budget', '기간 linked 비용 / 현재 활성 편성액 * 100; 소수 4자리 절삭; 분모 0은 null/not_applicable'],
    ],
    approvals: [
      ['approvals.created', 'count', 'period_flow', 'canonical read predicate로 인가된 created_at 기간 요청 수; 허용된 자기 draft 포함, 제출 수 아님'],
      ['approvals.decided', 'count', 'period_flow', '인가된 최종 approved/rejected 요청 중 결정 instant가 기간 안인 distinct 요청 수; hold/withdraw 제외'],
    ],
    ai: [['ai.calls', 'count', 'period_flow', 'legacy 현재 사용자의 tenant 내 ai_request_log created_at 기간 건수; PG 미지원']],
    audit: [['audit.events', 'count', 'period_flow', 'legacy audit.read 및 all scope의 tenant-wide audit_event created_at 기간 건수; 회사 건수 아님, PG 미지원']],
  }[source];
}
function rowScope(context, source) {
  if (source === 'approvals') return context.principal.has('approval.decide')
    ? (context.source === 'perp_db' ? 'readable_company_pool' : 'own_or_assigned_readable') : 'own_requester';
  if (source === 'ai') return 'tenant_self';
  if (source === 'audit') return 'tenant_all';
  return context.principal.scope === 'all' ? 'company' : context.principal.scope;
}
export async function analyticsKpis(context, adapter, window, now) {
  const metrics = [];
  for (const source of Object.keys(SOURCES)) {
    let state = sourceState(context, source), values;
    let reason = state === 'unavailable' ? (context.queryFailed?.has(source) ? 'SOURCE_QUERY_FAILED' : 'SOURCE_UNSUPPORTED') : null;
    if (!state) {
      try { values = await adapter.metrics(source, window, now); }
      catch (error) {
        console.error('analytics source query failed', source, error);
        state = 'unavailable'; reason = 'SOURCE_QUERY_FAILED';
      }
    }
    for (const [key, unit, basis, formula] of metricsFor(source)) {
      const result = values?.[key];
      metrics.push({ key, state: state ?? result.state, value: state ? null : result.value,
        unit: unit === 'money' ? (state ? adapter.moneyUnit : result.unit) : unit, basis, formula,
        scope: { ...context.scope, rows: rowScope(context, source), ...(source === 'audit' || source === 'ai' ? { tenant_id: context.principal.tenantId ?? null } : {}) },
        ...(reason ? { reason } : {}), ...(!state && result.reason ? { reason: result.reason } : {}),
        ...(!state && result.not_applicable ? { not_applicable: true } : {}) });
    }
  }
  return { scope: context.scope, period: window.period, generated_at: now.toISOString(), metrics, series: [] };
}
export function counts(entries) {
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, { value, state: value === 0 ? 'empty' : 'ready' }]));
}
export function moneyMetrics(rows, unit, keys = ['finance.revenue', 'finance.expense', 'finance.net']) {
  const units = new Set(rows.map(row => row.unit));
  if (units.size > 1) return Object.fromEntries(keys.map(key => [key, { state: 'unavailable', value: null, unit: 'mixed_currency', reason: 'MIXED_CURRENCY' }]));
  const revenue = rows.reduce((total, row) => total + row.revenue_minor, 0n), expense = rows.reduce((total, row) => total + row.expense_minor, 0n);
  return Object.fromEntries(keys.map((key, index) => [key, { state: rows.length ? 'ready' : 'empty', value: decimal([revenue, expense, revenue - expense][index]), unit: [...units][0] ?? unit }]));
}
export function budgetMetrics(rows, unit) {
  const amount = rows.reduce((sum, row) => sum + row.amount_minor, 0n);
  return { ...counts({ 'budgets.active': rows.length }), 'budgets.amount': { value: decimal(amount), state: rows.length ? 'ready' : 'empty', unit } };
}
export function budgetExecution(budgets, entries, unit) {
  const incompatible = entries.some(row => row.unit !== unit);
  if (incompatible) return Object.fromEntries(['budgets.executed', 'budgets.execution_rate'].map(key => [key, { state: 'unavailable', value: null, unit, reason: 'CURRENCY_MISMATCH' }]));
  const numerator = entries.reduce((sum, row) => sum + row.expense_minor, 0n), denominator = budgets.reduce((sum, row) => sum + row.amount_minor, 0n);
  return { 'budgets.executed': { value: decimal(numerator), state: entries.length ? 'ready' : 'empty', unit },
    'budgets.execution_rate': { value: executionRate(numerator, denominator), state: budgets.length ? 'ready' : 'empty', not_applicable: denominator === 0n } };
}
export async function analyticsReport(context, adapter, key, window) {
  reportKey(key);
  const source = key.startsWith('approvals_') ? 'approvals' : key, state = sourceState(context, source);
  if (state) throw new ApiError(state === 'forbidden' ? 'PERMISSION_DENIED' : state === 'disabled' ? 'FEATURE_DISABLED' : 'SERVICE_UNAVAILABLE', '보고서 원천을 사용할 수 없습니다.', { reportKey: key, state });
  const rows = assertExportSize(await adapter.report(key, window));
  return rows.map(row => Object.fromEntries(REPORT_COLUMNS[key].map(column => [column, row[column]])));
}
