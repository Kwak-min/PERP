import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  nodeKindLabel, predicateLabel, relationClass, relationLabel, KNOWLEDGE_GRAPH_RELATIONS,
  type KnowledgeGraphRelation, type KnowledgeGraphStageData, type KnowledgeGraphStageNode,
} from "./knowledgeGraphStageModel.ts";
import { useKnowledgeGraphEngine } from "./useKnowledgeGraphEngine.ts";
import "./knowledge-graph-stage.css";

export type { KnowledgeGraphRelation, KnowledgeGraphStageData, KnowledgeGraphStageEdge, KnowledgeGraphStageNode } from "./knowledgeGraphStageModel.ts";
export type KnowledgeGraphStageProps = {
  readonly data: KnowledgeGraphStageData;
  readonly scopeKey: string;
  readonly ariaLabel: string;
  readonly emptyMessage: string;
  readonly onNodeSelect?: (node: KnowledgeGraphStageNode) => void;
};

export function KnowledgeGraphStage(props: KnowledgeGraphStageProps) {
  return <ScopedKnowledgeGraphStage key={props.scopeKey} {...props} />;
}

function ScopedKnowledgeGraphStage({ data, scopeKey, ariaLabel, emptyMessage, onNodeSelect }: KnowledgeGraphStageProps) {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = (): void => setReducedMotion(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const [hidden, setHidden] = useState<readonly KnowledgeGraphRelation[]>([]);
  const [search, setSearch] = useState("");
  const filteredEdges = useMemo(() => data.edges.filter(edge => !hidden.includes(edge.kind)), [data, hidden]);
  const nodes = useMemo(() => data.nodes.filter(node => node.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [data, search]);
  const byId = useMemo(() => new Map(data.nodes.map(node => [node.renderer_id, node])), [data]);
  const engine = useKnowledgeGraphEngine({ data, hiddenRelations: hidden, scopeKey, reducedMotion, ...(onNodeSelect ? { onNodeSelect } : {}) });
  const selected = engine.selectedRendererId ? byId.get(engine.selectedRendererId) : null;
  const ready = engine.engineState === "ready";
  const nodeButton = (rendererId: string) => {
    const node = byId.get(rendererId);
    return node ? <button type="button" className="knowledge-graph-stage__node-link" onClick={() => engine.selectNode(node)}>{node.title || "제목 없음"}</button> : <span>접근할 수 없는 노드</span>;
  };

  return <section className="knowledge-graph-stage" data-engine-state={engine.engineState} data-render-state={engine.renderState} data-scope-key={scopeKey}>
    <div className="knowledge-graph-stage__toolbar" aria-label={`${ariaLabel} 시점 제어`}>
      <button type="button" disabled={!ready} onClick={() => engine.moveCamera(-Math.PI / 12, 1)} aria-label="왼쪽으로 회전">왼쪽 회전</button>
      <button type="button" disabled={!ready} onClick={() => engine.moveCamera(Math.PI / 12, 1)} aria-label="오른쪽으로 회전">오른쪽 회전</button>
      <button type="button" disabled={!ready} onClick={() => engine.moveCamera(0, 0.82)} aria-label="확대">확대</button>
      <button type="button" disabled={!ready} onClick={() => engine.moveCamera(0, 1.22)} aria-label="축소">축소</button>
      <button type="button" disabled={!ready} onClick={engine.fit}>화면 맞춤</button>
      <button type="button" aria-pressed={engine.autoRotate && !reducedMotion} disabled={!ready || reducedMotion} onClick={engine.toggleAutoRotate}>{engine.autoRotate && !reducedMotion ? "자동 회전 끄기" : "자동 회전"}</button>
    </div>
    <div className="knowledge-graph-stage__viewport" aria-label={ariaLabel}>
      <div ref={engine.hostRef} className="knowledge-graph-stage__webgl" aria-hidden="true" />
      {engine.engineState === "loading" && <p className="knowledge-graph-stage__message" role="status">문서와 연결을 배치하고 있습니다.</p>}
      {engine.engineState === "error" && <p className="knowledge-graph-stage__message" role="alert">3D 화면을 표시할 수 없습니다. 아래 목록에서 문서와 연결을 계속 탐색할 수 있습니다.</p>}
      {engine.engineState === "empty" && <p className="knowledge-graph-stage__message">{emptyMessage}</p>}
      {ready && (engine.hoveredTitle || selected) && <output className="knowledge-graph-stage__hover" aria-live="polite">{engine.hoveredTitle || `선택 · ${selected?.title}`}</output>}
      {ready && <p className="knowledge-graph-stage__hint">드래그로 회전 · 휠로 확대 · 노드나 목록을 선택해 내용 열기</p>}
    </div>
    <ul className="knowledge-graph-stage__kinds" aria-label="노드 유형">
      {[...new Set(data.nodes.map(node => node.kind))].map(kind => <li key={kind} data-node-kind={kind}>{nodeKindLabel(kind)}</li>)}
    </ul>
    <ul className="knowledge-graph-stage__legend" aria-label="관계 범례와 필터">
      {KNOWLEDGE_GRAPH_RELATIONS.filter(kind => data.edges.some(edge => edge.kind === kind)).map(kind => <li key={kind} data-relation={relationClass(kind)}><label><input type="checkbox" checked={!hidden.includes(kind)} onChange={() => setHidden(current => current.includes(kind) ? current.filter(value => value !== kind) : [...current, kind])} />{relationLabel(kind)}</label></li>)}
    </ul>
    <div className="knowledge-graph-stage__semantics">
      <div>
        <h3>노드 탐색 <small>{nodes.length} / {data.nodes.length}</small></h3>
        <label className="knowledge-graph-stage__search">제목으로 찾기<input type="search" aria-label={`${ariaLabel} 노드 검색`} placeholder="문서·개념 제목 검색" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <ul className="knowledge-graph-stage__nodes" aria-label={`${ariaLabel} 노드 목록`} onKeyDown={moveListFocus}>
          {nodes.map(node => <li key={node.renderer_id}><button type="button" aria-pressed={engine.selectedRendererId === node.renderer_id} onClick={() => engine.selectNode(node)}><span>{node.title || "제목 없음"}</span><small data-node-kind={node.kind}>{nodeKindLabel(node.kind)}</small></button></li>)}
          {!nodes.length && <li className="knowledge-graph-stage__list-empty">{search.trim() ? "검색 결과가 없습니다. 다른 제목으로 찾아보세요." : emptyMessage}</li>}
        </ul>
      </div>
      <details>
        <summary>연결 {filteredEdges.length}개 <small>/ 전체 {data.edges.length}개</small></summary>
        <ol className="knowledge-graph-stage__edges" aria-label={`${ariaLabel} 연결 목록`}>
          {filteredEdges.map((edge, index) => <li key={`${edge.source_renderer_id}:${edge.target_renderer_id}:${index}`} data-relation={relationClass(edge.kind)} data-resolution={edge.resolution} data-predicate={typeof edge.predicate === "string" ? edge.predicate : undefined}>
            <div className="knowledge-graph-stage__edge-path">{nodeButton(edge.source_renderer_id)}<span aria-label={edge.direction === "undirected" ? "양방향" : "방향"}>{edge.direction === "undirected" ? "↔" : "→"}</span>{edge.resolution === "resolved" && edge.target_renderer_id ? nodeButton(edge.target_renderer_id) : <span>{edge.target_title || "연결 대상 확인 필요"}</span>}</div>
            <small>{predicateLabel(edge.predicate) ?? relationLabel(edge.kind)} · {edge.kind === "ai_derived" ? "AI 제안 · 게시됨" : edge.resolution === "resolved" ? "연결됨" : "대상을 확인할 수 없음"}</small>
            {edge.provenance && <details><summary>검증 정보</summary><pre>{JSON.stringify(edge.provenance, null, 2)}</pre></details>}
          </li>)}
          {!filteredEdges.length && <li className="knowledge-graph-stage__list-empty">{hidden.length ? "선택한 관계 유형의 연결이 없습니다." : "아직 연결이 없습니다. 노드를 선택해 내용을 확인하세요."}</li>}
        </ol>
      </details>
    </div>
  </section>;
}

function moveListFocus(event: KeyboardEvent<HTMLUListElement>): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const first = buttons[0];
  if (!first) return;
  event.preventDefault();
  const activeButton = document.activeElement instanceof HTMLButtonElement ? document.activeElement : first;
  const current = Math.max(0, buttons.indexOf(activeButton));
  const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[target]?.focus();
}
