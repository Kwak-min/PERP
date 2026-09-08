import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareKnowledgeGraph, relationClass } from "../src/components/data/knowledgeGraphStageModel.ts";

const identity = (opaqueId, kind = "document") => ({ store: "pg", company: "company-27", owner: null, kind, opaque_id: opaqueId });
const node = (opaqueId, kind = "document", title = `Node ${opaqueId}`) => ({
  id: kind === "space" ? `project:${opaqueId}` : opaqueId,
  renderer_id: JSON.stringify(["pg", "company-27", null, kind, opaqueId]),
  identity: identity(opaqueId, kind),
  kind,
  title,
  source: { company: "company-27", owner: null },
});
const edge = (source, target, kind, declaration) => ({
  source: source.id,
  target_id: target.id,
  source_renderer_id: source.renderer_id,
  target_renderer_id: target.renderer_id,
  target_title: target.title,
  kind,
  binding: kind === "ai_similarity" ? "inference" : "explicit",
  resolution: "resolved",
  provenance: { model: "local-fixture", declaration: { ...declaration } },
});

test("physics receives deep mutable copies while source identity and provenance remain unchanged", () => {
  // Given authorized nodes and nested edge provenance.
  const a = node("a"), b = node("b");
  const data = { nodes: [a, b], edges: [edge(a, b, "wiki", { start: 1, end: 7 })] };
  const snapshot = structuredClone(data);

  // When the exact fields mutated by d3-force are changed on prepared render data.
  const prepared = prepareKnowledgeGraph(data);
  prepared.nodes[0].x = 900;
  prepared.links[0].render_source = prepared.nodes[1];
  prepared.links[0].provenance.declaration.start = 999;

  // Then the API DTO and nested provenance are byte-for-byte unchanged.
  assert.deepEqual(data, snapshot);
  assert.equal(prepared.identityMap.get(a.renderer_id), a);
  assert.equal(prepared.nodes[0].identity.opaque_id, "a");
});

test("reciprocal and parallel directed edges remain separate render links", () => {
  // Given two endpoints with parallel wiki/AI declarations in both directions.
  const a = node("a"), b = node("b");
  const edges = [edge(a, b, "wiki", { index: 0 }), edge(b, a, "wiki", { index: 1 }), edge(a, b, "ai_similarity", { index: 2 })];

  // When preparing force-graph links.
  const prepared = prepareKnowledgeGraph({ nodes: [a, b], edges });

  // Then order, direction, provenance, and relation class are retained independently.
  assert.equal(prepared.links.length, 3);
  assert.deepEqual(prepared.links.map((link) => [link.render_source, link.render_target]), [[a.renderer_id, b.renderer_id], [b.renderer_id, a.renderer_id], [a.renderer_id, b.renderer_id]]);
  assert.deepEqual(prepared.links.map((link) => link.provenance.declaration.index), [0, 1, 2]);
  assert.equal(new Set(prepared.links.map((link) => link.curvature * (link.source_renderer_id < link.target_renderer_id ? 1 : -1))).size, 3);
  assert.deepEqual(prepared.links.map((link) => relationClass(link.kind)), ["wiki", "wiki", "ai"]);
});

for (const reversed of [false, true]) test(`reciprocal lanes share a canonical endpoint orientation (reversed=${reversed})`, () => {
  const a = node("a"), b = node("b");
  const edges = [edge(a, b, "wiki", {}), edge(b, a, "wiki", {})];
  const prepared = prepareKnowledgeGraph({ nodes: [a, b], edges: reversed ? edges.reverse() : edges });
  const canonicalOffsets = prepared.links.map((link) => link.curvature * (link.source_renderer_id < link.target_renderer_id ? 1 : -1));
  assert.deepEqual(canonicalOffsets, [-0.11, 0.11]);
});

test("only resolved links with endpoints in the authorized graph reach physics", () => {
  // Given a resolved endpoint, an unavailable endpoint, and a forged foreign endpoint.
  const a = node("a"), b = node("b"), foreign = node("foreign");
  const unavailable = { ...edge(a, b, "wiki", {}), target_id: null, target_renderer_id: null, resolution: "unavailable" };

  // When preparing graph data after the task-26 parser boundary.
  const prepared = prepareKnowledgeGraph({ nodes: [a, b], edges: [edge(a, b, "wiki", {}), unavailable, edge(a, foreign, "wiki", {})] });

  // Then neither hidden nor unresolved endpoint metadata enters the engine.
  assert.equal(prepared.links.length, 1);
  assert.equal(prepared.nodes.length, 2);
});

for (const count of [0, 1, 1000]) test(`prepares ${count} authorized nodes without changing their opaque identities`, () => {
  // Given a graph at the required scale; When preparing; Then every identity survives exactly.
  const nodes = Array.from({ length: count }, (_, index) => node(String(index)));
  const prepared = prepareKnowledgeGraph({ nodes, edges: [] });
  assert.equal(prepared.nodes.length, count);
  assert.deepEqual(prepared.nodes.map((item) => item.identity.opaque_id), nodes.map((item) => item.identity.opaque_id));
});
