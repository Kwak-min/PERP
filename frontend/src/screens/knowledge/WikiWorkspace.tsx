import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { KnowledgeGraphStage } from "../../components/data/KnowledgeGraphStage";
import { Button } from "../../components/ui/Button";
import { apiEventStream, apiRequest, ApiError, userMessageOf, type ApiSession } from "../../services/api";
import { MarkdownView } from "../vault/MarkdownView";
import { adaptWikiGraph, base64Of, changeSetSchema, emptyWikiGraph, historySchema, jobSchema, manualDraftSchema, pageRevisionSchema, pagesSchema, publicationSchema, queryDraftSchema, rejectSchema, revisionCitations, sourceListSchema, sourceRevisionSchema, sourceSchema, verifiedSpan, wikiGraphSchema, wikiRootSchema, type WikiChangeSet, type WikiCitation, type WikiGraph, type WikiJob, type WikiPageRevision, type WikiPageSummary, type WikiRevision, type WikiScope, type WikiSource } from "./wikiModel";
import "./wiki-workspace.css";

export type WikiRecord = Readonly<{ kind: "note" | "document"; id: string; version: string | number; title: string }>;
type Props = Readonly<{ base: string; session: ApiSession; canWrite: boolean; record: WikiRecord | null; onInvalidated: () => void }>;
const stateEvent = z.object({ counts: z.object({ nodes: z.number().int(), edges: z.number().int() }), cursor: z.number().int().nonnegative() });
const wikiEvent = z.object({ sequence: z.number().int().nonnegative(), kind: z.string(), job_id: z.string().optional() }).passthrough();
const jobLabels = { queued: "접수됨", running: "조사 중", succeeded: "완료 · 검토 전", failed: "실패", unavailable: "사용 불가" };

export function WikiWorkspace({ base, session, canWrite, record, onInvalidated }: Props) {
  const root = `${base}/wiki`;
  const lifetime = useRef(new AbortController());
  const epoch = useRef(0), selection = useRef(0), refreshEpoch = useRef(0);
  const jobIds = useRef<string[]>([]), reviewId = useRef<string | null>(null), selectedRevision = useRef<{ kind: "source" | "page"; id: string; revision: string } | null>(null);
  const sourcesRef = useRef<WikiSource[]>([]), pagesRef = useRef<WikiPageSummary[]>([]);
  const [sources, setSources] = useState<WikiSource[]>([]), [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [scope, setScope] = useState<WikiScope | null>(null), [graph, setGraph] = useState<WikiGraph>(emptyWikiGraph);
  const [chosen, setChosen] = useState<string[]>([]), [question, setQuestion] = useState("");
  const [lookup, setLookup] = useState({ job: "", draft: "" });
  const [raw, setRaw] = useState(true), [published, setPublished] = useState(true);
  const [jobs, setJobs] = useState<WikiJob[]>([]), [review, setReview] = useState<WikiChangeSet | null>(null), [confirmed, setConfirmed] = useState(false);
  const [revision, setRevision] = useState<WikiRevision | null>(null), [history, setHistory] = useState<WikiPageRevision[]>([]);
  const [annotation, setAnnotation] = useState<{ before: string; quote: string; after: string; citation: WikiCitation } | null>(null);
  const [edit, setEdit] = useState<{ title: string; markdown: string; version: number; pageId: string } | null>(null);
  const [projection, setProjection] = useState<{ name: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [stream, setStream] = useState("연결 준비"), [connection, setConnection] = useState(0);
  const mutation = useRef(false), publishKey = useRef<{ hash: string; key: string } | null>(null);
  const cursor = useRef(0), reviewSelection = useRef(0);
  const invalidatedRef = useRef(onInvalidated); invalidatedRef.current = onInvalidated;
  const request = useCallback((path: string, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown, key?: string) => apiRequest(root + path, { session, signal: lifetime.current.signal, method, ...(body === undefined ? {} : { body }), ...(key ? { headers: { "Idempotency-Key": key } } : {}) }), [root, session]);

  const clearPrivate = useCallback(() => {
    epoch.current += 1; selection.current += 1; refreshEpoch.current += 1; reviewSelection.current += 1;
    lifetime.current.abort(); lifetime.current = new AbortController(); setLoading(false); setStream("접근 범위 변경 · 다시 연결하세요");
    jobIds.current = []; reviewId.current = null; selectedRevision.current = null; sourcesRef.current = []; pagesRef.current = [];
    setSources([]); setPages([]); setGraph(emptyWikiGraph); setScope(null); setChosen([]); setQuestion(""); setLookup({ job: "", draft: "" }); setJobs([]); setReview(null); setConfirmed(false); setRevision(null); setAnnotation(null); setHistory([]); setEdit(null); setProjection(null); setNotice(null);
    invalidatedRef.current();
  }, []);
  const fail = useCallback((caught: unknown) => {
    if (lifetime.current.signal.aborted) return;
    if (caught instanceof ApiError && ([401, 403, 404].includes(caught.status) || caught.code === "SOURCE_REVOKED")) clearPrivate();
    setConfirmed(false);
    setError(caught instanceof ApiError ? `${userMessageOf(caught)} (${caught.code})` : userMessageOf(caught));
  }, [clearPrivate]);
  const readRevision = useCallback(async (target: { kind: "source" | "page"; id: string; revision: string }): Promise<WikiRevision> => {
    const value = target.kind === "source" ? sourceRevisionSchema.parse(await request(`/sources/${encodeURIComponent(target.id)}/revisions/${encodeURIComponent(target.revision)}`)) : pageRevisionSchema.parse(await request(`/pages/${encodeURIComponent(target.id)}?revision=${encodeURIComponent(target.revision)}`));
    if (value.id !== target.revision || (value.artifact_kind === "source_revision" ? value.source_id : value.page_id) !== target.id) throw new Error("REVISION_ID_MISMATCH");
    return value;
  }, [request]);

  const refresh = useCallback(async () => {
    const e = ++refreshEpoch.current, alive = epoch.current, selected = selection.current, reviewing = reviewSelection.current;
    setLoading(true);
    // SSE가 권한 변화를 알리면 이전 projection을 먼저 숨긴다. 인가된 재응답만 복구한다.
    setGraph(emptyWikiGraph); setSources([]); setPages([]); setJobs([]); setReview(null); setRevision(null); setAnnotation(null); setHistory([]); setProjection(null);
    try {
      const [rootData, g, p] = await Promise.all([request("").then(v => wikiRootSchema.parse(v)), request("/graph").then(v => wikiGraphSchema.parse(v)), request("/pages").then(v => pagesSchema.parse(v))]);
      const s: WikiSource[] = []; let next: string | null = null;
      do { const list = sourceListSchema.parse(await request(`/sources?limit=100${next ? `&cursor=${encodeURIComponent(next)}` : ""}`)); s.push(...list.items); next = list.next_cursor; } while (next);
      const currentJobs = await Promise.all(jobIds.current.map(async id => { const job = jobSchema.parse(await request(`/jobs/${encodeURIComponent(id)}`)); if (job.id !== id) throw new Error("JOB_ID_MISMATCH"); return job; }));
      const r = reviewId.current ? changeSetSchema.parse(await request(`/change-sets/${encodeURIComponent(reviewId.current)}`)) : null;
      const detail = selectedRevision.current ? await readRevision(selectedRevision.current) : null;
      if (lifetime.current.signal.aborted || alive !== epoch.current || e !== refreshEpoch.current) return;
      if (sourcesRef.current.some(old => !s.some(item => item.id === old.id))) { clearPrivate(); setNotice("원본 접근 범위가 바뀌어 이전 화면과 작업을 비웠습니다."); }
      sourcesRef.current = s; pagesRef.current = p.items; setSources(s); setPages(p.items); setScope(rootData.wiki); setGraph(g);
      setJobs(currentJobs); if (reviewing === reviewSelection.current) setReview(r); if (selected === selection.current) setRevision(detail); setChosen(current => current.filter(id => s.some(source => source.current_revision_id === id && source.freshness === "current")));
      if (detail && detail.freshness !== "current") setEdit(null);
      setError(null);
    } catch (caught) { if (alive === epoch.current && e === refreshEpoch.current) fail(caught); }
    finally { if (e === refreshEpoch.current) setLoading(false); }
  }, [request, readRevision, fail, clearPrivate]);

  useEffect(() => {
    lifetime.current = new AbortController();
    void refresh();
    const accessChanged = () => { void refresh(); };
    window.addEventListener("orbitflow:access-changed", accessChanged);
    return () => { lifetime.current.abort(); epoch.current += 1; selection.current += 1; window.removeEventListener("orbitflow:access-changed", accessChanged); };
  }, [refresh, clearPrivate]);
  useEffect(() => {
    const controller = new AbortController(); let revoked = false;
    const signal = AbortSignal.any([controller.signal, lifetime.current.signal]);
    void (async () => {
      try {
        while (!signal.aborted && !revoked) {
          setStream("인증된 실시간 연결");
          await apiEventStream(`${root}/events`, { session, signal, cursor: cursor.current, onEvent: event => {
            if (signal.aborted) return;
            if (event.event === "unavailable") { revoked = true; clearPrivate(); setStream("연결 중단 · 접근 범위를 다시 확인하세요"); return; }
            if (event.event === "state") { stateEvent.parse(event.data); void refresh(); }
            if (event.event === "wiki") { const data = wikiEvent.parse(event.data); if (event.id !== String(data.sequence)) throw new Error("EVENT_SEQUENCE_MISMATCH"); cursor.current = Math.max(cursor.current, data.sequence); if (data.job_id && jobIds.current.includes(data.job_id)) void refresh(); }
          } });
          // 정상적인 서버 수명 종료만 마지막 sequence로 재연결한다. 실패는 사용자 재시도다.
        }
      } catch (caught) { if (!signal.aborted) { fail(caught); setStream("연결 끊김 · 다시 연결할 수 있습니다"); } }
    })();
    return () => controller.abort();
  }, [connection, root, session, refresh, clearPrivate, fail]);

  async function run(action: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setError(null); const e = epoch.current;
    try { await action(); } catch (caught) { if (e === epoch.current) fail(caught); }
    finally { mutation.current = false; if (!lifetime.current.signal.aborted) setBusy(false); }
  }
  async function register(file?: File) {
    if (!canWrite) return;
    await run(async () => {
      const e = epoch.current;
      let body: unknown;
      if (file) { if (file.size > 1000000) throw new Error("SOURCE_LIMIT"); body = { kind: "upload", filename: file.name, mime: file.name.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain", content_base64: base64Of(await file.arrayBuffer()) }; }
      else { if (!record) return; body = { kind: "record", origin_kind: record.kind, origin_id: record.id, version: record.version }; }
      if (e !== epoch.current || lifetime.current.signal.aborted) return;
      sourceSchema.parse(await request("/sources", "POST", body));
      if (e !== epoch.current) return; setNotice("원본을 등록했습니다. 기존 노트·문서는 변경하지 않았습니다."); await refresh();
    });
  }
  async function open(target: { kind: "source" | "page"; id: string; revision: string }, citation?: WikiCitation) {
    const selected = ++selection.current, e = epoch.current; selectedRevision.current = target;
    setRevision(null); setAnnotation(null); setHistory([]); setEdit(null); setError(null);
    try {
      const value = await readRevision(target); const span = citation ? await verifiedSpan(value, citation) : null;
      if (selected !== selection.current || e !== epoch.current || lifetime.current.signal.aborted) return;
      setRevision(value); if (span && citation) setAnnotation({ ...span, citation });
    } catch (caught) { if (selected === selection.current && e === epoch.current) fail(caught); }
  }
  async function cite(citation: WikiCitation) {
    const e = epoch.current, selected = ++selection.current; setAnnotation(null); setRevision(null); setEdit(null); setHistory([]);
    try {
      // 과거 revision에도 현재 허가된 stable 부모만 사용한다. 제목/본문 검색으로 추측하지 않는다.
      const candidates = citation.artifact_kind === "source_revision" ? sourcesRef.current.map(source => ({ kind: "source" as const, id: source.id, revision: citation.revision_id })) : pagesRef.current.map(page => ({ kind: "page" as const, id: page.id, revision: citation.revision_id }));
      for (const target of candidates) {
        if (selected !== selection.current || e !== epoch.current || lifetime.current.signal.aborted) return;
        let value: WikiRevision;
        try { value = await readRevision(target); } catch (caught) { if (caught instanceof ApiError && caught.status === 404) continue; throw caught; }
        const span = await verifiedSpan(value, citation);
        if (selected !== selection.current || e !== epoch.current || lifetime.current.signal.aborted) return;
        selectedRevision.current = target; setRevision(value); setAnnotation({ ...span, citation }); return;
      }
      throw new Error("CITATION_REVISION_UNAVAILABLE");
    } catch (caught) { if (selected === selection.current && e === epoch.current) fail(caught); }
  }
  async function admit(operation: "query" | "ingest" | "lint") {
    if (operation !== "query" && !canWrite) return;
    await run(async () => {
      const e = epoch.current;
      const body = operation === "query" ? { operation, question, retrieval: { raw, published_wiki: published, ...(chosen.length ? { source_revision_ids: chosen } : {}) } } : operation === "ingest" ? { operation, source_revision_ids: chosen } : { operation, page_revision_ids: pages.map(page => page.revision_id) };
      const job = jobSchema.parse(await request("/jobs", "POST", body, crypto.randomUUID()));
      if (e !== epoch.current || lifetime.current.signal.aborted) return;
      jobIds.current = [...jobIds.current, job.id]; setJobs(current => [...current.filter(item => item.id !== job.id), job]); await refresh();
    });
  }
  async function inspect(id: string) {
    const e = epoch.current, reviewing = ++reviewSelection.current;
    setReview(null); setConfirmed(false);
    const value = changeSetSchema.parse(await request(`/change-sets/${encodeURIComponent(id)}`));
    if (value.id !== id) throw new Error("CHANGE_SET_ID_MISMATCH");
    if (e !== epoch.current || reviewing !== reviewSelection.current || lifetime.current.signal.aborted) return;
    reviewId.current = id; setReview(value); setConfirmed(false); publishKey.current = null;
  }
  const stage = useMemo(() => adaptWikiGraph(graph, scope), [graph, scope]);
  const citations = (items: readonly WikiCitation[]) => <ol className="wiki-citations">{items.map((citation, index) => <li key={`${citation.revision_id}:${citation.start_byte}:${index}`}><button type="button" onClick={() => void cite(citation)}>인용 {index + 1} · {citation.artifact_kind} · UTF-8 [{citation.start_byte}, {citation.end_byte})</button><code>{citation.revision_id}</code></li>)}</ol>;

  return <section className="wiki-workspace" data-wiki-workspace data-access-epoch={epoch.current} data-loading={loading} data-source-count={sources.length} data-page-count={pages.length} aria-label="원본 기반 조사와 위키">
    <header><h2>원본 기반 조사와 위키</h2><p>원본 → 검토 전 조사 → 초안 검토 → 명시적 게시. 인용은 추적 가능성이며 사실성 보증이 아닙니다.</p><p role="status">{stream}{loading ? " · 최신 범위 확인 중" : ""}</p><Button tone="neutral" onClick={() => { setConnection(value => value + 1); void refresh(); }}>다시 연결·새로고침</Button></header>
    {error && <p role="alert" className="form-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="wiki-workspace__columns">
      <section><h3>원본 자료</h3><p>UTF-8 .md/.txt · 최대 1 MB. 등록은 모델 없이도 가능합니다.</p>
        {canWrite ? <div className="form-actions"><label>위키 원본 파일 올리기<input type="file" aria-label="위키 원본 파일 올리기" accept=".md,.txt" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void register(file); }} /></label><Button disabled={busy || !record} onClick={() => void register()}>선택 원본 등록</Button>{record && <span>{record.title} · v{record.version}</span>}</div> : <p>읽기 권한으로 조사할 수 있습니다. 원본 등록·초안·게시에는 쓰기 권한이 필요합니다.</p>}
        {!sources.length && !loading && <p>등록된 원본이 없습니다. 기존 노트·문서를 선택하거나 파일을 등록하세요.</p>}
        <ul className="wiki-sources">{sources.map(source => <li key={source.id}><label><input type="checkbox" aria-label={`조사 원본 ${source.title}`} checked={chosen.includes(source.current_revision_id)} disabled={source.freshness !== "current"} onChange={event => setChosen(current => event.target.checked ? [...current, source.current_revision_id] : current.filter(id => id !== source.current_revision_id))} />{source.title} · {source.freshness}</label><button onClick={() => void open({ kind: "source", id: source.id, revision: source.current_revision_id })}>고정 원본 열기</button>{canWrite && <><button disabled={busy} onClick={() => void run(async () => { await request(`/sources/${source.id}`, "DELETE", { expected_version: source.version }); clearPrivate(); await refresh(); })}>등록 철회</button>{source.kind === "record" && <button disabled={busy || !record || record.id !== source.origin_id || record.kind !== source.origin_kind} onClick={() => void run(async () => { if (!record) return; sourceSchema.parse(await request(`/sources/${source.id}/revisions`, "POST", { expected_version: source.version, version: record.version })); await refresh(); })}>선택 원본 새 판 캡처</button>}{source.kind === "upload" && <label>새 파일 판<input type="file" aria-label={`${source.title} 새 파일 판`} accept=".md,.txt" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void run(async () => { const e = epoch.current; const content_base64 = base64Of(await file.arrayBuffer()); if (e !== epoch.current) return; sourceSchema.parse(await request(`/sources/${source.id}/revisions`, "POST", { expected_version: source.version, filename: file.name, mime: file.name.endsWith(".md") ? "text/markdown" : "text/plain", content_base64 })); await refresh(); }); }} /></label>}</>}</li>)}</ul>
      </section>
      <section><h3>조사</h3><label>질문<textarea aria-label="위키 조사 질문" value={question} maxLength={4000} onChange={event => setQuestion(event.target.value)} /></label><div className="form-actions"><label><input type="checkbox" checked={raw} onChange={event => setRaw(event.target.checked)} />원본 검색</label><label><input type="checkbox" checked={published} onChange={event => setPublished(event.target.checked)} />게시 위키 검색</label></div><p>원본 미선택 시 허가된 원본에서 검색합니다. 게시 페이지가 0개여도 조사할 수 있습니다.</p><Button disabled={busy || !question.trim() || (!raw && !published)} onClick={() => void admit("query")}>원본 기반 조사</Button>{canWrite && <><Button disabled={busy || !chosen.length || chosen.length > 20} onClick={() => void admit("ingest")}>선택 원본 위키 초안 생성</Button><Button disabled={busy || !pages.length || pages.length > 20} onClick={() => void admit("lint")}>게시 위키 검토 초안 생성</Button></>}
      </section>
    </div>
    <section><h3>내 작업</h3><p>작업 ID는 이 화면 수명 동안만 보관합니다. 모델 부재·실패는 답변이나 게시물이 아닙니다.</p><details><summary>저장한 작업·초안 다시 열기</summary><label>저장한 작업 ID<input value={lookup.job} maxLength={200} onChange={event => setLookup({ ...lookup, job: event.target.value })} /></label><Button disabled={busy || !lookup.job.trim()} onClick={() => void run(async () => { const id = lookup.job.trim(), e = epoch.current; const job = jobSchema.parse(await request(`/jobs/${encodeURIComponent(id)}`)); if (job.id !== id) throw new Error("JOB_ID_MISMATCH"); if (e !== epoch.current || lifetime.current.signal.aborted) return; jobIds.current = [...new Set([...jobIds.current, id])]; await refresh(); })}>인가된 작업 다시 열기</Button><label>저장한 초안 ID<input value={lookup.draft} maxLength={200} onChange={event => setLookup({ ...lookup, draft: event.target.value })} /></label><Button disabled={busy || !lookup.draft.trim()} onClick={() => void run(() => inspect(lookup.draft.trim()))}>인가된 초안 다시 열기</Button></details>{jobs.map(job => <article key={job.id} data-job-id={job.id} data-job-state={job.state}><h4>{job.operation} · {jobLabels[job.state]}</h4><code>{job.id}</code>{job.failure_code && <p role="status">{job.failure_code}</p>}{["queued", "running"].includes(job.state) && <button disabled={busy || (job.operation !== "query" && !canWrite)} onClick={() => void run(async () => { jobSchema.parse(await request(`/jobs/${job.id}/cancel`, "POST", {})); await refresh(); })}>작업 취소</button>}{["failed", "unavailable"].includes(job.state) && <button disabled={busy || (job.operation !== "query" && !canWrite)} onClick={() => void run(async () => { jobSchema.parse(await request(`/jobs/${job.id}/retry`, "POST", {})); await refresh(); })}>명시적 재시도</button>}
      {job.result && <><p>검토 전 모델 생성 결과 · {job.result.freshness} · {job.result.citation_validation === "no_evidence" ? "근거 없음 · 답변할 수 없습니다" : "인용 위치 확인됨 · 사실 검증 아님"}</p>{job.result.answer_md !== null && <MarkdownView source={job.result.answer_md} />}{citations(job.result.citations)}<ul>{job.result.uncertainty.map((text, index) => <li key={index}>{text}</li>)}</ul><details><summary>검색 범위·추적 근거·검토 제안</summary><pre>{JSON.stringify({ coverage: job.result.retrieval_coverage, provenance: job.result.provenance, issues: job.result.issues }, null, 2)}</pre></details>{canWrite && job.operation === "query" && job.result.answer_md !== null && job.result.citation_validation === "anchors_valid" && <Button disabled={busy} onClick={() => void run(async () => { const result = queryDraftSchema.parse(await request(`/jobs/${job.id}/draft`, "POST", {})); if (result.result_revision_id !== job.result?.result_revision_id) throw new Error("RESULT_REVISION_MISMATCH"); await inspect(result.change_set_id); })}>이 결과를 검토 초안으로 보관</Button>}{job.result.change_set_id && <Button disabled={busy} onClick={() => void run(() => inspect(job.result!.change_set_id!))}>생성 초안 검토</Button>}</>}
    </article>)}</section>
    {review && <section className="wiki-review" data-review-id={review.id}><h3>정확한 변경 묶음 검토 · {review.state} · {review.freshness}</h3><p>확인한 서버 digest에만 승인이 적용됩니다. 원본 노트·문서는 바뀌지 않습니다.</p><p>초안 ID: <code>{review.id}</code></p><code data-review-digest>{review.manifest_hash}</code>{review.diff.map(diff => <article key={diff.page_id}><h4>{diff.after.kind} · {diff.after.title}</h4><div className="wiki-workspace__columns"><section><h5>이전 · {diff.before_state}</h5>{diff.before && <MarkdownView source={diff.before.markdown} />}</section><section><h5>게시할 내용</h5><MarkdownView source={diff.after.markdown} />{citations(diff.after.citations)}<pre>{JSON.stringify(diff.after.links, null, 2)}</pre></section></div></article>)}<details><summary>예상 head와 전체 입력 lineage</summary><pre>{JSON.stringify({ expected_heads: review.expected_heads, lineage: review.lineage }, null, 2)}</pre></details>{canWrite && review.state === "draft" && <><label><input type="checkbox" aria-label="이 정확한 변경 묶음 게시 확인" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />이 정확한 변경 묶음을 검토했습니다</label><Button disabled={busy || !confirmed || review.freshness !== "current"} onClick={() => void run(async () => { const snapshot = review; if (publishKey.current?.hash !== snapshot.manifest_hash) publishKey.current = { hash: snapshot.manifest_hash, key: crypto.randomUUID() }; const receipt = publicationSchema.parse(await request(`/change-sets/${snapshot.id}/publish`, "POST", { manifest_hash: snapshot.manifest_hash, confirmed: true }, publishKey.current.key)); if (receipt.manifest_hash !== snapshot.manifest_hash) throw new Error("PUBLICATION_DIGEST_MISMATCH"); setConfirmed(false); setNotice("검토한 변경 묶음을 게시했습니다."); await refresh(); })}>명시적으로 게시</Button><Button tone="neutral" disabled={busy} onClick={() => void run(async () => { rejectSchema.parse(await request(`/change-sets/${review.id}/reject`, "POST", { manifest_hash: review.manifest_hash })); setConfirmed(false); await refresh(); })}>이 묶음 거절</Button></>}</section>}
    <section><h3>게시 위키 · {pages.length}개</h3>{!pages.length && <p>현재 게시된 위키가 없습니다. 원본 조사와 초안 검토는 계속 사용할 수 있습니다.</p>}<ul>{pages.map(page => <li key={page.id}><button onClick={() => void open({ kind: "page", id: page.id, revision: page.revision_id })}>{page.title} · {page.kind} · 게시됨 · {page.freshness} · v{page.version}</button></li>)}</ul><div className="form-actions">{["index.md", "log.md", "schema.md"].map(name => <button key={name} onClick={() => void run(async () => { const e = epoch.current; const content = z.string().parse(await request(`/${name}`)); if (e === epoch.current) setProjection({ name, content }); })}>{name}</button>)}</div>{projection && <section><h4>{projection.name}</h4><MarkdownView source={projection.content} /></section>}
      <KnowledgeGraphStage data={stage} scopeKey={JSON.stringify(scope)} ariaLabel="게시 위키 3D 그래프" emptyMessage="현재 허가된 위키 그래프 노드가 없습니다." onNodeSelect={node => { const value = graph.nodes.find(item => item.id === node.id); if (value) void open({ kind: value.kind === "source" ? "source" : "page", id: value.kind === "source" ? value.source_id : value.page_id, revision: value.revision_id }); }} />
    </section>
    {revision && <section className="wiki-revision" data-revision-id={revision.id}><h3>{revision.title} · {revision.artifact_kind} · {revision.freshness}</h3><code>{revision.id}</code><p>추출문 SHA-256: <code>{revision.content_sha256}</code></p>{revision.artifact_kind === "source_revision" && <p>원본 bytes SHA-256: <code>{revision.original_sha256}</code> · 추출 판 <code>{revision.extraction_revision_id}</code></p>}{annotation ? <><p>정확한 UTF-8 [{annotation.citation.start_byte}, {annotation.citation.end_byte}) · span SHA-256 <code>{annotation.citation.span_sha256}</code></p><pre>{annotation.before}<mark tabIndex={0} ref={node => node?.focus()}>{annotation.quote}</mark>{annotation.after}</pre></> : <MarkdownView source={revision.content} />}
      {revision.artifact_kind === "page_revision" && <>{citations(revisionCitations(revision))}<button onClick={() => void run(async () => { const e = epoch.current, s = selection.current; const value = historySchema.parse(await request(`/pages/${revision.page_id}/history`)); if (e === epoch.current && s === selection.current) setHistory(value.items); })}>게시 이력 보기</button>{history.map(item => <button key={item.id} onClick={() => void open({ kind: "page", id: item.page_id, revision: item.id })}>v{item.version} · {item.title} · {item.freshness}</button>)}{canWrite && revision.freshness === "current" && <Button onClick={() => setEdit({ title: revision.title, markdown: revision.markdown, version: revision.version, pageId: revision.page_id })}>위키 수동 편집</Button>}</>}
      {edit && canWrite && <section><label>위키 제목<input aria-label="위키 편집 제목" value={edit.title} onChange={event => setEdit({ ...edit, title: event.target.value })} /></label><label>위키 본문<textarea aria-label="위키 편집 본문" rows={12} value={edit.markdown} onChange={event => setEdit({ ...edit, markdown: event.target.value })} /></label><Button disabled={busy || !edit.title.trim()} onClick={() => void run(async () => { const snapshot = edit, e = epoch.current, s = selection.current; const result = manualDraftSchema.parse(await request(`/pages/${snapshot.pageId}/change-sets`, "POST", { expected_version: snapshot.version, title: snapshot.title, markdown: snapshot.markdown })); if (e !== epoch.current || s !== selection.current) return; await inspect(result.id); setEdit(null); })}>수동 변경을 검토 초안으로 저장</Button><button onClick={() => setEdit(null)}>편집 취소</button></section>}
    </section>}
  </section>;
}
