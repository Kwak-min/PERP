import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError, apiCsvUpload, apiRequest, userMessageOf, type ApiSession } from '../../services/api';
import { Button } from '../../components/ui/Button';
import { expenseAccounts, financePath, type Account } from '../expenses/model';
import { isPgWorkspace } from '../../services/workspace';

const targetValues = ['external_id', 'expense_date', 'merchant', 'amount', 'currency', 'account_code', 'memo'] as const;
const headerSchema = z.object({ sourceOrdinal: z.number(), name: z.string(), normalizedName: z.string(), suggestedTarget: z.enum(targetValues).nullable(), disposition: z.string() });
const issueSchema = z.object({ code: z.string(), message: z.string().optional(), logicalRecordOrdinal: z.number().optional() });
const summarySchema = z.object({ total: z.number(), selected: z.number(), excluded: z.number(), errors: z.number(), duplicates: z.number(), amount: z.string().optional(), created: z.number().optional(), reused: z.number().optional() });
const uploadSchema = z.object({ upload_id: z.string(), expires_at: z.string(), headers: z.array(headerSchema), mapping_issues: z.array(issueSchema) });
const jobSchema = z.object({ job_id: z.string(), upload_id: z.string(), state: z.enum(['ready', 'invalid', 'superseded', 'completed']), content_expired: z.boolean(), headers: z.array(headerSchema).optional(), issues: z.array(issueSchema).optional(), summary: summarySchema });
// A commit response is a result, not a preview/job DTO. Keep only safe recovery fields.
const resultSchema = z.object({ job_id: z.string(), state: z.literal('completed'), summary: summarySchema.extend({ created: z.number(), reused: z.number(), amount: z.string() }) });
const rowSchema = z.object({ logicalRecordOrdinal: z.number(), values: z.object({ externalId: z.string().nullable(), expenseDate: z.string(), merchant: z.string(), amount: z.string(), currency: z.string(), accountCode: z.string().nullable(), memo: z.string().nullable() }).nullable().optional(), valid: z.boolean().optional(), issues: z.array(issueSchema).optional(), warnings: z.array(issueSchema).optional(), disposition: z.enum(['create', 'reuse', 'excluded']), duplicate_confirmed: z.boolean().optional(), result: z.object({ id: z.string() }).nullable().optional() });
const rowsSchema = z.object({ total: z.number(), items: z.array(rowSchema), content_expired: z.boolean().optional() });
type Job = z.infer<typeof jobSchema>;
type Row = z.infer<typeof rowSchema>;
type Result = z.infer<typeof resultSchema>;
type Filter = 'all' | 'errors' | 'duplicates';
type PageReview = Readonly<{ key: string; state: 'pending' | 'ready' | 'failed' }>;
type FrozenRequest = Readonly<{ jobId: string; key: string; body: Readonly<Record<string, never>> }>;
type Props = Readonly<{ session: ApiSession; onClose: () => void; onCompleted: (summary: z.infer<typeof summarySchema>) => void }>;

export function ExpenseImportPanel({ session, onClose, onCompleted }: Props) {
  const base = financePath(session.orgId), pg = isPgWorkspace(session.orgId), prefix = `${base}/transactions/imports`;
  const scope = useRef(new AbortController());
  // Draft responses belong to a generation. A submitted request instead belongs to
  // its immutable job/key and survives draft invalidation and content expiry.
  const generation = useRef(0), frozen = useRef<FrozenRequest | null>(null), reported = useRef<string | null>(null);
  const [file, setFile] = useState<File | null>(null), [upload, setUpload] = useState<z.infer<typeof uploadSchema> | null>(null);
  const [mapping, setMapping] = useState<Record<number, string | null>>({}), [confirmed, setConfirmed] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]), [accountMap, setAccountMap] = useState<Record<string, string>>({});
  const [draftCode, setDraftCode] = useState(''), [draftAccount, setDraftAccount] = useState('');
  const [reason, setReason] = useState(''), [job, setJob] = useState<Job | null>(null), [rows, setRows] = useState<Row[]>([]);
  const [excluded, setExcluded] = useState<number[]>([]), [duplicates, setDuplicates] = useState<number[]>([]);
  const [filter, setFilter] = useState<Filter>('all'), [offset, setOffset] = useState(0), [rowTotal, setRowTotal] = useState(0);
  const [pageReview, setPageReview] = useState<PageReview | null>(null), [pageRevision, setPageRevision] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [expired, setExpired] = useState(false);
  const [completion, setCompletion] = useState<Result | null>(null);
  const pageKey = `${job?.job_id}:${filter}:${offset}:${pageRevision}`;
  const locked = Boolean(frozen.current);
  const canCommit = !busy && !locked && !expired && confirmed && job?.state === 'ready' && pageReview?.key === pageKey && pageReview.state === 'ready';
  const canPreview = !busy && !locked && confirmed && Boolean(reason.trim()) && Object.keys(accountMap).length > 0;

  useEffect(() => {
    const controller = scope.current;
    apiRequest(`${base}/accounts`, { session, signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setAccounts(expenseAccounts(value, pg));
    }).catch(value => { if (!controller.signal.aborted) setError(userMessageOf(value)); });
    return () => controller.abort();
  }, [base, pg, session]);
  useEffect(() => {
    if (!upload) return;
    const delay = Date.parse(upload.expires_at) - Date.now();
    if (delay <= 0) { expire(); return; }
    const timer = window.setTimeout(expire, delay);
    return () => clearTimeout(timer);
  }, [upload]);
  useEffect(() => {
    if (!job) return;
    const controller = new AbortController(), version = generation.current;
    setRows([]); setRowTotal(0); setPageReview({ key: pageKey, state: 'pending' }); setError(null);
    apiRequest(`${prefix}/${job.job_id}/rows?offset=${offset}&limit=25&filter=${filter}`, { session, signal: AbortSignal.any([controller.signal, scope.current.signal]) }).then(value => {
      if (controller.signal.aborted || scope.current.signal.aborted || generation.current !== version) return;
      const parsed = rowsSchema.parse(value);
      if (parsed.content_expired) expire();
      else { setRows(parsed.items); setRowTotal(parsed.total); setPageReview({ key: pageKey, state: 'ready' }); }
    }).catch(value => {
      if (controller.signal.aborted || scope.current.signal.aborted || generation.current !== version) return;
      if (value instanceof ApiError && value.status === 410) expire();
      else if (value instanceof ApiError && value.status === 403) { clearContent(); setError(userMessageOf(value)); }
      else { setPageReview({ key: pageKey, state: 'failed' }); setError(userMessageOf(value)); }
    });
    return () => controller.abort();
  }, [pageKey, prefix, session]);

  function clearContent() {
    generation.current++;
    setFile(null); setUpload(null); setJob(null); setRows([]); setRowTotal(0); setPageReview(null);
    setMapping({}); setAccountMap({}); setConfirmed(false); setReason(''); setDraftCode(''); setDraftAccount('');
    setExcluded([]); setDuplicates([]); setFilter('all'); setOffset(0); setError(null);
  }
  function expire() { clearContent(); setExpired(true); }
  function resetApproval() {
    generation.current++;
    setConfirmed(false); setJob(null); setRows([]); setRowTotal(0); setPageReview(null); setOffset(0); setError(null);
  }
  async function choose(selected: File | null) {
    if (!selected || busy || frozen.current) return;
    clearContent(); setCompletion(null); setBusy(true); setExpired(false); setFile(selected);
    const version = generation.current;
    try {
      const parsed = uploadSchema.parse(await apiCsvUpload(`${prefix}/uploads`, { file: selected, session, signal: scope.current.signal }));
      if (scope.current.signal.aborted || version !== generation.current) return;
      setUpload(parsed); setMapping(Object.fromEntries(parsed.headers.map(header => [header.sourceOrdinal, header.suggestedTarget])));
    } catch (value) {
      if (!scope.current.signal.aborted && version === generation.current) { clearContent(); setError(userMessageOf(value)); }
    } finally { if (!scope.current.signal.aborted) setBusy(false); }
  }
  const codes = useMemo(() => [...new Set(rows.flatMap(row => row.values?.accountCode ? [row.values.accountCode] : []))], [rows]);
  async function preview() {
    if (!upload || !canPreview) return;
    const version = generation.current, previous = job?.job_id;
    setBusy(true); setError(null); setJob(null); setRows([]); setPageReview(null);
    try {
      const parsed = jobSchema.parse(await apiRequest(prefix, { method: 'POST', session, signal: scope.current.signal, body: {
        upload_id: upload.upload_id, provider_source: 'manual_csv',
        mapping: upload.headers.map(header => ({ sourceOrdinal: header.sourceOrdinal, target: mapping[header.sourceOrdinal] ?? null })),
        account_mapping: Object.entries(accountMap).map(([account_code, account_id]) => ({ account_code, account_id })),
        mapping_confirmed: confirmed, no_receipt_reason: reason, excluded_ordinals: excluded, duplicate_ordinals: duplicates,
        receipts: [], ...(previous ? { replaces_job_id: previous } : {}),
      } }));
      if (scope.current.signal.aborted || version !== generation.current) return;
      if (parsed.content_expired) expire();
      else { setJob(parsed); setOffset(0); }
    } catch (value) {
      if (scope.current.signal.aborted) return;
      if (value instanceof ApiError && value.status === 403) { clearContent(); setError(userMessageOf(value)); }
      else if (version === generation.current) {
        if (value instanceof ApiError && value.status === 410) expire();
        else setError(userMessageOf(value));
      }
    } finally { if (!scope.current.signal.aborted) setBusy(false); }
  }
  function toggle(list: number[], ordinal: number, setter: (value: number[]) => void) {
    setter(list.includes(ordinal) ? list.filter(value => value !== ordinal) : [...list, ordinal]); resetApproval();
  }
  function completed(result: Result) {
    clearContent(); frozen.current = null; setCompletion(result);
    if (reported.current !== result.job_id) { reported.current = result.job_id; onCompleted(result.summary); }
  }
  async function commit() {
    if (busy || (!frozen.current && !canCommit)) return;
    const recovering = Boolean(frozen.current);
    if (!frozen.current && job) frozen.current = Object.freeze({ jobId: job.job_id, key: crypto.randomUUID(), body: Object.freeze({}) });
    const request = frozen.current;
    if (!request) return;
    setBusy(true); setError(null);
    try {
      const result = resultSchema.parse(await apiRequest(`${prefix}/${request.jobId}/commit`, { method: 'POST', body: request.body, session, signal: scope.current.signal, headers: { 'Idempotency-Key': request.key } }));
      if (!scope.current.signal.aborted) completed(result);
    } catch (value) {
      if (scope.current.signal.aborted) return;
      if (value instanceof ApiError && value.status === 410) { frozen.current = null; expire(); }
      else if (value instanceof ApiError && value.status === 403) { clearContent(); setError(userMessageOf(value)); }
      else if (value instanceof ApiError && [400, 409].includes(value.status) && !recovering) {
        frozen.current = null; resetApproval(); setError(userMessageOf(value));
      } else {
        setError(userMessageOf(value));
        try {
          const status = jobSchema.parse(await apiRequest(`${prefix}/${request.jobId}`, { session, signal: scope.current.signal }));
          if (scope.current.signal.aborted) return;
          if (status.content_expired) expire();
          if (status.state === 'completed') completed(resultSchema.parse(status));
          else if (status.content_expired || status.state !== 'ready') { frozen.current = null; resetApproval(); }
        } catch (statusError) {
          if (scope.current.signal.aborted) return;
          if (statusError instanceof ApiError && statusError.status === 403) clearContent();
          setError(`${userMessageOf(value)} / 결과 확인 실패: ${userMessageOf(statusError)}. 같은 요청 키로 다시 확인하세요.`);
        }
      }
    } finally { if (!scope.current.signal.aborted) setBusy(false); }
  }
  return <section className="expense-panel expense-import" aria-label="CSV 지출 가져오기" data-expense-import data-import-busy={busy}>
    <header><div><h2>CSV 지출 가져오기</h2><p>원본 파일은 임시 보관되며 검토한 전체 선택 행만 원자적으로 적용됩니다.</p></div><Button tone="ghost" disabled={busy} onClick={onClose}>가져오기 닫기</Button></header>
    {expired && <div role="alert"><p>미리보기 내용이 만료되었습니다. 원본과 민감한 값을 폐기했습니다. 파일을 다시 선택해 새 검토를 시작하세요.</p></div>}
    <label>UTF-8 CSV 파일<input type="file" accept=".csv,text/csv" disabled={busy || locked} onChange={event => { const selected = event.target.files?.[0] ?? null; event.target.value = ''; void choose(selected); }} /></label>
    {file && <p>선택한 파일: {file.name} (브라우저에 영구 저장하지 않음)</p>}
    {upload && <fieldset disabled={locked} className="expense-import-draft"><legend>헤더 매핑</legend>
      {upload.mapping_issues.map((issue, index) => <p role="alert" key={index}>{issue.message ?? issue.code}</p>)}
      <div className="expense-import-mapping">{upload.headers.map(header => <label key={header.sourceOrdinal}>{header.name}<select value={mapping[header.sourceOrdinal] ?? ''} onChange={event => { setMapping(current => ({ ...current, [header.sourceOrdinal]: event.target.value || null })); resetApproval(); }}><option value="">무시</option>{targetValues.map(value => <option key={value} value={value}>{value}</option>)}</select><small>{header.disposition === 'mapped' ? '추천됨' : '무시 또는 모호한 필드'}</small></label>)}</div>
      <label className="expense-confirm"><input type="checkbox" checked={confirmed} onChange={event => { if (!job) generation.current++; setConfirmed(event.target.checked); }} />추천을 포함한 헤더 매핑을 직접 확인했습니다.</label>
      <label>영수증 미첨부 사유<input value={reason} maxLength={1000} onChange={event => { setReason(event.target.value); resetApproval(); }} /></label>
      <fieldset><legend>CSV 계정 코드와 활성 지출 계정의 정확한 매핑</legend><div className="expense-fields"><label>CSV 계정 코드<input value={draftCode} onChange={event => { setDraftCode(event.target.value); resetApproval(); }} /></label><label>활성 지출 계정<select value={draftAccount} onChange={event => { setDraftAccount(event.target.value); resetApproval(); }}><option value="">계정 선택</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label></div><Button tone="neutral" disabled={!draftCode.trim() || !draftAccount} onClick={() => { setAccountMap(current => ({ ...current, [draftCode]: draftAccount })); setDraftCode(''); setDraftAccount(''); resetApproval(); }}>계정 매핑 추가</Button>{Object.entries(accountMap).map(([code,id]) => <p key={code}>코드 {code} → {accounts.find(account => account.id === id)?.label ?? id} <Button tone="ghost" size="small" onClick={() => { setAccountMap(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== code))); resetApproval(); }}>삭제</Button></p>)}</fieldset>
      {codes.filter(code => !accountMap[code]).map(code => <p role="alert" key={code}>계정 코드 {code}의 매핑이 필요합니다.</p>)}
      <Button disabled={!canPreview} onClick={() => void preview()}>{job ? '변경 내용으로 새 미리보기' : '전체 미리보기 만들기'}</Button>
    </fieldset>}
    {job && <Review job={job} rows={pageReview?.key === pageKey ? rows : []} total={rowTotal} filter={filter} offset={offset} locked={busy || locked} excluded={excluded} duplicates={duplicates}
      setFilter={value => { setFilter(value); setOffset(0); }} setOffset={setOffset} toggleExclude={ordinal => toggle(excluded, ordinal, setExcluded)} toggleDuplicate={ordinal => toggle(duplicates, ordinal, setDuplicates)} />}
    {job && !locked && <Button disabled={!canCommit} onClick={() => void commit()}>검토한 선택 행 적용</Button>}
    {job && pageReview?.state === 'pending' && <p role="status">미리보기 페이지를 불러오는 중입니다.</p>}
    {job && pageReview?.state === 'failed' && <Button tone="neutral" disabled={busy || locked} onClick={() => setPageRevision(value => value + 1)}>미리보기 페이지 다시 불러오기</Button>}
    {locked && <Button disabled={busy} onClick={() => void commit()}>같은 요청 키로 결과 확인 / 재시도</Button>}
    {completion && <div data-import-job={completion.job_id}><p role="status">적용 완료: 새 기록 {completion.summary.created}건, 기존 기록 재사용 {completion.summary.reused}건, 완료 합계 {completion.summary.amount} KRW</p><p>복구 기록: {completion.job_id}</p></div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

function Review(props: Readonly<{ job: Job; rows: Row[]; total: number; filter: Filter; offset: number; locked: boolean; excluded: number[]; duplicates: number[]; setFilter: (value: Filter) => void; setOffset: (value: number) => void; toggleExclude: (ordinal: number) => void; toggleDuplicate: (ordinal: number) => void }>) {
  const { job } = props;
  return <div data-import-job={job.job_id}><h3>검토 요약</h3><p>전체 {job.summary.total}건 · 선택 {job.summary.selected}건 · 오류 {job.summary.errors}건 · 중복 {job.summary.duplicates}건</p>
    {job.summary.amount && <p>선택 미리보기 합계 {job.summary.amount} KRW (아직 장부 지출 아님)</p>}
    {job.issues?.map((issue,index) => <p role="alert" key={index}>{issue.logicalRecordOrdinal ? `${issue.logicalRecordOrdinal}행: ` : ''}{issue.message ?? issue.code}</p>)}
    <div className="expense-actions" role="group" aria-label="미리보기 필터">{(['all','errors','duplicates'] as const).map(value => <Button key={value} disabled={props.locked} tone={props.filter === value ? 'primary' : 'neutral'} onClick={() => props.setFilter(value)}>{value === 'all' ? '전체' : value === 'errors' ? '오류' : '중복'}</Button>)}</div>
    <div className="expense-table-wrap"><table><thead><tr><th>원본 행</th><th>일자</th><th>사용처</th><th>금액</th><th>계정 코드</th><th>상태 / 선택</th></tr></thead><tbody>{props.rows.map(row => <tr key={row.logicalRecordOrdinal}><td>{row.logicalRecordOrdinal}</td><td>{row.values?.expenseDate ?? '-'}</td><td>{row.values?.merchant ?? '-'}</td><td>{row.values?.amount ?? '-'}</td><td>{row.values?.accountCode ?? '-'}</td><td>{[...(row.issues ?? []), ...(row.warnings ?? [])].map(issue => issue.message ?? issue.code).join(', ') || row.disposition}<label><input type="checkbox" disabled={props.locked} checked={props.excluded.includes(row.logicalRecordOrdinal)} onChange={() => props.toggleExclude(row.logicalRecordOrdinal)} />제외</label>{row.disposition === 'reuse' || row.issues?.some(issue => issue.code === 'DUPLICATE_CONFIRMATION_REQUIRED') ? <label><input type="checkbox" disabled={props.locked} checked={props.duplicates.includes(row.logicalRecordOrdinal)} onChange={() => props.toggleDuplicate(row.logicalRecordOrdinal)} />중복 재사용 확인</label> : null}</td></tr>)}</tbody></table></div>
    <nav className="expense-actions" aria-label="미리보기 페이지"><Button tone="neutral" disabled={props.locked || props.offset === 0} onClick={() => props.setOffset(Math.max(0, props.offset - 25))}>이전</Button><span>{props.total ? props.offset + 1 : 0}-{Math.min(props.offset + 25, props.total)} / {props.total}</span><Button tone="neutral" disabled={props.locked || props.offset + 25 >= props.total} onClick={() => props.setOffset(props.offset + 25)}>다음</Button></nav>
    {job.state !== 'ready' && <p role="alert">미리보기가 완전한 ready 상태가 아니므로 적용할 수 없습니다.</p>}
  </div>;
}
