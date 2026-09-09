import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError, apiRequest, userMessageOf, type ApiSession } from '../../services/api';
import { isPgWorkspace } from '../../services/workspace';
import { budgetOptions, expenseAccounts, expenseSchema, financePath, type Account, type UploadSlot } from '../../screens/expenses/model';
import { ReceiptUploads } from './ReceiptUploads';
import { Button } from '../ui/Button';

type Props = Readonly<{ session: ApiSession; onSaved: (id: string) => void; onClose: () => void }>;
export function ExpenseForm({ session, onSaved, onClose }: Props) {
  const [values, setValues] = useState({ amount: '', expense_date: '', expense_time: '', merchant: '', account_id: '', budget_id: '', memo: '', no_receipt_reason: '' });
  const [slots, setSlots] = useState<UploadSlot[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]), [budgets, setBudgets] = useState<Account[]>([]);
  const [optionsState, setOptionsState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [revision, setRevision] = useState(0), [budgetError, setBudgetError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(false), [confirmed, setConfirmed] = useState(false);
  const scope = useRef(new AbortController());
  const pending = useRef<{ key: string; body: z.infer<typeof expenseSchema> } | null>(null);
  const base = financePath(session.orgId), pg = isPgWorkspace(session.orgId);
  useEffect(() => { const controller = new AbortController(); scope.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setOptionsState('loading');
    apiRequest(`${base}/accounts`, { session, signal: controller.signal }).then(payload => {
      const rows = expenseAccounts(payload, pg); if (!controller.signal.aborted) { setAccounts(rows); setOptionsState('ready'); }
    }).catch((caught: unknown) => { if (!controller.signal.aborted) { setError(userMessageOf(caught)); setOptionsState('failed'); } });
    apiRequest(`${base}/budgets`, { session, signal: controller.signal }).then(payload => {
      const rows = budgetOptions(payload, pg); if (!controller.signal.aborted) { setBudgets(rows); setBudgetError(null); }
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setBudgetError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [base, pg, session, revision]);
  function change(field: keyof typeof values, value: string) { setValues(current => ({ ...current, [field]: value })); setConfirmed(false); setError(null); }
  const locked = saving || uncertain;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (saving) return;
    setError(null);
    if (!pending.current) {
      if (slots.some(slot => slot.state !== 'ready')) { setError('모든 영수증 업로드를 완료하거나 실패한 파일을 제거하세요.'); return; }
      const parsed = expenseSchema.safeParse({ ...values, expense_time: values.expense_time || undefined, budget_id: values.budget_id || null, currency: 'KRW', receipt_tokens: slots.flatMap(slot => slot.upload ? [slot.upload.token] : []) });
      if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? '입력값을 확인하세요.'); return; }
      if (!confirmed) { setError('확정 후 원금과 내용을 변경할 수 없음을 확인해 주세요.'); return; }
      pending.current = { key: crypto.randomUUID(), body: parsed.data };
    }
    const request = pending.current, controller = scope.current;
    setSaving(true);
    try {
      const saved = z.object({ id: z.coerce.string(), status: z.literal('confirmed') }).parse(await apiRequest(`${base}/expenses`, { session, signal: controller.signal, method: 'POST', headers: { 'Idempotency-Key': request.key }, body: request.body }));
      if (!controller.signal.aborted) onSaved(saved.id);
    } catch (caught: unknown) {
      if (!controller.signal.aborted) {
        const definite = caught instanceof ApiError && caught.status < 500;
        if (definite) pending.current = null;
        setUncertain(!definite); setError(userMessageOf(caught));
      }
    } finally { if (!controller.signal.aborted) setSaving(false); }
  }
  return <section className="expense-panel" data-expense-form aria-label="새 지출 입력">
    <header><div><h2>새 지출 입력</h2><p>이미 사용한 비용을 KRW 확정 장부에 기록합니다.</p></div><Button tone="ghost" disabled={locked} onClick={onClose}>입력 닫기</Button></header>
    <form onSubmit={event => void submit(event)} noValidate>
      <fieldset disabled={locked}><legend>사용 내역</legend><div className="expense-fields">
        <label>금액 (KRW)<input name="amount" inputMode="decimal" value={values.amount} onChange={e => change('amount', e.target.value)} required aria-required="true" placeholder="0.00" /></label>
        <label>사용처<input name="merchant" maxLength={200} value={values.merchant} onChange={e => change('merchant', e.target.value)} required /></label>
        <label>사용일<input name="expense_date" type="date" value={values.expense_date} onChange={e => change('expense_date', e.target.value)} required /></label>
        <label>사용 시각 (선택 · 서울)<input name="expense_time" type="time" step="1" value={values.expense_time} onChange={e => change('expense_time', e.target.value)} /></label>
        <label>지출 계정<select name="account_id" value={values.account_id} onChange={e => change('account_id', e.target.value)} required><option value="">계정 선택</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label>
        <label>예산 (선택)<select name="budget_id" value={values.budget_id} onChange={e => change('budget_id', e.target.value)}><option value="">선택 안 함</option>{budgets.map(budget => <option key={budget.id} value={budget.id}>{budget.label}</option>)}</select></label>
      </div>
      {optionsState === 'loading' && <p role="status">계정을 불러오는 중...</p>}
      {optionsState === 'ready' && accounts.length === 0 && <p>현재 회사에 활성 지출 계정이 없습니다.</p>}
      {optionsState === 'failed' && <Button tone="neutral" onClick={() => setRevision(n => n + 1)}>계정 다시 불러오기</Button>}
      {budgetError && <p role="status">예산 조회 불가: {budgetError} 예산 없이 기록할 수 있습니다.</p>}
      <p>선택 예산과 계정의 일치·사용 가능 여부는 저장 시 다시 확인합니다.</p>
      <label>메모<textarea name="memo" maxLength={4000} value={values.memo} onChange={e => change('memo', e.target.value)} /></label></fieldset>
      <ReceiptUploads session={session} slots={slots} setSlots={setSlots} locked={locked} />
      <label>미첨부 사유 (영수증이 없으면 필수)<textarea name="no_receipt_reason" maxLength={1000} value={values.no_receipt_reason} disabled={locked} onChange={e => change('no_receipt_reason', e.target.value)} /></label>
      <label className="expense-confirm"><input type="checkbox" checked={confirmed} disabled={locked} onChange={e => setConfirmed(e.target.checked)} />확정 후 금액·내용은 변경할 수 없으며 영수증만 추가할 수 있음을 확인했습니다.</label>
      {error && <p role="alert">{error}</p>}
      {uncertain && <p role="status">응답을 확인하지 못했습니다. 중복 기록을 막기 위해 같은 입력과 요청 키로 결과를 다시 확인합니다.</p>}
      <Button type="submit" disabled={saving || optionsState !== 'ready' || slots.some(slot => slot.state !== 'ready')}>{saving ? '장부 기록 중...' : uncertain ? '같은 요청 재시도' : '지출 확정 기록'}</Button>
    </form>
  </section>;
}
