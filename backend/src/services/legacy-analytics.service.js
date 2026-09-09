import { db } from '../config/db.js';
import { resolvePrincipal } from '../middleware/auth.js';
import { enabledSet } from '../middleware/modules.js';
import { enabledFeatureSet } from '../config/features.js';
import { canReadApproval } from './approval.service.js';
import { counts, moneyMetrics, financeSeries, budgetMetrics, budgetExecution } from './analytics.service.js';
import { decimal, localDate } from './analytics-contract.service.js';
import { ApiError } from '../utils/errors.js';

export function legacyAnalyticsContext(req) {
  // 앞단에서 해석한 grant를 내보내기 재조회 인가로 재사용하지 않는다.
  delete req.principal;
  const principal = resolvePrincipal(req), org = req.organization;
  principal.require('analytics.read'); principal.require('menu.analytics');
  const modules = enabledSet(org.modules);
  if (!modules.has('analytics')) throw new ApiError('MODULE_DISABLED', '분석 모듈이 꺼져 있습니다.');
  return { principal, source: 'legacy', scope: { source: 'legacy', org_id: principal.orgId }, modules,
    features: enabledFeatureSet(org.enabled_features, org.modules), unsupported: new Set(principal.scope === 'all' ? [] : ['audit']), currency: org.currency };
}
export function legacyAnalyticsAdapter(context) {
  const p = context.principal, moneyUnit = context.currency;
  const all = (sql, params) => db().prepare(sql).all(...params);
  const base = alias => ({ sql: `${alias}.tenant_id=? AND ${alias}.org_id=? AND ${alias}.deleted_at IS NULL`, params: [p.tenantId, p.orgId] });
  function scoped(table, alias) {
    const filter = base(alias);
    if (p.scope === 'all') return filter;
    if (table === 'membership') {
      if (p.scope === 'department') {
        filter.sql += ` AND ${alias}.department_id IN (${p.departmentIds.map(() => '?').join(',') || 'NULL'})`;
        filter.params.push(...p.departmentIds);
      } else { filter.sql += ` AND ${alias}.user_id=?`; filter.params.push(p.userId); }
    } else if (p.scope === 'department') {
      if (table === 'task') {
        filter.sql += ` AND EXISTS (SELECT 1 FROM membership m WHERE m.user_id=${alias}.assignee_id AND m.tenant_id=${alias}.tenant_id AND m.org_id=${alias}.org_id AND m.deleted_at IS NULL AND m.status='active' AND m.department_id IN (${p.departmentIds.map(() => '?').join(',') || 'NULL'}))`;
      } else filter.sql += ` AND ${alias}.department_id IN (${p.departmentIds.map(() => '?').join(',') || 'NULL'})`;
      filter.params.push(...p.departmentIds);
    } else if (p.scope === 'project') {
      filter.sql += ` AND EXISTS (SELECT 1 FROM project_member pm JOIN project pr ON pr.id=pm.project_id AND pr.tenant_id=pm.tenant_id
        WHERE pm.project_id=${alias}.project_id AND pm.user_id=? AND pm.tenant_id=${alias}.tenant_id AND pr.org_id=${alias}.org_id AND pm.deleted_at IS NULL AND pr.deleted_at IS NULL)`;
      filter.params.push(p.userId);
    } else {
      filter.sql += ` AND ${alias}.${table === 'task' ? 'assignee_id' : 'created_by'}=?`; filter.params.push(p.userId);
    }
    return filter;
  }
  const timestamp = (column, w) => ({ sql: `julianday(${column})>=julianday(?) AND julianday(${column})<julianday(?)`, params: [w.start, w.end] });
  const limit = exporting => exporting ? ' LIMIT 100001' : '';
  function members(exporting = false) {
    const s = scoped('membership', 'm');
    return all(`SELECT m.id,m.user_id,m.status FROM membership m JOIN app_user u ON u.id=m.user_id
      WHERE ${s.sql} AND m.status='active' AND u.auth_status='active' ORDER BY m.id${limit(exporting)}`, s.params);
  }
  function tasks(w, exporting = false, mode = 'created', now = new Date()) {
    const s = scoped('task', 't');
    if (mode === 'created') { const range = timestamp('t.created_at', w); s.sql += ` AND ${range.sql}`; s.params.push(...range.params); }
    else {
      s.sql += " AND t.status IN ('todo','in_progress','blocked')";
      if (mode === 'overdue') {
        // legacy due_at은 DATE와 timestamp를 모두 수용했던 열이다. DATE에는 선택 tz의 오늘을 쓴다.
        s.sql += ' AND ((length(t.due_at)=10 AND t.due_at<?) OR (length(t.due_at)>10 AND julianday(t.due_at)<julianday(?)))';
        s.params.push(localDate(now, w.period.tz), now.toISOString());
      }
    }
    return all(`SELECT t.id,t.title,t.status,t.created_at,t.due_at AS due FROM task t WHERE ${s.sql} ORDER BY t.id${limit(exporting)}`, s.params);
  }
  function budgets(exporting = false) {
    const s = scoped('budget', 'b');
    return all(`SELECT b.id,CAST(b.amount_minor AS TEXT) AS amount_minor,b.status FROM budget b WHERE ${s.sql} AND b.status='approved' ORDER BY b.id${limit(exporting)}`, s.params)
      .map(row => ({ ...row, amount_minor: BigInt(row.amount_minor), amount: decimal(BigInt(row.amount_minor)), unit: moneyUnit }));
  }
  function entries(w, exporting = false, linked = false) {
    const s = scoped('transaction_record', 't');
    s.sql += " AND t.status='confirmed' AND t.occurred_on>=? AND t.occurred_on<?"; s.params.push(w.period.from, w.period.to);
    if (linked) {
      const b = scoped('budget', 'b');
      s.sql += ` AND t.kind='expense' AND EXISTS(SELECT 1 FROM budget b WHERE b.id=t.budget_id AND ${b.sql} AND b.status='approved')`; s.params.push(...b.params);
    }
    return all(`SELECT t.id,t.occurred_on AS date,t.kind,CAST(t.amount_minor AS TEXT) AS amount_minor,t.currency AS unit
      FROM transaction_record t WHERE ${s.sql} ORDER BY t.id${limit(exporting)}`, s.params).map(row => {
      const amount = BigInt(row.amount_minor), revenue_minor = row.kind === 'income' ? amount : 0n, expense_minor = row.kind === 'expense' ? amount : 0n;
      return { ...row, revenue_minor, expense_minor, revenue: decimal(revenue_minor), expense: decimal(expense_minor) };
    });
  }
  function approvals(w, decided = false, exporting = false) {
    const s = base('a');
    // SQL 선필터는 canonical canReadApproval과 같은 requester/실제 배정자 경계다.
    s.sql += ` AND ((a.requester_id=? AND ?=1) OR (a.requester_id<>? AND a.status<>'draft' AND ?=1 AND EXISTS(
      SELECT 1 FROM approval_step s WHERE s.approval_id=a.id AND s.tenant_id=a.tenant_id AND s.approver_id=? AND s.deleted_at IS NULL)))`;
    s.params.push(p.userId, Number(p.has('approval.request')), p.userId, Number(p.has('approval.decide')), p.userId);
    const decision = `(SELECT s.decided_at FROM approval_step s WHERE s.tenant_id=a.tenant_id AND s.approval_id=a.id AND s.deleted_at IS NULL AND s.status IN ('approved','rejected') AND s.decided_at IS NOT NULL ORDER BY julianday(s.decided_at) DESC,s.id DESC LIMIT 1)`;
    const range = timestamp(decided ? decision : 'a.created_at', w);
    s.sql += ` AND ${range.sql}`; s.params.push(...range.params);
    if (decided) s.sql += " AND a.status IN ('approved','rejected')";
    const rows = all(`SELECT a.id,a.requester_id,a.status,a.created_at,${decision} AS decided_at FROM approval a WHERE ${s.sql} ORDER BY a.id${limit(exporting)}`, s.params);
    // 단일 read predicate 변경은 집계/내보내기에서도 즉시 거부로 반영된다.
    return rows.filter(row => canReadApproval(p, row));
  }
  return { moneyUnit,
    metrics(source, w, now) {
      if (source === 'members') return counts({ 'members.active': members().length });
      if (source === 'tasks') return counts({ 'tasks.created': tasks(w).length, 'tasks.open': tasks(w, false, 'open', now).length, 'tasks.overdue': tasks(w, false, 'overdue', now).length });
      if (source === 'transactions') { const rows = entries(w); return { ...moneyMetrics(rows, moneyUnit), ...counts({ 'finance.journals': rows.length }), series: financeSeries(rows, w.period) }; }
      if (source === 'budgets') return budgetMetrics(budgets(), moneyUnit);
      if (source === 'execution') return budgetExecution(budgets(), entries(w, false, true), moneyUnit);
      if (source === 'approvals') return counts({ 'approvals.created': approvals(w).length, 'approvals.decided': approvals(w, true).length });
      const ai = source === 'ai', range = timestamp('created_at', w);
      const rows = all(`SELECT COUNT(*) AS count FROM ${ai ? 'ai_request_log' : 'audit_event'} WHERE tenant_id=? ${ai ? 'AND user_id=?' : ''} AND ${range.sql}`,
        [p.tenantId, ...(ai ? [p.userId] : []), ...range.params]);
      return counts({ [ai ? 'ai.calls' : 'audit.events']: rows[0].count });
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
