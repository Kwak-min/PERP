import { z } from 'zod';
import type { AnalyticsKpis, AnalyticsMetric, AnalyticsPeriod, AnalyticsScope, AnalyticsExportJob } from '../../../../backend/src/services/analytics.contract';
export type { AnalyticsMetric, AnalyticsPeriod, AnalyticsScope, AnalyticsExportJob } from '../../../../backend/src/services/analytics.contract';

export const metricLabels = {
  'members.active': '현재 활성 소속', 'tasks.created': '기간 생성 업무', 'tasks.open': '현재 열린 업무', 'tasks.overdue': '현재 지연 업무',
  'finance.revenue': '기간 수입', 'finance.expense': '기간 비용', 'finance.net': '기간 차액', 'finance.journals': '기간 전표',
  'budgets.active': '현재 활성 예산', 'budgets.amount': '현재 편성액', 'budgets.executed': '기간 연결 실행액', 'budgets.execution_rate': '현재 예산 대비 기간 실행률',
  'approvals.created': '기간 생성 결재 요청', 'approvals.decided': '기간 최종 결정 요청', 'ai.calls': '나의 기간 AI 호출', 'audit.events': '테넌트 기간 감사 사건',
} as const;
export const metricKeys = Object.keys(metricLabels) as (keyof typeof metricLabels)[];
const countKeys = new Set(['members.active', 'tasks.created', 'tasks.open', 'tasks.overdue', 'finance.journals', 'budgets.active', 'approvals.created', 'approvals.decided', 'ai.calls', 'audit.events']);
const decimal = z.string().regex(/^-?\d+\.\d+$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const instant = new Date(value + 'T00:00:00Z');
  return !value.startsWith('0000') && Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
});
const timezone = z.string().min(1).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
});
export const filterSchema = z.object({ from: date.optional(), to: date.optional(), tz: timezone }).strict().refine(value =>
  (value.from === undefined && value.to === undefined) || (value.from !== undefined && value.to !== undefined && value.from < value.to));
export const periodSchema = z.object({ from: date, to: date, tz: timezone }).strict().refine(value => value.from < value.to);
const scopeSchema = z.object({ source: z.enum(['legacy', 'perp_db']), org_id: z.string().min(1) });
const metricSchema = z.object({
  key: z.enum(metricKeys as [keyof typeof metricLabels, ...(keyof typeof metricLabels)[]]),
  state: z.enum(['ready', 'empty', 'forbidden', 'disabled', 'unavailable']), value: z.union([z.number().int().nonnegative().safe(), decimal, z.null()]),
  unit: z.string().min(1), basis: z.enum(['current_snapshot', 'period_flow', 'period_flow_current_budget']), formula: z.string(),
  scope: scopeSchema.extend({ rows: z.enum(['company', 'self', 'project', 'department', 'own_requester', 'own_or_assigned_readable', 'readable_company_pool', 'tenant_self', 'tenant_all']), tenant_id: z.string().nullable().optional() }),
  reason: z.enum(['SOURCE_UNSUPPORTED', 'SOURCE_QUERY_FAILED', 'MIXED_CURRENCY', 'CURRENCY_MISMATCH']).optional(), not_applicable: z.literal(true).optional(),
}).superRefine((metric, context) => {
  const count = countKeys.has(metric.key), ratio = metric.key === 'budgets.execution_rate', available = metric.state === 'ready' || metric.state === 'empty';
  if ((count && metric.unit !== 'count') || (ratio && metric.unit !== 'percent') ||
    (!available && (metric.value !== null || metric.not_applicable)) ||
    (available && (count ? typeof metric.value !== 'number' : ratio ? !(typeof metric.value === 'string' && !metric.not_applicable || metric.value === null && metric.not_applicable) : typeof metric.value !== 'string')) ||
    (!ratio && metric.not_applicable)) context.addIssue({ code: 'custom', message: 'Invalid metric value/unit/state combination' });
}).transform(value => value as AnalyticsMetric);
const exactMoney = z.string().regex(/^-?\d+\.\d{2}$/);
const seriesSchema = z.object({
  key: z.literal('finance'), state: z.enum(['ready', 'empty', 'forbidden', 'disabled', 'unavailable']),
  unit: z.string().min(1), currency: z.string().min(1).nullable(), basis: z.literal('period_flow'), date_basis: z.literal('posted_entry_date'),
  scope: scopeSchema.extend({ rows: z.enum(['company', 'self', 'project', 'department']) }),
  granularity: z.enum(['day', 'calendar_day_group']), bucket_days: z.number().int().positive().safe(),
  reason: z.enum(['SOURCE_UNSUPPORTED', 'SOURCE_QUERY_FAILED', 'MIXED_CURRENCY', 'CURRENCY_MISMATCH']).optional(),
  points: z.array(z.object({ from: date, to: date, state: z.enum(['ready', 'empty']), revenue: exactMoney, expense: exactMoney, net: exactMoney }).strict()).max(366),
}).strict().transform(({ reason, ...series }) => ({ ...series, ...(reason ? { reason } : {}) }));
const dayNumber = (value: string) => Date.parse(value + 'T00:00:00Z') / 86400000;
export function seriesMinor(value: string): bigint { return BigInt(value.replace('.', '')); }
const kpisSchema = z.object({ scope: scopeSchema, period: periodSchema, generated_at: z.iso.datetime({ offset: true }), metrics: z.array(metricSchema).length(16), series: z.tuple([seriesSchema]) }).superRefine((data, context) => {
  if (new Set(data.metrics.map(metric => metric.key)).size !== 16 || data.metrics.some(metric => metric.scope.source !== data.scope.source || metric.scope.org_id !== data.scope.org_id)) context.addIssue({ code: 'custom', message: 'Invalid metric keys or scope' });
  const series = data.series[0], finance = data.metrics.find(metric => metric.key === 'finance.revenue');
  const available = series.state === 'ready' || series.state === 'empty';
  const days = dayNumber(data.period.to) - dayNumber(data.period.from), bucketDays = Math.ceil(days / 366);
  const totals = { revenue: 0n, expense: 0n, net: 0n };
  let boundary = data.period.from;
  let invalid = series.scope.source !== data.scope.source || series.scope.org_id !== data.scope.org_id || series.scope.rows !== finance?.scope.rows ||
    series.state !== finance?.state || series.unit !== finance?.unit || series.reason !== (finance && 'reason' in finance ? finance.reason : undefined) ||
    series.currency !== (['ledger_decimal', 'mixed_currency'].includes(series.unit) ? null : series.unit) ||
    series.bucket_days !== bucketDays || series.granularity !== (bucketDays === 1 ? 'day' : 'calendar_day_group') ||
    series.points.length !== (available ? Math.ceil(days / bucketDays) : 0);
  for (const point of series.points) {
    invalid ||= point.from !== boundary || dayNumber(point.to) !== Math.min(dayNumber(data.period.to), dayNumber(point.from) + bucketDays) ||
      seriesMinor(point.net) !== seriesMinor(point.revenue) - seriesMinor(point.expense) ||
      point.state === 'empty' && [point.revenue, point.expense, point.net].some(value => value !== '0.00');
    for (const key of ['revenue', 'expense', 'net'] as const) totals[key] += seriesMinor(point[key]);
    boundary = point.to;
  }
  if (available) {
    invalid ||= boundary !== data.period.to || (series.state === 'empty') !== series.points.every(point => point.state === 'empty');
    for (const key of ['revenue', 'expense', 'net'] as const) {
      const metric = data.metrics.find(metric => metric.key === `finance.${key}`);
      invalid ||= typeof metric?.value !== 'string' || !exactMoney.safeParse(metric.value).success || seriesMinor(metric.value) !== totals[key];
    }
  }
  if (invalid) context.addIssue({ code: 'custom', message: 'Invalid finance series scope/state/coverage/exact totals' });
});
export function samePeriod(a: AnalyticsPeriod, b: AnalyticsPeriod): boolean { return a.from === b.from && a.to === b.to && a.tz === b.tz; }
function assertScope(actual: AnalyticsScope, expected: AnalyticsScope): void {
  if (actual.source !== expected.source || actual.org_id !== expected.org_id) throw new Error('Analytics response scope mismatch');
}
export function parseKpis(payload: unknown, scope: AnalyticsScope): AnalyticsKpis { const data = kpisSchema.parse(payload); assertScope(data.scope, scope); return data; }

export const reportLabels = { members: '활성 소속', tasks: '기간 생성 업무', transactions: '기간 전표', budgets: '현재 활성 예산', approvals_created: '기간 생성 결재', approvals_decided: '기간 결정 결재' } as const;
export const reportKeys = ['members', 'tasks', 'transactions', 'budgets', 'approvals_created', 'approvals_decided'] as const;
export type ReportKey = typeof reportKeys[number];
export const reportKeySchema = z.enum(reportKeys);
export const reportColumns = {
  members: ['id', 'user_id', 'status'], tasks: ['id', 'title', 'status', 'created_at', 'due'], transactions: ['id', 'date', 'revenue', 'expense', 'unit'],
  budgets: ['id', 'amount', 'unit', 'status'], approvals_created: ['id', 'status', 'created_at'], approvals_decided: ['id', 'status', 'decided_at'],
} as const;
export const reportColumnLabels = { id: '기록 ID', user_id: '구성원 ID', status: '상태', title: '제목', created_at: '생성 시각', due: '기한', date: '전표 날짜', revenue: '수입', expense: '비용', unit: '단위', amount: '편성액', decided_at: '결정 시각' } as const;
const text = z.string(), id = text.min(1);
const rowSchemas = {
  members: z.object({ id, user_id: id, status: text }).strict(), tasks: z.object({ id, title: text, status: text, created_at: text, due: text.nullable() }).strict(),
  transactions: z.object({ id, date: text, revenue: decimal, expense: decimal, unit: text }).strict(), budgets: z.object({ id, amount: decimal, unit: text, status: text }).strict(),
  approvals_created: z.object({ id, status: text, created_at: text }).strict(), approvals_decided: z.object({ id, status: text, decided_at: text }).strict(),
};
export interface AnalyticsReport { reportKey: ReportKey; scope: AnalyticsScope; period: AnalyticsPeriod; generated_at: string; items: Record<string, string | null>[]; row_count: number }
const reportSchema = z.object({ reportKey: reportKeySchema, scope: scopeSchema, period: periodSchema, generated_at: z.iso.datetime({ offset: true }), items: z.array(z.unknown()).max(100000), row_count: z.number().int().min(0).max(100000) });
export function parseReport(payload: unknown, scope: AnalyticsScope, key: ReportKey, period: AnalyticsPeriod): AnalyticsReport {
  const data = reportSchema.parse(payload); assertScope(data.scope, scope);
  if (data.reportKey !== key || !samePeriod(data.period, period) || data.items.length !== data.row_count) throw new Error('Analytics report filter/count mismatch');
  return { ...data, items: data.items.map(row => rowSchemas[key].parse(row)) };
}
const jobSchema = z.object({ id, reportKey: reportKeySchema, filter: periodSchema, status: z.literal('ready'), row_count: z.number().int().min(0).max(100000), expires_at: z.iso.datetime({ offset: true }), requery_on_download: z.literal(true), download_url: text });
export function parseExportJob(payload: unknown, scope: AnalyticsScope, key: ReportKey, period: AnalyticsPeriod): AnalyticsExportJob {
  const job = jobSchema.parse(payload), prefix = scope.source === 'perp_db' ? '/pg' : '';
  if (job.reportKey !== key || !samePeriod(job.filter, period) || !/^[a-zA-Z0-9-]+$/.test(job.id) || job.download_url !== `${prefix}/analytics/exports/${job.id}/download`) throw new Error('Analytics export identity/filter mismatch');
  return job;
}
export const stateLabels = { ready: '조회 완료', empty: '데이터 없음', forbidden: '원천 권한 없음', disabled: '기능 꺼짐', unavailable: '사용 불가' } as const;
export const reasonLabels = { SOURCE_UNSUPPORTED: '선택한 범위에서 지원하지 않는 지표', SOURCE_QUERY_FAILED: '원천 조회 실패. 다시 조회해 주세요.', MIXED_CURRENCY: '여러 통화: 환산 없이 합산할 수 없음', CURRENCY_MISMATCH: '예산과 연결 거래의 통화 불일치' } as const;
export const basisSummaryLabels = { current_snapshot: '현재 상태', period_flow: '선택 기간', period_flow_current_budget: '선택 기간 / 현재 예산' } as const;
export const basisLabels = { current_snapshot: '현재 상태 (과거 말일 상태 아님)', period_flow: '선택 기간 흐름 [시작, 종료)', period_flow_current_budget: '선택 기간 흐름 / 현재 활성 예산 (과거 예산 상태 아님)' } as const;
export const rowScopeLabels = { company: '선택 회사의 인가된 행', self: '본인 범위', department: '본인 부서 범위', project: '참여 프로젝트 범위', own_requester: '본인의 결재 요청만', own_or_assigned_readable: '본인 요청 또는 실제 배정되어 읽을 수 있는 결재', readable_company_pool: '읽기 허용된 회사 결재 풀 (개인 배정함 아님)', tenant_self: '현재 테넌트의 본인 기록만', tenant_all: '테넌트 전체 (회사별 건수 아님)' } as const;
export function metricValue(metric: AnalyticsMetric): string {
  if (metric.value === null) return 'not_applicable' in metric && metric.not_applicable ? '해당 없음 (분모 0)' : '—';
  // Exact money and ratio strings are displayed verbatim. No locale/Number money conversion.
  return String(metric.value);
}
export function metricUnit(unit: string): string { return unit === 'ledger_decimal' ? '장부 단위' : unit === 'count' ? '건' : unit === 'percent' ? '%' : unit === 'mixed_currency' ? '여러 통화' : unit; }
