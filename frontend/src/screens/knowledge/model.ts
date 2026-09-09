import { z } from "zod";

import {
  graphEndpointSchema,
  graphIdentitySchema,
  graphRendererId,
  validateGraphBindings,
} from "../vault/graph3d.ts";

/** 조직 지식(RAG) 그래프 응답. 백엔드 GET /documents/graph 와 짝을 이룬다. */
export const knowledgeNodeSchema = z.object({
  id: z.string(),
  renderer_id: z.string().min(1),
  identity: graphIdentitySchema,
  kind: z.enum(["space", "document"]),
  title: z.string().catch(""),
  folder: z.string().catch("미분류"),
  sensitivity: z.string().catch("internal"),
  chunks: z.number().catch(0),
  tags: z.array(z.string()).catch([]),
  updated_at: z.string().catch(""),
}).passthrough().superRefine((node, context) => {
  if (node.identity.kind !== node.kind) context.addIssue({ code: "custom", message: "node kind mismatch" });
  const apiId = node.identity.store === "pg" && node.kind === "space"
    ? `project:${node.identity.opaque_id}`
    : node.identity.opaque_id;
  if (node.id !== apiId) context.addIssue({ code: "custom", message: "node API ID mismatch" });
  if (node.renderer_id !== graphRendererId(node.identity)) context.addIssue({ code: "custom", message: "renderer identity mismatch" });
});

export const documentAnalysisSchema = z.object({
  state: z.enum(["pending", "ready", "error", "unavailable", "not_analyzed"]),
  reason: z.string().optional(),
  version: z.number().int().positive(),
  model: z.string().nullable(),
  local_only: z.literal(true),
});

export const knowledgeEdgeSchema = graphEndpointSchema.and(z.object({
  kind: z.enum(["space", "link", "ai_similarity"]),
}));

export const knowledgeGraphSchema = z.object({
  nodes: z.array(knowledgeNodeSchema),
  edges: z.array(knowledgeEdgeSchema),
  analysis: z.array(z.object({ id: z.string() }).and(documentAnalysisSchema)).catch([]),
  orphans: z.array(z.string()).catch([]),
  stats: z
    .object({
      documents: z.number().catch(0),
      spaces: z.number().catch(0),
      chunks: z.number().catch(0),
      restricted: z.number().catch(0),
    })
    .catch({ documents: 0, spaces: 0, chunks: 0, restricted: 0 }),
}).superRefine(validateGraphBindings);

export const documentDetailSchema = z.object({
  id: z.string(),
  title: z.string().catch(""),
  content: z.string(),
  version: z.number().int().positive(),
  versions: z.array(z.unknown()).catch([]),
});

export function parseDocumentDetail(targetId: string, input: unknown): z.infer<typeof documentDetailSchema> {
  const detail = documentDetailSchema.parse(input);
  if (detail.id !== targetId) throw new Error("DETAIL_ID_MISMATCH");
  return detail;
}

const documentWriteResultSchema = z.object({ id: z.string(), version: z.number().int().positive() });

export function parseDocumentWriteResult(targetId: string, input: unknown): z.infer<typeof documentWriteResultSchema> {
  const result = documentWriteResultSchema.parse(input);
  if (result.id !== targetId) throw new Error("DETAIL_ID_MISMATCH");
  return result;
}

export const uploadedDocumentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  extraction: z.object({ format: z.enum(["markdown", "plain_text"]), bytes: z.number(), encoding: z.literal("utf-8") }),
  analysis: documentAnalysisSchema.nullable(),
});

export type KnowledgeNode = z.infer<typeof knowledgeNodeSchema>;
export type KnowledgeEdge = z.infer<typeof knowledgeEdgeSchema>;
export type KnowledgeGraph = z.infer<typeof knowledgeGraphSchema>;

export function membersOfKnowledgeHub(
  nodes: readonly KnowledgeNode[],
  edges: readonly KnowledgeEdge[],
  hubRendererId: string,
): readonly KnowledgeNode[] {
  const memberRendererIds = new Set(edges
    .filter((edge) => edge.kind === "space" && edge.resolution === "resolved" && edge.target_renderer_id === hubRendererId)
    .map((edge) => edge.source_renderer_id));
  return nodes.filter((node) => node.kind === "document" && memberRendererIds.has(node.renderer_id));
}

export const SENSITIVITY_LABEL: Readonly<Record<string, string>> = {
  public: "공개",
  internal: "내부",
  personal: "개인",
  sensitive: "민감",
  confidential: "고기밀",
  org: "조직 공개",
};
