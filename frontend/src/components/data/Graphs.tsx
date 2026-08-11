export type GraphNode = Readonly<{ id: string; label: string; x: number; y: number; tone?: "primary" | "ai" | "muted" }>;
export type GraphEdge = Readonly<{ source: string; target: string }>;

export function NodeGraph({
  nodes,
  edges,
}: Readonly<{ nodes: readonly GraphNode[]; edges: readonly GraphEdge[] }>) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return (
    <div className="nodegraph">
      <svg viewBox="0 0 100 62" className="nodegraph__svg" role="img" aria-label="관계 그래프">
        {edges.map((edge) => {
          const a = byId.get(edge.source);
          const b = byId.get(edge.target);
          if (!a || !b) return null;
          return (
            <line
              key={`${edge.source}-${edge.target}`}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              className="nodegraph__edge"
            />
          );
        })}
        {nodes.map((node) => (
          <g key={node.id}>
            <circle cx={node.x} cy={node.y} r={2.6} className={`nodegraph__node nodegraph__node--${node.tone ?? "primary"}`} />
            <text x={node.x} y={node.y - 4} className="nodegraph__label">{node.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export type FlowNode = Readonly<{ id: string; kind: "트리거" | "조건" | "액션" | "승인"; label: string; detail: string }>;

export function FlowCanvas({ nodes }: Readonly<{ nodes: readonly FlowNode[] }>) {
  return (
    <div className="flowcanvas">
      {nodes.map((node, index) => (
        <div className="flowcanvas__step" key={node.id}>
          <article className={`flownode flownode--${index === 0 ? "trigger" : node.kind === "조건" ? "cond" : node.kind === "승인" ? "approve" : "action"}`}>
            <span className="flownode__kind">{node.kind}</span>
            <b>{node.label}</b>
            <span className="flownode__detail">{node.detail}</span>
          </article>
          {index < nodes.length - 1 && <span className="flowcanvas__arrow" aria-hidden="true">↓</span>}
        </div>
      ))}
    </div>
  );
}
