import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import type { ScreenDefinition } from '../routes/catalog';
import { sessionStore, useSession } from '../store/session';
import { useAccess } from '../hooks/useWorkspaceAccess';
import { apiBlob, apiUpload, userMessageOf, type ApiSession } from '../services/api';
import { Button } from '../components/ui/Button';
import { approvalAdapter, exactAmount, statusLabels, type ApprovalDetail, type ApprovalForm, type ApprovalStep, type Box, type ListRow } from './approvals/model';
import './approvals/approvals.css';

type Adapter = ReturnType<typeof approvalAdapter>;
const boxes: [Box,string][] = [['inbox','처리할 요청'],['sent','내 요청'],['completed','처리완료'],['drafts','임시저장']];
const actionLabels: Record<string,string> = { 'draft.created': '초안 생성', 'draft.updated': '초안 저장', 'draft.resubmitted': '재상신 초안 생성', submitted: '제출', withdrawn: '철회', 'decision.approve': '승인 결정', 'decision.reject': '반려 결정', 'decision.hold': '보류 결정' };
const text = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const requestUrl = (id: string, history = false) => `/approvals?request=${encodeURIComponent(id)}${history ? '&view=history' : ''}`;

// 사용자/회사 변경 후 이전 응답과 후속 쓰기/다운로드가 새 화면에 도달하지 않는다.
function useApprovalScope(session: ApiSession) {
  const mounted = useRef(true), controllers = useRef(new Set<AbortController>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); }; }, []);
  return {
    current: () => { const stored = sessionStore.getSnapshot(); return mounted.current && stored?.token === session.token && stored.orgId === session.orgId; },
    signal: () => { const controller = new AbortController(); controllers.current.add(controller); return controller.signal; },
  };
}

export function ApprovalsScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const stored = useSession();
  const session = useMemo(() => stored ? { token: stored.token, orgId: stored.orgId } : null, [stored?.token, stored?.orgId]);
  return session ? <ApprovalWorkspace key={`${session.token}:${session.orgId}`} session={session} screen={screen} /> : null;
}

function ApprovalWorkspace({ session, screen }: { session: ApiSession; screen: ScreenDefinition }) {
  const adapter = useMemo(() => approvalAdapter(session), [session]);
  const access = useAccess();
  const canRequest = !!access && (access.permissions.includes('*') || access.permissions.includes('approval.request'));
  const canDecide = !!access && (access.permissions.includes('*') || access.permissions.includes('approval.decide'));
  const [params, setParams] = useSearchParams();
  const selected = params.get('request'), creating = params.get('new') === '1';
  const box = boxes.find(([key]) => key === params.get('box'))?.[0] ?? 'inbox';
  const [identity, setIdentity] = useState<string | null>(null), [page, setPage] = useState(0);
  const [rows, setRows] = useState<{ items: ListRow[]; hasMore: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    adapter.identity(controller.signal).then(id => { if (!controller.signal.aborted) setIdentity(id); }).catch(error => { if (!controller.signal.aborted) setError(userMessageOf(error)); });
    return () => controller.abort();
  }, [adapter]);
  useEffect(() => {
    if (!identity || selected || creating) return;
    const controller = new AbortController(); setRows(null); setError(null);
    adapter.list(box, identity, page, controller.signal).then(data => { if (!controller.signal.aborted) setRows(data); }).catch(error => { if (!controller.signal.aborted) setError(userMessageOf(error)); });
    return () => controller.abort();
  }, [adapter, identity, box, page, revision, selected, creating]);
  return <div className="screen approvals-screen" data-screen-id={screen.id}>
    <header className="screen-header"><div><h1>결재</h1><p>{adapter.pg ? '회사 결재 권한자가 처리하는 공용 요청함입니다. 개인에게 배정된 단계가 아닙니다.' : '저장된 결재 경로와 실제 배정된 요청을 확인합니다.'}</p></div>
      {canRequest && <Button data-approval-create onClick={() => setParams({ new: '1' })}>새 기안</Button>}</header>
    <nav className="approvals-tabs" aria-label="결재함">{boxes.map(([key,label]) => <button key={key} aria-current={!selected && !creating && box === key ? 'page' : undefined} onClick={() => { setPage(0); setParams({ box: key }); }}>{label}</button>)}</nav>
    {error && <p role="alert">{error}</p>}
    {!identity && !error && <p role="status">인증 정보를 확인하는 중...</p>}
    {identity && (selected || creating) ? <ApprovalRecord key={selected ?? 'new'} session={session} adapter={adapter} id={selected} identity={identity} canRequest={canRequest} canDecide={canDecide} open={id => setParams({ request: id })} /> : identity && <section aria-label="요청 목록">
      <div className="approvals-actions"><Button tone="neutral" onClick={() => setRevision(n => n + 1)}>새로고침</Button><span>{page + 1}페이지 · 페이지당 25건</span></div>
      {!rows && !error && <p role="status">목록을 불러오는 중...</p>}
      {rows && <><ul className="approvals-list">{rows.items.map(row => <li key={row.id} data-approval-row={row.id}><Link to={requestUrl(row.id)}>{row.title || '제목 없는 초안'}</Link><span>{statusLabels[row.status] ?? row.status}</span><small>요청자 {row.requesterName ?? row.requester_id ?? '기록 없음'} · #{row.id}</small></li>)}</ul>
        {!rows.items.length && <p>표시할 요청이 없습니다.</p>}
        <div className="approvals-actions"><Button tone="neutral" disabled={page === 0} onClick={() => setPage(n => n - 1)}>이전 페이지</Button><Button tone="neutral" disabled={!rows.hasMore} onClick={() => setPage(n => n + 1)}>다음 페이지</Button></div></>}
    </section>}
  </div>;
}

function ApprovalRecord({ session, adapter, id, identity, canRequest, canDecide, open }: { session: ApiSession; adapter: Adapter; id: string | null; identity: string; canRequest: boolean; canDecide: boolean; open: (id: string) => void }) {
  const scope = useApprovalScope(session);
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<Adapter['history']>> | null>(null);
  const [forms, setForms] = useState<ApprovalForm[]>([]), [candidates, setCandidates] = useState<{ id: string; name: string }[]>([]);
  const [formKey, setFormKey] = useState('generic'), [title, setTitle] = useState(''), [body, setBody] = useState<Record<string,unknown>>({});
  const [steps, setSteps] = useState<ApprovalStep[]>([{ approver_id: '', mode: 'sequential', kind: 'approve' }]);
  // Only a new route belongs to the default form. Restored drafts and explicit edits own theirs.
  const routeInitialized = useRef(!!id);
  function editSteps(update: (steps: ApprovalStep[]) => ApprovalStep[]) {
    routeInitialized.current = true; setSteps(update);
  }
  const [staged, setStaged] = useState<{ token: string; filename: string }[]>([]);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [comment, setComment] = useState(''), [password, setPassword] = useState(''), [selfConfirmed, setSelfConfirmed] = useState(false);
  const own = !id || detail?.requester_id === identity;
  const editable = canRequest && own && (!id || detail?.status === 'draft');
  const activeForm = forms.find(form => form.key === formKey);
  const mine = detail?.steps?.filter(step => step.approver_id === identity && ['pending','held'].includes(step.status ?? '')).sort((a,b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))[0];
  const blockedStep = !!mine && mine.mode === 'sequential' && detail?.steps?.some(step => (step.ordinal ?? 0) < (mine.ordinal ?? 0) && ['pending','held'].includes(step.status ?? ''));
  const decisionAllowed = detail?.status === 'pending' && canDecide && (adapter.pg || !!mine);
  function populate(value: ApprovalDetail) {
    setDetail(value); setFormKey(value.form_key ?? 'generic'); setTitle(value.title ?? ''); setBody(value.body ?? {});
    if (value.steps?.length) setSteps(value.steps); else setSteps([{ approver_id: '', mode: 'sequential', kind: 'approve' }]);
  }
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    Promise.all([adapter.detail(id, controller.signal), adapter.history(id, controller.signal)]).then(([value, events]) => {
      if (!controller.signal.aborted) { populate(value); setHistory(events); }
    }).catch(error => { if (!controller.signal.aborted) setError(userMessageOf(error)); });
    return () => controller.abort();
  }, [adapter, id]);
  useEffect(() => {
    if (!editable) return;
    const controller = new AbortController();
    Promise.all([adapter.forms(controller.signal), adapter.pg ? Promise.resolve([]) : adapter.candidates(controller.signal)]).then(([forms, candidates]) => {
      if (!controller.signal.aborted) {
        setForms(forms); setCandidates(candidates);
        if (!routeInitialized.current) {
          routeInitialized.current = true;
          const route = forms.find(form => form.key === 'generic')?.route;
          if (!adapter.pg && route?.length) setSteps(route);
        }
      }
    }).catch(error => { if (!controller.signal.aborted) setError(userMessageOf(error)); });
    return () => controller.abort();
  }, [adapter, editable]);
  async function operation(work: (signal: AbortSignal) => Promise<void>) {
    if (busy || !scope.current()) return;
    setBusy(true); setError(null); setNotice(null);
    try { await work(scope.signal()); }
    catch (error) { if (scope.current()) setError(userMessageOf(error)); }
    finally { if (scope.current()) { setBusy(false); setPassword(''); } }
  }
  async function save(signal: AbortSignal) {
    const payload = { form_key: formKey, title, body, ...(!adapter.pg ? { steps: steps.filter(step => step.approver_id).map(({ approver_id, mode, kind }) => ({ approver_id, mode, kind })) } : {}) };
    const value = await adapter.mutate(id ? adapter.detailPath(id) + '/draft' : adapter.root + '/drafts', id ? 'PATCH' : 'POST', id ? { ...payload, expected_version: detail!.version, receipt_tokens: staged.map(file => file.token) } : payload, signal);
    if (!scope.current()) return null;
    populate(value); setStaged([]); setNotice('초안을 저장했습니다. 제출 전까지 결재함에 공개되지 않습니다.');
    if (!id) open(value.id);
    else { const events = await adapter.history(id, signal); if (scope.current()) setHistory(events); }
    return value;
  }
  async function submit(signal: AbortSignal) {
    if (!id || !detail || !activeForm) return;
    // 편집 내용 저장과 명시적 제출은 별도 API다. 제출 실패 시 저장된 초안/입력은 그대로 남긴다.
    const saved = await save(signal); if (!saved || !scope.current()) return;
    const value = await adapter.mutate(adapter.detailPath(id) + '/submit', 'POST', { expected_version: saved.version, form_revision: activeForm.revision }, signal);
    if (!scope.current()) return;
    populate(value); const events = await adapter.history(id, signal); if (scope.current()) setHistory(events);
  }
  async function transition(action: 'approve' | 'reject' | 'hold' | 'withdraw' | 'resubmit', signal: AbortSignal) {
    if (!detail) return;
    const decision = ['approve','reject','hold'].includes(action);
    const payload = decision ? { decision: action, comment, ...(adapter.pg ? { confirm_self_decision: selfConfirmed } : action === 'approve' && detail.requires_reauth ? { reauth_password: password } : {}) } : { expected_version: detail.version };
    const value = await adapter.mutate(adapter.detailPath(detail.id) + '/' + (decision ? 'actions' : action), 'POST', payload, signal);
    if (!scope.current()) return;
    setSelfConfirmed(false); setPassword('');
    if (action === 'resubmit') { open(value.id); return; }
    populate(value); const events = await adapter.history(value.id, signal); if (scope.current()) setHistory(events);
  }
  async function upload(file: File, signal: AbortSignal) {
    const uploaded = z.object({ token: z.string() }).parse(await apiUpload(adapter.root + '/receipt-uploads', file, { session, signal }));
    if (scope.current()) setStaged(files => [...files, { token: uploaded.token, filename: file.name }]);
  }
  async function download(fileId: string, signal: AbortSignal) {
    if (!detail) return;
    const result = await apiBlob(adapter.detailPath(detail.id) + '/receipts/' + encodeURIComponent(fileId), { session, signal });
    if (!scope.current()) return;
    const url = URL.createObjectURL(result.blob);
    try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename; document.body.append(anchor); anchor.click(); anchor.remove(); }
    finally { URL.revokeObjectURL(url); }
  }
  return <section className="approval-record" data-approval-detail={detail?.id} data-operation-state={busy ? 'busy' : 'idle'} aria-label="결재 상세">
    {error && <p role="alert">{error} 입력한 초안은 자동으로 지우지 않습니다.</p>}{notice && <p role="status">{notice}</p>}
    {id && !detail && !error && <p role="status">상세와 기록을 불러오는 중...</p>}
    {detail && <header><h2>{detail.title || '제목 없는 초안'}</h2><p data-approval-status={detail.status}>{statusLabels[detail.status] ?? detail.status} · 버전 {detail.version} · 요청 #{detail.id}</p>
      <div className="approvals-actions"><Link to={requestUrl(detail.id)}>상세 URL</Link><Link to={requestUrl(detail.id,true) + '#approval-history'}>이력 URL</Link>{detail.predecessor_id && <Link to={requestUrl(detail.predecessor_id)}>이전 요청 원본</Link>}</div>
      <p>요청자 ID: {detail.requester_id ?? '기록 없음'}</p></header>}
    {editable && <div data-approval-editor>
      {id && error && <Button tone="neutral" disabled={busy} onClick={() => void operation(async signal => {
        const latest = await adapter.detail(id, signal); if (!scope.current()) return;
        if (latest.status !== 'draft') { setError('서버에서 이미 제출 또는 처리되었습니다. 입력 내용은 남겨 두며 원본을 덮어쓰지 않습니다.'); return; }
        setDetail(latest); setNotice('최신 서버 버전을 확인했습니다. 입력은 유지했습니다. 다음 임시저장은 현재 서버 초안을 이 입력으로 갱신합니다.');
      })}>최신 버전 확인 (입력 유지)</Button>}
      <fieldset disabled={busy}><legend>구조화 기안</legend>
        <label>양식<select aria-label="양식" value={formKey} onChange={event => { const key = event.target.value; routeInitialized.current = true; setFormKey(key); const route = forms.find(form => form.key === key)?.route; if (!adapter.pg && route?.length) setSteps(route); }}>{!forms.some(form => form.key === formKey) && <option value={formKey}>{formKey}</option>}{forms.map(form => <option key={form.key} value={form.key}>{form.name}</option>)}</select></label>
        <div className="approvals-actions"><span data-form-revision={activeForm?.revision}>양식 revision {activeForm?.revision ?? '확인 필요'}</span><Button tone="neutral" onClick={() => void operation(async signal => { const forms = await adapter.forms(signal); if (scope.current()) setForms(forms); })}>양식 새로고침</Button></div>
        <label>제목<input value={title} maxLength={300} aria-required onChange={event => setTitle(event.target.value)} /></label>
        {activeForm?.fields.map(field => <label key={field.key}>{field.label}{field.required ? ' (필수)' : ''}{field.type === 'krw' ? ' · KRW' : ''}
          {field.type === 'textarea' ? <textarea value={text(body[field.key])} aria-required={field.required} onChange={event => setBody(body => ({ ...body, [field.key]: event.target.value }))} /> : <input type="text" inputMode={field.type === 'krw' ? 'decimal' : 'text'} value={text(body[field.key])} aria-required={field.required} placeholder={field.type === 'krw' ? '1000.00' : undefined} onChange={event => setBody(body => ({ ...body, [field.key]: event.target.value }))} />}</label>)}
        {Object.entries(body).filter(([key]) => !activeForm?.fields.some(field => field.key === key)).map(([key,value]) => <label key={key}>{key} (기존 본문)<textarea value={text(value)} onChange={event => setBody(body => ({ ...body, [key]: event.target.value }))} /></label>)}
        {!adapter.pg && <section aria-label="저장할 결재 경로"><h3>결재 경로</h3>{steps.map((step,index) => <div className="approval-step-edit" key={index}><label>결재자 {index + 1}<select aria-label={`결재자 ${index + 1}`} value={step.approver_id} onChange={event => editSteps(steps => steps.map((step,i) => i === index ? { ...step, approver_id: event.target.value } : step))}><option value="">선택</option>{step.approver_id && !candidates.some(item => item.id === step.approver_id) && <option value={step.approver_id}>{step.approver_id} (현재 후보 아님)</option>}{candidates.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</select></label>
          <label>진행 방식 {index + 1}<select aria-label={`진행 방식 ${index + 1}`} value={step.mode} onChange={event => editSteps(steps => steps.map((step,i) => i === index ? { ...step, mode: event.target.value as ApprovalStep['mode'] } : step))}><option value="sequential">순차</option><option value="parallel">병렬</option></select></label><Button tone="ghost" onClick={() => editSteps(steps => steps.filter((_,i) => i !== index))}>단계 {index + 1} 제거</Button></div>)}<Button tone="neutral" onClick={() => editSteps(steps => [...steps, { approver_id: '', mode: 'sequential', kind: 'approve' }])}>결재자 추가</Button></section>}
        <p>{adapter.pg ? '제출하면 현재 회사 결재 권한자 누구나 처리할 수 있습니다. 대상자 참조는 결재자 배정이 아닙니다.' : '결재자와 순서를 저장합니다. 현재 활성 결재 권한자 후보만 표시하며 제출 시 서버가 다시 검증합니다.'}</p>
        {id ? <label>첨부 파일<input type="file" accept="image/jpeg,image/png,application/pdf" disabled={staged.length + (detail?.attachment_snapshot.length ?? 0) >= 5} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void operation(signal => upload(file,signal)); }} /></label> : <p>초안을 저장한 뒤 원본 첨부를 업로드할 수 있습니다.</p>}
        <p>JPEG · PNG · PDF, 파일당 10MiB, 최대 5개. 제출 후 본문과 첨부는 변경할 수 없습니다.</p>
        <ul>{staged.map(file => <li key={file.token} data-staged-receipt>{file.filename} · 임시 업로드, 초안 저장 시 연결</li>)}</ul>
        <div className="approvals-actions"><Button disabled={!activeForm} onClick={() => void operation(async signal => { await save(signal); })}>임시저장</Button>{id && <Button disabled={!activeForm} onClick={() => void operation(submit)}>제출</Button>}</div>
      </fieldset>
    </div>}
    {detail && !editable && <section aria-label="제출 원본"><h3>제출 원본</h3><p>양식 {detail.form_snapshot ? `${detail.form_snapshot.name} · revision ${detail.form_snapshot.revision}` : '기존 기록에 양식 snapshot 없음'}</p>
      {exactAmount(detail) !== null && <p data-exact-amount>금액 {exactAmount(detail)} KRW</p>}
      <dl>{Object.entries(detail.body ?? {}).map(([key,value]) => <div key={key}><dt>{detail.form_snapshot?.fields.find(field => field.key === key)?.label ?? key}</dt><dd>{text(value)}</dd></div>)}</dl>
      {adapter.pg ? <p>회사 공용 결정 권한 · 개인 배정 단계 없음{detail.target_user_id ? ` · 대상 참조 ID ${detail.target_user_id}` : ''}</p> : <ol>{detail.steps?.map((step,index) => <li key={index}>{index + 1}. {step.approver_id} · {step.mode === 'sequential' ? '순차' : '병렬'} · {statusLabels[step.status ?? ''] ?? step.status} {step.comment && `· ${step.comment}`} {step.decided_at}</li>)}</ol>}
      {detail.subject_id && <p>관련 참조: {detail.subject_type} #{detail.subject_id} (별도 원천 열람 권한 필요)</p>}
      {detail.decision_note && <p>처리 의견: {detail.decision_note}</p>}
    </section>}
    {detail && <section aria-label="첨부 원본"><h3>첨부 원본</h3><ul>{detail.attachment_snapshot.map(file => <li key={file.file_id}><Button tone="neutral" disabled={busy} onClick={() => void operation(signal => download(file.file_id,signal))}>{file.filename} 원본 다운로드</Button><small>{file.size_bytes} bytes · SHA-256 {file.checksum_sha256}</small></li>)}</ul>{!detail.attachment_snapshot.length && <p>연결된 원본 첨부가 없습니다.</p>}</section>}
    {decisionAllowed && <fieldset disabled={busy}><legend>결정</legend>{blockedStep && <p>앞선 순차 단계가 대기 또는 보류 중입니다. 해당 결재자가 먼저 처리해야 합니다.</p>}
      <label>처리 의견 / 반려 사유<textarea maxLength={2000} value={comment} onChange={event => setComment(event.target.value)} /></label>
      {!adapter.pg && detail.requires_reauth && <label>재인증 비밀번호<input aria-label="재인증 비밀번호" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /><small>고액 승인에는 본인 비밀번호가 필요합니다. 전송 후 비밀번호를 지웁니다.</small></label>}
      {adapter.pg && own && <label className="approval-confirm"><input type="checkbox" checked={selfConfirmed} onChange={event => setSelfConfirmed(event.target.checked)} />본인 요청을 직접 결정함을 확인합니다</label>}
      <div className="approvals-actions">{(['approve','reject', ...(!adapter.pg ? ['hold'] : [])] as ('approve'|'reject'|'hold')[]).map(action => <Button key={action} disabled={blockedStep} tone={action === 'approve' ? 'primary' : 'neutral'} onClick={() => void operation(signal => transition(action,signal))}>{action === 'approve' ? '승인' : action === 'reject' ? '반려' : '보류'}</Button>)}</div>
      <p>결재 결과만 기록합니다. 계정·역할 변경이나 송금은 실행하지 않습니다.</p>
    </fieldset>}
    {detail && own && canRequest && <div className="approvals-actions">{detail.status === 'pending' && <Button tone="neutral" disabled={busy} onClick={() => void operation(signal => transition('withdraw',signal))}>요청 철회</Button>}{['rejected','withdrawn'].includes(detail.status) && <Button disabled={busy} onClick={() => void operation(signal => transition('resubmit',signal))}>새 초안으로 재상신</Button>}</div>}
    {detail && <section id="approval-history" aria-label="기록된 이력"><h3>기록된 이력</h3><p>서버에 실제 기록된 이벤트만 표시합니다. 이전 요청의 이력은 원본 링크에서 확인합니다.</p>{history?.length === 0 && <p>기록된 이벤트가 없습니다.</p>}<ol>{history?.map((event,index) => <li key={event.id ?? `legacy-${index}`}><time>{event.created_at}</time> · {actionLabels[event.action] ?? event.action} · {statusLabels[event.status] ?? event.status} · 처리자 {event.actor_id ?? '기록 없음'}{event.comment && <p>{event.comment}</p>}{event.snapshot == null ? <p>이전 결정 기록: 당시 본문·양식·첨부 snapshot 없음</p> : <details><summary>기록 당시 snapshot</summary><pre>{JSON.stringify(event.snapshot,null,2)}</pre></details>}</li>)}</ol></section>}
  </section>;
}
