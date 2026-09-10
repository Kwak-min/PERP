import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest, userMessageOf, type ApiSession } from '../../services/api';
import { isPgWorkspace } from '../../services/workspace';
import { budgetOptions, expenseAccounts, expenseSchema, financePath, confirmedMoneySchema, type Account, type UploadSlot } from '../../screens/expenses/model';
import { ReceiptUploads } from './ReceiptUploads';
import { Button } from '../ui/Button';
import { saveMoneyAttempt, clearMoneyAttempt, knownMoneyRollback, type MoneyAttempt, type MoneyAttemptScope } from '../../services/money-attempts';

type Props = Readonly<{ session: ApiSession; attemptScope: MoneyAttemptScope; initialAttempt: Extract<MoneyAttempt, { kind: 'expense' }> | null; onSaved: (id: string) => void; onClose: () => void; onLockChange?: (locked: boolean) => void; project?: { id: string; name: string; budgets: Account[] } }>;
export function ExpenseForm({ session, attemptScope, initialAttempt, onSaved, onClose, project, onLockChange }: Props) {
  const linkedProjectId = initialAttempt ? initialAttempt.body.project_id : project?.id;
  const [values, setValues] = useState({ amount: initialAttempt?.body.amount ?? '', expense_date: initialAttempt?.body.expense_date ?? '', expense_time: initialAttempt?.body.expense_time ?? '', merchant: initialAttempt?.body.merchant ?? '', account_id: initialAttempt?.body.account_id ?? '', budget_id: initialAttempt?.body.budget_id ?? '', memo: initialAttempt?.body.memo ?? '', no_receipt_reason: initialAttempt?.body.no_receipt_reason ?? '' });
  const [slots, setSlots] = useState<UploadSlot[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]), [budgets, setBudgets] = useState<Account[]>([]);
  const [optionsState, setOptionsState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [revision, setRevision] = useState(0), [budgetError, setBudgetError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(Boolean(initialAttempt)), [confirmed, setConfirmed] = useState(Boolean(initialAttempt));
  const scope = useRef(new AbortController());
  const pending = useRef(initialAttempt);
  const base = financePath(session.orgId), pg = isPgWorkspace(session.orgId);
  useEffect(() => { const controller = new AbortController(); scope.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setOptionsState('loading');
    apiRequest(`${base}/accounts`, { session, signal: controller.signal }).then(payload => {
      const rows = expenseAccounts(payload, pg); if (!controller.signal.aborted) { setAccounts(rows); setOptionsState('ready'); }
    }).catch((caught: unknown) => { if (!controller.signal.aborted) { setError(userMessageOf(caught)); setOptionsState('failed'); } });
    if (project) { setBudgets(project.budgets); setBudgetError(null); }
    else apiRequest(`${base}/budgets`, { session, signal: controller.signal }).then(payload => {
      const rows = budgetOptions(payload, pg); if (!controller.signal.aborted) { setBudgets(rows); setBudgetError(null); }
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setBudgetError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [base, pg, session, revision, project]);
  function change(field: keyof typeof values, value: string) { setValues(current => ({ ...current, [field]: value })); setConfirmed(false); setError(null); }
  const locked = saving || uncertain;
  useEffect(() => { onLockChange?.(locked); }, [locked, onLockChange]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (saving) return;
    setError(null);
    if (!pending.current) {
      if (slots.some(slot => slot.state !== 'ready')) { setError('모든 영수증 업로드를 완료하거나 실패한 파일을 제거하세요.'); return; }
      const parsed = expenseSchema.safeParse({ ...values, ...(linkedProjectId ? { project_id: linkedProjectId } : {}), expense_time: values.expense_time || undefined, budget_id: values.budget_id || null, currency: 'KRW', receipt_tokens: slots.flatMap(slot => slot.upload ? [slot.upload.token] : []) });
      if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? '입력값을 확인하세요.'); return; }
      if (!confirmed) { setError('확정 후 원금과 내용을 변경할 수 없음을 확인해 주세요.'); return; }
      const attempt = { kind: 'expense' as const, key: crypto.randomUUID(), body: parsed.data };
      try { saveMoneyAttempt(attemptScope, attempt); }
      catch (caught: unknown) { setError(`요청을 보관하지 못해 전송하지 않았습니다. ${userMessageOf(caught)}`); return; }
      pending.current = attempt;
    }
    const request = pending.current, controller = scope.current;
    setSaving(true);
    try {
      const responseSchema = confirmedMoneySchema({ ...request.body, counterparty: request.body.merchant, date: request.body.expense_date });
      const saved = responseSchema.parse(await apiRequest(`${base}/expenses`, { session, signal: controller.signal, method: 'POST', headers: { 'Idempotency-Key': request.key }, body: request.body }));
      if (!controller.signal.aborted) { clearMoneyAttempt(attemptScope); pending.current = null; onLockChange?.(false); onSaved(saved.id); }
    } catch (caught: unknown) {
      if (!controller.signal.aborted) {
        // 미확인 요청의 후속 권한/검증 오류는 이전 COMMIT의 부재를 증명하지 않는다.
        const definite = !uncertain && knownMoneyRollback(caught);
        if (definite) { clearMoneyAttempt(attemptScope); pending.current = null; }
        setUncertain(!definite); setError(userMessageOf(caught));
      }
    } finally { if (!controller.signal.aborted) setSaving(false); }
  }
  return <section className="expense-panel" data-expense-form data-money-state={saving ? 'saving' : uncertain ? 'uncertain' : 'editing'} aria-label="새 지출 입력">
    <header><div><h2>새 지출 입력</h2><p>이미 사용한 비용을 KRW 확정 장부에 기록합니다.</p></div><Button tone="ghost" disabled={locked} onClick={onClose}>입력 닫기</Button></header>
    {(linkedProjectId || initialAttempt) && <p data-money-project={linkedProjectId ?? ''}>{linkedProjectId ? <>연결 프로젝트: <Link to={`/projects/${encodeURIComponent(linkedProjectId)}`}>{project?.id === linkedProjectId ? project.name : '보관된 프로젝트 보기'}</Link> · 이 프로젝트의 확정 지출로 기록합니다.</> : '보관된 요청: 프로젝트 미연결'}</p>}
    <form onSubmit={event => void submit(event)} noValidate>
      <fieldset disabled={locked}><legend>사용 내역</legend><div className="expense-fields">
        <label>금액 (KRW)<input name="amount" inputMode="decimal" value={values.amount} onChange={e => change('amount', e.target.value)} required aria-required="true" placeholder="0.00" /></label>
        <label>사용처<input name="merchant" maxLength={200} value={values.merchant} onChange={e => change('merchant', e.target.value)} required /></label>
        <label>사용일<input name="expense_date" type="date" value={values.expense_date} onChange={e => change('expense_date', e.target.value)} required /></label>
        <label>사용 시각 (선택 · 서울)<input name="expense_time" type="time" step="1" value={values.expense_time} onChange={e => change('expense_time', e.target.value)} /></label>
        <label>지출 분류 (계정)<select name="account_id" value={values.account_id} onChange={e => change('account_id', e.target.value)} required><option value="">계정 선택</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label>
        <label>예산 (선택)<select name="budget_id" value={values.budget_id} onChange={e => change('budget_id', e.target.value)}><option value="">선택 안 함</option>{initialAttempt && values.budget_id && !budgets.some(budget => budget.id === values.budget_id) && <option value={values.budget_id}>보관된 예산 {values.budget_id}</option>}{budgets.map(budget => <option key={budget.id} value={budget.id}>{budget.label}</option>)}</select></label>
      </div>
      {optionsState === 'loading' && <p role="status">계정을 불러오는 중...</p>}
      {optionsState === 'ready' && accounts.length === 0 && <p>현재 회사에 활성 지출 계정이 없습니다.</p>}
      {optionsState === 'failed' && <Button tone="neutral" onClick={() => setRevision(n => n + 1)}>계정 다시 불러오기</Button>}
      {budgetError && <p role="status">예산 조회 불가: {budgetError} 예산 없이 기록할 수 있습니다.</p>}
      <p>선택 예산과 계정의 일치·사용 가능 여부는 저장 시 다시 확인합니다.</p>
      <label>메모<textarea name="memo" maxLength={4000} value={values.memo} onChange={e => change('memo', e.target.value)} /></label></fieldset>
      {initialAttempt && <p role="status">보관된 요청의 영수증 {initialAttempt.body.receipt_tokens.length}개를 원래 첨부 토큰으로 확인합니다. 파일을 다시 업로드하지 않습니다.</p>}
      <ReceiptUploads session={session} slots={slots} setSlots={setSlots} locked={locked} />
      <label>미첨부 사유 (영수증이 없으면 필수)<textarea name="no_receipt_reason" maxLength={1000} value={values.no_receipt_reason} disabled={locked} onChange={e => change('no_receipt_reason', e.target.value)} /></label>
      <label className="expense-confirm"><input type="checkbox" checked={confirmed} disabled={locked} onChange={e => setConfirmed(e.target.checked)} />확정 후 금액·내용은 변경할 수 없으며 영수증만 추가할 수 있음을 확인했습니다.</label>
      {error && <p role="alert">{error}</p>}
      {uncertain && <p role="status">응답을 확인하지 못했습니다. 이 탭에 원래 입력과 요청 키를 보관했습니다. 새로고침하거나 다시 방문해도 같은 요청을 확인합니다. 로그아웃하면 보관한 입력을 지우므로 장부를 먼저 확인하세요.</p>}
      <Button type="submit" disabled={saving || optionsState !== 'ready' || slots.some(slot => slot.state !== 'ready')}>{saving ? '장부 기록 중...' : uncertain ? '같은 요청 재시도' : '지출 확정 기록'}</Button>
    </form>
  </section>;
}
