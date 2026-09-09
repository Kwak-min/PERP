import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { useSearchParams } from 'react-router-dom';
import type { ScreenDefinition } from '../routes/catalog';
import { useSession } from '../store/session';
import { apiRequest, userMessageOf, type ApiSession } from '../services/api';
import { isPgWorkspace } from '../services/workspace';
import { authenticatedUserId, isPgToken } from '../services/auth';
import { loadMoneyAttempt, type MoneyAttempt, type MoneyAttemptScope } from '../services/money-attempts';
import { Button } from '../components/ui/Button';
import { ExpenseForm } from '../components/common/ExpenseForm';
import { IncomeForm } from '../components/common/IncomeForm';
import { downloadCsv, paginateTable, type TableData } from '../pages/screenTable';
import { ExpenseDetail } from './expenses/ExpenseDetail';
import { FinanceOverview } from './expenses/FinanceOverview';
import { ExpenseImportPanel } from './finance/ExpenseImportPanel';
import { financePath, financeSetupSchema, ledgerRows, statusLabel, type LedgerRow } from './expenses/model';
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
  const [create, setCreate] = useState<'income' | 'expense' | null>(params.get('new') === 'income' ? 'income' : params.get('new') === 'expense' ? 'expense' : null), [importing, setImporting] = useState(false);
  const [setup, setSetup] = useState<z.infer<typeof financeSetupSchema> | null>(null), [setupError, setSetupError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false), [entryLocked, setEntryLocked] = useState(false);
  const [moneyScope, setMoneyScope] = useState<MoneyAttemptScope | null>(null), [restoredAttempt, setRestoredAttempt] = useState<MoneyAttempt | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const selected = params.get('transaction');
  const [query, setQuery] = useState(''), [status, setStatus] = useState(''), [page, setPage] = useState(1);
  const [success, setSuccess] = useState<string | null>(null), [loadedAt, setLoadedAt] = useState('');
  const pg = isPgWorkspace(session.orgId), base = financePath(session.orgId);
  const canWrite = permissions.includes('*') || permissions.includes('transaction.write');
  const canCreate = canWrite && (pg || permissions.includes('*') || permissions.includes('transaction.confirm'));
  const incomeReady = setup !== null && !setup.missing.includes('income') && !setup.missing.includes('cash');
  const expenseReady = setup !== null && !setup.missing.includes('expense') && !setup.missing.includes('cash');
  useEffect(() => {
    const controller = new AbortController();
    authenticatedUserId(session.token, controller.signal).then(userId => {
      if (controller.signal.aborted) return;
      if (!session.orgId) throw new Error('돈을 기록할 공간을 선택하세요.');
      const scope: MoneyAttemptScope = { userId, source: isPgToken(session.token) ? 'pg' : 'legacy', orgId: session.orgId };
      const attempt = loadMoneyAttempt(scope);
      setMoneyScope(scope); setRestoredAttempt(attempt);
      if (attempt) { setCreate(attempt.kind); setEntryLocked(true); }
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setRecoveryError(`보관된 요청을 확인하지 못해 새 입력을 차단했습니다. ${userMessageOf(caught)}`); });
    return () => controller.abort();
  }, [session]);
  useEffect(() => {
    const controller = new AbortController(); setError(null);
    // legacy의 실제 limit=-1은 SQLite LIMIT의 전체 조회 계약이다. PG 목록은 서버에서 전체를 반환한다.
    Promise.all([apiRequest(`${base}/transactions${pg ? '' : '?limit=-1'}`, { session, signal: controller.signal }), apiRequest('/settings/access', { session, signal: controller.signal })]).then(([payload, access]) => {
      const items = ledgerRows(payload, pg), grants = z.object({ permissions: z.array(z.string()) }).parse(access);
      if (!controller.signal.aborted) { setRows(items); setPermissions(grants.permissions); setLoadedAt(new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })); }
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [base, pg, session, revision]);
  useEffect(() => {
    const controller = new AbortController(); setSetupError(null);
    apiRequest(`${base}/setup`, { session, signal: controller.signal }).then(payload => {
      const value = financeSetupSchema.parse(payload); if (!controller.signal.aborted) setSetup(value);
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setSetupError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [base, session, revision]);
  async function prepare() {
    setPreparing(true); setSetupError(null);
    try {
      const value = financeSetupSchema.parse(await apiRequest(`${base}/setup`, { session, method: 'POST', body: {} }));
      setSetup(value); setRevision(n => n + 1);
    } catch (caught: unknown) { setSetupError(userMessageOf(caught)); }
    finally { setPreparing(false); }
  }
  function select(id: string | null) { const next = new URLSearchParams(params); if (id) next.set('transaction', id); else next.delete('transaction'); setParams(next, { replace: true }); }
  const filtered = (rows ?? []).filter(row => (!status || row.status === status) && `${row.id} ${row.date} ${row.memo} ${row.merchant ?? ''} ${row.kind}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const table: TableData = { columns: pg ? ['ID', '일자', '상태', '사용처', '내용', '차변', '대변', '입력 통화'] : ['ID', '일자', '상태', '사용처', '내용', '금액', '유형', '통화'],
    rows: filtered.map(row => ({ id: row.id, values: row, cells: [row.id, row.date, statusLabel(row.status), row.merchant ?? '', row.memo, row.amount, row.credit ?? row.kind, row.currency] })) };
  const paged = paginateTable(table, page);
  return <div className="screen expense-screen" data-screen-id={screen.id}>
    <header className="screen-header"><div><h1>{screen.label}</h1><p>기존 수입·지출과 초안·확정 전표를 함께 확인합니다.</p></div><div className="expense-actions">
      <Button tone="neutral" onClick={() => setRevision(n => n + 1)}>새로고침</Button>
      {canCreate && <Button tone="neutral" disabled={entryLocked || !moneyScope || !expenseReady} data-expense-import-entry onClick={() => { setImporting(true); setCreate(null); setSuccess(null); }}>CSV 가져오기</Button>}
      {canCreate && <Button disabled={entryLocked || !moneyScope || !incomeReady} data-income-entry onClick={() => { setCreate('income'); setImporting(false); setSuccess(null); }}>수입 입력</Button>}
      {canCreate && <Button disabled={entryLocked || !moneyScope || !expenseReady} data-expense-entry onClick={() => { setCreate('expense'); setImporting(false); setSuccess(null); }}>지출 입력</Button>}
    </div></header>
    {(!setup?.ready || setupError) && <section className="expense-panel" data-finance-setup aria-label="돈 관리 준비"><header><h2>돈 관리 준비</h2></header>
      {setupError && <p role="alert">{setupError} 결과를 확인하지 못했다면 다시 준비해도 기존 기록은 중복 생성되지 않습니다.</p>}
      {!setup && !setupError && <p role="status">준비 상태를 확인하는 중...</p>}
      {setup && !setup.ready && <><p>수입과 지출을 기록할 기본 분류{pg ? '와 현금 계정' : ''}를 준비합니다. 기존 계정과 기록은 유지하며 예시 거래·잔액·부서를 만들지 않습니다.</p>
        <p>필요한 항목: {setup.missing.map(item => ({ cash: '현금 계정', income: '수입 분류', expense: '지출 분류' })[item]).join(', ')}</p>
        {setup.can_initialize ? <Button data-finance-prepare disabled={preparing} onClick={() => void prepare()}>{preparing ? '준비 중...' : '돈 관리 준비하기'}</Button> : <p>공간 관리자에게 돈 관리 준비를 요청하세요.</p>}</>}
    </section>}
    {screen.id === 'FIN-001' && rows && <FinanceOverview rows={rows} pg={pg} session={session} loadedAt={loadedAt} />}
    {recoveryError && <p role="alert">{recoveryError}</p>}
    {!moneyScope && !recoveryError && <p role="status">계정과 보관된 돈 기록 요청을 확인하는 중...</p>}
    {success && <p role="status" data-expense-success>{success}</p>}
    {create === 'income' && canCreate && moneyScope && (incomeReady || restoredAttempt) && <IncomeForm session={session} attemptScope={moneyScope} initialAttempt={restoredAttempt?.kind === 'income' ? restoredAttempt : null} onLockChange={setEntryLocked} onClose={() => setCreate(null)} onSaved={id => { setRestoredAttempt(null); setCreate(null); select(id); setSuccess('확정 장부에 수입이 기록되었습니다.'); setRevision(n => n + 1); }} />}
    {create === 'expense' && canCreate && moneyScope && (expenseReady || restoredAttempt) && <ExpenseForm session={session} attemptScope={moneyScope} initialAttempt={restoredAttempt?.kind === 'expense' ? restoredAttempt : null} onLockChange={setEntryLocked} onClose={() => setCreate(null)} onSaved={id => { setRestoredAttempt(null); setCreate(null); select(id); setSuccess('확정 장부에 지출이 기록되었습니다.'); setRevision(n => n + 1); }} />}
    {importing && canCreate && <ExpenseImportPanel session={session} onClose={() => setImporting(false)} onCompleted={summary => { setSuccess(`CSV 적용 완료: 새 기록 ${summary.created ?? 0}건, 기존 기록 재사용 ${summary.reused ?? 0}건.`); setRevision(n => n + 1); }} />}
    {selected && <ExpenseDetail key={selected} id={selected} session={session} canWrite={canWrite} onClose={() => select(null)} onChanged={() => setRevision(n => n + 1)} />}
    <section className="expense-panel" aria-label="전체 거래 장부"><header><div><h2>전체 거래 장부</h2><p>{loadedAt ? `조회 시각 ${loadedAt} · 서울` : '선택 회사의 장부'}</p></div><Button tone="neutral" disabled={!rows || Boolean(error)} onClick={() => downloadCsv('거래', table)}>필터 결과 전체 CSV 내보내기</Button></header>
      <div className="expense-fields"><label>장부 검색<input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} /></label><label>상태<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">전체 상태</option>{['confirmed', 'draft', 'pending'].map(value => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label></div>
      {error && <p role="alert">{error} 이전 조회가 남아 있으면 최신 결과가 아닙니다.</p>}
      {!rows && !error && <p role="status">전체 전표를 불러오는 중...</p>}
      {rows && <><p role="status" data-ledger-count={rows.length}>검색 {filtered.length}건 / 회사 전체 {rows.length}건 · {paged.start}–{paged.end} 표시</p>
        {pg && <p>수입·지출 금액은 실제 수익·비용 계정의 순액입니다. 복합·기존 전표는 상세 분개로 확인하며, 원래 차변·대변 합계는 회계 정보와 CSV에 유지합니다.</p>}
        <ul className="expense-ledger">{paged.table.rows.map(item => {
          const row = filtered.find(row => row.id === item.id);
          return row ? <li key={row.id} data-transaction-id={row.id}><div><span className="expense-kicker">{row.date} · {row.kind} · {statusLabel(row.status)}</span><h3>{row.merchant ?? (row.legacy ? '기존 기록' : '사용처 없음')}</h3><p>{row.memo || '메모 없음'}</p></div><div className="expense-ledger-amount"><strong>{pg && !row.recordedAmount ? '복합·기존 전표' : `${row.kind} ${row.recordedAmount ?? row.amount} ${row.currency}`}</strong>{row.credit !== null && <details><summary>회계 정보 (차변·대변)</summary><span>차변 {row.amount} · 대변 {row.credit} · {row.currency}</span></details>}<Button tone="neutral" onClick={() => select(row.id)}>상세 보기</Button></div></li> : null;
        })}</ul>
        {!filtered.length && <p>표시할 거래가 없습니다.</p>}
        <nav className="expense-actions" aria-label="거래 페이지"><Button tone="neutral" disabled={paged.currentPage <= 1} onClick={() => setPage(paged.currentPage - 1)}>이전</Button><span>{paged.currentPage} / {paged.pageCount}</span><Button tone="neutral" disabled={paged.currentPage >= paged.pageCount} onClick={() => setPage(paged.currentPage + 1)}>다음</Button></nav>
      </>}
    </section>
  </div>;
}
