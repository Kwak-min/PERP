// Task24 -> Task25: JSON 전송 계약. 금액/비율을 Number로 변환하지 않는다.
export type AnalyticsSource = 'legacy' | 'perp_db';
export type AnalyticsScope = { source: AnalyticsSource; org_id: string };
export type AnalyticsPeriod = { from: string; to: string; tz: string };
export type AnalyticsFilter = { from?: string; to?: string; tz?: string };
export type AnalyticsMetricState = 'ready' | 'empty' | 'forbidden' | 'disabled' | 'unavailable';
export type CountMetricKey = 'members.active' | 'tasks.created' | 'tasks.open' | 'tasks.overdue'
  | 'finance.journals' | 'budgets.active' | 'approvals.created' | 'approvals.decided' | 'ai.calls' | 'audit.events';
export type MoneyMetricKey = 'finance.revenue' | 'finance.expense' | 'finance.net' | 'budgets.amount' | 'budgets.executed';
export type RatioMetricKey = 'budgets.execution_rate';
export type MetricKey = CountMetricKey | MoneyMetricKey | RatioMetricKey;
export type AnalyticsBasis = 'current_snapshot' | 'period_flow' | 'period_flow_current_budget';
export type AnalyticsRowScope = 'company' | 'self' | 'project' | 'department' | 'own_requester'
  | 'own_or_assigned_readable' | 'readable_company_pool' | 'tenant_self' | 'tenant_all';
export type AnalyticsReason = 'SOURCE_UNSUPPORTED' | 'SOURCE_QUERY_FAILED' | 'MIXED_CURRENCY' | 'CURRENCY_MISMATCH';
type MetricMetadata<K extends MetricKey> = {
  key: K;
  unit: K extends CountMetricKey ? 'count' : K extends RatioMetricKey ? 'percent' : string;
  basis: AnalyticsBasis;
  formula: string;
  scope: AnalyticsScope & { rows: AnalyticsRowScope; tenant_id?: string | null };
};
type Result<K extends MetricKey> =
  | { state: 'forbidden' | 'disabled' | 'unavailable'; value: null; reason?: AnalyticsReason }
  | ({ state: 'ready' | 'empty' } & (K extends CountMetricKey ? { value: number }
    : K extends MoneyMetricKey ? { value: string }
    : { value: string; not_applicable?: never } | { value: null; not_applicable: true }));
export type AnalyticsMetric = { [K in MetricKey]: MetricMetadata<K> & Result<K> }[MetricKey];
export interface AnalyticsKpis {
  scope: AnalyticsScope;
  period: AnalyticsPeriod;
  generated_at: string;
  metrics: AnalyticsMetric[];
  series: [];
}
export type AnalyticsReportKey = 'members' | 'tasks' | 'transactions' | 'budgets' | 'approvals_created' | 'approvals_decided';
export interface AnalyticsExportInput { reportKey: AnalyticsReportKey; filter?: AnalyticsFilter }
export interface AnalyticsExportJob {
  id: string;
  reportKey: AnalyticsReportKey;
  filter: AnalyticsPeriod;
  status: 'ready';
  row_count: number;
  expires_at: string;
  requery_on_download: true;
  download_url: string;
}
