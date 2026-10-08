import { useEffect, useMemo, useRef, useState } from 'react';
import { createRequestKey } from '../../services/requestKey';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { apiRequest, ApiError, userMessageOf, type ApiSession } from '../../services/api';
import { authenticatedUserId, isPgToken } from '../../services/auth';
import { loadMoneyAttempt, knownMoneyRollback, type MoneyAttempt, type MoneyAttemptScope } from '../../services/money-attempts';
import { isPgWorkspace } from '../../services/workspace';
import { useAccess } from '../../hooks/useWorkspaceAccess';
import { Button } from '../../components/ui/Button';
import { IncomeForm } from '../../components/common/IncomeForm';
import { ExpenseForm } from '../../components/common/ExpenseForm';
import { financePath, financeSetupSchema } from '../expenses/model';
import '../expenses/expense.css';
import './project-finance.css';

const amount = z.string().regex(/^-?\d+\.\d{2}$/);
const budget = z.object({ id: z.string(), name: z.string(), amount, unit: z.string(), status: z.string(), version: z.number(), account_id: z.string().nullable(), spending: amount.nullable(), remaining: amount.nullable() });
const summarySchema = z.object({ project_id: z.string(), generated_at: z.string(), scope: z.string(), basis: z.literal('explicit_posted_project'),
  totals: z.array(z.object({ unit: z.string(), allocated: amount, spending: amount, remaining: amount.nullable(), income: amount.nullable(), net: amount.nullable() })),
  budgets: z.array(budget), available_budgets: z.array(z.object({ id: z.string(), name: z.string(), version: z.number() })),
  entries: z.array(z.object({ id: z.string(), budget_id: z.string().nullable(), unit: z.string(), date: z.string(), memo: z.string().nullable(), expense: amount, income: amount })),
});
type Summary = z.infer<typeof summarySchema>;
type Props = Readonly<{ projectId: string; projectName: string; session: ApiSession }>;
const unitLabel = (unit: string) => ({ ledger_decimal: '통화 미지정 장부 단위', currency_unspecified: '통화 미지정 예산 단위' })[unit] ?? unit;

export function ProjectFinancePanel(props: Props) {
  const access = useAccess();
  const has = (permission: string) => Boolean(access?.permissions.includes('*') || access?.permissions.includes(permission) || access?.menus.includes(permission));
  if (!access) return <p role="status">프로젝트 재무 권한을 확인하는 중입니다.</p>;
  if (!access.modules.includes('finance')) return <p data-project-money-unavailable>프로젝트 재무: 재무 기능이 꺼져 있습니다.</p>;
  if (!['menu.finance', 'menu.projects', 'project.read', 'budget.read', 'transaction.read'].every(has)) return <p data-project-money-unavailable>프로젝트 재무: 조회 권한이 없습니다.</p>;
  return <ProjectMoneyContent {...props} canBudget={has('project.write') && has('budget.write')} canExpense={has('transaction.write') && (isPgWorkspace(props.session.orgId) || has('transaction.confirm'))} />;
}
function ProjectMoneyContent({ projectId, projectName, session, canBudget, canExpense }: Props & { canBudget: boolean; canExpense: boolean }) {
  const endpoint = `${isPgWorkspace(session.orgId) ? '/pg' : ''}/projects/${encodeURIComponent(projectId)}/money`;
  const [summary, setSummary] = useState<Summary | null>(null), [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [revision, setRevision] = useState(0), [form, setForm] = useState<'budget' | 'expense' | 'income' | null>(null);
  const [notice, setNotice] = useState<string | null>(null), [page, setPage] = useState(0);
  const [attemptScope, setAttemptScope] = useState<MoneyAttemptScope | null>(null), [initialAttempt, setInitialAttempt] = useState<MoneyAttempt | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [setup, setSetup] = useState<z.infer<typeof financeSetupSchema> | null>(null), [setupError, setSetupError] = useState<string | null>(null);
  const incomeReady = setup !== null && !setup.missing.includes('income') && !setup.missing.includes('cash');
  const expenseReady = setup !== null && !setup.missing.includes('expense') && !setup.missing.includes('cash');
  useEffect(() => {
    const controller = new AbortController(); setSetup(null); setSetupError(null);
    apiRequest(`${financePath(session.orgId)}/setup`, { session, signal: controller.signal }).then(payload => {
      const value = financeSetupSchema.parse(payload); if (!controller.signal.aborted) setSetup(value);
    }).catch(caught => { if (!controller.signal.aborted) setSetupError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [session, revision]);
  useEffect(() => {
    const controller = new AbortController();
    authenticatedUserId(session.token, controller.signal).then(userId => {
      if (controller.signal.aborted) return;
      if (!session.orgId) throw new Error('돈을 기록할 공간을 선택하세요.');
      const scope: MoneyAttemptScope = { userId, source: isPgToken(session.token) ? 'pg' : 'legacy', orgId: session.orgId };
      const attempt = loadMoneyAttempt(scope);
      setAttemptScope(scope); setInitialAttempt(attempt);
      if (attempt?.body.project_id === projectId) setForm(attempt.kind);
    }).catch(caught => { if (!controller.signal.aborted) setRecoveryError(`보관된 요청을 확인하지 못해 새 입력을 차단했습니다. ${userMessageOf(caught)}`); });
    return () => controller.abort();
  }, [session, projectId]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setSummary(null); setError(null);
    apiRequest(endpoint, { session, signal: controller.signal }).then(payload => {
      const value = summarySchema.parse(payload);
      if (!controller.signal.aborted) { setSummary(value); setLoading(false); }
    }).catch(caught => { if (!controller.signal.aborted) { setLoading(false); setError(userMessageOf(caught)); setForm(null); } });
    return () => controller.abort();
  }, [endpoint, session, revision]);
  const project = useMemo(() => ({ id: projectId, name: projectName, budgets: (summary?.budgets ?? []).filter(row => row.unit === 'KRW' && ['active', 'approved'].includes(row.status)).map(row => ({ id: row.id, label: row.name })) }), [projectId, projectName, summary]);
  const saved = () => { setInitialAttempt(null); setForm(null); setRevision(value => value + 1); setNotice('프로젝트 재무 기록을 저장했습니다. 확정 장부를 다시 조회합니다.'); };
  return <section className="project-finance" data-project-money data-setup-loaded={setup !== null} data-income-ready={incomeReady} data-expense-ready={expenseReady} aria-label="프로젝트 재무">
    <header><div><h3>프로젝트 재무</h3><p>배정 예산과 이 프로젝트에 명시적으로 연결된 확정 장부만 집계합니다.</p></div>
      <Button size="small" tone="neutral" disabled={loading || form !== null} onClick={() => setRevision(value => value + 1)}>재무 새로고침</Button></header>
    {notice && <p role="status">{notice}</p>}
    {recoveryError && <p role="alert">{recoveryError}</p>}
    {setupError && <p role="alert">새 입력 준비 상태를 확인하지 못했습니다: {setupError}</p>}
    {!setup && !setupError && <p role="status">수입·지출별 입력 준비 상태를 확인하는 중입니다.</p>}
    {setup && setup.missing.length > 0 && <p>준비가 필요한 분류: {setup.missing.map(kind => ({ income: '수입', expense: '지출', cash: '현금 계정' })[kind]).join(', ')}. 다른 분류가 준비되어 있으면 해당 방향의 입력은 계속할 수 있습니다. <Link to="/finance">돈 관리 준비 확인</Link></p>}
    {!attemptScope && !recoveryError && <p role="status">계정과 보관된 돈 기록 요청을 확인하는 중입니다.</p>}
    {initialAttempt && initialAttempt.body.project_id !== projectId && <p data-project-money-pending>다른 프로젝트 또는 미연결 보관 요청이 있습니다. 새 입력 전에 <Link to="/finance">장부에서 원래 요청 확인</Link>을 완료하세요.</p>}
    {loading ? <p role="status">확정 장부를 불러오는 중입니다.</p> : error ? <p role="alert">프로젝트 재무 조회 불가: {error}</p> : summary && <>
      <p className="project-finance__basis">조회 시각: <time dateTime={summary.generated_at}>{new Date(summary.generated_at).toLocaleString('ko-KR')}</time> · {summary.scope === 'project' ? '내 프로젝트 범위' : '회사 범위'}</p>
      {!summary.totals.length && <p data-money-empty>연결된 예산과 확정 장부가 없습니다. 예산을 명시적으로 배정해 시작하세요.</p>}
      {summary.totals.map(total => <div className="project-finance__currency" key={total.unit} data-money-unit={total.unit}><h4>{unitLabel(total.unit)}</h4><dl className="project-finance__totals">
        <div><dt>배정 예산</dt><dd data-money-stat="allocated">{total.allocated}</dd></div>
        <div><dt>확정 지출</dt><dd data-money-stat="spending">{total.spending}</dd></div>
        <div><dt>잔여 예산</dt><dd data-money-stat="remaining">{total.remaining ?? '통화 미지정으로 계산 불가'}</dd></div>
        {total.income !== null && <><div><dt>확정 수입</dt><dd data-money-stat="income">{total.income}</dd></div><div><dt>기록상 수입 − 지출</dt><dd data-money-stat="net">{total.net}</dd></div></>}
      </dl></div>)}
      <p>잔여 예산은 배정 예산 − 확정 지출입니다. 수입·지출 차액과 잔여 예산은 은행 잔액이 아닙니다. 미연결 금액은 포함하지 않으며 통화별로 구분합니다.</p>
      <div className="project-finance__actions"><Button size="small" disabled={!canBudget || form !== null || !attemptScope || initialAttempt !== null} onClick={() => setForm('budget')}>예산 배정</Button><Button size="small" disabled={!canExpense || !expenseReady || form !== null || !attemptScope || initialAttempt !== null} onClick={() => setForm('expense')}>프로젝트 지출 기록</Button><Button size="small" disabled={!canExpense || !incomeReady || form !== null || !attemptScope || initialAttempt !== null} onClick={() => setForm('income')}>프로젝트 수입 기록</Button><Link to="/finance">재무 장부 보기</Link></div>
      {form === 'budget' && canBudget && <ProjectBudgetForm endpoint={endpoint} projectId={projectId} session={session} available={summary.available_budgets} onSaved={saved} onClose={() => setForm(null)} />}
      {form === 'income' && canExpense && attemptScope && (incomeReady || initialAttempt) && <IncomeForm session={session} attemptScope={attemptScope} initialAttempt={initialAttempt?.kind === 'income' ? initialAttempt : null} project={project} onSaved={saved} onClose={() => setForm(null)} />}
      {form === 'expense' && canExpense && attemptScope && (expenseReady || initialAttempt) && <ExpenseForm session={session} attemptScope={attemptScope} initialAttempt={initialAttempt?.kind === 'expense' ? initialAttempt : null} project={project} onSaved={saved} onClose={() => setForm(null)} />}
      {summary.budgets.length > 0 && <details open><summary>배정 예산 {summary.budgets.length}건</summary><ul className="project-finance__budgets">{summary.budgets.map(row => <li key={row.id} data-money-budget={row.id}><strong>{row.name}</strong><span>{unitLabel(row.unit)} · 배정 {row.amount}</span><span>확정 지출 {row.spending ?? '통화 미지정'} · 잔여 {row.remaining ?? '계산 불가'}</span><small>{['active', 'approved'].includes(row.status) ? '사용 가능' : '사용 종료 또는 승인 전'}</small></li>)}</ul></details>}
      <details><summary>연결된 확정 장부 {summary.entries.length}건</summary>{summary.entries.length ? <><div className="project-finance__ledger"><table><thead><tr><th>일자·메모</th><th>통화</th><th>확정 지출</th><th>확정 수입</th><th>예산</th></tr></thead><tbody>{summary.entries.slice(page * 10, page * 10 + 10).map(entry => <tr key={entry.id}><td>{entry.date}<br />{entry.memo}</td><td>{unitLabel(entry.unit)}</td><td>{entry.expense}</td><td>{entry.income}</td><td>{summary.budgets.find(row => row.id === entry.budget_id)?.name ?? '예산 미연결'}</td></tr>)}</tbody></table></div><div className="project-finance__actions"><Button size="small" disabled={page === 0} onClick={() => setPage(value => value - 1)}>이전 기록</Button><Button size="small" disabled={(page + 1) * 10 >= summary.entries.length} onClick={() => setPage(value => value + 1)}>다음 기록</Button></div></> : <p>연결된 확정 장부가 없습니다.</p>}</details>
    </>}
  </section>;
}
function ProjectBudgetForm({ endpoint, projectId, session, available, onSaved, onClose }: Readonly<{ endpoint: string; projectId: string; session: ApiSession; available: Summary['available_budgets']; onSaved: () => void; onClose: () => void }>) {
  const [mode, setMode] = useState('create'), [name, setName] = useState(''), [amount, setAmount] = useState(''), [selected, setSelected] = useState('');
  const [confirmed, setConfirmed] = useState(false), [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState<string | null>(null);
  const pending = useRef<{ key: string; route: string; body: unknown } | null>(null), scope = useRef(new AbortController());
  useEffect(() => { const controller = new AbortController(); scope.current = controller; return () => controller.abort(); }, []);
  const locked = saving || uncertain;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (saving) return; setError(null);
    if (!pending.current) {
      if (!confirmed) { setError('예산 연결 범위를 확인해 주세요.'); return; }
      if (mode === 'create' && (!name.trim() || !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(amount) || !/[1-9]/.test(amount))) { setError('예산 이름과 0보다 큰 금액을 소수점 두 자리 이내로 입력하세요.'); return; }
      const budget = available.find(row => row.id === selected);
      if (mode === 'associate' && !budget) { setError('연결할 예산을 선택하세요.'); return; }
      pending.current = { key: createRequestKey(), route: mode === 'create' ? `${endpoint}/budgets` : `${endpoint}/budgets/${encodeURIComponent(selected)}/associate`, body: mode === 'create' ? { name: name.trim(), amount, currency: 'KRW' } : { expected_version: budget!.version } };
    }
    const request = pending.current, controller = scope.current; setSaving(true);
    try { z.object({ id: z.string().min(1), project_id: z.literal(projectId), version: z.number().int().positive() }).parse(await apiRequest(request.route, { session, signal: controller.signal, method: 'POST', body: request.body, headers: { 'Idempotency-Key': request.key } })); if (!controller.signal.aborted) onSaved(); }
    catch (caught) {
      if (!controller.signal.aborted) {
        // 후속 거부는 이전 COMMIT의 부재를 증명하지 않는다. 최초 연결 버전 충돌만 안전하게 다시 선택한다.
        const definite = !uncertain && (knownMoneyRollback(caught) || (mode === 'associate' && caught instanceof ApiError && caught.status === 409 && caught.code === 'VERSION_CONFLICT'));
        if (definite) pending.current = null;
        setUncertain(!definite); setError(userMessageOf(caught));
      }
    }
    finally { if (!controller.signal.aborted) setSaving(false); }
  }
  return <form className="project-finance__form" data-project-budget-form onSubmit={event => void submit(event)}><fieldset disabled={locked}><legend>프로젝트 예산 배정</legend>
    <label>배정 방법<select value={mode} onChange={event => { setMode(event.target.value); setConfirmed(false); }}><option value="create">새 예산 만들기</option><option value="associate">기존 미연결 예산 연결</option></select></label>
    {mode === 'create' ? <><label>예산 이름<input name="budget_name" value={name} maxLength={200} onChange={event => setName(event.target.value)} /></label><label>배정 금액 (KRW)<input name="budget_amount" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /></label></> : <label>미연결 예산<select value={selected} onChange={event => setSelected(event.target.value)}><option value="">예산 선택</option>{available.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
    <p>이후 선택하는 새 장부에만 프로젝트가 연결됩니다. 과거 미연결 장부와 통화는 변경하지 않으며, 배정한 예산은 다른 프로젝트로 옮길 수 없습니다.</p>
    <label className="expense-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />이 프로젝트에 예산을 배정하는 것을 확인했습니다.</label></fieldset>
    {error && <p role="alert">{error}</p>}{uncertain && <p role="status">응답을 확인하지 못했습니다. 같은 요청 키로 결과를 다시 확인합니다.</p>}
    <div className="project-finance__actions"><Button type="submit" disabled={saving}>{uncertain ? '같은 예산 요청 재시도' : saving ? '배정 중...' : '예산 배정 저장'}</Button><Button tone="neutral" disabled={locked} onClick={onClose}>취소</Button></div>
  </form>;
}
