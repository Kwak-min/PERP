import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { KnowledgeGraphStage } from "../components/data/KnowledgeGraphStage";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import { useAccess } from "../hooks/useWorkspaceAccess";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, ApiError, userMessageOf, type ApiSession } from "../services/api";
import { useSession } from "../store/session";
import { MarkdownView } from "./vault/MarkdownView";
import { knowledgeGraphSchema, membersOfKnowledgeHub, parseDocumentDetail, parseDocumentWriteResult, uploadedDocumentSchema, type KnowledgeGraph, type KnowledgeNode } from "./knowledge/model";
import { WikiWorkspace } from "./knowledge/WikiWorkspace";
import { base64Of } from "./knowledge/wikiModel";
import "./vault.css";
import "./graph-stage.css";

export function KnowledgeGraphScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession(), access = useAccess();
  if (!session?.orgId) return <p role="status">인증된 회사를 선택하세요.</p>;
  const canWrite = access?.org_id === session.orgId && (access.permissions.includes("*") || access.permissions.includes("document.write"));
  return <CompanyGraphContent key={`${session.token}:${session.orgId}`} screen={screen} token={session.token} orgId={session.orgId} canWrite={!!canWrite} />;
}
const emptyGraph: KnowledgeGraph = { nodes: [], edges: [], analysis: [], orphans: [], stats: { documents: 0, spaces: 0, chunks: 0, restricted: 0 } };
function CompanyGraphContent({ screen, token, orgId, canWrite }: { screen: ScreenDefinition; token: string; orgId: string; canWrite: boolean }) {
  const session: ApiSession = useMemo(() => ({ token, orgId }), [token, orgId]), pg = orgId.startsWith("pg:"), base = pg ? "/pg/documents" : "/documents";
  const life = useRef(new AbortController()), graphRequest = useRef<AbortController | null>(null), detailRequest = useRef<AbortController | null>(null), epoch = useRef(0), mutation = useRef(false);
  const [graph, setGraph] = useState<KnowledgeGraph>(emptyGraph), [selected, setSelected] = useState<KnowledgeNode | null>(null), [detail, setDetail] = useState<ReturnType<typeof parseDocumentDetail> | null>(null);
  const [editing, setEditing] = useState(false), [content, setContent] = useState(""), [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const clear = useCallback(() => { epoch.current += 1; life.current.abort(); life.current = new AbortController(); graphRequest.current?.abort(); detailRequest.current?.abort(); setGraph(emptyGraph); setSelected(null); setDetail(null); setContent(""); setEditing(false); setProjectId(""); setNotice(null); setError(null); setBusy(false); }, []);
  const load = useCallback(async () => {
    graphRequest.current?.abort(); const controller = new AbortController(); graphRequest.current = controller;
    try { const value = knowledgeGraphSchema.parse(await apiRequest(`${base}/graph`, { session, signal: AbortSignal.any([controller.signal, life.current.signal]) })); if (!controller.signal.aborted && !life.current.signal.aborted) setGraph(value); }
    catch (caught) { if (!controller.signal.aborted && !life.current.signal.aborted) { clear(); setError(userMessageOf(caught)); } }
  }, [base, session, clear]);
  useEffect(() => { life.current = new AbortController(); void load(); return () => { life.current.abort(); detailRequest.current?.abort(); graphRequest.current?.abort(); epoch.current += 1; }; }, [load]);
  useEffect(() => { if (!canWrite) setEditing(false); }, [canWrite]);
  async function open(node: KnowledgeNode) {
    const e = ++epoch.current; detailRequest.current?.abort(); const controller = new AbortController(); detailRequest.current = controller;
    setSelected(node); setDetail(null); setContent(""); setEditing(false); setBusy(false); setError(null);
    if (node.kind !== "document") return;
    setBusy(true);
    try { const value = parseDocumentDetail(node.id, await apiRequest(`${base}/${encodeURIComponent(node.id)}`, { session, signal: AbortSignal.any([controller.signal, life.current.signal]) })); if (e === epoch.current && !controller.signal.aborted && !life.current.signal.aborted) { setDetail(value); setContent(value.content); } }
    catch (caught) { if (e === epoch.current && !controller.signal.aborted) { setSelected(null); setError(userMessageOf(caught)); } }
    finally { if (e === epoch.current && !life.current.signal.aborted) setBusy(false); }
  }
  async function save() {
    if (!canWrite || !selected || !detail || mutation.current) return;
    const snapshot = { id: selected.id, content, version: detail.version }, e = epoch.current;
    mutation.current = true; setBusy(true); setError(null);
    try { const value = parseDocumentWriteResult(snapshot.id, await apiRequest(`${base}/${snapshot.id}`, { method: "PATCH", session, signal: life.current.signal, body: { content: snapshot.content, version: snapshot.version } })); if (life.current.signal.aborted) return; if (e === epoch.current) { setDetail(current => current ? { ...current, content: snapshot.content, version: value.version } : null); setEditing(false); setNotice("원본 문서를 새 판으로 저장했습니다. 위키 원본은 명시적으로 새 판을 캡처하세요."); } await load(); }
    catch (caught) { if (e === epoch.current && !life.current.signal.aborted) { if (caught instanceof ApiError && [401, 403, 404].includes(caught.status)) clear(); setError(userMessageOf(caught)); } }
    finally { mutation.current = false; if (e === epoch.current && !life.current.signal.aborted) setBusy(false); }
  }
  async function upload(file: File) {
    if (!canWrite || mutation.current || (pg && !projectId)) return;
    const snapshotProject = projectId, e = epoch.current; mutation.current = true; setBusy(true); setError(null);
    try { const content_base64 = base64Of(await file.arrayBuffer()); if (life.current.signal.aborted || e !== epoch.current) return; const value = uploadedDocumentSchema.parse(await apiRequest(`${base}/upload`, { method: "POST", session, signal: life.current.signal, body: { filename: file.name, mime: file.name.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain", content_base64, ...(pg ? { project_id: snapshotProject } : {}) } })); if (life.current.signal.aborted || e !== epoch.current) return; setNotice(`${value.filename} 원본 문서를 저장했습니다. 유사도 분석 상태: ${value.analysis?.state ?? "not_analyzed"}. 위키 등록·게시는 별도입니다.`); await load(); }
    catch (caught) { if (!life.current.signal.aborted && e === epoch.current) setError(userMessageOf(caught)); }
    finally { mutation.current = false; if (e === epoch.current && !life.current.signal.aborted) setBusy(false); }
  }
  const members = selected?.kind === "space" ? membersOfKnowledgeHub(graph.nodes, graph.edges, selected.renderer_id) : [];
  const projects = graph.nodes.filter(node => node.kind === "space" && node.identity.store === "pg");
  const stage = useMemo(() => ({ nodes: graph.nodes, edges: graph.edges }), [graph]);
  return <div className="screen" data-screen-id={screen.id}><header className="screen-header"><div><span className="eyebrow">회사 지식</span><h1>{screen.label}</h1><p>기존 문서·프로젝트 소속과 게시 위키를 구분합니다. 연결은 새로운 열람 권한을 부여하지 않습니다.</p></div><Button tone="neutral" onClick={() => void load()}>원본 새로고침</Button></header>
    {error && <p role="alert" className="form-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {canWrite && <div className="form-actions">{pg && <label>저장할 프로젝트<select aria-label="저장할 프로젝트" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">프로젝트 선택</option>{projects.map(project => <option key={project.renderer_id} value={project.identity.opaque_id}>{project.title}</option>)}</select></label>}<label>문서 파일 올리기 (.md/.txt)<input type="file" aria-label="조직 문서 파일 올리기" accept=".md,.txt" disabled={busy || (pg && !projectId)} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void upload(file); }} /></label></div>}
    <div className="graph-layout"><SectionCard title="원본 회사 문서 그래프" padded><KnowledgeGraphStage data={stage} scopeKey={JSON.stringify([base, orgId])} ariaLabel="조직 지식 3D 그래프" emptyMessage="아직 허가된 회사 문서가 없습니다. 아래 원본 기반 조사는 게시 위키 없이도 사용할 수 있습니다." onNodeSelect={node => { const found = graph.nodes.find(item => item.renderer_id === node.renderer_id); if (found) void open(found); }} /><p>문서 {graph.stats.documents} · 공간 {graph.stats.spaces} · 분석 대기 {graph.analysis.filter(item => item.state === "pending").length}</p></SectionCard>
      <SectionCard title={selected?.title ?? "원본 노드 상세"} padded>{selected?.kind === "space" ? <ul>{members.map(node => <li key={node.renderer_id}><button onClick={() => void open(node)}>{node.title}</button></li>)}{!members.length && <li>문서가 없는 공간입니다.</li>}</ul> : detail && selected ? <><p>원본 판 v{detail.version} · 이력 {detail.versions.length}건</p>{editing && canWrite ? <><label>본문 (마크다운)<textarea aria-label="원본 문서 본문" rows={14} value={content} onChange={event => setContent(event.target.value)} /></label><Button disabled={busy} onClick={() => void save()}>변경 저장</Button><Button tone="neutral" onClick={() => { setEditing(false); setContent(detail.content); }}>취소</Button></> : <><MarkdownView source={detail.content} />{canWrite && <Button onClick={() => setEditing(true)}>본문 수정</Button>}<Link to={`/documents/${selected.id}`}>문서 화면에서 열기</Link></>}</> : <p>{busy ? "문서를 불러오는 중" : "문서 또는 프로젝트·공간 노드를 선택하세요."}</p>}</SectionCard></div>
    <WikiWorkspace base={base} session={session} canWrite={canWrite} record={selected?.kind === "document" && detail ? { kind: "document", id: selected.id, title: selected.title, version: detail.version } : null} onInvalidated={clear} />
  </div>;
}
