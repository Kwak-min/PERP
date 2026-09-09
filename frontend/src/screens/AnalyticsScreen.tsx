import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ScreenDefinition } from '../routes/catalog';
import { apiBlob, apiRequest, ApiError, userMessageOf, type ApiSession } from '../services/api';
import { isPgWorkspace } from '../services/workspace';
import { sessionStore, useSession } from '../store/session';
import { basisLabels, filterSchema, metricLabels, metricUnit, metricValue, parseExportJob, parseKpis, parseReport, reasonLabels, reportColumns, reportKeySchema, reportKeys, reportLabels, rowScopeLabels, samePeriod, stateLabels, type AnalyticsExportJob, type AnalyticsMetric, type AnalyticsPeriod, type AnalyticsReport, type AnalyticsScope, type ReportKey } from './analytics/model';
import type { AnalyticsFilter, AnalyticsKpis } from '../../../backend/src/services/analytics.contract';
import { FinanceSeries } from './analytics/FinanceSeries';
import './analytics/analytics.css';

type State<T> = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: T };
function currentSession(session: ApiSession): boolean { const current = sessionStore.getSnapshot(); return current?.token === session.token && current.orgId === session.orgId; }
function ErrorNotice({ error }: { error: unknown }) {
  return <div role="alert" className="analytics-error" data-error-code={error instanceof ApiError ? error.code : 'INVALID_RESPONSE'}>
    <p>{userMessageOf(error)}</p>
    {error instanceof ApiError && <p>HTTP {error.status} · {error.code}{error.details.limit !== undefined && <> · 한도 {String(error.details.limit)}행</>}</p>}
    {error instanceof ApiError && error.status === 413 && <p>기간을 좁히세요. 행을 임의로 잘라 내보내지 않습니다.</p>}
  </div>;
}

export function AnalyticsScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const stored = useSession();
  if (!stored?.orgId) return <section className="analytics-screen" data-screen-id={screen.id}><h1>분석</h1><p>회사를 선택해 주세요.</p></section>;
  const name = stored.organizations.find(org => org.org_id === stored.orgId)?.org_name ?? stored.orgId;
  return <AnalyticsWorkspace key={JSON.stringify([stored.token, stored.orgId])} session={{ token: stored.token, orgId: stored.orgId }} companyName={name} screen={screen} />;
}
function AnalyticsWorkspace({ session, companyName, screen }: { session: ApiSession; companyName: string; screen: ScreenDefinition }) {
  const [draft, setDraft] = useState({ from: '', to: '', tz: 'Asia/Seoul' });
  const [selection, setSelection] = useState<{ filter: AnalyticsFilter; controller: AbortController; revision: number } | null>(() => ({ filter: { tz: 'Asia/Seoul' }, controller: new AbortController(), revision: 0 }));
  const [validationError, setValidationError] = useState(false);
  const scope: AnalyticsScope = { source: isPgWorkspace(session.orgId) ? 'perp_db' : 'legacy', org_id: session.orgId! };
  useLayoutEffect(() => {
    const unsubscribe = sessionStore.subscribe(() => { if (!currentSession(session)) selection?.controller.abort(); });
    return unsubscribe;
  }, [session.token, session.orgId, selection]);
  function edit(field: keyof typeof draft, value: string) {
    selection?.controller.abort(); setSelection(null); setValidationError(false); setDraft(old => ({ ...old, [field]: value }));
  }
  return <section className="analytics-screen" data-screen-id={screen.id} data-source={scope.source} data-company={scope.org_id}>
    <header><h1>분석 · 보고서</h1><p><strong>{companyName}</strong> · {scope.source === 'perp_db' ? 'PostgreSQL' : '기존 조직'} ({scope.source})</p><p className="analytics-identity">회사 ID: {scope.org_id}</p></header>
    <form className="analytics-filters" onSubmit={event => {
      event.preventDefault();
      const parsed = filterSchema.safeParse({ ...(draft.from ? { from: draft.from } : {}), ...(draft.to ? { to: draft.to } : {}), tz: draft.tz });
      selection?.controller.abort();
      if (!parsed.success) { setSelection(null); setValidationError(true); return; }
      setValidationError(false); setSelection({ filter: { ...(parsed.data.from ? { from: parsed.data.from } : {}), ...(parsed.data.to ? { to: parsed.data.to } : {}), tz: parsed.data.tz }, controller: new AbortController(), revision: (selection?.revision ?? 0) + 1 });
    }}>
      <label>시작일 (포함)<input aria-label="시작일" type="date" value={draft.from} onChange={event => edit('from', event.target.value)} /></label>
      <label>종료일 (제외)<input aria-label="종료일" type="date" value={draft.to} onChange={event => edit('to', event.target.value)} /></label>
      <label>시간대<input aria-label="시간대" list="analytics-timezones" value={draft.tz} onChange={event => edit('tz', event.target.value)} /></label>
      <datalist id="analytics-timezones"><option value="Asia/Seoul" /><option value="UTC" /><option value="America/New_York" /></datalist>
      <button className="button" type="submit">기간 적용 · 다시 조회</button>
      <p>날짜는 함께 입력하세요. 둘 다 비우면 선택 시간대의 이번 달 첫날부터 다음 달 첫날까지 조회합니다.</p>
    </form>
    {validationError && <p role="alert" data-error-code="VALIDATION_ERROR">실제 날짜, 시작일 &lt; 종료일, 유효한 시간대를 확인하세요.</p>}
    {!selection && <p role="status">필터 변경으로 이전 조회와 다운로드를 해제했습니다. 기간을 적용해 주세요.</p>}
    {selection && <AnalyticsResults key={selection.revision} session={session} scope={scope} filter={selection.filter} signal={selection.controller.signal} />}
  </section>;
}
function AnalyticsResults({ session, scope, filter, signal }: { session: ApiSession; scope: AnalyticsScope; filter: AnalyticsFilter; signal: AbortSignal }) {
  const [state, setState] = useState<State<AnalyticsKpis>>({ status: 'loading' });
  const [reportKey, setReportKey] = useState<ReportKey>('tasks');
  useEffect(() => {
    const controller = new AbortController(), requestSignal = AbortSignal.any([signal, controller.signal]);
    apiRequest('/pg/analytics/kpis?' + new URLSearchParams(filter), { session, signal: requestSignal }).then(payload => {
      const data = parseKpis(payload, scope);
      if (data.period.tz !== (filter.tz ?? 'Asia/Seoul') || (filter.from && filter.to && !samePeriod(data.period, { from: filter.from, to: filter.to, tz: filter.tz ?? 'Asia/Seoul' }))) throw new Error('Analytics period mismatch');
      if (!requestSignal.aborted && currentSession(session)) setState({ status: 'ready', data });
    }).catch(error => { if (!requestSignal.aborted && currentSession(session)) setState({ status: 'error', error }); });
    return () => controller.abort();
  }, [session.token, session.orgId, filter, signal, scope.source, scope.org_id]);
  return <div data-analytics-kpis data-state={state.status}>
    {state.status === 'loading' && <p role="status">인가된 원천 지표를 조회하고 있습니다.</p>}
    {state.status === 'error' && <ErrorNotice error={state.error} />}
    {state.status === 'ready' && <>
      <div className="analytics-period" data-from={state.data.period.from} data-to={state.data.period.to} data-tz={state.data.period.tz}>
        <h2>확인된 조회 기간</h2><p><time>{state.data.period.from}</time> (포함) → <time>{state.data.period.to}</time> (제외) · {state.data.period.tz}</p>
        <p>조회 시작 시각: <time dateTime={state.data.generated_at}>{state.data.generated_at}</time></p>
        <p>현재 상태 지표는 과거 말일 상태가 아닙니다. 여러 원천의 전역 동시 스냅샷을 보장하지 않습니다.</p>
      </div>
      <div className="analytics-metrics">{state.data.metrics.map(metric => <MetricCard key={metric.key} metric={metric} />)}</div>
      <FinanceSeries key={state.data.generated_at} series={state.data.series[0]} period={state.data.period} />
      <section className="analytics-reports"><h2>보고서 · CSV 내보내기</h2>
        <label>보고서 선택<select aria-label="보고서 선택" value={reportKey} onChange={event => setReportKey(reportKeySchema.parse(event.target.value))}>{reportKeys.map(key => <option key={key} value={key}>{reportLabels[key]}</option>)}</select></label>
        <p>위 확인된 기간과 시간대를 그대로 사용합니다. 활성 소속·예산 보고서는 기간과 무관한 현재 상태입니다.</p>
        <ReportPanel key={reportKey} session={session} scope={scope} period={state.data.period} reportKey={reportKey} signal={signal} />
      </section>
    </>}
  </div>;
}
function MetricCard({ metric }: { metric: AnalyticsMetric }) {
  const reason = 'reason' in metric ? metric.reason : undefined;
  return <article className="analytics-metric" data-metric-key={metric.key} data-state={metric.state} data-reason={reason} data-unit={metric.unit} data-basis={metric.basis}>
    <h2>{metricLabels[metric.key]}</h2><p className="analytics-state">{stateLabels[metric.state]}</p>
    <p className="analytics-value"><strong data-metric-value>{metricValue(metric)}</strong>{metric.value !== null && <span>{metricUnit(metric.unit)}</span>}</p>
    {reason && <p>{reasonLabels[reason]} <code>{reason}</code></p>}
    <dl><dt>기준</dt><dd>{basisLabels[metric.basis]} <code>{metric.basis}</code></dd><dt>단위</dt><dd>{metricUnit(metric.unit)}</dd>
      <dt>산식</dt><dd>{metric.formula}</dd><dt>원천 범위</dt><dd>{rowScopeLabels[metric.scope.rows]} <code>{metric.scope.rows}</code><br />{metric.scope.source} · {metric.scope.org_id}{metric.scope.tenant_id && <><br />테넌트: {metric.scope.tenant_id}</>}</dd></dl>
  </article>;
}
function ReportPanel({ session, scope, period, reportKey, signal }: { session: ApiSession; scope: AnalyticsScope; period: AnalyticsPeriod; reportKey: ReportKey; signal: AbortSignal }) {
  const lifetime = useRef<AbortController | null>(null);
  const [report, setReport] = useState<State<AnalyticsReport> | null>(null);
  const [job, setJob] = useState<AnalyticsExportJob | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [downloadRows, setDownloadRows] = useState<number | null>(null);
  useLayoutEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const active = () => !signal.aborted && lifetime.current !== null && !lifetime.current.signal.aborted && currentSession(session);
  const requestSignal = () => AbortSignal.any([signal, lifetime.current!.signal]);
  async function loadReport() {
    if (!active() || busy) return;
    setBusy(true); setError(null); setReport({ status: 'loading' });
    try {
      const payload = await apiRequest(`/pg/analytics/reports/${reportKey}?${new URLSearchParams(period)}`, { session, signal: requestSignal() });
      const data = parseReport(payload, scope, reportKey, period); if (active()) setReport({ status: 'ready', data });
    } catch (error) { if (active()) setReport({ status: 'error', error }); }
    finally { if (active()) setBusy(false); }
  }
  async function createExport() {
    if (!active() || busy) return;
    setBusy(true); setError(null); setJob(null); setDownloadRows(null);
    try {
      const payload = await apiRequest('/pg/analytics/exports', { method: 'POST', body: { reportKey, filter: period }, session, signal: requestSignal() });
      const data = parseExportJob(payload, scope, reportKey, period); if (active()) setJob(data);
    } catch (error) { if (active()) setError(error); }
    finally { if (active()) setBusy(false); }
  }
  async function download() {
    if (!job || !active() || busy) return;
    setBusy(true); setError(null); setDownloadRows(null);
    try {
      const result = await apiBlob(job.download_url, { session, signal: requestSignal() });
      if (!active()) return;
      const url = URL.createObjectURL(result.blob), link = document.createElement('a');
      try { link.href = url; link.download = result.filename; document.body.append(link); link.click(); setDownloadRows(result.rowCount); }
      finally { link.remove(); URL.revokeObjectURL(url); }
    } catch (error) { if (active()) setError(error); }
    finally { if (active()) setBusy(false); }
  }
  return <div data-report-key={reportKey} aria-busy={busy}>
    <p>다운로드할 때 저장된 필터와 현재 권한으로 원천 데이터를 다시 조회합니다. 생성 시 행 수와 다운로드 행 수는 다를 수 있으며, 저장된 불변 파일이 아닙니다. 최대 100000행이며 초과 시 명시적으로 거부합니다.</p>
    <div className="analytics-actions"><button className="button" disabled={busy} onClick={loadReport}>보고서 조회</button><button className="button" disabled={busy} onClick={createExport}>CSV 요청 생성</button></div>
    {error !== null && <ErrorNotice error={error} />}
    {job && <div className="analytics-export" data-export-id={job.id}><p>생성 시 <strong data-created-rows>{job.row_count}</strong>행 · 만료 <time dateTime={job.expires_at}>{job.expires_at}</time></p><button className="button" disabled={busy} onClick={download}>현재 권한으로 CSV 다운로드</button>
      {downloadRows !== null && <p role="status">다운로드 응답 X-Row-Count: <strong data-download-rows>{downloadRows}</strong>행</p>}</div>}
    {report?.status === 'loading' && <p role="status">보고서를 조회하고 있습니다.</p>}
    {report?.status === 'error' && <ErrorNotice error={report.error} />}
    {report?.status === 'ready' && <div data-report-rows={report.data.row_count}><p>{report.data.row_count}행 · 조회 시각 <time>{report.data.generated_at}</time> · {report.data.scope.source} · {report.data.scope.org_id}</p>
      {report.data.row_count === 0 ? <p>인가된 조회 결과가 비어 있습니다.</p> : <div className="analytics-table" role="region" aria-label="보고서 결과" tabIndex={0}><table><thead><tr>{reportColumns[reportKey].map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{report.data.items.map(row => <tr key={row.id}>{reportColumns[reportKey].map(column => <td key={column}>{row[column] ?? '—'}</td>)}</tr>)}</tbody></table></div>}
    </div>}
  </div>;
}
