import { z } from "zod";

/** Vault 그래프 3D 배치·투영 엔진. React 와 canvas 에 의존하지 않는 순수 수학. */

export const versionTokenSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]);

export const graphIdentitySchema = z.object({
  store: z.enum(["legacy", "pg"]),
  company: z.string().min(1).nullable(),
  owner: z.string().min(1).nullable(),
  kind: z.enum(["note", "document", "space"]),
  opaque_id: z.string().min(1),
}).strict().superRefine((identity, context) => {
  if (identity.kind === "note" && identity.owner === null) {
    context.addIssue({ code: "custom", message: "note owner is required", path: ["owner"] });
  }
  if (identity.kind !== "note" && identity.company === null) {
    context.addIssue({ code: "custom", message: "company scope is required", path: ["company"] });
  }
  if (identity.store === "pg" && identity.kind === "note" && identity.company !== null) {
    context.addIssue({ code: "custom", message: "PG personal identity is company-independent", path: ["company"] });
  }
});
export type GraphIdentity = z.infer<typeof graphIdentitySchema>;

export function graphRendererId(identity: GraphIdentity): string {
  return JSON.stringify([identity.store, identity.company, identity.owner, identity.kind, identity.opaque_id]);
}

const graphEndpointBaseSchema = z.object({
  source: z.string(),
  target_id: z.string().nullable(),
  source_renderer_id: z.string().min(1),
  target_renderer_id: z.string().min(1).nullable(),
  target_title: z.string().catch(""),
  binding: z.enum(["explicit", "title", "membership", "inference"]),
  resolution: z.enum(["resolved", "unresolved", "unavailable"]),
  resolution_reason: z.string().optional(),
  score: z.number().min(-1).max(1).optional(),
  provenance: z.object({
    provider: z.string(), model: z.string(), method: z.string(),
    source_version: versionTokenSchema, target_version: versionTokenSchema, analyzed_at: z.string(),
  }).passthrough().optional(),
}).passthrough();

function validateGraphEndpoint(
  edge: z.infer<typeof graphEndpointBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (edge.resolution === "resolved" && (edge.target_id === null || edge.target_renderer_id === null)) {
    context.addIssue({ code: "custom", message: "resolved edge requires a server-authorized target" });
  }
  if (edge.resolution !== "resolved" && (edge.target_id !== null || edge.target_renderer_id !== null)) {
    context.addIssue({ code: "custom", message: "unresolved edge cannot expose a render target" });
  }
}

export const graphEndpointSchema = graphEndpointBaseSchema.superRefine(validateGraphEndpoint);
export const graphEdgeSchema = graphEndpointBaseSchema.extend({
  kind: z.enum(["manual", "ai_similarity"]).optional(),
}).superRefine(validateGraphEndpoint);

// The renderer ID and API ID must name the same node in this authorized graph.
export function validateGraphBindings(
  graph: { nodes: readonly { id: string; renderer_id: string; identity: GraphIdentity }[]; edges: readonly z.infer<typeof graphEndpointSchema>[] },
  context: z.RefinementCtx,
): void {
  const nodes = new Map(graph.nodes.map((node) => [node.renderer_id, node]));
  if (nodes.size !== graph.nodes.length) context.addIssue({ code: "custom", message: "duplicate renderer identity", path: ["nodes"] });
  if (new Set(graph.nodes.map((node) => node.id)).size !== graph.nodes.length) {
    context.addIssue({ code: "custom", message: "ambiguous API identity", path: ["nodes"] });
  }
  graph.edges.forEach((edge, index) => {
    const source = nodes.get(edge.source_renderer_id);
    const target = edge.target_renderer_id === null ? undefined : nodes.get(edge.target_renderer_id);
    if (!source || source.id !== edge.source) {
      context.addIssue({ code: "custom", message: "source identity mismatch", path: ["edges", index, "source_renderer_id"] });
    }
    if (edge.resolution === "resolved" && (!target || target.id !== edge.target_id)) {
      context.addIssue({ code: "custom", message: "target identity mismatch", path: ["edges", index, "target_renderer_id"] });
    }
    if (source && target && (source.identity.store !== target.identity.store || source.identity.company !== target.identity.company || source.identity.owner !== target.identity.owner)) {
      context.addIssue({ code: "custom", message: "endpoint scope mismatch", path: ["edges", index] });
    }
  });
}

export const graphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      renderer_id: z.string().min(1),
      identity: graphIdentitySchema,
      title: z.string().catch(""),
      folder: z.string().catch("/"),
    }).passthrough().superRefine((node, context) => {
      if (node.identity.kind !== "note") context.addIssue({ code: "custom", message: "Vault node must be a note" });
      if (node.id !== node.identity.opaque_id) context.addIssue({ code: "custom", message: "node API ID mismatch" });
      if (node.renderer_id !== graphRendererId(node.identity)) context.addIssue({ code: "custom", message: "renderer identity mismatch" });
    }),
  ),
  edges: z.array(graphEdgeSchema).default([]),
  analysis: z.array(z.object({ id: z.string(), state: z.string() })).optional(),
  orphans: z.array(z.string()).catch([]),
}).superRefine(validateGraphBindings);

export type VaultGraph = z.infer<typeof graphSchema>;
export type GraphNode = VaultGraph["nodes"][number];

export type Camera = { yaw: number; pitch: number; distance: number };

export type Scene = {
  readonly count: number;
  readonly pos: Float32Array; // x,y,z
  readonly disp: Float32Array;
  readonly links: Int32Array; // [a,b] 쌍
  readonly linkCount: number;
  readonly linkKinds: readonly ("manual" | "ai_similarity")[];
  readonly linkEdges: readonly VaultGraph["edges"][number][];
  readonly degree: Int32Array;
  readonly proj: Float32Array; // sx,sy,depth,scale
  readonly order: Int32Array;
  readonly k: number;
  alpha: number;
  unresolved: number;
  unavailable: number;
  width: number;
  height: number;
};

export const ALPHA_MIN = 0.02;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** noUncheckedIndexedAccess 아래에서 TypedArray 읽기를 number 로 좁힌다(범위는 호출부가 보장). */
const at = (buffer: Float32Array | Int32Array, index: number): number => buffer[index] as number;

/** 폴더별 색. 팔레트는 DESIGN.md 토큰 계열에서 고른 8색 고정. */
const PALETTE = [
  "#4f46e5",
  "#7c3aed",
  "#0ea5e9",
  "#15803d",
  "#b45309",
  "#b91c1c",
  "#0f766e",
  "#a21caf",
] as const;

/** 폴더를 정렬 순서대로 팔레트에 배정한다(해시 배정과 달리 이웃 폴더 색이 겹치지 않는다). */
export function folderPalette(nodes: readonly GraphNode[]): ReadonlyMap<string, string> {
  const folders = [...new Set(nodes.map((n) => n.folder))].sort();
  return new Map(folders.map((folder, i) => [folder, PALETTE[i % PALETTE.length] as string]));
}

/** 흰색과 섞어 하이라이트 색을 만든다(구체 음영용). */
export function lighten(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (channel: number): number => Math.round(channel + (255 - channel) * amount);
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}

/** 노드를 피보나치 구면에 결정론적으로 뿌리고 링크를 인덱스 쌍으로 정규화한다. */
export function buildScene(graph: VaultGraph): Scene {
  const count = graph.nodes.length;
  const index = new Map<string, number>();
  graph.nodes.forEach((node, i) => {
    index.set(node.renderer_id, i);
  });

  const pairs: number[] = [];
  const linkKinds: ("manual" | "ai_similarity")[] = [];
  const linkEdges: VaultGraph["edges"][number][] = [];
  let unresolved = 0;
  let unavailable = 0;
  for (const edge of graph.edges) {
    if (edge.resolution !== "resolved") {
      if (edge.resolution === "unavailable") unavailable += 1;
      else unresolved += 1;
      continue;
    }
    const a = index.get(edge.source_renderer_id);
    const b = index.get(edge.target_renderer_id ?? "");
    if (a === undefined || b === undefined) {
      unavailable += 1;
      continue;
    }
    // Each directed declaration has its own identity/provenance, even at equal endpoints.
    pairs.push(a, b);
    linkKinds.push(edge.kind ?? "manual");
    linkEdges.push(structuredClone(edge));
  }

  const degree = new Int32Array(count);
  for (let i = 0; i < pairs.length; i += 2) {
    const a = pairs[i] as number;
    const b = pairs[i + 1] as number;
    degree[a] = at(degree, a) + 1;
    degree[b] = at(degree, b) + 1;
  }

  const k = 46 + 3 * Math.sqrt(Math.max(count, 1));
  const radius = count === 1 ? 0 : k * Math.cbrt(Math.max(count, 2));
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const y = count === 1 ? 0 : 1 - (i / (count - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = GOLDEN * i;
    const jitter = 0.85 + ((i * 2654435761) % 1000) / 3333;
    pos[i * 3] = Math.cos(theta) * ring * radius * jitter;
    pos[i * 3 + 1] = y * radius * jitter;
    pos[i * 3 + 2] = Math.sin(theta) * ring * radius * jitter;
  }

  return {
    count,
    pos,
    disp: new Float32Array(count * 3),
    links: Int32Array.from(pairs),
    linkCount: pairs.length / 2,
    linkKinds,
    linkEdges,
    degree,
    proj: new Float32Array(count * 4),
    order: Int32Array.from({ length: count }, (_, i) => i),
    k,
    alpha: 1,
    unresolved,
    unavailable,
    width: 900,
    height: 600,
  };
}

/**
 * 3D Fruchterman-Reingold 한 스텝.
 * 반발 k^2/d, 인력 d^2/k, 중심 복원 2% (고립 노드가 연결 군집을 화면 밖으로 밀지 않도록), 스텝 상한 k*alpha, 냉각 0.985 (alpha 1 -> 0.02 = 약 257 스텝).
 * 프레임당 할당 없음(disp 재사용). count<=400 에서 O(n^2) 로 충분하다.
 */
export function stepScene(scene: Scene): void {
  const { count, pos, disp, links, linkCount, k } = scene;
  disp.fill(0);

  for (let i = 0; i < count; i += 1) {
    const ix = i * 3;
    const x = at(pos, ix);
    const y = at(pos, ix + 1);
    const z = at(pos, ix + 2);
    let ax = 0;
    let ay = 0;
    let az = 0;

    for (let j = i + 1; j < count; j += 1) {
      const jx = j * 3;
      let dx = x - at(pos, jx);
      let dy = y - at(pos, jx + 1);
      let dz = z - at(pos, jx + 2);
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 0.01) {
        dx = ((i * 7 + j) % 13) - 6;
        dy = ((i * 11 + j) % 13) - 6;
        dz = ((i * 17 + j) % 13) - 6;
        d2 = dx * dx + dy * dy + dz * dz + 0.01;
      }
      const f = (k * k) / d2; // 성분에 곱하면 크기 k^2/d
      const fx = dx * f;
      const fy = dy * f;
      const fz = dz * f;
      ax += fx;
      ay += fy;
      az += fz;
      disp[jx] = at(disp, jx) - fx;
      disp[jx + 1] = at(disp, jx + 1) - fy;
      disp[jx + 2] = at(disp, jx + 2) - fz;
    }

    disp[ix] = at(disp, ix) + ax;
    disp[ix + 1] = at(disp, ix + 1) + ay;
    disp[ix + 2] = at(disp, ix + 2) + az;
  }

  for (let l = 0; l < linkCount; l += 1) {
    const a = at(links, l * 2) * 3;
    const b = at(links, l * 2 + 1) * 3;
    const dx = at(pos, a) - at(pos, b);
    const dy = at(pos, a + 1) - at(pos, b + 1);
    const dz = at(pos, a + 2) - at(pos, b + 2);
    const f = Math.sqrt(dx * dx + dy * dy + dz * dz) / k; // 성분에 곱하면 크기 d^2/k
    disp[a] = at(disp, a) - dx * f;
    disp[a + 1] = at(disp, a + 1) - dy * f;
    disp[a + 2] = at(disp, a + 2) - dz * f;
    disp[b] = at(disp, b) + dx * f;
    disp[b + 1] = at(disp, b + 1) + dy * f;
    disp[b + 2] = at(disp, b + 2) + dz * f;
  }

  const maxStep = k * scene.alpha;
  for (let i = 0; i < count; i += 1) {
    const ix = i * 3;
    const dx = at(disp, ix);
    const dy = at(disp, ix + 1);
    const dz = at(disp, ix + 2);
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const s = len > maxStep ? maxStep / len : 1;
    pos[ix] = (at(pos, ix) + dx * s) * 0.98;
    pos[ix + 1] = (at(pos, ix + 1) + dy * s) * 0.98;
    pos[ix + 2] = (at(pos, ix + 2) + dz * s) * 0.98;
  }

  scene.alpha *= 0.985;
}

/** 배치가 차지하는 반지름. 카메라 자동 맞춤에 쓴다. */
export function boundingRadius(scene: Scene): number {
  let max = 1;
  for (let i = 0; i < scene.count; i += 1) {
    const ix = i * 3;
    const r2 = at(scene.pos, ix) ** 2 + at(scene.pos, ix + 1) ** 2 + at(scene.pos, ix + 2) ** 2;
    if (r2 > max) max = r2;
  }
  return Math.sqrt(max);
}

export function focalOf(height: number): number {
  return Math.max(320, height * 1.1);
}

/** 월드 -> 카메라(yaw,pitch,distance) -> 화면. proj 와 order(먼 것부터)를 갱신한다. */
export function projectScene(scene: Scene, camera: Camera, width: number, height: number): void {
  scene.width = width;
  scene.height = height;
  // 카메라는 구면 밖에 둔다. 뒤쪽 노드를 근평면에 붙여 그리는 왜곡을 방지한다.
  camera.distance = Math.max(camera.distance, boundingRadius(scene) + 40);
  const cy = Math.cos(camera.yaw);
  const sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  const focal = focalOf(height);
  const ox = width / 2;
  const oy = height / 2;
  const { pos, proj, count, order } = scene;

  for (let i = 0; i < count; i += 1) {
    const ix = i * 3;
    const x = at(pos, ix);
    const y = at(pos, ix + 1);
    const z = at(pos, ix + 2);
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const y2 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const depth = z2 + camera.distance;
    const scale = focal / depth;
    const px = i * 4;
    proj[px] = ox + x1 * scale;
    proj[px + 1] = oy - y2 * scale;
    proj[px + 2] = depth;
    proj[px + 3] = scale;
  }

  // 화가 알고리즘: 먼 노드부터 그리도록 삽입 정렬(프레임 간 거의 정렬된 상태라 O(n)에 가깝다).
  for (let i = 1; i < count; i += 1) {
    const v = at(order, i);
    const d = at(proj, v * 4 + 2);
    let j = i - 1;
    while (j >= 0 && at(proj, at(order, j) * 4 + 2) < d) {
      order[j + 1] = at(order, j);
      j -= 1;
    }
    order[j + 1] = v;
  }
}

export function projected(scene: Scene, i: number, field: 0 | 1 | 2 | 3): number {
  return at(scene.proj, i * 4 + field);
}

export function orderAt(scene: Scene, position: number): number {
  return at(scene.order, position);
}

export function linkEnds(scene: Scene, l: number): readonly [number, number] {
  return [at(scene.links, l * 2), at(scene.links, l * 2 + 1)];
}

/** 노드 반지름(월드 기준). 연결이 많을수록 크다. */
export function nodeRadius(scene: Scene, i: number): number {
  return 10 + 3.4 * Math.sqrt(at(scene.degree, i));
}

export function screenRadius(scene: Scene, i: number): number {
  return Math.max(4.5, nodeRadius(scene, i) * projected(scene, i, 3));
}

/** 그래프 전체가 화면을 알맞게 채우는 카메라 거리. */
export function fitDistance(scene: Scene): number {
  const half = Math.max(1, (Math.min(scene.width, scene.height) - 80) / 2);
  const radius = boundingRadius(scene) + 24;
  return Math.max(160, radius * Math.hypot(1, focalOf(scene.height) / half));
}

/** 깊이 안개: 가까울수록 1, 멀수록 흐려진다. */
export function depthAlpha(scene: Scene, i: number, distance: number): number {
  const rel = projected(scene, i, 2) / Math.max(1, distance);
  return Math.min(1, Math.max(0.18, 1.35 - rel * 0.75));
}

/** 화면 좌표에서 가장 앞에 있는 노드를 고른다. 없으면 -1. */
export function pickNode(scene: Scene, x: number, y: number): number {
  let best = -1;
  let bestDepth = Infinity;
  for (let i = 0; i < scene.count; i += 1) {
    const r = Math.max(6, screenRadius(scene, i) + 4);
    const dx = projected(scene, i, 0) - x;
    const dy = projected(scene, i, 1) - y;
    if (dx * dx + dy * dy > r * r) continue;
    const depth = projected(scene, i, 2);
    if (depth < bestDepth) {
      bestDepth = depth;
      best = i;
    }
  }
  return best;
}
