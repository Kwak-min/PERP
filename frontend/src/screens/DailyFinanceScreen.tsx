import { useEffect, useMemo, useRef, useState } from 'react';
import { createRequestKey } from '../services/requestKey';
import { z } from 'zod';
import type { ScreenDefinition } from '../routes/catalog';
import { useSession } from '../store/session';
import { isPgWorkspace } from '../services/workspace';
import { ApiError, apiRequest, userMessageOf, type ApiSession } from '../services/api';
import { ScreenPage } from '../pages/ScreenPage';
import { downloadCsv, type TableData } from '../pages/screenTable';
import { Button } from '../components/ui/Button';
import { CreateFormModal } from '../components/common/CreateFormModal';
import './daily-finance.css';

const approvalSchema = z.object({
  items: z.array(z.object({ __id: z.coerce.string(), 유형: z.string(), 신청자: z.string().nullable(), 대상: z.string().nullable(),
    status: z.string(), 신청일: z.string(), payload: z.object({ note: z.string().optional() }).passthrough(),
    decision_note: z.string().nullable(), decided_at: z.string().nullable() }).passthrough()),
  can_decide: z.boolean(), can_request: z.boolean(),
});
const duesSchema = z.object({ items: z.array(z.object({ __id: z.coerce.string(), 대상: z.string().nullable(), 금액: z.string(),
  기한: z.string().nullable(), status: z.string(), version: z.number(), paid: z.string(), outstanding: z.string() }).passthrough()) });
const historySchema = z.object({ id: z.string(), status: z.string(), version: z.number(), outstanding: z.string(),
  items: z.array(z.object({ id: z.string(), amount: z.string(), paid_on: z.string(), method: z.string().nullable() })) });
const accessSchema = z.object({ permissions: z.array(z.string()) });
const statusLabel: Record<string, string> = { pending: '대기', approved: '승인', rejected: '반려', unpaid: '미납', partial: '부분 납부', paid: '완납', waived: '면제', overdue: '연체' };
type Approval = z.infer<typeof approvalSchema>['items'][number];

export function DailyFinanceScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const stored = useSession();
  const session = useMemo<ApiSession | null>(() => stored ? { token: stored.token, orgId: stored.orgId } : null, [stored]);
  if (!isPgWorkspace(session?.orgId)) return <ScreenPage screen={screen} />;
  return session ? <FinanceWorkspace key={`${session.orgId}:${screen.id}`} session={session} screen={screen} /> : null;
}

function FinanceWorkspace({ session, screen }: Readonly<{ session: ApiSession; screen: ScreenDefinition }>) {
  const approvals = screen.id === 'APR-001';
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ approvals?: z.infer<typeof approvalSchema>; dues?: z.infer<typeof duesSchema>; permissions: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [editing, setEditing] = useState<{ id: string; values: Record<string, string> } | null>(null);
  const [mutating, setMutating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const refresh = () => setRevision(n => n + 1);
  useEffect(() => {
    const controller = new AbortController(); setState(null); setError(null);
    Promise.all([apiRequest(approvals ? '/pg/approvals' : '/pg/finance/dues', { session, signal: controller.signal }),
      apiRequest('/settings/access', { session, signal: controller.signal })]).then(([payload, access]) => {
      const parsed = { permissions: accessSchema.parse(access).permissions, ...(approvals ? { approvals: approvalSchema.parse(payload) } : { dues: duesSchema.parse(payload) }) };
      if (!controller.signal.aborted) setState(parsed);
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [session, approvals, revision]);
  const approvalRows = state?.approvals?.items.filter(row => (!status || row.status === status) && `${row.유형} ${row.신청자 ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const duesRows = state?.dues?.items.filter(row => (!status || row.status === status) && (row.대상 ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const canWrite = state?.permissions.includes('dues.write') ?? false;
  const canCreate = approvals ? state?.approvals?.can_request : canWrite;
  // 화면과 동일한 필터 결과 전체를 사용한다. 금액 문자열과 원본 행 메타데이터를 유지한다.
  const exportTable: TableData = approvals ? {
    columns: ['ID','유형','신청자','대상','상태','신청일','신청 내용','처리 의견','처리일'],
    rows: approvalRows.map(row => ({ id: row.__id, values: row,
      cells: [row.__id, row.유형, row.신청자 ?? '', row.대상 ?? '', row.status, row.신청일, JSON.stringify(row.payload), row.decision_note ?? '', row.decided_at ?? ''] })),
  } : {
    columns: ['ID','대상','청구액','납부액','잔액','기한','상태'],
    rows: duesRows.map(row => ({ id: row.__id, values: row,
      cells: [row.__id, row.대상 ?? '', row.금액, row.paid, row.outstanding, row.기한 ?? '', row.status] })),
  };
  async function editCharge(id: string) {
    setMutating(true); setError(null);
    try {
      const value = await apiRequest(`/pg/records/dues/${id}`, { session });
      const row = z.object({ amount: z.string(), due_date: z.string().nullable(), version: z.number() }).parse(value);
      setEditing({ id, values: { amount: row.amount, due_date: row.due_date ?? '', version: String(row.version) } });
    } catch (caught: unknown) { setError(userMessageOf(caught)); }
    finally { setMutating(false); }
  }
  async function deleteCharge(id: string, version: number) {
    if (!window.confirm('납부 전 청구를 삭제할까요?')) return;
    setMutating(true); setError(null);
    try { await apiRequest(`/pg/records/dues/${id}`, { session, method: 'DELETE', body: { expected_version: version } }); if (selected === id) setSelected(null); refresh(); }
    catch (caught: unknown) { setError(userMessageOf(caught)); }
    finally { setMutating(false); }
  }
  return <div className="screen daily-finance" data-screen-id={screen.id}>
    <header className="screen-header"><div><h1>{screen.label}</h1><p>{approvals ? '내 신청과 처리 권한이 있는 결재를 확인합니다.' : '납부 기록을 등록합니다. 실제 송금은 실행하지 않습니다.'}</p></div>
      <div className="daily-finance__actions"><Button tone="neutral" disabled={!state} onClick={() => downloadCsv(screen.label, exportTable)}>필터 결과 전체 내보내기</Button><Button tone="neutral" onClick={refresh}>새로고침</Button>{canCreate && screen.create && <Button onClick={() => setCreate(true)}>{screen.label} 만들기</Button>}</div></header>
    <div className="daily-finance__filters"><label>검색<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label>상태<select value={status} onChange={e => setStatus(e.target.value)}><option value="">전체</option>{(approvals ? ['pending','approved','rejected'] : ['unpaid','partial','paid','waived','overdue']).map(key => <option key={key} value={key}>{statusLabel[key]}</option>)}</select></label></div>
    {error && <p role="alert">{error}</p>}
    {!state && !error && <p role="status">불러오는 중...</p>}
    {state && <><p role="status">{approvals ? approvalRows.length : duesRows.length}건 / 전체 {state.approvals?.items.length ?? state.dues?.items.length ?? 0}건</p>
      {approvals ? <ul className="daily-finance__list">{approvalRows.map(row => <ApprovalRow key={row.__id} row={row} canDecide={state.approvals?.can_decide ?? false} session={session} refresh={refresh} />)}</ul>
        : <ul className="daily-finance__list">{duesRows.map(row => <li key={row.__id} data-dues-id={row.__id} data-status={row.status}>
          <div><h2>{row.대상 ?? '대상자 삭제됨'}</h2><p>청구 {row.금액} / 납부 {row.paid} / 잔액 {row.outstanding}</p><p>{statusLabel[row.status] ?? row.status} {row.기한 ? ` · 기한 ${row.기한.slice(0, 10)}` : ''}</p></div>
          <div className="daily-finance__actions"><Button tone="neutral" data-open-payments onClick={() => setSelected(row.__id)}>납부 / 이력</Button>
            {canWrite && ['unpaid','overdue'].includes(row.status) && <><Button tone="neutral" disabled={mutating} onClick={() => void editCharge(row.__id)}>수정</Button><Button tone="ghost" disabled={mutating} onClick={() => void deleteCharge(row.__id, row.version)}>삭제</Button></>}
          </div></li>)}</ul>}
      {(approvals ? approvalRows.length : duesRows.length) === 0 && <p>표시할 기록이 없습니다.</p>}</>}
    {selected && <PaymentPanel key={selected} id={selected} session={session} canWrite={canWrite} refresh={refresh} close={() => setSelected(null)} />}
    {create && screen.create && <CreateFormModal entityLabel={screen.label} config={screen.create} session={session} onClose={() => setCreate(false)} onCreated={refresh} />}
    {editing && screen.create && <CreateFormModal entityLabel={screen.label} config={{ endpoint: `/pg/records/dues/${editing.id}`, fields: screen.create.fields.filter(field => field.type !== 'select') }} method="PATCH" initialValues={editing.values} versionField="expected_version" session={session} onClose={() => setEditing(null)} onCreated={() => { setSelected(null); refresh(); }} />}
  </div>;
}

function ApprovalRow({ row, canDecide, session, refresh }: Readonly<{ row: Approval; canDecide: boolean; session: ApiSession; refresh: () => void }>) {
  const [comment, setComment] = useState(''); const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  async function decide(decision: 'approve' | 'reject') {
    setSaving(true); setError(null);
    try { await apiRequest(`/pg/approvals/${row.__id}/decide`, { session, method: 'POST', body: { decision, comment } }); refresh(); }
    catch (caught: unknown) { setError(userMessageOf(caught)); }
    finally { setSaving(false); }
  }
  return <li data-approval-id={row.__id} data-status={row.status}>
    <div><h2>{row.유형}</h2><p>{row.신청자 ?? '신청자 삭제됨'} {row.대상 ? ` → ${row.대상}` : ''} · {statusLabel[row.status] ?? row.status}</p>
      <p>{row.payload.note}</p>{row.decision_note && <p>처리 의견: {row.decision_note}</p>}</div>
    {canDecide && row.status === 'pending' && <div className="daily-finance__decision"><label>처리 의견<textarea maxLength={2000} value={comment} onChange={e => setComment(e.target.value)} /></label>
      <div className="daily-finance__actions"><Button data-decision="approve" disabled={saving} onClick={() => void decide('approve')}>승인</Button><Button data-decision="reject" tone="neutral" disabled={saving} onClick={() => void decide('reject')}>반려</Button></div></div>}
    {error && <p role="alert">{error}</p>}
  </li>;
}

function PaymentPanel({ id, session, canWrite, refresh, close }: Readonly<{ id: string; session: ApiSession; canWrite: boolean; refresh: () => void; close: () => void }>) {
  const [history, setHistory] = useState<z.infer<typeof historySchema> | null>(null);
  const [amount, setAmount] = useState(''); const [error, setError] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0); const key = useRef(createRequestKey());
  useEffect(() => {
    const controller = new AbortController();
    apiRequest(`/pg/finance/dues/${id}/payments`, { session, signal: controller.signal }).then(payload => {
      const parsed = historySchema.parse(payload); if (!controller.signal.aborted) setHistory(parsed);
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [id, session, revision]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!history) return;
    setSaving(true); setError(null);
    try {
      await apiRequest(`/pg/finance/dues/${id}/payments`, { session, method: 'POST', headers: { 'Idempotency-Key': key.current }, body: { amount, expected_version: history.version, method: 'manual' } });
      key.current = createRequestKey(); setAmount(''); setRevision(n => n + 1); refresh();
    } catch (caught: unknown) {
      setError(userMessageOf(caught));
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') { key.current = createRequestKey(); setRevision(n => n + 1); refresh(); }
    } finally { setSaving(false); }
  }
  return <section className="daily-finance__payments" data-payment-panel aria-label="납부 이력">
    <header><h2>청구 #{id} 납부 이력</h2><Button tone="ghost" disabled={saving} onClick={close}>닫기</Button></header>
    {history ? <><p>잔액 <strong data-outstanding>{history.outstanding}</strong></p>
      <ul>{history.items.map(payment => <li key={payment.id} data-payment-id={payment.id}>{payment.paid_on} · {payment.amount} · {payment.method ?? '미지정'}</li>)}</ul>
      {canWrite && !['paid','waived'].includes(history.status) && <form onSubmit={e => void submit(e)}><label>납부액<input name="amount" type="number" min="0.01" step="0.01" required value={amount} disabled={saving} onChange={e => setAmount(e.target.value)} /></label><Button type="submit" disabled={saving}>납부 기록</Button></form>}
    </> : <p role="status">이력을 불러오는 중...</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
