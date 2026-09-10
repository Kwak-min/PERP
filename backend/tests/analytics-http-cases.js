import assert from 'node:assert/strict';
import { analyticsPeriod, decimalMinor, decimal } from '../src/services/analytics-contract.service.js';

const filter = { from: '2026-09-01', to: '2026-10-01', tz: 'Asia/Seoul' };
const query = new URLSearchParams(filter).toString();
const common = ['analytics.read', 'menu.analytics'];
const metric = (body, key) => { const row = body.metrics.find(item => item.key === key); assert.ok(row, key); return row; };
const domainSQL = /FROM\s+(?:task\b|transaction_record\b|budget\b|approval\s+a\b|project\.tasks\b|accounting\.(?:journal_entries|budgets)\b|org\.approval_requests\b)/i;
export async function analyticsCases(t, f) {
  const { api, owner, pgMode } = f;
  const kpis = async (actor = owner, q = query) => {
    const body = await api(actor, '/analytics/kpis?' + q);
    assert.equal(body.series.length, 1, 'authorized period must supply typed finance series');
    const series = body.series[0], finance = metric(body, 'finance.revenue');
    for (const key of ['state', 'unit', 'scope', 'reason']) assert.deepEqual(series[key], finance[key]);
    assert.equal(series.basis, 'period_flow'); assert.equal(series.date_basis, 'posted_entry_date');
    assert.equal(series.currency, ['ledger_decimal', 'mixed_currency'].includes(series.unit) ? null : series.unit);
    assert.ok(series.points.length <= 366);
    if (['ready', 'empty'].includes(series.state)) {
      assert.equal(series.points[0].from, body.period.from); assert.equal(series.points.at(-1).to, body.period.to);
      for (const key of ['revenue', 'expense', 'net']) assert.equal(decimal(series.points.reduce((sum, point) => sum + decimalMinor(point[key]), 0n)), metric(body, `finance.${key}`).value);
      for (const [index, point] of series.points.entries()) {
        assert.equal(point.net, decimal(decimalMinor(point.revenue) - decimalMinor(point.expense)));
        assert.equal(point.from, index === 0 ? body.period.from : series.points[index - 1].to);
        assert.ok(point.from < point.to);
        if (point.state === 'empty') for (const key of ['revenue', 'expense', 'net']) assert.equal(point[key], '0.00');
      }
    } else assert.deepEqual(series.points, [], 'no values or synthetic zeros for denied/disabled/failed/mixed source');
    return body;
  };
  const report = (key, actor = owner, q = query) => api(actor, `/analytics/reports/${key}?${q}`);
  await t.test('actual API returns nonempty authorized daily finance series', async () => {
    await f.entry('2024-02-29', '12.34', 'income');
    const body = await kpis(owner, 'from=2024-02-28&to=2024-03-01&tz=Asia/Seoul');
    assert.equal(body.series.length, 1, 'authorized nonempty period must supply finance series');
    assert.deepEqual(body.series[0].points, [
      { from: '2024-02-28', to: '2024-02-29', state: 'empty', revenue: '0.00', expense: '0.00', net: '0.00' },
      { from: '2024-02-29', to: '2024-03-01', state: 'ready', revenue: '12.34', expense: '0.00', net: '12.34' },
    ]);
  });
  await t.test('real dates, paired endpoints and IANA timezone are validated', async () => {
    for (const q of ['from=2026-02-30&to=2026-03-01', 'from=2026-09-01', 'from=2026-10-01&to=2026-09-01', 'from=2026-09-01&to=2026-09-01', 'from=0000-01-01&to=2026-10-01', 'from=2026-09-01&to=2026-10-01&tz=bad', 'from=2026-09-01&from=2026-08-01&to=2026-10-01', 'from=2026-09-01&to=2026-10-01&limit=5']) {
      await api(owner, '/analytics/kpis?' + q, 'GET', undefined, 400);
    }
    const defaultWindow = analyticsPeriod({}, new Date('2026-12-31T15:00:00Z'));
    assert.deepEqual(defaultWindow.period, { from: '2027-01-01', to: '2027-02-01', tz: 'Asia/Seoul' });
    assert.equal(analyticsPeriod({ from: '2026-03-08', to: '2026-03-09', tz: 'America/New_York' }).start, '2026-03-08T05:00:00.000Z');
    assert.equal(analyticsPeriod({ from: '2026-03-08', to: '2026-03-09', tz: 'America/New_York' }).end, '2026-03-09T04:00:00.000Z');
    await api(owner, '/analytics/kpis?from=2011-12-30&to=2012-01-01&tz=Pacific/Apia', 'GET', undefined, 400);
    const defaultBody = await api(owner, '/analytics/kpis');
    assert.equal(defaultBody.period.tz, 'Asia/Seoul');
  });
  await t.test('typed empty is not unavailable and zero denominator is null', async () => {
    const body = await kpis();
    assert.deepEqual(body.period, filter);
    assert.deepEqual(body.scope, { source: pgMode ? 'perp_db' : 'legacy', org_id: owner.orgId });
    assert.equal(metric(body, 'tasks.created').state, 'empty'); assert.equal(metric(body, 'tasks.created').value, 0);
    assert.equal(metric(body, 'members.active').value, 1);
    assert.equal(metric(body, 'budgets.execution_rate').value, null); assert.equal(metric(body, 'budgets.execution_rate').not_applicable, true);
    assert.equal(metric(body, 'finance.revenue').value, '0.00');
    const historicalEmpty = await kpis(owner, 'from=1990-01-01&to=1990-02-01');
    for (const key of ['ai.calls', 'audit.events']) assert.equal(metric(historicalEmpty, key).state, pgMode ? 'unavailable' : 'empty');
    assert.equal(body.series[0].state, 'empty');
    assert.equal(body.series[0].points.length, 30);
    assert.ok(body.series[0].points.every(point => point.state === 'empty'));
    if (pgMode) {
      // native v8은 새0원 예산을 금지한다. 실제 분모0은 위 빈 모집단으로 검증한다.
      await assert.rejects(f.budget('0.00'), { code: '23514', constraint: 'daily_positive_amount' });
    } else {
      const zero = await f.budget('0.00');
      const actualZero = metric(await kpis(), 'budgets.execution_rate');
      assert.equal(actualZero.state, 'ready'); assert.equal(actualZero.value, null); assert.equal(actualZero.not_applicable, true);
      f.database.prepare("UPDATE budget SET status='closed' WHERE id=?").run(zero);
    }
  });
  const basic = await f.limited(common);
  await t.test('analytics action/menu/module gates precede every source query', async () => {
    for (const permissions of [[], ['menu.analytics'], ['analytics.read']]) {
      await f.grants(basic, permissions);
      const { queries } = await f.trace(() => api(basic, '/analytics/kpis?' + query, 'GET', undefined, 403));
      assert.equal(queries.filter(sql => domainSQL.test(sql)).length, 0);
    }
    await f.grants(basic, common);
    await f.moduleEnabled('analytics', false);
    try {
      const { queries } = await f.trace(() => api(owner, '/analytics/kpis?' + query, 'GET', undefined, 403));
      assert.equal(queries.filter(sql => domainSQL.test(sql)).length, 0);
    } finally { await f.moduleEnabled('analytics', true); }
  });
  await t.test('source action denies are null, not queried, and not values behind analytics permission', async () => {
    const { value: body, queries } = await f.trace(() => kpis(basic));
    for (const row of body.metrics) { assert.equal(row.state, 'forbidden', row.key); assert.equal(row.value, null, row.key); }
    assert.equal(queries.filter(sql => domainSQL.test(sql)).length, 0);
    assert.equal(queries.filter(sql => /SELECT m\.(?:id|user_id::text AS id)/.test(sql)).length, 0);
    await api(basic, '/analytics/reports/transactions?' + query, 'GET', undefined, 403);
    await api(basic, '/analytics/exports', 'POST', { reportKey: 'transactions', filter }, 403);
  });
  await t.test('finance series requires both source action and menu even behind analytics', async () => {
    for (const permission of ['transaction.read', 'menu.finance']) {
      await f.grants(basic, [...common, permission]);
      const { value, queries } = await f.trace(() => kpis(basic));
      assert.equal(value.series[0].state, 'forbidden');
      assert.ok(!queries.some(sql => /FROM (?:transaction_record\b|accounting\.journal_entries)/i.test(sql)));
    }
    await f.grants(basic, common);
  });
  const taskTimes = ['2026-08-31T14:59:59.999Z', '2026-08-31T15:00:00.000Z', '2026-09-30T14:59:59.999Z', '2026-09-30T15:00:00.000Z'];
  const taskIds = [];
  for (const instant of taskTimes) taskIds.push(await f.task(instant));
  await f.task('2020-01-01T00:00:00Z', 'todo', '2020-01-01');
  await f.task('2020-01-01T00:00:00Z', 'in_progress', '2999-01-01');
  await f.task('2020-01-01T00:00:00Z', 'blocked', '2020-01-01');
  await f.task('2020-01-01T00:00:00Z', 'cancelled', '2020-01-01');
  await f.task('2020-01-01T00:00:00Z', 'done', '2020-01-01');
  await t.test('timestamp edges use selected tz; current open/overdue excludes cancelled and done', async () => {
    const body = await kpis();
    assert.equal(metric(body, 'tasks.created').value, 2);
    assert.deepEqual((await report('tasks')).items.map(row => row.id).sort(), taskIds.slice(1, 3).sort());
    assert.deepEqual((await report('tasks', owner, new URLSearchParams({ ...filter, tz: 'UTC' }))).items.map(row => row.id).sort(), taskIds.slice(2).sort());
    for (const q of [query, 'from=1990-01-01&to=1990-02-01']) {
      const snapshot = await kpis(owner, q);
      assert.equal(metric(snapshot, 'tasks.open').value, 3);
      assert.equal(metric(snapshot, 'tasks.overdue').value, 2);
      assert.equal(metric(snapshot, 'tasks.open').basis, 'current_snapshot');
    }
    await f.task('2026-03-08T04:59:59.999Z');
    const included = [await f.task('2026-03-08T05:00:00Z'), await f.task('2026-03-09T03:59:59.999Z')];
    await f.task('2026-03-09T04:00:00Z');
    const dst = await report('tasks', owner, 'from=2026-03-08&to=2026-03-09&tz=America/New_York');
    assert.deepEqual(dst.items.map(row => row.id).sort(), included.sort());
  });
  const budget = await f.budget(), closed = await f.budget('10000.00', false);
  await f.entry('2026-08-31', '700.00');
  await f.entry('2026-09-01', '10.01', 'expense', true, budget);
  await f.entry('2026-09-30', '19.99', 'expense', true, budget);
  await f.entry('2026-10-01', '700.00', 'expense', true, budget);
  await f.entry('2026-09-01', '700.00', 'expense', false, budget);
  await f.entry('2026-09-01', '20.00', 'expense', true, closed);
  await f.entry('2026-09-01', '30.00', 'income');
  const large = pgMode ? '9999999999999999.99' : '90071992547409.91';
  await f.entry('2026-09-02', large, 'income'); await f.entry('2026-09-02', large, 'income');
  await t.test('DATE boundaries, exact beyond-safe totals, account direction and distinct journals', async () => {
    for (const tz of ['Asia/Seoul', 'UTC', 'America/New_York']) {
      const body = await kpis(owner, new URLSearchParams({ ...filter, tz }));
      assert.equal(metric(body, 'finance.expense').value, '50.00');
      assert.equal(metric(body, 'finance.revenue').value, pgMode ? '20000000000000029.98' : '180143985094849.82');
      assert.equal(metric(body, 'finance.net').value, pgMode ? '19999999999999979.98' : '180143985094799.82');
      assert.equal(metric(body, 'finance.journals').value, 6);
      assert.equal(metric(body, 'finance.revenue').unit, pgMode ? 'ledger_decimal' : 'KRW');
    }
    const rows = (await report('transactions')).items;
    assert.equal(rows.length, 6); assert.ok(rows.every(row => typeof row.revenue === 'string' && typeof row.expense === 'string'));
    const foreign = await kpis(f.foreign); assert.equal(metric(foreign, 'finance.journals').value, 0);
    if (pgMode) assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM membership').get().n, 0, 'PG analytics does not synthesize legacy membership');
  });
  await t.test('series uses the same single authorized source query and keeps each daily exact amount', async () => {
    await f.grants(basic, [...common, 'transaction.read', 'menu.finance']);
    const { value: body, queries } = await f.trace(() => kpis(basic));
    assert.equal(queries.filter(sql => /FROM (?:transaction_record\b|accounting\.journal_entries)/i.test(sql)).length, 1);
    const points = body.series[0].points;
    assert.equal(points[0].revenue, '30.00'); assert.equal(points[0].expense, '30.01'); assert.equal(points[0].net, '-0.01');
    assert.equal(points[1].revenue, pgMode ? '19999999999999999.98' : '180143985094819.82');
    assert.equal(points[2].state, 'empty'); assert.equal(points[29].expense, '19.99');
    await f.grants(basic, common);
  });
  await t.test('bounded calendar buckets preserve the full range, leap days and DST DATE semantics', async () => {
    for (const [from, to, before] of [['2025-03-09', '2025-03-10', '2025-03-08'], ['2025-11-02', '2025-11-03', '2025-11-01']]) {
      await f.entry(before, '900.00'); await f.entry(from, '5.01', 'income'); await f.entry(from, '5.01'); await f.entry(to, '900.00');
      for (const tz of ['America/New_York', 'Asia/Seoul', 'UTC']) {
        const body = await kpis(owner, new URLSearchParams({ from, to, tz }));
        assert.deepEqual(body.series[0].points, [{ from, to, state: 'ready', revenue: '5.01', expense: '5.01', net: '0.00' }]);
      }
    }
    for (const [from, to, expectedDays, expectedCount] of [['2024-01-01', '2025-01-01', 1, 366], ['2024-01-01', '2025-01-02', 2, 184], ['0001-01-01', '9999-12-31', 9979, 366]]) {
      const body = await kpis(owner, new URLSearchParams({ from, to, tz: 'UTC' })), series = body.series[0];
      assert.equal(series.bucket_days, expectedDays); assert.equal(series.points.length, expectedCount);
      assert.equal(series.granularity, expectedDays === 1 ? 'day' : 'calendar_day_group');
    }
  });
  await t.test('budget execution uses active linked ledger, not cache, and requires BOTH source actions', async () => {
    const body = await kpis();
    assert.equal(metric(body, 'budgets.active').value, 1); assert.equal(metric(body, 'budgets.amount').value, '100.00');
    assert.equal(metric(body, 'budgets.executed').value, '30.00'); assert.equal(metric(body, 'budgets.execution_rate').value, '30.0000');
    for (const permission of ['transaction.read', 'budget.read']) {
      await f.grants(basic, [...common, 'menu.finance', permission]);
      const { value: limited, queries } = await f.trace(() => kpis(basic));
      assert.equal(metric(limited, 'budgets.executed').state, 'forbidden');
      assert.equal(metric(limited, 'budgets.execution_rate').value, null);
      if (permission === 'transaction.read') assert.ok(!queries.some(sql => /FROM (?:budget\b|accounting\.budgets)/i.test(sql)));
      else assert.ok(!queries.some(sql => /FROM (?:transaction_record\b|accounting\.journal_entries)/i.test(sql)));
    }
  });
  const requesterPermissions = [...common, 'menu.approvals', 'approval.request'];
  const deciderPermissions = [...common, 'menu.approvals', 'approval.decide'];
  const requester = await f.limited(requesterPermissions), peer = await f.limited(requesterPermissions), decider = await f.limited(deciderPermissions);
  await t.test('current active members require both active membership and active account even for historical filters', async () => {
    const before = metric(await kpis(), 'members.active').value;
    assert.equal(before, 5);
    if (pgMode) await f.native.pool.query("UPDATE auth.users SET account_status='suspended' WHERE id=$1", [peer.userId]);
    else f.database.prepare("UPDATE app_user SET auth_status='suspended' WHERE id=?").run(peer.userId);
    try { assert.equal(metric(await kpis(owner, 'from=1990-01-01&to=1990-02-01'), 'members.active').value, before - 1); }
    finally {
      if (pgMode) await f.native.pool.query("UPDATE auth.users SET account_status='active' WHERE id=$1", [peer.userId]);
      else f.database.prepare("UPDATE app_user SET auth_status='active' WHERE id=?").run(peer.userId);
    }
    if (pgMode) await f.native.pool.query("UPDATE org.company_memberships SET status='suspended' WHERE company_id=$1 AND user_id=$2", [f.cid, peer.userId]);
    else f.database.prepare("UPDATE membership SET status='suspended' WHERE org_id=? AND user_id=?").run(owner.orgId, peer.userId);
    try { assert.equal(metric(await kpis(), 'members.active').value, before - 1); }
    finally {
      if (pgMode) await f.native.pool.query("UPDATE org.company_memberships SET status='active' WHERE company_id=$1 AND user_id=$2", [f.cid, peer.userId]);
      else f.database.prepare("UPDATE membership SET status='active' WHERE org_id=? AND user_id=?").run(owner.orgId, peer.userId);
    }
  });
  const ownDraft = await f.approval(requester, '2026-09-01T00:00:00Z');
  const ownPending = await f.approval(requester, '2026-09-01T00:00:00Z', 'pending', null, owner);
  const peerDraft = await f.approval(peer, '2026-09-01T00:00:00Z');
  const readable = [];
  readable.push(await f.approval(peer, '2026-09-01T00:00:00Z', 'pending', null, decider));
  const beforeCreated = await f.approval(peer, '2026-08-01T00:00:00Z', 'approved', taskTimes[1], decider);
  readable.push(await f.approval(peer, '2026-09-01T00:00:00Z', 'rejected', taskTimes[3], decider));
  const decidedInside = await f.approval(peer, '2026-09-01T00:00:00Z', 'approved', taskTimes[2], decider); readable.push(decidedInside);
  const unassigned = await f.approval(peer, '2026-09-01T00:00:00Z', 'pending', null, owner);
  await t.test('approval requester own rows and decider pool/assigned rows obey canonical private-draft policy', async () => {
    const own = await kpis(requester); assert.equal(metric(own, 'approvals.created').value, 2); assert.equal(metric(own, 'approvals.decided').value, 0);
    assert.equal(metric(own, 'approvals.created').scope.rows, 'own_requester');
    const pool = await report('approvals_created', decider);
    assert.deepEqual(pool.items.map(row => row.id).sort(), [...readable, ...(pgMode ? [ownPending, unassigned] : [])].sort());
    const decisions = await report('approvals_decided', decider);
    assert.deepEqual(decisions.items.map(row => row.id).sort(), [beforeCreated, decidedInside].sort());
    const detail = id => pgMode ? `/approvals/${id}` : `/approvals/requests/${id}`;
    for (const id of [ownDraft, peerDraft]) await api(decider, detail(id), 'GET', undefined, 404);
    for (const row of pool.items) await api(decider, detail(row.id));
    await f.grants(requester, deciderPermissions);
    const transition = (await report('approvals_created', requester)).items;
    assert.ok(!transition.some(row => row.id === ownDraft));
    assert.equal(transition.some(row => row.id === ownPending), pgMode);
    await api(requester, detail(ownDraft), 'GET', undefined, 404);
    await f.grants(requester, requesterPermissions);
  });
  await t.test('feature and module disabled are not empty and no disabled source query runs', async () => {
    await f.feature(false); await f.moduleEnabled('finance', false); await f.moduleEnabled('tasks', false);
    try {
      const { value: body, queries } = await f.trace(() => kpis());
      for (const key of ['approvals.created', 'tasks.created', 'finance.revenue', 'budgets.executed']) { assert.equal(metric(body, key).state, 'disabled'); assert.equal(metric(body, key).value, null); }
      assert.equal(queries.filter(sql => domainSQL.test(sql)).length, 0);
      await api(owner, '/analytics/exports', 'POST', { reportKey: 'approvals_created', filter }, 403);
    } finally { await f.feature(true); await f.moduleEnabled('finance', true); await f.moduleEnabled('tasks', true); }
  });
  await t.test('real source schema failure affects only its metrics, never becomes zero', async () => {
    if (pgMode) await f.native.pool.query('ALTER TABLE project.tasks RENAME TO tasks_analytics_unavailable');
    else f.database.exec('ALTER TABLE task RENAME TO task_analytics_unavailable');
    try {
      const body = await kpis(); assert.equal(metric(body, 'tasks.created').state, 'unavailable');
      assert.equal(metric(body, 'tasks.created').value, null); assert.equal(metric(body, 'tasks.created').reason, 'SOURCE_QUERY_FAILED');
      assert.equal(metric(body, 'finance.journals').value, 6);
    } finally {
      if (pgMode) await f.native.pool.query('ALTER TABLE project.tasks_analytics_unavailable RENAME TO tasks');
      else f.database.exec('ALTER TABLE task_analytics_unavailable RENAME TO task');
    }
  });
  await t.test('real finance source failure returns unavailable series without zeros or partial values', async () => {
    if (pgMode) await f.native.pool.query('ALTER TABLE accounting.journal_entries RENAME TO series_unavailable_entries');
    else f.database.exec('ALTER TABLE transaction_record RENAME TO series_unavailable_entries');
    try {
      const body = await kpis();
      assert.equal(body.series[0].state, 'unavailable'); assert.equal(body.series[0].reason, 'SOURCE_QUERY_FAILED');
      assert.equal(metric(body, 'tasks.created').value, 2);
    } finally {
      if (pgMode) await f.native.pool.query('ALTER TABLE accounting.series_unavailable_entries RENAME TO journal_entries');
      else f.database.exec('ALTER TABLE series_unavailable_entries RENAME TO transaction_record');
    }
  });
  await t.test('export allowlist, validated filter, fresh download data and revocation', async () => {
    for (const reportKey of ['__proto__', 'constructor', 'monthly', 'audit', 'tasks; DROP TABLE task']) await api(owner, '/analytics/exports', 'POST', { reportKey, filter }, 400);
    await api(owner, '/analytics/exports', 'POST', { reportKey: 'tasks', filter: { from: '2026-02-30', to: '2026-03-01' } }, 400);
    await api(owner, '/analytics/reports/monthly?' + query, 'GET', undefined, 400);
    await f.grants(basic, [...common, 'task.read', 'menu.projects']);
    const job = await api(basic, '/analytics/exports', 'POST', { reportKey: 'tasks', filter }, 201);
    assert.equal(job.row_count, 2); assert.deepEqual(job.filter, filter); assert.equal(job.requery_on_download, true);
    const download = `/analytics/exports/${job.id}/download`;
    const initial = await api(basic, download); assert.equal(initial.split('\r\n').length, 3);
    const late = await f.task('2026-09-05T00:00:00Z');
    const fresh = await api(basic, download); assert.equal(fresh.split('\r\n').length, 4); assert.ok(fresh.includes(late));
    await api(owner, download, 'GET', undefined, 404); await api(f.foreign, download, 'GET', undefined, 404);
    for (const grants of [[...common, 'menu.projects'], [...common, 'task.read'], ['task.read', 'menu.projects', 'menu.analytics'], ['task.read', 'menu.projects', 'analytics.read']]) {
      await f.grants(basic, grants);
      const { queries } = await f.trace(() => api(basic, download, 'GET', undefined, 403));
      assert.equal(queries.filter(sql => domainSQL.test(sql)).length, 0);
    }
    await f.grants(basic, [...common, 'task.read', 'menu.projects']);
    await f.moduleEnabled('tasks', false);
    try { await api(basic, download, 'GET', undefined, 403); } finally { await f.moduleEnabled('tasks', true); }
    const approvalJob = await api(requester, '/analytics/exports', 'POST', { reportKey: 'approvals_created', filter }, 201);
    assert.equal(approvalJob.row_count, 2);
    await f.grants(requester, [...common, 'menu.approvals']);
    await api(requester, `/analytics/exports/${approvalJob.id}/download`, 'GET', undefined, 403);
    await f.grants(requester, requesterPermissions);
    await f.feature(false);
    try { await api(requester, `/analytics/exports/${approvalJob.id}/download`, 'GET', undefined, 403); }
    finally { await f.feature(true); }
    const title = '=1+2,"quoted"';
    if (pgMode) await f.native.pool.query('UPDATE project.tasks SET title=$2 WHERE id=$1', [late, title]);
    else f.database.prepare('UPDATE task SET title=? WHERE id=?').run(title, late);
    const escaped = await api(basic, download); assert.ok(escaped.includes('"\'=1+2,""quoted"""'));
    const compatibility = await api(owner, '/analytics/exports', 'POST', { kind: 'tasks', params: filter }, 201);
    assert.deepEqual(compatibility.filter, filter);
    await api(owner, '/analytics/exports', 'POST', { kind: 'tasks', params: { where: '1=1' } }, 400);
  });
  if (!pgMode) {
    await t.test('SQLite final approval decision orders actual instants, not timestamp text', async () => {
      const id = await f.approval(owner, '2026-08-01T00:00:00Z', 'approved', '2026-10-01T00:00:00+10:00');
      f.record('approval_step', { approval_id: id, ordinal: 1, approver_id: owner.userId, status: 'approved', decided_at: '2026-09-30T15:00:00Z' });
      assert.ok(!(await report('approvals_decided')).items.some(row => row.id === id));
    });
    await t.test('SQLite signed 64-bit source amounts and aggregates never traverse Number or SUM overflow', async () => {
      const insert = f.database.prepare("INSERT INTO transaction_record(id,tenant_id,org_id,created_at,updated_at,kind,amount_minor,currency,occurred_on,status) VALUES(?,?,?,'2028-01-01','2028-01-01','income',?,'KRW','2028-01-01','confirmed')");
      for (const id of ['exact-bigint-1','exact-bigint-2']) insert.run(id, f.tenant, owner.orgId, 9223372036854775807n);
      const body = await kpis(owner, 'from=2028-01-01&to=2028-02-01');
      assert.equal(metric(body, 'finance.revenue').value, '184467440737095516.14');
      assert.equal(metric(body, 'finance.journals').value, 2);
    });
    await t.test('SQLite department and project role scopes are applied before aggregation/export', async () => {
      const department = f.record('department', { name: 'Analytics department' });
      const actor = await f.limited([...common, 'task.read', 'member.read', 'menu.projects', 'menu.members'], 'department');
      f.database.prepare('UPDATE membership SET department_id=? WHERE org_id=? AND user_id=?').run(department.id, owner.orgId, actor.userId);
      const ownTask = await f.task('2026-09-03T00:00:00Z', 'done', null, actor);
      assert.deepEqual((await report('tasks', actor)).items.map(row => row.id), [ownTask]);
      assert.equal(metric(await kpis(actor), 'members.active').value, 1);
      const projectActor = await f.limited([...common, 'task.read', 'menu.projects'], 'project');
      const project = f.record('project', { name: 'Only assigned project' });
      f.record('project_member', { project_id: project.id, user_id: projectActor.userId });
      const assigned = f.record('task', { project_id: project.id, title: 'Allowed project task', created_at: '2026-09-03T00:00:00Z' });
      assert.deepEqual((await report('tasks', projectActor)).items.map(row => row.id), [assigned.id]);
    });
    await t.test('SQLite scoped roles cannot aggregate other assignees or currency-convert history', async () => {
      const self = await f.limited([...common, 'task.read', 'member.read', 'menu.projects', 'menu.members'], 'self');
      await f.task('2026-09-03T00:00:00Z', 'done', null, self);
      const body = await kpis(self); assert.equal(metric(body, 'tasks.created').value, 1); assert.equal(metric(body, 'members.active').value, 1);
      await f.entry('2026-09-04', '10.00', 'income', true, null, 'USD');
      const mixed = await kpis(); assert.equal(metric(mixed, 'finance.revenue').state, 'unavailable');
      assert.equal(metric(mixed, 'finance.revenue').reason, 'MIXED_CURRENCY'); assert.equal(metric(mixed, 'finance.journals').value, 7);
      assert.ok((await report('transactions')).items.some(row => row.unit === 'USD' && row.revenue === '10.00'));
      const dollars = (await kpis(owner, 'from=2026-09-04&to=2026-09-05&tz=UTC')).series[0];
      assert.equal(dollars.unit, 'USD'); assert.equal(dollars.currency, 'USD'); assert.equal(dollars.state, 'ready');
      assert.deepEqual(dollars.points, [{ from: '2026-09-04', to: '2026-09-05', state: 'ready', revenue: '10.00', expense: '0.00', net: '10.00' }]);
    });
  }
  if (!pgMode) await t.test('finance day buckets enforce self/department/project, company and deleted/draft predicates', async () => {
    const periodQuery = 'from=2027-05-01&to=2027-05-03&tz=UTC';
    for (const scope of ['self', 'department', 'project']) {
      const actor = await f.limited([...common, 'transaction.read', 'menu.finance'], scope);
      const department = f.record('department', { name: 'Series scope' }).id;
      const project = f.record('project', { name: 'Series scope' }).id;
      f.database.prepare('UPDATE membership SET department_id=? WHERE org_id=? AND user_id=?').run(department, owner.orgId, actor.userId);
      f.record('project_member', { project_id: project, user_id: actor.userId });
      const base = { occurred_on: '2027-05-01', created_by: actor.userId, department_id: department, project_id: project, status: 'confirmed', currency: 'KRW' };
      const ids = [f.record('transaction_record', { ...base, kind: 'income', amount_minor: 1000 }).id, f.record('transaction_record', { ...base, kind: 'expense', amount_minor: 300 }).id];
      for (const extra of [{ status: 'draft' }, { deleted_at: '2027-05-02' }]) f.record('transaction_record', { ...base, kind: 'income', amount_minor: 99999, ...extra });
      for (const extra of [{ org_id: f.foreign.orgId }, { tenant_id: 'foreign-tenant' }]) {
        // 새 회사 불일치 프로젝트 연결은 DB 제약으로 거부한다. 미연결 외부 행도 집계에서 제외한다.
        assert.throws(() => f.record('transaction_record', { ...base, kind: 'income', amount_minor: 99999, ...extra }), { code: 'ERR_SQLITE_ERROR', errcode: 1811 });
        f.record('transaction_record', { ...base, project_id: null, kind: 'income', amount_minor: 99999, ...extra });
      }
      f.record('transaction_record', { occurred_on: '2027-05-01', kind: 'income', amount_minor: 99999, status: 'confirmed', currency: 'USD' });
      const body = await kpis(actor, periodQuery);
      assert.equal(body.series[0].scope.rows, scope); assert.equal(body.series[0].unit, 'KRW');
      assert.deepEqual(body.series[0].points[0], { from: '2027-05-01', to: '2027-05-02', state: 'ready', revenue: '10.00', expense: '3.00', net: '7.00' });
      assert.equal(body.series[0].points[1].state, 'empty');
      assert.deepEqual((await report('transactions', actor, periodQuery)).items.map(row => row.id).sort(), ids.sort());
    }
  });
  await t.test('100000 rows export in full; creation and fresh download reject 100001 explicitly', async () => {
    const largeFilter = { from: '2030-01-01', to: '2030-02-01', tz: 'Asia/Seoul' };
    await f.bulkTasks(100000);
    const job = await api(owner, '/analytics/exports', 'POST', { reportKey: 'tasks', filter: largeFilter }, 201);
    assert.equal(job.row_count, 100000);
    const text = await api(owner, `/analytics/exports/${job.id}/download`); assert.equal(text.split('\r\n').length, 100001);
    await f.bulkTasks(1);
    const error = await api(owner, `/analytics/exports/${job.id}/download`, 'GET', undefined, 413);
    assert.equal(error.error.code, 'EXPORT_LIMIT_EXCEEDED');
    await api(owner, '/analytics/exports', 'POST', { reportKey: 'tasks', filter: largeFilter }, 413);
    await api(owner, '/analytics/reports/tasks?' + new URLSearchParams(largeFilter), 'GET', undefined, 413);
  });
}
