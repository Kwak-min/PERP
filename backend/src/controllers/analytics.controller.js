import { db } from '../config/db.js';
import { resolvePrincipal } from '../middleware/auth.js';
import { insert } from '../models/base.js';
import { ApiError, notFound } from '../utils/errors.js';
import { legacyAnalyticsContext, legacyAnalyticsAdapter } from '../services/legacy-analytics.service.js';
import { analyticsKpis, analyticsReport, REPORT_COLUMNS } from '../services/analytics.service.js';
import { analyticsPeriod, exportInput, reportKey, csv } from '../services/analytics-contract.service.js';

export async function kpis(req, res) {
  const context = legacyAnalyticsContext(req), now = new Date(), window = analyticsPeriod(req.query, now);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await analyticsKpis(context, legacyAnalyticsAdapter(context), window, now));
}

export function dashboard(req, res) {
  const principal = resolvePrincipal(req);
  const myTasks = db()
    .prepare(
      `SELECT id, title, status, priority, due_at FROM task
       WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL
         AND assignee_id = ? AND status != 'done'
       ORDER BY due_at IS NULL, due_at LIMIT 10`,
    )
    .all(principal.tenantId, principal.orgId, principal.userId);

  const myApprovals = db()
    .prepare(
      `SELECT a.id, a.title, a.status FROM approval a
       JOIN approval_step s ON s.approval_id = a.id
       WHERE a.tenant_id = ? AND a.org_id = ? AND a.deleted_at IS NULL
         AND s.approver_id = ? AND s.status = 'pending'
       ORDER BY a.created_at DESC LIMIT 10`,
    )
    .all(principal.tenantId, principal.orgId, principal.userId);

  const upcoming = db()
    .prepare(
      `SELECT id, title, start_at, end_at, location FROM event
       WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL AND end_at >= ?
       ORDER BY start_at LIMIT 10`,
    )
    .all(principal.tenantId, principal.orgId, new Date().toISOString());

  const unread = db()
    .prepare(
      `SELECT COUNT(*) AS c FROM notification
       WHERE tenant_id = ? AND recipient_id = ? AND read_at IS NULL AND deleted_at IS NULL`,
    )
    .get(principal.tenantId, principal.userId).c;

  res.json({
    my_tasks: myTasks,
    my_approvals: myApprovals,
    upcoming_events: upcoming,
    unread_notifications: unread,
    modules: (req.organization?.modules ?? '').split(',').filter(Boolean),
  });
}

export async function report(req, res) {
  const context = legacyAnalyticsContext(req), key = reportKey(req.params.reportKey), window = analyticsPeriod(req.query);
  const items = await analyticsReport(context, legacyAnalyticsAdapter(context), key, window);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ reportKey: key, scope: context.scope, period: window.period, generated_at: new Date().toISOString(), items, row_count: items.length });
}
export async function createExport(req, res) {
  const context = legacyAnalyticsContext(req), payload = exportInput.parse(req.body), window = analyticsPeriod(payload.filter);
  const rows = await analyticsReport(context, legacyAnalyticsAdapter(context), payload.reportKey, window), p = context.principal;
  const job = insert('export_job', { tenant_id: p.tenantId, org_id: p.orgId, kind: payload.reportKey, params: JSON.stringify(window.period),
    status: 'ready', requested_by: p.userId, expires_at: new Date(Date.now() + 7 * 86400000).toISOString(), created_by: p.userId });
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(201).json({ id: job.id, reportKey: job.kind, filter: window.period, status: 'ready', row_count: rows.length,
    expires_at: job.expires_at, requery_on_download: true, download_url: `/analytics/exports/${job.id}/download` });
}
export function listExports(req, res) {
  const context = legacyAnalyticsContext(req), p = context.principal;
  const rows = db().prepare(`SELECT id,kind AS reportKey,params,expires_at,created_at FROM export_job
    WHERE tenant_id=? AND org_id=? AND requested_by=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100`).all(p.tenantId, p.orgId, p.userId);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ items: rows.map(({ params, ...row }) => ({ ...row, filter: JSON.parse(params), requery_on_download: true })) });
}
export async function downloadExport(req, res) {
  const context = legacyAnalyticsContext(req), p = context.principal;
  const job = db().prepare(`SELECT * FROM export_job WHERE id=? AND tenant_id=? AND org_id=? AND requested_by=? AND deleted_at IS NULL`)
    .get(req.params.exportId, p.tenantId, p.orgId, p.userId);
  if (!job) throw notFound('export');
  if (job.status !== 'ready' || job.expires_at <= new Date().toISOString()) throw new ApiError('CONFLICT', '내보내기 요청이 만료되었거나 준비되지 않았습니다.');
  const key = reportKey(job.kind), window = analyticsPeriod(JSON.parse(job.params));
  const rows = await analyticsReport(context, legacyAnalyticsAdapter(context), key, window);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${key}-${job.id}.csv"`);
  res.setHeader('X-Row-Count', String(rows.length));
  res.send(csv(rows, REPORT_COLUMNS[key]));
}
