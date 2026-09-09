import { z } from "zod";
import type { KnowledgeGraphStageData, KnowledgeGraphStageNode, WikiGraphIdentity } from "../../components/data/knowledgeGraphStageModel";

const id = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const freshnessSchema = z.enum(["current", "stale", "unavailable"]);
export const citationSchema = z.object({ artifact_kind: z.enum(["source_revision", "page_revision"]), revision_id: id, revision_sha256: hash, start_byte: z.number().int().nonnegative(), end_byte: z.number().int().positive(), span_sha256: hash }).strict();
export type WikiCitation = z.infer<typeof citationSchema>;
const jsonObject = z.record(z.string(), z.unknown());
export const sourceSchema = z.object({ id, wiki_id: id, kind: z.enum(["record", "upload"]), origin_kind: z.enum(["note", "document"]).nullable(), origin_id: id.nullable(), current_revision_id: id, version: z.number().int().positive(), access_version: z.number().int().positive() }).passthrough();
export const sourceListSchema = z.object({ items: z.array(sourceSchema.extend({ title: z.string(), freshness: freshnessSchema })), next_cursor: id.nullable() });
export type WikiSource = z.infer<typeof sourceListSchema>["items"][number];
export const scopeSchema = z.object({ store: z.enum(["legacy", "pg"]), company_id: id.nullable(), owner_id: id.nullable(), scope: z.enum(["personal", "company"]) });
export const wikiRootSchema = z.object({ wiki: scopeSchema.passthrough().nullable(), pages: z.array(z.unknown()) });
export type WikiScope = z.infer<typeof scopeSchema>;
const pageKind = z.enum(["page", "entity", "concept"]);
const pageSummary = z.object({ id, revision_id: id, title: z.string(), kind: pageKind, version: z.number().int().positive(), freshness: freshnessSchema });
export const pagesSchema = z.object({ items: z.array(pageSummary), next_cursor: z.null() });
export type WikiPageSummary = z.infer<typeof pageSummary>;
const sourceIdentity = z.object({ store: z.enum(["legacy", "pg"]), company: id.nullable(), owner: id.nullable(), kind: z.enum(["note", "document", "upload"]), opaque_id: id });
export const sourceRevisionSchema = z.object({ id, source_id: id, artifact_kind: z.literal("source_revision"), title: z.string(), content: z.string(), content_sha256: hash, original_sha256: hash, original_base64: z.string(), extraction_revision_id: id, restrictions_json: z.string(), source_identity: sourceIdentity, freshness: freshnessSchema }).passthrough();
export const pageRevisionSchema = z.object({ id, page_id: id, artifact_kind: z.literal("page_revision"), title: z.string(), content: z.string(), markdown: z.string(), content_sha256: hash, citations_json: z.string(), links_json: z.string(), provenance_json: z.string(), input_manifest_hash: hash, version: z.number().int().positive(), kind: pageKind, freshness: freshnessSchema }).passthrough();
export type WikiRevision = z.infer<typeof sourceRevisionSchema> | z.infer<typeof pageRevisionSchema>;
export type WikiPageRevision = z.infer<typeof pageRevisionSchema>;
export const historySchema = z.object({ items: z.array(pageRevisionSchema) });
const resultSchema = z.object({ result_revision_id: id, operation: z.enum(["query", "ingest", "lint"]), review_state: z.literal("unreviewed"), answer_md: z.string().nullable(), citations: z.array(citationSchema), citation_validation: z.enum(["anchors_valid", "no_evidence"]), freshness: freshnessSchema, input_manifest_hash: hash, provenance: jsonObject, uncertainty: z.array(z.string()), retrieval_coverage: jsonObject.nullable(), change_set_id: id.nullable(), issues: z.array(jsonObject) }).superRefine((result, context) => {
  if ((result.operation === "query") !== (result.retrieval_coverage !== null)) context.addIssue({ code: "custom", message: "Query retrieval coverage must be an object; ingest/lint coverage is null" });
});
export const jobSchema = z.object({ id, operation: z.enum(["query", "ingest", "lint"]), state: z.enum(["queued", "running", "succeeded", "failed", "unavailable"]), failure_code: z.string().nullable(), result: resultSchema.nullable(), attempts: z.array(z.object({ id, ordinal: z.number().int(), model_version: z.string(), configuration: jsonObject, failure_code: z.string().nullable() }).passthrough()) }).passthrough();
export type WikiJob = z.infer<typeof jobSchema>;
const linkSchema = z.object({ id, type: z.enum(["manual", "ai_derived"]), target_page_id: id, predicate: z.enum(["related", "supports", "contradicts", "supersedes"]), direction: z.enum(["directed", "undirected"]), origin: z.enum(["human", "compiler"]), citations: z.array(citationSchema) }).passthrough();
const proposalSchema = z.object({ page_id: id, kind: pageKind, title: z.string(), markdown: z.string(), index_entry: z.string(), citations: z.array(citationSchema), links: z.array(linkSchema), provenance: jsonObject });
export const changeSetSchema = z.object({ id, state: z.enum(["draft", "published", "rejected"]), manifest_hash: hash, input_manifest_hash: hash, proposed_revisions: z.array(proposalSchema), expected_heads: z.array(z.object({ page_id: id, version: z.number().int().positive().nullable(), published_head_id: id.nullable() })), lineage: z.object({ inputs: z.array(jsonObject), hash }), freshness: freshnessSchema, diff: z.array(z.object({ page_id: id, before: z.object({ revision_id: id, title: z.string(), markdown: z.string() }).nullable(), before_state: z.enum(["current", "stale", "unavailable", "absent"]), after: proposalSchema })) }).passthrough();
export type WikiChangeSet = z.infer<typeof changeSetSchema>;
export const manualDraftSchema = z.object({ id, manifest_hash: hash, proposed_revisions_json: z.string(), expected_heads_json: z.string(), lineage_json: z.string() }).passthrough();
export const queryDraftSchema = z.object({ change_set_id: id, manifest_hash: hash, result_revision_id: id });
export const publicationSchema = z.object({ id, manifest_hash: hash, result_json: z.object({ page_revision_ids: z.array(id), page_ids: z.array(id), pages: z.array(z.object({ id, revision_id: id, version: z.number().int().positive() })) }) }).passthrough();
export const rejectSchema = z.object({ id, state: z.literal("rejected"), manifest_hash: hash }).passthrough();
const graphNode = z.discriminatedUnion("kind", [z.object({ id, kind: z.literal("source"), source_id: id, revision_id: id, title: z.string(), freshness: freshnessSchema }), z.object({ id, kind: pageKind, page_id: id, revision_id: id, title: z.string(), version: z.number().int().positive(), freshness: freshnessSchema })]);
const graphEdge = z.union([z.object({ id, type: z.literal("citation"), origin: z.literal("citation"), direction: z.literal("directed"), citation: citationSchema }), linkSchema]).and(z.object({ source: id, target: id, source_revision_id: id, target_revision_id: id, review_state: z.literal("published") }));
export const wikiGraphSchema = z.object({ nodes: z.array(graphNode), edges: z.array(graphEdge), counts: z.object({ nodes: z.number().int().nonnegative(), edges: z.number().int().nonnegative() }) }).superRefine((graph, ctx) => {
  const ids = new Set(graph.nodes.map(n => n.id));
  if (ids.size !== graph.nodes.length || graph.nodes.length !== graph.counts.nodes || graph.edges.length !== graph.counts.edges || new Set(graph.edges.map(e => e.id)).size !== graph.edges.length) ctx.addIssue({ code: "custom", message: "Invalid graph identity/count" });
  for (const node of graph.nodes) if (node.id !== `${node.kind}:${node.kind === "source" ? node.source_id : node.page_id}`) ctx.addIssue({ code: "custom", message: "Invalid typed node identity" });
  for (const edge of graph.edges) if (!ids.has(edge.source) || !ids.has(edge.target)) ctx.addIssue({ code: "custom", message: "Unauthorized graph endpoint" });
});
export type WikiGraph = z.infer<typeof wikiGraphSchema>;
export const emptyWikiGraph: WikiGraph = { nodes: [], edges: [], counts: { nodes: 0, edges: 0 } };
export function adaptWikiGraph(graph: WikiGraph, scope: WikiScope | null): KnowledgeGraphStageData {
  if (!scope) { if (graph.nodes.length) throw new Error("WIKI_SCOPE_REQUIRED"); return { nodes: [], edges: [] }; }
  const nodes = graph.nodes.map((node): KnowledgeGraphStageNode => {
    const identity: WikiGraphIdentity = { store: scope.store, company: scope.company_id, owner: scope.owner_id, kind: node.kind, opaque_id: node.kind === "source" ? node.source_id : node.page_id };
    return { ...node, identity, renderer_id: JSON.stringify([identity.store, identity.company, identity.owner, identity.kind, identity.opaque_id]) };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  return { nodes, edges: graph.edges.map(edge => {
    const source = byId.get(edge.source), target = byId.get(edge.target);
    if (!source || !target) throw new Error("UNAUTHORIZED_ENDPOINT");
    return { ...edge, kind: edge.type, target_id: target.id, source_renderer_id: source.renderer_id, target_renderer_id: target.renderer_id, target_title: target.title, binding: edge.type === "ai_derived" ? "inference" : "explicit", resolution: "resolved", provenance: { ...edge } };
  }) };
}
export async function verifiedSpan(revision: WikiRevision, citation: WikiCitation): Promise<{ before: string; quote: string; after: string }> {
  const bytes = new TextEncoder().encode(revision.content);
  const digest = async (value: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))].map(n => n.toString(16).padStart(2, "0")).join("");
  if (revision.id !== citation.revision_id || revision.artifact_kind !== citation.artifact_kind || citation.end_byte <= citation.start_byte || citation.end_byte > bytes.length || await digest(bytes) !== citation.revision_sha256) throw new Error("CITATION_REVISION_MISMATCH");
  const selected = bytes.slice(citation.start_byte, citation.end_byte);
  if (await digest(selected) !== citation.span_sha256) throw new Error("CITATION_SPAN_MISMATCH");
  const decode = (value: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(value);
  return { before: decode(bytes.slice(0, citation.start_byte)), quote: decode(selected), after: decode(bytes.slice(citation.end_byte)) };
}
export function revisionCitations(revision: WikiPageRevision): WikiCitation[] { return z.array(citationSchema).parse(JSON.parse(revision.citations_json)); }
export function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer); let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
