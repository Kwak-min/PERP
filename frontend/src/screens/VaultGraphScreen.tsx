import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KnowledgeGraphStage } from "../components/data/KnowledgeGraphStage";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, ApiError, userMessageOf, type ApiSession } from "../services/api";
import { useSession } from "../store/session";
import { NoteEditor } from "./vault/NoteEditor";
import { NoteAnalysisPanel } from "./vault/NoteAnalysisPanel";
import { graphSchema, type VaultGraph } from "./vault/graph3d";
import { EMPTY_DRAFT, draftOf, parseNoteDetail, parseNoteResult, tagsOf, type NoteDraft } from "./vault/model";
import { WikiWorkspace } from "./knowledge/WikiWorkspace";
import "./vault.css";
import "./graph-stage.css";

export function VaultGraphScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  if (!session?.orgId) return <p role="status">인증된 작업 공간을 선택하세요.</p>;
  // 키는 React 수명에만 사용한다. 토큰을 DOM/renderer ID에 넣지 않는다.
  return <VaultGraphContent key={`${session.token}:${session.orgId}`} screen={screen} token={session.token} orgId={session.orgId} />;
}
function VaultGraphContent({ screen, token, orgId }: { screen: ScreenDefinition; token: string; orgId: string }) {
  const session: ApiSession = useMemo(() => ({ token, orgId }), [token, orgId]);
  const base = orgId.startsWith("pg:") ? "/pg/vault" : "/vault";
  const life = useRef(new AbortController()), detailRequest = useRef<AbortController | null>(null), graphRequest = useRef<AbortController | null>(null);
  const epoch = useRef(0), mutation = useRef(false);
  const [graph, setGraph] = useState<VaultGraph>({ nodes: [], edges: [], orphans: [] });
  const [selected, setSelected] = useState<ReturnType<typeof parseNoteDetail> | null>(null), [draft, setDraft] = useState<NoteDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const clear = useCallback(() => { epoch.current += 1; life.current.abort(); life.current = new AbortController(); setBusy(false); detailRequest.current?.abort(); graphRequest.current?.abort(); setSelected(null); setDraft(EMPTY_DRAFT); setGraph({ nodes: [], edges: [], orphans: [] }); setNotice(null); setError(null); }, []);
  const load = useCallback(async () => {
    graphRequest.current?.abort(); const controller = new AbortController(); graphRequest.current = controller;
    try { const value = graphSchema.parse(await apiRequest(`${base}/graph`, { session, signal: AbortSignal.any([controller.signal, life.current.signal]) })); if (!controller.signal.aborted && !life.current.signal.aborted) setGraph(value); }
    catch (caught) { if (!controller.signal.aborted && !life.current.signal.aborted) { clear(); setError(userMessageOf(caught)); } }
  }, [base, session, clear]);
  useEffect(() => { life.current = new AbortController(); void load(); return () => { life.current.abort(); detailRequest.current?.abort(); graphRequest.current?.abort(); epoch.current += 1; }; }, [load]);
  async function open(id: string) {
    if (!graph.nodes.some(node => node.id === id)) return;
    const e = ++epoch.current; detailRequest.current?.abort(); const controller = new AbortController(); detailRequest.current = controller;
    setSelected(null); setDraft(EMPTY_DRAFT); setBusy(true); setError(null);
    try { const value = parseNoteDetail(id, await apiRequest(`${base}/notes/${encodeURIComponent(id)}`, { session, signal: AbortSignal.any([controller.signal, life.current.signal]) })); if (e === epoch.current && !controller.signal.aborted && !life.current.signal.aborted) { setSelected(value); setDraft(draftOf(value)); } }
    catch (caught) { if (e === epoch.current && !controller.signal.aborted) setError(userMessageOf(caught)); }
    finally { if (e === epoch.current && !life.current.signal.aborted) setBusy(false); }
  }
  async function save(remove = false) {
    if (!selected || busy || mutation.current) return;
    mutation.current = true; const snapshot = selected, body = draft, e = epoch.current; setBusy(true); setError(null);
    try {
      if (remove) await apiRequest(`${base}/notes/${snapshot.id}`, { method: "DELETE", session, signal: life.current.signal });
      else {
        const value = parseNoteResult(snapshot.id, await apiRequest(`${base}/notes/${snapshot.id}`, { method: "PATCH", session, signal: life.current.signal, body: { title: body.title.trim(), content: body.content, folder: body.folder.trim() || "/", ...(base === "/vault" ? { tags: tagsOf(body), pinned: body.pinned, agent_enabled: body.agent_enabled } : {}), version: snapshot.version } }));
        if (e === epoch.current && !life.current.signal.aborted) setSelected({ ...snapshot, ...value });
      }
      if (life.current.signal.aborted) return;
      if (e === epoch.current) { if (remove) { setSelected(null); setDraft(EMPTY_DRAFT); } setNotice(remove ? "노트를 삭제했습니다." : "원본 노트를 저장했습니다. 위키 원본은 명시적으로 새 판을 캡처하세요."); }
      await load();
    } catch (caught) { if (e === epoch.current && !life.current.signal.aborted) { if (caught instanceof ApiError && [401, 403, 404].includes(caught.status)) clear(); setError(userMessageOf(caught)); } }
    finally { mutation.current = false; if (!life.current.signal.aborted && e === epoch.current) setBusy(false); }
  }
  const stage = useMemo(() => ({ nodes: graph.nodes.map(node => ({ ...node, kind: node.identity.kind })), edges: graph.edges.map(edge => ({ ...edge, kind: edge.kind ?? "manual" as const })) }), [graph]);
  const scopeKey = JSON.stringify(graph.nodes[0]?.identity ? [graph.nodes[0].identity.store, graph.nodes[0].identity.company, graph.nodes[0].identity.owner] : [base, "empty"]);
  return <div className="screen" data-screen-id={screen.id}><header className="screen-header"><div><span className="eyebrow">개인 지식</span><h1>{screen.label}</h1><p>원본 노트와 게시 위키를 구분하여 읽고 편집합니다. 배치와 시점은 다시 열면 초기화됩니다.</p></div><Button tone="neutral" onClick={() => void load()}>원본 새로고침</Button></header>
    {error && <p role="alert" className="form-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="graph-layout"><SectionCard title="원본 노트 그래프" padded><KnowledgeGraphStage data={stage} scopeKey={scopeKey} ariaLabel="개인 노트 3D 그래프" emptyMessage="아직 원본 노트가 없습니다. 개인 노트 화면에서 작성하거나 아래에 위키 원본을 등록하세요." onNodeSelect={node => void open(node.id)} /><label>노트 선택<select aria-label="그래프 노트 선택" value={selected?.id ?? ""} onChange={event => void open(event.target.value)}><option value="" disabled>노트를 선택하세요</option>{graph.nodes.map(node => <option key={node.id} value={node.id}>{node.title} · {node.folder}</option>)}</select></label></SectionCard>
      <SectionCard title={selected?.title ?? "원본 노트 편집"} padded>{selected ? <fieldset disabled={busy} data-note-id={selected.id}><NoteAnalysisPanel noteId={selected.id} version={selected.version} base={base} session={session} onSettled={load} /><NoteEditor key={selected.id} storage={base === "/pg/vault" ? "pg" : "legacy"} draft={draft} editingId={selected.id} folders={[...new Set(graph.nodes.map(node => node.folder))]} busy={busy} onChange={patch => setDraft(current => ({ ...current, ...patch }))} onSave={() => void save()} onDelete={() => void save(true)} onReset={() => { epoch.current += 1; detailRequest.current?.abort(); setSelected(null); setDraft(EMPTY_DRAFT); setBusy(false); }} /></fieldset> : <p>{busy ? "불러오는 중" : "노드를 선택하면 기존 API의 원본 노트를 편집합니다."}</p>}</SectionCard></div>
    <WikiWorkspace base={base} session={session} canWrite record={selected ? { kind: "note", id: selected.id, title: selected.title, version: selected.version } : null} onInvalidated={clear} />
  </div>;
}
