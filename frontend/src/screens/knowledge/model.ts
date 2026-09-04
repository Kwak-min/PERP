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

export const knowledgeGraphSchema = z.object({
  nodes: z.array(knowledgeNodeSchema),
  edges: z
    .array(
      z.object({
        source: z.string(),
        target_id: z.string().nullable().catch(null),
        target_title: z.string().catch(""),
        kind: z.string().catch("link"),
      }),
    )
    .catch([]),
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

export type KnowledgeNode = z.infer<typeof knowledgeNodeSchema>;
export type KnowledgeGraph = z.infer<typeof knowledgeGraphSchema>;

export const SENSITIVITY_LABEL: Readonly<Record<string, string>> = {
  public: "공개",
  internal: "내부",
  personal: "개인",
  sensitive: "민감",
  confidential: "고기밀",
  org: "조직 공개",
};
