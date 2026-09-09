import type { ForceGraph3DInstance, LinkObject, NodeObject } from "3d-force-graph";
import type { RefObject } from "react";

import type { KnowledgeGraphRenderLink, KnowledgeGraphRenderNode, KnowledgeGraphStageData, KnowledgeGraphStageNode } from "./knowledgeGraphStageModel.ts";

export type OrbitControls = {
  autoRotate: boolean;
  autoRotateSpeed: number;
  readonly domElement: Element;
  // Three 0.185.1 exposes this bound instance listener, but dispose omits it.
  readonly _interceptControlUp: EventListener;
  update(): boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
};

export type StageGraph = ForceGraph3DInstance;

export type ActiveGraph = {
  readonly graph: StageGraph;
  readonly controls: OrbitControls;
  readonly nodes: ReadonlyMap<string, KnowledgeGraphRenderNode>;
  settled: boolean;
  wakeFrame: number;
};

export type GraphEngineRequest = {
  readonly data: KnowledgeGraphStageData;
  readonly scopeKey: string;
  readonly reducedMotion: boolean;
  readonly onNodeSelect?: (node: KnowledgeGraphStageNode) => void;
};

export type GraphEngineController = {
  readonly hostRef: RefObject<HTMLDivElement | null>;
  readonly engineState: "empty" | "loading" | "ready" | "error";
  readonly renderState: "active" | "idle";
  readonly autoRotate: boolean;
  readonly selectedRendererId: string | null;
  readonly hoveredTitle: string;
  readonly selectNode: (node: KnowledgeGraphStageNode) => void;
  readonly moveCamera: (angle: number, zoom: number) => void;
  readonly fit: () => void;
  readonly toggleAutoRotate: () => void;
};

export function isOrbitControls(value: object): value is OrbitControls {
  return "autoRotate" in value && "autoRotateSpeed" in value && "update" in value && typeof value.update === "function"
    && "addEventListener" in value && typeof value.addEventListener === "function"
    && "removeEventListener" in value && typeof value.removeEventListener === "function"
    && "domElement" in value && value.domElement instanceof Element
    && "_interceptControlUp" in value && typeof value._interceptControlUp === "function";
}

export function isRenderNode(value: NodeObject): value is KnowledgeGraphRenderNode {
  return "render_id" in value && typeof value.render_id === "string";
}

export function isRenderLink(value: LinkObject): value is KnowledgeGraphRenderLink {
  return "kind" in value && typeof value.kind === "string";
}
