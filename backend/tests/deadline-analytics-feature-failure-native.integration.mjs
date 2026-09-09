import assert from 'node:assert/strict';
import test from 'node:test';
import { analyticsFixture } from './analytics-http-fixture.js';

const filter = { from: '2026-09-01', to: '2026-10-01', tz: 'Asia/Seoul' };
const query = new URLSearchParams(filter);
const common = ['analytics.read', 'menu.analytics'];
const approvalKeys = ['approvals.created', 'approvals.decided'];
const keys = ['members.active', 'tasks.created', 'tasks.open', 'tasks.overdue',
  'finance.revenue', 'finance.expense', 'finance.net', 'finance.journals',
  'budgets.active', 'budgets.amount', 'budgets.executed', 'budgets.execution_rate',
  ...approvalKeys, 'ai.calls', 'audit.events'];
const featureSQL = /SELECT enabled_features FROM org\.company_feature_settings/i;
const approvalSQL = /FROM org\.approval_requests/i;

test('native PG feature-settings SQL failure is SOURCE_QUERY_FAILED, not unsupported or disabled', async () => {
  const f = await analyticsFixture(true), { api, owner } = f;
  const kpis = (actor = owner) => api(actor, '/analytics/kpis?' + query);
  try {
    const denied = await f.limited(common);
    await f.approval(owner, '2026-09-02T00:00:00Z', 'approved', '2026-09-03T00:00:00Z');
    const before = await kpis();
    const job = await api(owner, '/analytics/exports', 'POST', { reportKey: 'approvals_created', filter }, 201);
    await f.native.pool.query('ALTER TABLE org.company_feature_settings RENAME COLUMN enabled_features TO probe_features');
    try {
      const observation = await f.trace(() => kpis()), body = observation.value;
      assert.deepEqual(body.metrics.map(row => row.key), keys);
      assert.deepEqual(body.series, []);
      assert.equal(observation.queries.filter(sql => featureSQL.test(sql)).length, 1, 'no automatic feature-query retry');
      assert.equal(observation.queries.filter(sql => approvalSQL.test(sql)).length, 0);
      for (const key of approvalKeys) {
        const row = body.metrics.find(row => row.key === key);
        assert.equal(row.state, 'unavailable'); assert.equal(row.value, null);
        assert.equal(row.reason, 'SOURCE_QUERY_FAILED');
      }
      for (const row of body.metrics.filter(row => !approvalKeys.includes(row.key))) {
        assert.deepEqual(row, before.metrics.find(metric => metric.key === row.key));
      }
      for (const key of ['ai.calls', 'audit.events']) {
        const row = body.metrics.find(row => row.key === key);
        assert.equal(row.state, 'unavailable'); assert.equal(row.value, null);
        assert.equal(row.reason, 'SOURCE_UNSUPPORTED');
      }
      for (const permissions of [common, [...common, 'menu.approvals'], [...common, 'approval.request']]) {
        await f.grants(denied, permissions);
        const deniedObservation = await f.trace(() => kpis(denied));
        for (const row of deniedObservation.value.metrics.filter(row => approvalKeys.includes(row.key))) {
          assert.equal(row.state, 'forbidden'); assert.equal(row.value, null); assert.equal(row.reason, undefined);
        }
        assert.equal(deniedObservation.queries.filter(sql => featureSQL.test(sql) || approvalSQL.test(sql)).length, 0);
      }
      const blocked = await f.trace(async () => {
        for (const key of ['approvals_created', 'approvals_decided']) {
          const response = await api(owner, `/analytics/reports/${key}?${query}`, 'GET', undefined, 503);
          assert.equal(response.error.code, 'SERVICE_UNAVAILABLE');
          await api(owner, '/analytics/exports', 'POST', { reportKey: key, filter }, 503);
        }
        await api(owner, `/analytics/exports/${job.id}/download`, 'GET', undefined, 503);
      });
      assert.equal(blocked.queries.filter(sql => approvalSQL.test(sql)).length, 0);
    } finally {
      await f.native.pool.query('ALTER TABLE org.company_feature_settings RENAME COLUMN probe_features TO enabled_features');
    }
    const recovered = await kpis();
    for (const row of recovered.metrics.filter(row => approvalKeys.includes(row.key))) {
      assert.equal(row.state, 'ready'); assert.equal(row.value, 1); assert.equal(row.reason, undefined);
    }
    const csv = await api(owner, `/analytics/exports/${job.id}/download`);
    assert.equal(csv.split('\r\n').length, 2);
    await f.feature(false);
    try {
      const disabled = await f.trace(() => kpis());
      for (const row of disabled.value.metrics.filter(row => approvalKeys.includes(row.key))) {
        assert.equal(row.state, 'disabled'); assert.equal(row.value, null); assert.equal(row.reason, undefined);
      }
      assert.equal(disabled.queries.filter(sql => approvalSQL.test(sql)).length, 0);
    } finally { await f.feature(true); }
  } finally { await f.close(); }
});
