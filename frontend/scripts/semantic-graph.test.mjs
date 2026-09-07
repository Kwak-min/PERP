import assert from "node:assert/strict";
import { test } from "node:test";
import { buildScene, graphSchema } from "../src/screens/vault/graph3d.ts";
const input = { nodes: [{ id: "a", title: "A", folder: "/" }, { id: "b", title: "B", folder: "/" }], edges: [
  { source: "a", target_id: "b", target_title: "B" },
  { source: "a", target_id: "b", target_title: "B", kind: "ai_similarity", score: 0.94, provenance: { model: "fixture", provider: "ollama-local", method: "embedding_cosine", source_version: 2, target_version: 1, analyzed_at: "2026-01-01T00:00:00Z" } },
], orphans: [] };
test("manual and AI links retain distinct render kinds and validated score/provenance", () => {
  const graph = graphSchema.parse(input), scene = buildScene(graph);
  assert.equal(scene.linkCount, 2); assert.deepEqual(scene.linkKinds, ["manual", "ai_similarity"]);
  assert.equal(graph.edges[1].score, 0.94); assert.equal(graph.edges[1].provenance.model, "fixture");
  assert.equal(graphSchema.safeParse({ ...input, edges: [{ ...input.edges[1], score: 4 }] }).success, false);
});
