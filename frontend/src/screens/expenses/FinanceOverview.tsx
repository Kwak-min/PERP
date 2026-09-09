import { useEffect, useState } from 'react';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { apiRequest, userMessageOf, type ApiSession } from '../../services/api';
import type { LedgerRow } from './model';

export function legacyTotals(rows: readonly LedgerRow[]) {
  const totals = new Map<string, { income: bigint; expense: bigint }>();
  for (const row of rows) {
    if (row.status !== 'confirmed') continue;
    const bucket = totals.get(row.currency) ?? { income: 0n, expense: 0n };
    const [whole = '0', fraction = ''] = row.amount.split('.');
    const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    if (row.kind === '수입') bucket.income += minor; else bucket.expense += minor;
    totals.set(row.currency, bucket);
  }
  const decimal = (value: bigint) => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;
  return [...totals].map(([currency, value]) => ({ currency, income: decimal(value.income), expense: decimal(value.expense), balance: decimal(value.income - value.expense) }));
}
export function FinanceOverview({ rows, pg, session, loadedAt }: Readonly<{ rows: readonly LedgerRow[]; pg: boolean; session: ApiSession; loadedAt: string }>) {
  const [summary, setSummary] = useState<{ 수입: string; 지출: string; 잔액: string } | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!pg) return;
    const controller = new AbortController(); setError(null); setSummary(null);
    apiRequest('/pg/finance/summary', { session, signal: controller.signal }).then(payload => {
      const parsed = z.object({ 수입: z.string(), 지출: z.string(), 잔액: z.string() }).parse(payload);
      if (!controller.signal.aborted) setSummary(parsed);
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [pg, session, rows]);
  const totals = pg ? summary ? [{ currency: '장부 금액', income: summary.수입, expense: summary.지출, balance: summary.잔액 }] : [] : legacyTotals(rows);
  return <section className="expense-panel" aria-label="확정 장부 요약"><header><div><h2>확정 장부 요약</h2><p>전체 기간 · {pg ? '게시된 분개의 계정 방향 기준' : '확정 거래의 통화별 합계'} · {loadedAt} 조회</p></div><Link to="/finance/transactions">전체 거래·상세·CSV 내보내기</Link></header>
    {error && <p role="alert">{error}</p>}{pg && !summary && !error && <p role="status">장부 합계를 불러오는 중...</p>}
    {totals.map(total => <div key={total.currency}><h3>{total.currency}</h3><dl className="expense-summary"><div><dt>수입</dt><dd>{total.income}</dd></div><div><dt>지출</dt><dd>{total.expense}</dd></div><div><dt>기록한 수입 − 지출</dt><dd>{total.balance}</dd></div></dl></div>)}
    <p>장부에 기록한 금액의 차이이며 실제 현금·은행 잔액이 아닙니다. 통화를 입력하지 않은 과거 PG 기록은 장부 단위로 표시합니다.</p>
    {!pg && totals.length === 0 && <p>확정된 거래가 없습니다.</p>}
  </section>;
}
