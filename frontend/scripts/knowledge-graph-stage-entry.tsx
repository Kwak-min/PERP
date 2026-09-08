import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { KnowledgeGraphStage } from "../src/components/data/KnowledgeGraphStage.tsx";
import type { KnowledgeGraphRelation, KnowledgeGraphStageData } from "../src/components/data/knowledgeGraphStageModel.ts";
import "../src/styles.css";

const unsafeTitle = `<img src="https://untrusted.invalid/pixel.png" onerror="window.__unsafeExecuted=true"><script>window.__unsafeExecuted=true</script>`;

function makeGraph(count: number): KnowledgeGraphStageData {
  const nodes = Array.from({ length: count }, (_, index) => {
    const opaqueId = String(index);
    const kind = index === 2 ? "space" as const : "document" as const;
    return {
      id: kind === "space" ? `project:${opaqueId}` : opaqueId,
      renderer_id: JSON.stringify(["pg", "company-task-27", null, kind, opaqueId]),
      identity: { store: "pg" as const, company: "company-task-27", owner: null, kind, opaque_id: opaqueId },
      kind,
      title: index === 0 ? unsafeTitle : `인가된 지식 노드 ${index}`,
      source: "company",
      image: "https://untrusted.invalid/never-fetch.png",
    };
  });
  const resolvedEdge = (sourceIndex: number, targetIndex: number, kind: KnowledgeGraphRelation, index: number) => ({
    source: nodes[sourceIndex]?.id ?? "",
    target_id: nodes[targetIndex]?.id ?? null,
    source_renderer_id: nodes[sourceIndex]?.renderer_id ?? "",
    target_renderer_id: nodes[targetIndex]?.renderer_id ?? null,
    target_title: nodes[targetIndex]?.title ?? "",
    kind,
    binding: kind === "ai_similarity" ? "inference" as const : kind === "space" ? "membership" as const : "explicit" as const,
    resolution: "resolved" as const,
    provenance: { provider: "authorized-synthetic", model: "local-task-27", nested: { declaration: index } },
  });
  const edges = count < 2 ? [] : [
    resolvedEdge(0, 1, "wiki", 0),
    resolvedEdge(1, 0, "wiki", 1),
    resolvedEdge(0, 1, "ai_similarity", 2),
    ...Array.from({ length: Math.max(0, count - 2) }, (_, index) => resolvedEdge(index + 1, index + 2, index % 3 === 0 ? "space" : "wiki", index + 3)),
  ];
  return { nodes, edges };
}

function Fixture() {
  const [count, setCount] = useState(1);
  const [mounted, setMounted] = useState(true);
  const [scope, setScope] = useState(0);
  const [selected, setSelected] = useState("");
  const data = useMemo(() => makeGraph(count), [count]);
  const snapshot = useMemo(() => JSON.stringify(data), [data]);
  window.__task27Source = data;
  window.__task27Snapshot = snapshot;
  window.__task27Unchanged = () => JSON.stringify(data) === window.__task27Snapshot;
  window.__unsafeExecuted = window.__unsafeExecuted ?? false;
  return (
    <main className="screen task27-fixture">
      <header className="screen-header"><div><span className="eyebrow">Task 27 renderer QA</span><h1>공통 3D 지식 그래프</h1><p>서버에서 인가된 합성 그래프만 사용하는 실제 컴포넌트 검증 화면입니다.</p></div></header>
      <nav aria-label="QA 그래프 전환" className="task27-fixture__switches">
        {[0, 1, 1000].map((value) => <button key={value} type="button" onClick={() => setCount(value)}>{value}개 노드</button>)}
        <button type="button" onClick={() => setMounted((value) => !value)}>{mounted ? "그래프 해제" : "그래프 장착"}</button>
        <button type="button" onClick={() => setScope((value) => value + 1)}>범위 전환</button>
      </nav>
      <output data-testid="selected-node" hidden>{selected}</output>
      {mounted && <KnowledgeGraphStage data={data} scopeKey={`company-task-27:${scope}`} ariaLabel="인가된 합성 지식 그래프" emptyMessage="표시할 수 있는 지식 노드가 없습니다." onNodeSelect={(node) => setSelected(node.renderer_id)} />}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new TypeError("Task 27 fixture root is missing");
createRoot(root).render(<Fixture />);

declare global {
  interface Window {
    __task27Source: KnowledgeGraphStageData;
    __task27Snapshot: string;
    __task27Unchanged: () => boolean;
    __unsafeExecuted: boolean;
  }
}
