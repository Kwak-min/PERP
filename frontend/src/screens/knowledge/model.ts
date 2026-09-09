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
  local_only: z.boolean(),
});

export const DOCUMENT_AI_REASON: Readonly<Record<string, string>> = {
  embedding_model_not_configured: '관리자에게 ORBITFLOW_DOCUMENT_OPENROUTER_EMBEDDING_MODEL 설정을 요청하세요. 채팅 모델은 임베딩에 사용하지 않습니다.',
  embedding_model_unsupported: '설정한 모델이 OpenRouter 임베딩 목록에 없습니다. 지원되는 임베딩 모델을 설정하세요.',
  embedding_context_limit: '임베딩 모델의 입력 한도를 초과했습니다. 더 큰 입력을 지원하는 모델을 설정하세요.',
  model_not_configured: '로컬 전용 분석에 ORBITFLOW_DOCUMENT_EMBEDDING_MODEL 설정이 필요합니다.',
  local_endpoint_required: '로컬 전용 분석에는 루프백 Ollama 주소가 필요합니다.',
  inference_unavailable: 'AI 연결 설정의 키 권한·잔액과 모델·네트워크를 확인한 뒤 다시 분석하세요.',
  invalid_embeddings: '공급자가 올바른 임베딩 벡터를 반환하지 않았습니다. 모델 설정을 확인하세요.',
  document_access_changed: '문서 버전·등급 또는 접근 권한이 변경되었습니다. 원본을 새로고침하세요.',
};

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
