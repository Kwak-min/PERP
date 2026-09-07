import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { once } from "node:events";
import { api, createOwnerOrg, startTestServer } from "./http.js";
import { startEmbeddingFixture } from "./vault-semantic-fixture.js";
let server, wire, owner, alien, a, b, unrelated;
const request = (path, options = {}) => api(server.baseUrl, `/vault${path}`, { ...owner, ...options });
const analyze = id => request(`/notes/${id}/analysis?wait=1`);
before(async () => {
  wire = await startEmbeddingFixture();
  process.env.OLLAMA_BASE_URL = wire.baseUrl;
  process.env.ORBITFLOW_VAULT_EMBEDDING_MODEL = "synthetic-wire-v1";
  server = await startTestServer();
  owner = await createOwnerOrg(server.baseUrl, ["agent"]);
  alien = await createOwnerOrg(server.baseUrl, ["agent"]);
});
after(async () => { await server?.close(); await wire?.close(); });
test("save is nonblocking; actual embedding wire yields similar but not irrelevant edges and preserves wiki links", async () => {
  a = (await request("/notes", { method: "POST", body: { title: "A", content: "SYNTH_RELATED" } })).body;
  assert.equal((await analyze(a.id)).body.state, "ready");
  unrelated = (await request("/notes", { method: "POST", body: { title: "Other", content: "SYNTH_IRRELEVANT" } })).body;
  await analyze(unrelated.id);
  const gate = Promise.withResolvers(); wire.gate = gate.promise;
  const entered = once(wire.server, "inference", { signal: AbortSignal.timeout(5000) });
  try {
    const saved = await request("/notes", { method: "POST", body: { title: "B", content: "SYNTH_PARAPHRASE [[Other]]", sensitivity: "sensitive" } });
    assert.equal(saved.status, 201); b = saved.body;
    assert.equal(b.analysis.state, "pending"); await entered;
  } finally { gate.resolve(); wire.gate = null; }
  assert.equal((await analyze(b.id)).body.state, "ready");
  const graph = (await request("/graph")).body;
  const edges = graph.edges.filter(e => e.kind === "ai_similarity");
  assert.equal(edges.length, 1); assert.deepEqual(new Set([edges[0].source, edges[0].target_id]), new Set([a.id, b.id]));
  assert.ok(edges[0].score > 0.98); assert.equal(edges[0].provenance.model, "synthetic-wire-v1");
  assert.equal(edges[0].provenance.provider, "ollama-local");
  assert.ok(graph.edges.some(e => e.source === b.id && e.target_id === unrelated.id && e.kind !== "ai_similarity"));
  assert.ok(wire.calls.every(c => c.path === "/api/embed" && c.body.truncate === true && c.body.input.length <= 33));
  const before = wire.calls.length;
  await request(`/notes/${b.id}/analysis`, { method: "POST" }); await analyze(b.id);
  assert.equal(wire.calls.length, before, "unchanged versions reuse model embeddings");
});
test("version updates invalidate both endpoints immediately; stale in-flight results never restore deleted edges", async () => {
  const gate = Promise.withResolvers(); wire.gate = gate.promise;
  const entered = once(wire.server, "inference", { signal: AbortSignal.timeout(5000) });
  try {
    const changed = await request(`/notes/${a.id}`, { method: "PATCH", body: { version: a.version, content: "SYNTH_IRRELEVANT" } });
    assert.equal(changed.status, 200); a = changed.body; await entered;
    assert.equal((await request("/graph")).body.edges.filter(e => e.kind === "ai_similarity").length, 0);
    assert.equal((await request(`/notes/${b.id}`, { method: "DELETE" })).status, 200);
  } finally { gate.resolve(); wire.gate = null; }
  await analyze(a.id);
  assert.ok(!(await request("/graph")).body.edges.some(e => e.target_id === b.id || e.source === b.id));
  assert.equal((await request(`/notes/${a.id}`, { method: "PATCH", body: { content: "blind" } })).status, 400);
  assert.equal((await request(`/notes/${a.id}`, { method: "PATCH", body: { version: 1, content: "stale" } })).status, 409);
});
test("cross-owner candidates, statuses, retries and alternate sources are excluded", async () => {
  const foreign = await request("/notes", { ...alien, method: "POST", body: { title: "Alien", content: "SYNTH_RELATED FOREIGN_ONLY" } });
  await request(`/notes/${foreign.body.id}/analysis?wait=1`, alien);
  const before = wire.calls.length;
  const saved = await request("/notes", { method: "POST", body: { title: "Own new", content: "SYNTH_RELATED OWN_ONLY" } });
  assert.equal((await analyze(saved.body.id)).body.state, "ready");
  assert.ok(wire.calls.length > before, "owner scope must actually reach inference");
  assert.ok(wire.calls.slice(before).every(c => !JSON.stringify(c.body).includes("FOREIGN_ONLY")));
  for (const method of ["GET", "POST"]) assert.equal((await request(`/notes/${foreign.body.id}/analysis`, { method })).status, 404);
  assert.ok(!(await request("/graph")).body.nodes.some(n => n.id === foreign.body.id));
});
test("provider failures and invalid embeddings are honest, never fake links; retry recovers", async () => {
  for (const mode of ["error", "malformed"]) {
    wire.mode = mode;
    const saved = await request("/notes", { method: "POST", body: { title: `Failure ${mode}`, content: `SYNTH_PARAPHRASE ${mode}` } });
    assert.equal(saved.status, 201);
    const result = await analyze(saved.body.id); assert.equal(result.body.state, "error");
    assert.ok(!(await request("/graph")).body.edges.some(e => e.kind === "ai_similarity" && (e.source === saved.body.id || e.target_id === saved.body.id)));
    wire.mode = "ok";
    await request(`/notes/${saved.body.id}/analysis`, { method: "POST" });
    assert.equal((await analyze(saved.body.id)).body.state, "ready");
  }
});
test("legacy note AI opt-out excludes source and candidates without removing manual links", async () => {
  const before = wire.calls.length;
  const optedOut = await request("/notes", { method: "POST", body: { title: "Opted out", content: "SYNTH_PARAPHRASE DISABLED_ONLY [[A]]", agent_enabled: false } });
  assert.equal(optedOut.status, 201);
  assert.equal((await analyze(optedOut.body.id)).body.reason, "note_ai_disabled");
  assert.equal(wire.calls.length, before);
  const source = await request("/notes", { method: "POST", body: { title: "Opt-out comparison", content: "SYNTH_RELATED OWN_COMPARE" } });
  assert.equal((await analyze(source.body.id)).body.state, "ready");
  assert.ok(wire.calls.length > before);
  assert.ok(wire.calls.slice(before).every(c => !JSON.stringify(c.body).includes("DISABLED_ONLY")));
  const graph = (await request("/graph")).body;
  assert.ok(graph.edges.some(e => e.source === optedOut.body.id && e.target_id === a.id && e.kind !== "ai_similarity"));
  assert.ok(!graph.edges.some(e => e.kind === "ai_similarity" && (e.source === optedOut.body.id || e.target_id === optedOut.body.id)));
});
test("missing model and remote/redirect endpoints never send notes externally", async () => {
  delete process.env.ORBITFLOW_VAULT_EMBEDDING_MODEL;
  const saved = await request("/notes", { method: "POST", body: { title: "No model", content: "SYNTH_RELATED" } });
  assert.equal(saved.status, 201); assert.equal((await analyze(saved.body.id)).body.state, "unavailable");
  process.env.ORBITFLOW_VAULT_EMBEDDING_MODEL = "synthetic-wire-v2";
  process.env.OLLAMA_BASE_URL = "https://example.invalid";
  const before = wire.calls.length;
  await request(`/notes/${saved.body.id}/analysis`, { method: "POST" });
  assert.equal((await analyze(saved.body.id)).body.state, "unavailable"); assert.equal(wire.calls.length, before);
  process.env.OLLAMA_BASE_URL = wire.baseUrl;
  assert.equal((await request("/graph")).body.edges.filter(e => e.kind === "ai_similarity").length, 0, "model changes invalidate prior provenance");
});
