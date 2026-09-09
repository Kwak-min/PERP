import type { GraphIdentity } from "../../screens/vault/graph3d.ts";

export type WikiGraphIdentity = Omit<GraphIdentity, "kind"> & { readonly kind: "source" | "page" | "entity" | "concept" };
export type StageGraphIdentity = GraphIdentity | WikiGraphIdentity;

export const KNOWLEDGE_GRAPH_RELATIONS = ["manual", "wiki", "link", "ai_similarity", "space", "project", "citation", "ai_derived"] as const;
export type KnowledgeGraphRelation = (typeof KNOWLEDGE_GRAPH_RELATIONS)[number];

export type KnowledgeGraphStageNode = {
  readonly id: string;
  readonly renderer_id: string;
  readonly identity: StageGraphIdentity;
  readonly kind: StageGraphIdentity["kind"];
  readonly title: string;
  readonly folder?: string;
  readonly [field: string]: unknown;
};

export type KnowledgeGraphStageEdge = {
  readonly source: string;
  readonly target_id: string | null;
  readonly source_renderer_id: string;
  readonly target_renderer_id: string | null;
  readonly target_title: string;
  readonly kind: KnowledgeGraphRelation;
  readonly binding: "explicit" | "title" | "membership" | "inference";
  readonly resolution: "resolved" | "unresolved" | "unavailable";
  readonly direction?: "directed" | "undirected";
  readonly provenance?: object | undefined;
  readonly [field: string]: unknown;
};

export type KnowledgeGraphStageData = {
  readonly nodes: readonly KnowledgeGraphStageNode[];
  readonly edges: readonly KnowledgeGraphStageEdge[];
};

/** Mutable copies are the only objects handed to d3-force-3d. */
export type KnowledgeGraphRenderNode = KnowledgeGraphStageNode & {
  readonly render_id: string;
  x?: number;
  y?: number;
  z?: number;
};

/** render_source/render_target absorb the engine's endpoint-object mutation. */
export type KnowledgeGraphRenderLink = KnowledgeGraphStageEdge & {
  readonly render_edge_id: string;
  readonly curvature: number;
  render_source: string | KnowledgeGraphRenderNode;
  render_target: string | KnowledgeGraphRenderNode;
};

export type PreparedKnowledgeGraph = {
  readonly nodes: KnowledgeGraphRenderNode[];
  readonly links: KnowledgeGraphRenderLink[];
  readonly identityMap: ReadonlyMap<string, KnowledgeGraphStageNode>;
};

export type KnowledgeGraphRelationClass = "wiki" | "ai" | "space" | "citation" | "derived";

export function relationClass(kind: KnowledgeGraphRelation): KnowledgeGraphRelationClass {
  switch (kind) {
    case "manual":
    case "wiki":
    case "link":
      return "wiki";
    case "ai_similarity":
      return "ai";
    case "citation":
      return "citation";
    case "ai_derived":
      return "derived";
    case "space":
    case "project":
      return "space";
    default:
      return assertNever(kind);
  }
}

export function relationLabel(kind: KnowledgeGraphRelation): string {
  const relation = relationClass(kind);
  switch (relation) {
    case "wiki":
      return "직접 위키 링크";
    case "ai":
      return "AI 유사도 추론";
    case "space":
      return "프로젝트·공간 소속";
    case "citation":
      return "고정 판 인용";
    case "derived":
      return "AI 근거 기반 파생 관계";
    default:
      return assertNever(relation);
  }
}

export function nodeKindLabel(kind: StageGraphIdentity["kind"]): string {
  return { note: "개인 노트", document: "문서", space: "프로젝트·공간", source: "원본", page: "위키", entity: "대상", concept: "개념" }[kind];
}

export function predicateLabel(predicate: unknown): string | null {
  switch (predicate) {
    case "related": return "관련 있음";
    case "supports": return "뒷받침함";
    case "contradicts": return "상충함";
    case "supersedes": return "대체함";
    default: return null;
  }
}

export function prepareKnowledgeGraph(data: KnowledgeGraphStageData): PreparedKnowledgeGraph {
  const identityMap = new Map(data.nodes.map((node) => [node.renderer_id, node]));
  const nodes = data.nodes.map((node): KnowledgeGraphRenderNode => ({
    ...structuredClone(node),
    render_id: node.renderer_id,
  }));

  const resolved = data.edges.filter((edge) =>
    edge.resolution === "resolved"
    && edge.target_renderer_id !== null
    && identityMap.has(edge.source_renderer_id)
    && identityMap.has(edge.target_renderer_id));
  const groupCounts = new Map<string, number>();
  for (const edge of resolved) {
    const target = edge.target_renderer_id ?? "";
    const key = [edge.source_renderer_id, target].sort().join("\u0000");
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
  }
  const groupPositions = new Map<string, number>();
  const links = resolved.map((edge, index): KnowledgeGraphRenderLink => {
    const target = edge.target_renderer_id ?? "";
    const key = [edge.source_renderer_id, target].sort().join("\u0000");
    const position = groupPositions.get(key) ?? 0;
    groupPositions.set(key, position + 1);
    const count = groupCounts.get(key) ?? 1;
    // The engine's perpendicular flips when source/target reverse. Assign lanes
    // in canonical endpoint order, then convert to the link's directed frame.
    const direction = edge.source_renderer_id < target ? 1 : -1;
    return {
      ...structuredClone(edge),
      render_edge_id: `${index}:${edge.source_renderer_id}:${target}`,
      render_source: edge.source_renderer_id,
      render_target: target,
      curvature: edge.source_renderer_id === target ? 0.4 + position * 0.12 : (position - (count - 1) / 2) * 0.22 * direction,
    };
  });
  return { nodes, links, identityMap };
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported graph variant: ${String(value)}`);
}
