import { z } from "zod";

/** 조직 지식(RAG) 그래프 응답. 백엔드 GET /documents/graph 와 짝을 이룬다. */
export const knowledgeNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(["space", "document"]).catch("document"),
  title: z.string().catch(""),
  folder: z.string().catch("미분류"),
  sensitivity: z.string().catch("internal"),
  chunks: z.number().catch(0),
  tags: z.array(z.string()).catch([]),
  updated_at: z.string().catch(""),
});

export const documentAnalysisSchema = z.object({
  state: z.enum(["pending", "ready", "error", "unavailable", "not_analyzed"]),
  reason: z.string().optional(),
  version: z.number().int(),
  model: z.string().nullable(),
  local_only: z.literal(true),
});

export const knowledgeEdgeSchema = z.object({
  source: z.string(),
  target_id: z.string().nullable().catch(null),
  target_title: z.string().catch(""),
  kind: z.enum(["space", "link", "ai_similarity"]).catch("link"),
  score: z.number().min(-1).max(1).optional(),
  provenance: z.object({
    provider: z.literal("ollama-local"),
    model: z.string(),
    method: z.literal("embedding_cosine"),
    source_version: z.number().int(),
    target_version: z.number().int(),
    analyzed_at: z.string(),
  }).optional(),
});

export const knowledgeGraphSchema = z.object({
  nodes: z.array(knowledgeNodeSchema),
  edges: z.array(knowledgeEdgeSchema).catch([]),
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
});

export const documentDetailSchema = z.object({
  id: z.string(),
  title: z.string().catch(""),
  content: z.string().catch(""),
  version: z.number().catch(1),
  versions: z.array(z.unknown()).catch([]),
});

export const uploadedDocumentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  extraction: z.object({ format: z.enum(["markdown", "plain_text"]), bytes: z.number(), encoding: z.literal("utf-8") }),
  analysis: documentAnalysisSchema.nullable(),
});

export type KnowledgeNode = z.infer<typeof knowledgeNodeSchema>;
export type KnowledgeEdge = z.infer<typeof knowledgeEdgeSchema>;
export type KnowledgeGraph = z.infer<typeof knowledgeGraphSchema>;

export const SENSITIVITY_LABEL: Readonly<Record<string, string>> = {
  public: "공개",
  internal: "내부",
  personal: "개인",
  sensitive: "민감",
  confidential: "고기밀",
  org: "조직 공개",
};
