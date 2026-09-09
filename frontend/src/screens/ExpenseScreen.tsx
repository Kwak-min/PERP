import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { useSearchParams } from 'react-router-dom';
import type { ScreenDefinition } from '../routes/catalog';
import { useSession } from '../store/session';
import { apiRequest, userMessageOf, type ApiSession } from '../services/api';
import { isPgWorkspace } from '../services/workspace';
import { Button } from '../components/ui/Button';
import { ExpenseForm } from '../components/common/ExpenseForm';
import { downloadCsv, paginateTable, type TableData } from '../pages/screenTable';
import { ExpenseDetail } from './expenses/ExpenseDetail';
import { FinanceOverview } from './expenses/FinanceOverview';
import { ExpenseImportPanel } from './finance/ExpenseImportPanel';
import { financePath, ledgerRows, statusLabel, type LedgerRow } from './expenses/model';
import './expenses/expense.css';

export function ExpenseScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const stored = useSession();
  const session = useMemo(() => stored ? { token: stored.token, orgId: stored.orgId } : null, [stored?.token, stored?.orgId]);
  return session ? <ExpenseWorkspace key={`${session.token}:${session.orgId}:${screen.id}`} session={session} screen={screen} /> : null;
}
function ExpenseWorkspace({ session, screen }: Readonly<{ session: ApiSession; screen: ScreenDefinition }>) {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<LedgerRow[] | null>(null), [permissions, setPermissions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const [create, setCreate] = useState(params.get('new') === 'expense'), [importing, setImporting] = useState(false);
  const selected = params.get('transaction');
  const [query, setQuery] = useState(''), [status, setStatus] = useState(''), [page, setPage] = useState(1);
  const [success, setSuccess] = useState<string | null>(null), [loadedAt, setLoadedAt] = useState('');
  const pg = isPgWorkspace(session.orgId), base = financePath(session.orgId);
  const canWrite = permissions.includes('*') || permissions.includes('transaction.write');
  const canCreate = canWrite && (pg || permissions.includes('*') || permissions.includes('transaction.confirm'));
  useEffect(() => {
    const controller = new AbortController(); setError(null);
    // legacy의 실제 limit=-1은 SQLite LIMIT의 전체 조회 계약이다. PG 목록은 서버에서 전체를 반환한다.
    Promise.all([apiRequest(`${base}/transactions${pg ? '' : '?limit=-1'}`, { session, signal: controller.signal }), apiRequest('/settings/access', { session, signal: controller.signal })]).then(([payload, access]) => {
      const items = ledgerRows(payload, pg), grants = z.object({ permissions: z.array(z.string()) }).parse(access);
      if (!controller.signal.aborted) { setRows(items); setPermissions(grants.permissions); setLoadedAt(new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })); }
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [base, pg, session, revision]);
  function select(id: string | null) { const next = new URLSearchParams(params); if (id) next.set('transaction', id); else next.delete('transaction'); setParams(next, { replace: true }); }
  const filtered = (rows ?? []).filter(row => (!status || row.status === status) && `${row.id} ${row.date} ${row.memo} ${row.merchant ?? ''} ${row.kind}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const table: TableData = { columns: pg ? ['ID', '일자', '상태', '사용처', '내용', '차변', '대변', '입력 통화'] : ['ID', '일자', '상태', '사용처', '내용', '금액', '유형', '통화'],
    rows: filtered.map(row => ({ id: row.id, values: row, cells: [row.id, row.date, statusLabel(row.status), row.merchant ?? '', row.memo, row.amount, row.credit ?? row.kind, row.currency] })) };
  const paged = paginateTable(table, page);
  return <div className="screen expense-screen" data-screen-id={screen.id}>
    <header className="screen-header"><div><h1>{screen.label}</h1><p>기존 수입·지출과 초안·확정 전표를 함께 확인합니다.</p></div><div className="expense-actions">
      <Button tone="neutral" onClick={() => setRevision(n => n + 1)}>새로고침</Button>
      {canCreate && <Button tone="neutral" data-expense-import-entry onClick={() => { setImporting(true); setCreate(false); setSuccess(null); }}>CSV 가져오기</Button>}
      {canCreate && <Button data-expense-entry onClick={() => { setCreate(true); setImporting(false); setSuccess(null); }}>새 지출 입력</Button>}
    </div></header>
    {screen.id === 'FIN-001' && rows && <FinanceOverview rows={rows} pg={pg} session={session} loadedAt={loadedAt} />}
    {success && <p role="status" data-expense-success>{success}</p>}
    {create && canCreate && <ExpenseForm session={session} onClose={() => setCreate(false)} onSaved={id => { setCreate(false); select(id); setSuccess('확정 장부에 지출이 기록되었습니다.'); setRevision(n => n + 1); }} />}
    {importing && canCreate && <ExpenseImportPanel session={session} onClose={() => setImporting(false)} onCompleted={summary => { setSuccess(`CSV 적용 완료: 새 기록 ${summary.created ?? 0}건, 기존 기록 재사용 ${summary.reused ?? 0}건.`); setRevision(n => n + 1); }} />}
    {selected && <ExpenseDetail key={selected} id={selected} session={session} canWrite={canWrite} onClose={() => select(null)} onChanged={() => setRevision(n => n + 1)} />}
    <section className="expense-panel" aria-label="전체 거래 장부"><header><div><h2>전체 거래 장부</h2><p>{loadedAt ? `조회 시각 ${loadedAt} · 서울` : '선택 회사의 장부'}</p></div><Button tone="neutral" disabled={!rows || Boolean(error)} onClick={() => downloadCsv('거래', table)}>필터 결과 전체 CSV 내보내기</Button></header>
      <div className="expense-fields"><label>장부 검색<input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} /></label><label>상태<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">전체 상태</option>{['confirmed', 'draft', 'pending'].map(value => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label></div>
      {error && <p role="alert">{error} 이전 조회가 남아 있으면 최신 결과가 아닙니다.</p>}
      {!rows && !error && <p role="status">전체 전표를 불러오는 중...</p>}
      {rows && <><p role="status" data-ledger-count={rows.length}>검색 {filtered.length}건 / 회사 전체 {rows.length}건 · {paged.start}–{paged.end} 표시</p>
        {pg && <p>차변·대변은 전표의 실제 합계입니다. 수입·비용 방향과 계정은 상세 분개에서 확인하세요.</p>}
        <ul className="expense-ledger">{paged.table.rows.map(item => {
          const row = filtered.find(row => row.id === item.id);
          return row ? <li key={row.id} data-transaction-id={row.id}><div><span className="expense-kicker">{row.date} · {row.kind} · {statusLabel(row.status)}</span><h3>{row.merchant ?? (row.legacy ? '기존 기록' : '사용처 없음')}</h3><p>{row.memo || '메모 없음'}</p></div><div className="expense-ledger-amount"><strong>{pg ? '차변 ' : ''}{row.amount} {row.currency}</strong>{row.credit !== null && <span>대변 {row.credit}</span>}<Button tone="neutral" onClick={() => select(row.id)}>상세 보기</Button></div></li> : null;
        })}</ul>
        {!filtered.length && <p>표시할 거래가 없습니다.</p>}
        <nav className="expense-actions" aria-label="거래 페이지"><Button tone="neutral" disabled={paged.currentPage <= 1} onClick={() => setPage(paged.currentPage - 1)}>이전</Button><span>{paged.currentPage} / {paged.pageCount}</span><Button tone="neutral" disabled={paged.currentPage >= paged.pageCount} onClick={() => setPage(paged.currentPage + 1)}>다음</Button></nav>
      </>}
    </section>
  </div>;
}
