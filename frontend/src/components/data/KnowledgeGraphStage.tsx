import { useEffect, useState, type KeyboardEvent } from "react";

import {
  relationClass,
  relationLabel,
  type KnowledgeGraphStageData,
  type KnowledgeGraphStageNode,
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

export function KnowledgeGraphStage({ data, scopeKey, ariaLabel, emptyMessage, onNodeSelect }: KnowledgeGraphStageProps) {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = (): void => setReducedMotion(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const engine = useKnowledgeGraphEngine({ data, scopeKey, reducedMotion, ...(onNodeSelect ? { onNodeSelect } : {}) });

  return (
    <section className="knowledge-graph-stage" data-engine-state={engine.engineState} data-render-state={engine.renderState} data-scope-key={scopeKey}>
      <div className="knowledge-graph-stage__toolbar" aria-label={`${ariaLabel} 시점 제어`}>
        <button type="button" onClick={() => engine.moveCamera(-Math.PI / 12, 1)} aria-label="왼쪽으로 회전">왼쪽</button>
        <button type="button" onClick={() => engine.moveCamera(Math.PI / 12, 1)} aria-label="오른쪽으로 회전">오른쪽</button>
        <button type="button" onClick={() => engine.moveCamera(0, 0.82)} aria-label="확대">확대</button>
        <button type="button" onClick={() => engine.moveCamera(0, 1.22)} aria-label="축소">축소</button>
        <button type="button" onClick={engine.fit}>화면 맞춤</button>
        <button type="button" aria-pressed={engine.autoRotate && !reducedMotion} disabled={reducedMotion} onClick={engine.toggleAutoRotate}>
          {engine.autoRotate && !reducedMotion ? "자동 회전 끄기" : "자동 회전"}
        </button>
      </div>
      <div className="knowledge-graph-stage__viewport" aria-label={ariaLabel}>
        <div ref={engine.hostRef} className="knowledge-graph-stage__webgl" aria-hidden="true" />
        {engine.engineState === "loading" && <p className="knowledge-graph-stage__message" role="status">3D 그래프를 준비하고 있습니다.</p>}
        {engine.engineState === "error" && <p className="knowledge-graph-stage__message" role="alert">이 환경에서는 WebGL 3D 그래프를 표시할 수 없습니다. 아래 목록에서 모든 노드와 연결을 계속 탐색할 수 있습니다.</p>}
        {engine.engineState === "empty" && <p className="knowledge-graph-stage__message">{emptyMessage}</p>}
        {engine.hoveredTitle && <output className="knowledge-graph-stage__hover" aria-live="polite">{engine.hoveredTitle}</output>}
      </div>
      <ul className="knowledge-graph-stage__legend" aria-label="관계 범례">
        <li data-relation="wiki">직접 위키 링크</li>
        <li data-relation="ai">AI 유사도 추론</li>
        <li data-relation="space">프로젝트·공간 소속</li>
      </ul>
      <div className="knowledge-graph-stage__semantics">
        <div>
          <h3>노드 탐색</h3>
          <ul className="knowledge-graph-stage__nodes" aria-label={`${ariaLabel} 노드 목록`} onKeyDown={moveListFocus}>
            {data.nodes.map((node) => (
              <li key={node.renderer_id}>
                <button type="button" aria-pressed={engine.selectedRendererId === node.renderer_id} onClick={() => engine.selectNode(node)}>
                  <span>{node.title || "제목 없음"}</span><small>{node.kind}</small>
                </button>
              </li>
            ))}
            {data.nodes.length === 0 && <li>{emptyMessage}</li>}
          </ul>
        </div>
        <details>
          <summary>연결 {data.edges.length}개</summary>
          <ol className="knowledge-graph-stage__edges" aria-label={`${ariaLabel} 연결 목록`}>
            {data.edges.map((edge, index) => (
              <li key={`${edge.source_renderer_id}:${edge.target_renderer_id}:${index}`} data-relation={relationClass(edge.kind)} data-resolution={edge.resolution}>
                <span>{nodeTitle(data, edge.source_renderer_id)} → {edge.resolution === "resolved" && edge.target_renderer_id ? nodeTitle(data, edge.target_renderer_id) : edge.target_title}</span>
                <small>{relationLabel(edge.kind)} · {edge.resolution}</small>
              </li>
            ))}
          </ol>
        </details>
      </div>
    </section>
  );
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

function nodeTitle(data: KnowledgeGraphStageData, rendererId: string): string {
  return data.nodes.find((node) => node.renderer_id === rendererId)?.title ?? "접근할 수 없는 노드";
}
