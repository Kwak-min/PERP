import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { once } from "node:events";
import { api } from "./http.js";
import { startEmbeddingFixture } from "./vault-semantic-fixture.js";
import { startPgGraphFixture } from "../../frontend/scripts/graph-pg-fixture.mjs";
let fixture, wire, created;
const request = (path, options = {}) => api(fixture.baseUrl, `/pg/vault${path}`, { ...fixture, ...options });
before(async () => {
  wire = await startEmbeddingFixture(); process.env.OLLAMA_BASE_URL = wire.baseUrl; process.env.ORBITFLOW_VAULT_EMBEDDING_MODEL = "synthetic-pg-v1";
  fixture = await startPgGraphFixture();
  fixture.notes.get("1").content_md = "SYNTH_RELATED";
  fixture.notes.get("2").content_md = "SYNTH_IRRELEVANT";
  fixture.notes.get("3").content_md = "SYNTH_IRRELEVANT";
  fixture.notes.get("4").content_md = "FOREIGN_ONLY SYNTH_RELATED";
});
after(async () => { await fixture?.close(); await wire?.close(); });
test("PG save uses owner-bounded PG candidates, genuine inference wire, strict source and version", async () => {
  const result = await request("/notes", { method: "POST", body: { title: "PG semantic", content: "SYNTH_PARAPHRASE [[PG Gamma]]" } });
  assert.equal(result.status, 201); created = result.body;
  const status = await request(`/notes/${created.id}/analysis?wait=1`); assert.equal(status.body.state, "ready");
  const graph = (await request("/graph")).body;
  const ai = graph.edges.filter(e => e.kind === "ai_similarity"); assert.equal(ai.length, 1);
  assert.deepEqual(new Set([ai[0].source, ai[0].target_id]), new Set([created.id, "1"]));
  assert.ok(graph.edges.some(e => e.source === created.id && e.target_id === "2" && e.kind !== "ai_similarity"));
  assert.ok(wire.calls.every(c => !JSON.stringify(c.body).includes("FOREIGN_ONLY")));
  assert.ok(fixture.queries.some(q => q.sql.includes("LIMIT $2") && q.values[0] === "101" && q.values[1] === 33));
  for (const method of ["GET", "POST"]) assert.equal((await request("/notes/4/analysis", { method })).status, 404);
  assert.equal((await request(`/notes/${created.id}/analysis`, { method: "POST", orgId: "pg:88" })).status, 403);
  assert.equal((await request(`/notes/${created.id}`, { method: "PATCH", body: { content: "blind" } })).status, 400);
});
test("PG update invalidates versioned links before inference, delete prevents stale results", async () => {
  const gate = Promise.withResolvers(); wire.gate = gate.promise;
  const entered = once(wire.server, "inference", { signal: AbortSignal.timeout(5000) });
  try {
    const result = await request(`/notes/${created.id}`, { method: "PATCH", body: { version: created.version, content: "SYNTH_IRRELEVANT changed" } });
    assert.equal(result.status, 200); assert.ok(result.body.version > created.version); await entered;
    assert.equal((await request("/graph")).body.edges.filter(e => e.kind === "ai_similarity").length, 0);
    assert.equal((await request(`/notes/${created.id}`, { method: "PATCH", body: { version: created.version, content: "stale" } })).status, 409);
    assert.equal((await request(`/notes/${created.id}`, { method: "DELETE" })).status, 200);
  } finally { gate.resolve(); wire.gate = null; }
  const graph = await request("/graph?wait=1"); assert.ok(!graph.body.edges.some(e => e.source === created.id || e.target_id === created.id));
  assert.equal((await request(`/notes/${created.id}/analysis`)).status, 404);
});
test("PG save succeeds on model failure without inferred edges", async () => {
  wire.mode = "error";
  const result = await request("/notes", { method: "POST", body: { title: "PG failure", content: "SYNTH_PARAPHRASE failure" } });
  assert.equal(result.status, 201);
  assert.equal((await request(`/notes/${result.body.id}/analysis?wait=1`)).body.state, "error");
  assert.ok(!(await request("/graph")).body.edges.some(e => e.kind === "ai_similarity" && (e.source === result.body.id || e.target_id === result.body.id)));
});
