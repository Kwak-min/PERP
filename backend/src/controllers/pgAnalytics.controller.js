import { z } from 'zod';
import { pgQuery } from '../config/pg.js';
import { pgAnalyticsContext, pgAnalyticsAdapter } from '../services/pg-analytics.service.js';
import { analyticsKpis, analyticsReport, REPORT_COLUMNS } from '../services/analytics.service.js';
import { analyticsPeriod, exportInput, reportKey, csv } from '../services/analytics-contract.service.js';
import { ApiError, notFound } from '../utils/errors.js';

export async function kpis(req, res) {
  const context = await pgAnalyticsContext(req), now = new Date(), window = analyticsPeriod(req.query, now);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await analyticsKpis(context, pgAnalyticsAdapter(context), window, now));
}
export async function report(req, res) {
  const context = await pgAnalyticsContext(req), key = reportKey(req.params.reportKey), window = analyticsPeriod(req.query);
  const items = await analyticsReport(context, pgAnalyticsAdapter(context), key, window);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ reportKey: key, scope: context.scope, period: window.period, generated_at: new Date().toISOString(), items, row_count: items.length });
}
export async function createExport(req, res) {
  const context = await pgAnalyticsContext(req), payload = exportInput.parse(req.body), window = analyticsPeriod(payload.filter);
  const rows = await analyticsReport(context, pgAnalyticsAdapter(context), payload.reportKey, window), p = context.principal;
  const { rows: [job] } = await pgQuery(`INSERT INTO org.analytics_export_jobs(company_id,requested_by,report_key,filter,expires_at)
    VALUES($1,$2,$3,$4,now()+interval '7 days') RETURNING id::text,expires_at`, [p.companyId, p.userId, payload.reportKey, window.period]);
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(201).json({ id: job.id, reportKey: payload.reportKey, filter: window.period, status: 'ready', row_count: rows.length,
    expires_at: job.expires_at.toISOString(), requery_on_download: true, download_url: `/pg/analytics/exports/${job.id}/download` });
}
export async function listExports(req, res) {
  const context = await pgAnalyticsContext(req), p = context.principal;
  const { rows } = await pgQuery(`SELECT id::text,report_key AS "reportKey",filter,expires_at,created_at
    FROM org.analytics_export_jobs WHERE company_id=$1 AND requested_by=$2 ORDER BY id DESC LIMIT 100`, [p.companyId, p.userId]);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ items: rows.map(row => ({ ...row, expires_at: row.expires_at.toISOString(), created_at: row.created_at.toISOString(), requery_on_download: true })) });
}
export async function downloadExport(req, res) {
  const context = await pgAnalyticsContext(req), p = context.principal, id = z.string().regex(/^[1-9]\d*$/).max(19).parse(req.params.exportId);
  const { rows: [job] } = await pgQuery(`SELECT report_key,filter,expires_at FROM org.analytics_export_jobs
    WHERE id=$1 AND company_id=$2 AND requested_by=$3`, [id, p.companyId, p.userId]);
  if (!job) throw notFound('export');
  if (job.expires_at.getTime() <= Date.now()) throw new ApiError('CONFLICT', '내보내기 요청이 만료되었습니다.');
  const key = reportKey(job.report_key), window = analyticsPeriod(job.filter);
  const rows = await analyticsReport(context, pgAnalyticsAdapter(context), key, window);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${key}-${id}.csv"`);
  res.setHeader('X-Row-Count', String(rows.length));
  res.send(csv(rows, REPORT_COLUMNS[key]));
}
