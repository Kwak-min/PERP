import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { vaultSemantic } from "../src/services/vault-semantic.service.js";
import { startEmbeddingFixture } from "./vault-semantic-fixture.js";

test("bounded queue, inference concurrency, candidates, input size and redirect rejection", async () => {
  const wire = await startEmbeddingFixture();
  process.env.OLLAMA_BASE_URL = wire.baseUrl; process.env.ORBITFLOW_VAULT_EMBEDDING_MODEL = "budget-wire";
  const scope = "budget-fixture", gate = Promise.withResolvers();
  wire.gate = gate.promise;
  const entered = once(wire.server, "inference", { signal: AbortSignal.timeout(5000) });
  try {
    const jobs = Array.from({ length: 70 }, (_, index) => ({ id: `job-${index}`, version: 1, title: `Job ${index}`, content: "SYNTH_RELATED" }));
    const statuses = jobs.map(note => vaultSemantic.schedule(scope, note, async () => []));
    assert.equal(statuses.filter(s => s.state === "pending").length, 64);
    assert.equal(statuses.filter(s => s.reason === "queue_full").length, 6);
    await entered; assert.ok(wire.calls.length <= 2, "global concurrency is two while wire is gated");
    gate.resolve(); wire.gate = null; await vaultSemantic.wait(scope);
    assert.equal(statuses.filter(s => s.state === "ready").length, 64);
    const note = { id: "long", version: 1, title: "Long", content: "SYNTH_RELATED".repeat(1000) };
    const before = wire.calls.length;
    vaultSemantic.schedule(scope, note, async () => jobs);
    await vaultSemantic.wait(scope, note.id);
    assert.ok(wire.calls.slice(before).every(c => c.body.input.length <= 33 && c.body.input.every(text => text.length <= 6000)));
    assert.equal(vaultSemantic.status(scope, note).candidates, 32);
    assert.equal(vaultSemantic.status(scope, note).truncated, true);
    assert.ok(vaultSemantic.graph(scope, [...jobs, note]).edges.filter(e => e.source === note.id).length <= 5);
    wire.mode = "redirect";
    const redirected = { id: "redirect", version: 1, title: "Redirect", content: "SYNTH_PARAPHRASE" };
    const redirectsBefore = wire.calls.length;
    vaultSemantic.schedule(scope, redirected, async () => []); await vaultSemantic.wait(scope, redirected.id);
    assert.equal(vaultSemantic.status(scope, redirected).state, "error");
    assert.equal(wire.calls.length, redirectsBefore + 1); assert.ok(!wire.calls.some(c => c.path === "/must-not-follow"));
  } finally { gate.resolve(); wire.gate = null; await vaultSemantic.wait(scope); await wire.close(); }
});
