import { useEffect, useRef, useState } from 'react';
import { createRequestKey } from '../../services/requestKey';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { apiRequest, userMessageOf, type ApiSession } from '../../services/api';
import { isPgWorkspace } from '../../services/workspace';
import { financePath, incomeAccounts, incomeSchema, confirmedMoneySchema, type Account } from '../../screens/expenses/model';
import { Button } from '../ui/Button';
import { saveMoneyAttempt, clearMoneyAttempt, knownMoneyRollback, type MoneyAttempt, type MoneyAttemptScope } from '../../services/money-attempts';

type Props = Readonly<{ session: ApiSession; attemptScope: MoneyAttemptScope; initialAttempt: Extract<MoneyAttempt, { kind: 'income' }> | null; onSaved: (id: string) => void; onClose: () => void; onLockChange?: (locked: boolean) => void; project?: { id: string; name: string } }>;
export function IncomeForm({ session, attemptScope, initialAttempt, onSaved, onClose, onLockChange, project }: Props) {
  const linkedProjectId = initialAttempt ? initialAttempt.body.project_id : project?.id;
  const [values, setValues] = useState({ amount: initialAttempt?.body.amount ?? '', income_date: initialAttempt?.body.income_date ?? '', payer: initialAttempt?.body.payer ?? '', account_id: initialAttempt?.body.account_id ?? '', memo: initialAttempt?.body.memo ?? '' });
  const [accounts, setAccounts] = useState<Account[]>([]), [optionsState, setOptionsState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [revision, setRevision] = useState(0), [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(Boolean(initialAttempt)), [confirmed, setConfirmed] = useState(Boolean(initialAttempt));
  const scope = useRef(new AbortController()), pending = useRef(initialAttempt);
  const base = financePath(session.orgId), pg = isPgWorkspace(session.orgId), locked = saving || uncertain;
  useEffect(() => { const controller = new AbortController(); scope.current = controller; return () => controller.abort(); }, []);
  useEffect(() => { onLockChange?.(locked); }, [locked, onLockChange]);
  useEffect(() => {
    const controller = new AbortController(); setOptionsState('loading');
    apiRequest(`${base}/accounts`, { session, signal: controller.signal }).then(payload => {
      const rows = incomeAccounts(payload, pg); if (!controller.signal.aborted) { setAccounts(rows); setOptionsState('ready'); }
    }).catch((caught: unknown) => { if (!controller.signal.aborted) { setError(userMessageOf(caught)); setOptionsState('failed'); } });
    return () => controller.abort();
  }, [base, pg, session, revision]);
  function change(field: keyof typeof values, value: string) { setValues(current => ({ ...current, [field]: value })); setConfirmed(false); setError(null); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (saving) return; setError(null);
    if (!pending.current) {
      const parsed = incomeSchema.safeParse({ ...values, currency: 'KRW', ...(linkedProjectId ? { project_id: linkedProjectId } : {}) });
      if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? '입력값을 확인하세요.'); return; }
      if (!confirmed) { setError('확정 후 금액과 내용을 변경할 수 없음을 확인해 주세요.'); return; }
      const attempt = { kind: 'income' as const, key: createRequestKey(), body: parsed.data };
      try { saveMoneyAttempt(attemptScope, attempt); }
      catch (caught: unknown) { setError(`요청을 보관하지 못해 전송하지 않았습니다. ${userMessageOf(caught)}`); return; }
      pending.current = attempt;
    }
    const request = pending.current, controller = scope.current; setSaving(true);
    try {
      const responseSchema = confirmedMoneySchema({ ...request.body, counterparty: request.body.payer, date: request.body.income_date }).extend({ kind: z.literal('income'), income_date: z.literal(request.body.income_date), payer: z.literal(request.body.payer) });
      const saved = responseSchema.parse(await apiRequest(`${base}/incomes`, { session, signal: controller.signal, method: 'POST', headers: { 'Idempotency-Key': request.key }, body: request.body }));
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
  return <section className="expense-panel" data-income-form data-money-state={saving ? 'saving' : uncertain ? 'uncertain' : 'editing'} aria-label="수입 입력">
    <header><div><h2>수입 입력</h2><p>받은 돈을 KRW 확정 장부에 기록합니다. 은행 잔액을 조회하는 기능은 아닙니다.</p></div><Button tone="ghost" disabled={locked} onClick={onClose}>입력 닫기</Button></header>
    {(linkedProjectId || initialAttempt) && <p data-money-project={linkedProjectId ?? ''}>{linkedProjectId ? <>연결 프로젝트: <Link to={`/projects/${encodeURIComponent(linkedProjectId)}`}>{project?.id === linkedProjectId ? project.name : '보관된 프로젝트 보기'}</Link> · 예산과 별도로 이 프로젝트의 확정 수입에 기록합니다.</> : '보관된 요청: 프로젝트 미연결'}</p>}
    <form onSubmit={event => void submit(event)} noValidate>
      <fieldset disabled={locked}><legend>들어온 돈</legend><div className="expense-fields">
        <label>금액 (KRW)<input name="amount" inputMode="decimal" value={values.amount} onChange={e => change('amount', e.target.value)} required placeholder="0.00" /></label>
        <label>보낸 사람·받은 곳<input name="payer" maxLength={200} value={values.payer} onChange={e => change('payer', e.target.value)} required /></label>
        <label>받은 날<input name="income_date" type="date" value={values.income_date} onChange={e => change('income_date', e.target.value)} required /></label>
        <label>수입 분류<select name="account_id" value={values.account_id} onChange={e => change('account_id', e.target.value)} required><option value="">분류 선택</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label>
      </div>
      {optionsState === 'loading' && <p role="status">분류를 불러오는 중...</p>}
      {optionsState === 'ready' && accounts.length === 0 && <p>현재 공간에 활성 수입 분류가 없습니다. 돈 관리 준비 상태를 확인하세요.</p>}
      {optionsState === 'failed' && <Button tone="neutral" onClick={() => setRevision(n => n + 1)}>분류 다시 불러오기</Button>}
      <label>메모<textarea name="memo" maxLength={4000} value={values.memo} onChange={e => change('memo', e.target.value)} /></label>
      </fieldset>
      <label className="expense-confirm"><input type="checkbox" checked={confirmed} disabled={locked} onChange={e => setConfirmed(e.target.checked)} />확정 후 금액·내용을 변경할 수 없음을 확인했습니다.</label>
      {error && <p role="alert">{error}</p>}
      {uncertain && <p role="status">응답을 확인하지 못했습니다. 이 탭에 원래 입력과 요청 키를 보관했습니다. 새로고침하거나 다시 방문해도 같은 요청을 확인합니다. 로그아웃하면 보관한 입력을 지우므로 장부를 먼저 확인하세요.</p>}
      <Button type="submit" disabled={saving || optionsState !== 'ready'}>{saving ? '장부 기록 중...' : uncertain ? '같은 요청 재시도' : '수입 확정 기록'}</Button>
    </form>
  </section>;
}
