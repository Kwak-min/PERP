import assert from 'node:assert/strict';
import test from 'node:test';
import { metricKeys, parseKpis, metricValue, parseReport, parseExportJob, filterSchema, reportKeys } from '../src/screens/analytics/model.ts';
import { workspaceEndpoint } from '../src/services/workspace.ts';

const scope = { source: 'legacy', org_id: 'company-a' }, period = { from: '2026-09-01', to: '2026-10-01', tz: 'Asia/Seoul' };
const money = new Set(['finance.revenue', 'finance.expense', 'finance.net', 'budgets.amount', 'budgets.executed']);
function fixture() {
  return { scope, period, generated_at: '2026-09-08T00:00:00.000Z', series: [], metrics: metricKeys.map(key => ({
    key, state: 'ready', value: money.has(key) ? '184467440737095516.14' : key === 'budgets.execution_rate' ? '33.3333' : 1,
    unit: money.has(key) ? 'USD' : key === 'budgets.execution_rate' ? 'percent' : 'count', basis: 'period_flow', formula: '', scope: { ...scope, rows: 'company' },
  })) };
}
test('exact 16 metric contract preserves every value, scope, basis and state without nested DTO fallback', () => {
  const input = fixture(); assert.deepEqual(parseKpis(input, scope), input);
  for (const state of ['ready', 'empty', 'forbidden', 'disabled', 'unavailable']) {
    const body = fixture();
    for (const metric of body.metrics) {
      metric.state = state;
      if (['forbidden', 'disabled', 'unavailable'].includes(state)) metric.value = null;
      else if (state === 'empty') metric.value = money.has(metric.key) ? '0.00' : metric.key === 'budgets.execution_rate' ? null : 0;
      if (metric.key === 'budgets.execution_rate' && state === 'empty') metric.not_applicable = true;
      if (state === 'unavailable') metric.reason = 'SOURCE_QUERY_FAILED';
    }
    const parsed = parseKpis(body, scope); assert.deepEqual(parsed, body);
    for (const metric of parsed.metrics) {
      const displayed = metricValue(metric);
      if (metric.value !== null) assert.equal(displayed, String(metric.value));
      else { assert.notEqual(displayed, '0'); assert.notEqual(displayed, '0%'); assert.notEqual(displayed, '0.00'); }
    }
  }
  for (const reason of ['SOURCE_UNSUPPORTED', 'SOURCE_QUERY_FAILED', 'MIXED_CURRENCY', 'CURRENCY_MISMATCH']) {
    const body = fixture(); Object.assign(body.metrics[4], { state: 'unavailable', value: null, reason });
    assert.equal(parseKpis(body, scope).metrics[4].reason, reason);
  }
  for (const invalid of [{}, { items: fixture() }, { ...fixture(), metrics: [] }, { ...fixture(), metrics: fixture().metrics.slice(0, 15) }]) assert.throws(() => parseKpis(invalid, scope));
  const duplicate = fixture(); duplicate.metrics[15] = duplicate.metrics[0]; assert.throws(() => parseKpis(duplicate, scope));
  const foreign = fixture(); foreign.metrics[0].scope.org_id = 'other'; assert.throws(() => parseKpis(foreign, scope));
  assert.throws(() => parseKpis(fixture(), { ...scope, source: 'perp_db' }));
});
test('monetary and ratio strings cannot be silently coerced or defaulted', () => {
  for (const key of [...money, 'budgets.execution_rate']) {
    for (const value of [42, NaN, Infinity, '1e6', '', '12,000.00', null]) {
      const body = fixture(), metric = body.metrics.find(row => row.key === key); metric.value = value;
      assert.throws(() => parseKpis(body, scope), `${key}: ${value}`);
    }
  }
  for (const value of ['184467440737095516.14', '-99999999999999999999.99', '0.00']) {
    const body = fixture(); body.metrics[4].value = value; body.metrics[4].unit = 'ledger_decimal';
    const parsed = parseKpis(body, scope); assert.equal(metricValue(parsed.metrics[4]), value); assert.equal(parsed.metrics[4].unit, 'ledger_decimal');
  }
  for (const state of ['ready', 'empty']) {
    const body = fixture(); Object.assign(body.metrics[11], { state, value: null, not_applicable: true });
    assert.deepEqual(parseKpis(body, scope).metrics[11], body.metrics[11]);
  }
  const denied = fixture(); denied.metrics[0].state = 'forbidden'; assert.throws(() => parseKpis(denied, scope));
});
test('validated paired real dates and timezone; no unsupported fabricated series', () => {
  assert.deepEqual(filterSchema.parse(period), period);
  assert.deepEqual(filterSchema.parse({ tz: 'UTC' }), { tz: 'UTC' });
  for (const input of [{ ...period, from: '2026-02-30' }, { ...period, from: '0000-01-01' }, { ...period, from: period.to }, { ...period, to: period.from }, { from: period.from, tz: 'UTC' }, { ...period, tz: 'invalid' }, { ...period, comparison: true }]) assert.equal(filterSchema.safeParse(input).success, false);
  assert.throws(() => parseKpis({ ...fixture(), series: [{ invented: 1 }] }, scope));
});
test('report and export allowlist, exact rows, scope and confirmed filter identity', () => {
  const report = { scope, period, reportKey: 'transactions', generated_at: '2026-09-08T00:00:00.000Z', row_count: 1, items: [{ id: 'r1', date: period.from, revenue: '184467440737095516.14', expense: '0.00', unit: 'USD' }] };
  assert.deepEqual(parseReport(report, scope, 'transactions', period), report);
  assert.throws(() => parseReport({ ...report, row_count: 0 }, scope, 'transactions', period));
  assert.throws(() => parseReport(report, scope, 'tasks', period));
  assert.throws(() => parseReport(report, scope, 'transactions', { ...period, tz: 'UTC' }));
  assert.throws(() => parseReport({ ...report, items: [{ ...report.items[0], revenue: 123 }] }, scope, 'transactions', period));
  for (const key of reportKeys) {
    const job = { id: 'job-1', reportKey: key, filter: period, status: 'ready', row_count: 1, expires_at: '2026-09-15T00:00:00.000Z', requery_on_download: true, download_url: '/analytics/exports/job-1/download' };
    assert.deepEqual(parseExportJob(job, scope, key, period), job);
    for (const changed of [{ reportKey: '__proto__' }, { filter: { ...period, to: '2026-11-01' } }, { requery_on_download: false }, { download_url: 'https://example.invalid/file' }, { download_url: '/pg/analytics/exports/job-1/download' }, { row_count: 100001 }]) assert.throws(() => parseExportJob({ ...job, ...changed }, scope, key, period));
  }
});
test('sanctioned routing selects only the chosen source for every analytics endpoint', () => {
  for (const suffix of ['/kpis?from=2026-09-01&to=2026-10-01&tz=UTC', '/reports/transactions', '/exports', '/exports/job-1/download']) {
    assert.equal(workspaceEndpoint('/pg/analytics' + suffix, 'company-a'), '/analytics' + suffix);
    assert.equal(workspaceEndpoint('/pg/analytics' + suffix, 'pg:42'), '/pg/analytics' + suffix);
  }
});
