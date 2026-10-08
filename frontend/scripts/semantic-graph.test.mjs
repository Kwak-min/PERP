import assert from "node:assert/strict";
import { test } from "node:test";
import { buildScene, graphRendererId, graphSchema } from "../src/screens/vault/graph3d.ts";
const identity = opaque_id => ({ store: "legacy", company: "company", owner: "owner", kind: "note", opaque_id });
const a = { id: "a", renderer_id: graphRendererId(identity("a")), identity: identity("a"), title: "A", folder: "/" };
const b = { id: "b", renderer_id: graphRendererId(identity("b")), identity: identity("b"), title: "B", folder: "/" };
const endpoint = { source: "a", target_id: "b", source_renderer_id: a.renderer_id, target_renderer_id: b.renderer_id, target_title: "B", binding: "explicit", resolution: "resolved" };
const input = { nodes: [a, b], edges: [
  endpoint,
  { ...endpoint, kind: "ai_similarity", binding: "inference", score: 0.94, provenance: { model: "fixture", provider: "ollama-local", method: "embedding_cosine", source_version: 2, target_version: 1, analyzed_at: "2026-01-01T00:00:00Z" } },
], orphans: [] };
test("manual and AI links retain distinct render kinds and validated score/provenance", () => {
  const graph = graphSchema.parse(input), scene = buildScene(graph);
  assert.equal(scene.linkCount, 2); assert.deepEqual(scene.linkKinds, ["manual", "ai_similarity"]);
  assert.equal(graph.edges[1].score, 0.94); assert.equal(graph.edges[1].provenance.model, "fixture");
  assert.equal(graphSchema.safeParse({ ...input, edges: [{ ...input.edges[1], score: 4 }] }).success, false);
});
