import { useId, useState } from 'react';
import type { AnalyticsFinanceSeries, AnalyticsPeriod, AnalyticsSeriesPoint } from '../../../../backend/src/services/analytics.contract';
import { metricUnit, reasonLabels, rowScopeLabels, seriesMinor, stateLabels } from './model';

const lines = [
  { key: 'revenue', label: '수입', color: '#1556a0', dash: undefined },
  { key: 'expense', label: '비용', color: '#a13e12', dash: '8 4' },
  { key: 'net', label: '차액', color: '#603ba0', dash: '2 4' },
] as const;

export function FinanceSeries({ series, period }: { series: AnalyticsFinanceSeries; period: AnalyticsPeriod }) {
  const id = useId(), [selected, setSelected] = useState(0);
  const unit = metricUnit(series.unit), available = series.state === 'ready' || series.state === 'empty';
  const selectedPoint = series.points[selected];
  let maximum = 0n, maximumText = '0.00';
  for (const point of series.points) for (const { key } of lines) {
    const value = seriesMinor(point[key]), absolute = value < 0n ? -value : value;
    if (absolute > maximum) { maximum = absolute; maximumText = point[key].replace(/^-/, ''); }
  }
  // 금액은 BigInt로 유지한다. 좌표만 [-10000,10000] 정수 비율로 정규화한다.
  const y = (value: string) => 130 - (maximum === 0n ? 0 : Number(seriesMinor(value) * 10000n / maximum) / 10000 * 110);
  const start = Date.parse(period.from), duration = Date.parse(period.to) - start;
  const x = (point: AnalyticsSeriesPoint) => 20 + ((Date.parse(point.from) + Date.parse(point.to)) / 2 - start) / duration * 680;
  const pointLabel = (point: AnalyticsSeriesPoint) => `${point.from} (포함) → ${point.to} (제외)`;
  return <section className="analytics-series" data-series-count={series.points.length} data-series-state={series.state} data-series-reason={series.reason} aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>기간 수입 · 비용 · 차액</h2>
    <p id={`${id}-context`} className="analytics-note">{period.from} (포함) → {period.to} (제외) · {period.tz}<br />
      {series.granularity === 'day' ? '일별 합계' : `${series.bucket_days}일씩 합산`} · {unit}{series.currency === null && ' · 통화 미지정 (환산 없음)'}
      {series.scope.rows !== 'company' && <> · {rowScopeLabels[series.scope.rows]}</>}</p>
    <p className="analytics-state" role="status">{stateLabels[series.state]}{series.reason && <> · {reasonLabels[series.reason]}</>}</p>
    {available && selectedPoint && <>
      <label>구간 선택<select aria-label="차트 구간 선택" aria-describedby={`${id}-context`} value={selected} onChange={event => setSelected(Number(event.target.value))}>
        {series.points.map((point, index) => <option key={point.from} value={index}>{pointLabel(point)}</option>)}
      </select></label>
      <div className="analytics-series-detail" data-series-selected={selectedPoint.from} aria-live="polite" aria-atomic="true">
        <p>{pointLabel(selectedPoint)} · {stateLabels[selectedPoint.state]} · {unit}</p>
        <dl>{lines.map(line => <div key={line.key}><dt>{line.label}</dt><dd data-selected-value={line.key}>{selectedPoint[line.key]}</dd></div>)}</dl>
      </div>
      <ul className="analytics-series-legend">{lines.map(line => <li key={line.key}><svg width="36" height="12" aria-hidden="true"><line x1="0" x2="36" y1="6" y2="6" stroke={line.color} strokeWidth="3" strokeDasharray={line.dash} /></svg>{line.label}</li>)}</ul>
      <svg data-series-chart className="analytics-series-chart" viewBox="0 0 720 260" role="img" aria-labelledby={`${id}-chart-title`} aria-describedby={`${id}-context ${id}-basis ${id}-scale`}>
        <title id={`${id}-chart-title`}>선택 기간의 수입, 비용, 차액 ({unit})</title>
        <line x1="20" x2="700" y1="130" y2="130" stroke="#657084" />
        {lines.map(line => <g key={line.key}>
          <polyline fill="none" stroke={line.color} strokeWidth="2" strokeDasharray={line.dash} points={series.points.map(point => `${x(point)},${y(point[line.key])}`).join(' ')} />
          {series.points.map((point, index) => <circle key={point.from} cx={x(point)} cy={y(point[line.key])} r={index === selected ? 4 : 2} fill={line.color}>
            <title>{pointLabel(point)} · {period.tz} · {line.label}: {point[line.key]} {unit} · {stateLabels[point.state]}</title>
          </circle>)}
        </g>)}
      </svg>
      <div className="analytics-series-axis"><span>{period.from}</span><span>{period.to} (제외)</span></div>
      <div className="analytics-table analytics-series-table" data-series-table role="region" aria-label="기간 시계열 정확한 값" aria-describedby={`${id}-context`} tabIndex={0}>
        <table><caption>구간별 정확한 합계 · {unit} · {period.tz}</caption>
          <thead><tr><th scope="col">기간 [포함, 제외)</th><th scope="col">상태</th>{lines.map(line => <th scope="col" key={line.key}>{line.label} ({unit})</th>)}</tr></thead>
          <tbody>{series.points.map(point => <tr key={point.from} data-series-from={point.from} aria-current={point === selectedPoint ? 'true' : undefined}>
            <th scope="row">{point.from} → {point.to}</th><td>{stateLabels[point.state]}</td>{lines.map(line => <td key={line.key} data-series-value={line.key}>{point[line.key]}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </>}
    <details className="analytics-basis"><summary>집계 기준 · 차트</summary>
      <p id={`${id}-basis`}>{series.scope.source} · {series.scope.org_id} · {rowScopeLabels[series.scope.rows]}<br />
        단위: {unit} · {series.unit} · 통화: {series.currency ?? '통화 미지정 (환산 없음)'}<br />
        선택 기간 흐름 · {series.basis} · 게시/확정 전표의 DATE 기준 · {series.date_basis}. 날짜를 시간대 이동하지 않습니다.</p>
      <p>{series.granularity === 'day' ? '일별 합계' : `${series.bucket_days}개 달력일씩 합산 (마지막 구간은 짧을 수 있음)`} · 최대 366구간. 기간 전체를 포함하며 평균이나 이전 기간 비교가 아닙니다.</p>
      {series.reason && <p><code>{series.reason}</code></p>}
      {available && selectedPoint && <p id={`${id}-scale`}>세 선은 같은 선형 축을 사용합니다. 축 상단 +{maximumText}, 중앙 0.00, 하단 {maximum === 0n ? '0.00' : `-${maximumText}`} ({unit}). 각 점은 구간의 중앙 날짜 위치에 합계를 표시합니다. 작은 차이는 겹칠 수 있습니다. 정확한 값은 구간 선택과 표에서 확인하세요.</p>}
    </details>
  </section>;
}
