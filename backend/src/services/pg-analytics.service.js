import { pgQuery } from '../config/pg.js';
import { resolvePgCompanyPrincipal } from '../middleware/pgAccess.js';
import { pgEnabledFeatures } from '../middleware/features.js';
import { canReadPgApproval } from './pg-approval-read-policy.service.js';
import { counts, moneyMetrics, financeSeries, budgetMetrics, budgetExecution } from './analytics.service.js';
import { decimalMinor, decimal, localDate } from './analytics-contract.service.js';
import { ApiError } from '../utils/errors.js';

export async function pgAnalyticsContext(req) {
  delete req.pgCompanyPrincipal; delete req.pgCompanyWorkspace;
  const principal = await resolvePgCompanyPrincipal(req);
  principal.require('analytics.read'); principal.require('menu.analytics');
  if (!principal.modules.includes('analytics')) throw new ApiError('MODULE_DISABLED', '분석 모듈이 꺼져 있습니다.');
  // 기능 설정 실패도 결재 지표에만 국한한다.
  let features = new Set();
  const queryFailed = new Set();
  if (principal.has('menu.approvals') && (principal.has('approval.request') || principal.has('approval.decide'))) {
    try { features = new Set(await pgEnabledFeatures(principal.companyId, principal.modules)); }
    catch (error) { console.error('analytics approval feature query failed', error); queryFailed.add('approvals'); }
  }
  return { principal, source: 'perp_db', scope: { source: 'perp_db', org_id: principal.orgId }, modules: new Set(principal.modules), features,
    unsupported: new Set(['ai', 'audit']), queryFailed };
}
export function pgAnalyticsAdapter(context) {
  const p = context.principal, moneyUnit = 'ledger_decimal';
  const all = async (sql, params = []) => (await pgQuery(sql, [p.companyId, ...params])).rows;
  const limit = exporting => exporting ? ' LIMIT 100001' : '';
  async function members(exporting = false) {
    return all(`SELECT m.user_id::text AS id,m.user_id::text,m.status FROM org.company_memberships m
      JOIN auth.users u ON u.id=m.user_id WHERE m.company_id=$1 AND m.status='active'
      AND u.account_status='active' AND u.approval_status='approved' ORDER BY m.user_id${limit(exporting)}`);
  }
  async function tasks(w, exporting = false, mode = 'created', now = new Date()) {
    const condition = mode === 'created' ? 't.created_at>=$2::timestamptz AND t.created_at<$3::timestamptz'
      : `t.status IN ('todo','in_progress','blocked')${mode === 'overdue' ? ' AND t.due_on<$2::date' : ''}`;
    const params = mode === 'created' ? [w.start, w.end] : mode === 'overdue' ? [localDate(now, w.period.tz)] : [];
    return (await all(`SELECT t.id::text,t.title,t.status,t.created_at,t.due_on::text AS due FROM project.tasks t
      JOIN project.projects pr ON pr.id=t.project_id WHERE pr.company_id=$1 AND ${condition} ORDER BY t.id${limit(exporting)}`, params))
      .map(row => ({ ...row, created_at: row.created_at.toISOString() }));
  }
  async function budgets(exporting = false) {
    return (await all(`SELECT b.id::text,b.amount::text,b.status FROM accounting.budgets b WHERE b.company_id=$1 AND b.status='active' ORDER BY b.id${limit(exporting)}`))
      .map(row => ({ ...row, amount_minor: decimalMinor(row.amount), unit: moneyUnit }));
  }
  async function entries(w, exporting = false, linked = false) {
    // 먼저 전표를 선택하고 계정 방향으로 합산한다. 잔액 계정의 반대쪽 line은 중복 비용이 아니다.
    const rows = await all(`SELECT e.id::text,e.entry_date::text AS date,
      COALESCE(SUM(CASE WHEN a.account_type='revenue' THEN l.credit-l.debit ELSE 0 END),0)::text AS revenue,
      COALESCE(SUM(CASE WHEN a.account_type='expense' THEN l.debit-l.credit ELSE 0 END),0)::text AS expense
      FROM accounting.journal_entries e
      LEFT JOIN accounting.journal_lines l ON l.entry_id=e.id
      LEFT JOIN accounting.accounts a ON a.id=l.account_id AND a.company_id=e.company_id
      WHERE e.company_id=$1 AND e.posted=true AND e.entry_date>=$2::date AND e.entry_date<$3::date
      ${linked ? "AND EXISTS(SELECT 1 FROM accounting.budgets b WHERE b.id=e.budget_id AND b.company_id=e.company_id AND b.status='active')" : ''}
      GROUP BY e.id,e.entry_date ORDER BY e.id${limit(exporting)}`, [w.period.from, w.period.to]);
    return rows.map(row => ({ ...row, revenue: decimal(decimalMinor(row.revenue)), expense: decimal(decimalMinor(row.expense)),
      revenue_minor: decimalMinor(row.revenue), expense_minor: decimalMinor(row.expense), unit: moneyUnit }));
  }
  async function approvals(w, decided = false, exporting = false) {
    const column = decided ? 'a.decided_at' : 'a.created_at';
    const rows = await all(`SELECT a.id::text,a.requester_id::text,a.status,a.created_at,a.decided_at
      FROM org.approval_requests a WHERE a.company_id=$1
      AND ((a.requester_id=$2 AND $3::boolean) OR (a.status<>'draft' AND $4::boolean))
      AND ${column}>=$5::timestamptz AND ${column}<$6::timestamptz ${decided ? "AND a.status IN ('approved','rejected')" : ''}
      ORDER BY a.id${limit(exporting)}`, [p.userId, p.has('approval.request'), p.has('approval.decide'), w.start, w.end]);
    return rows.filter(row => canReadPgApproval(p, row)).map(row => ({ ...row, created_at: row.created_at.toISOString(), decided_at: row.decided_at?.toISOString() ?? null }));
  }
  return { moneyUnit,
    async metrics(source, w, now) {
      if (source === 'members') return counts({ 'members.active': (await members()).length });
      if (source === 'tasks') {
        const [created, open, overdue] = await Promise.all([tasks(w), tasks(w, false, 'open', now), tasks(w, false, 'overdue', now)]);
        return counts({ 'tasks.created': created.length, 'tasks.open': open.length, 'tasks.overdue': overdue.length });
      }
      if (source === 'transactions') { const rows = await entries(w); return { ...moneyMetrics(rows, moneyUnit), ...counts({ 'finance.journals': rows.length }), series: financeSeries(rows, w.period) }; }
      if (source === 'budgets') return budgetMetrics(await budgets(), moneyUnit);
      if (source === 'execution') {
        const [active, linked] = await Promise.all([budgets(), entries(w, false, true)]);
        return budgetExecution(active, linked, moneyUnit);
      }
      if (source === 'approvals') {
        const [created, decided] = await Promise.all([approvals(w), approvals(w, true)]);
        return counts({ 'approvals.created': created.length, 'approvals.decided': decided.length });
      }
      throw new Error('Unsupported analytics source');
    },
    report(key, w) {
      if (key === 'members') return members(true);
      if (key === 'tasks') return tasks(w, true);
      if (key === 'transactions') return entries(w, true);
      if (key === 'budgets') return budgets(true);
      return approvals(w, key === 'approvals_decided', true);
    },
  };
}
