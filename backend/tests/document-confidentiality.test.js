import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";

describe("document confidentiality through HTTP and provider wire adapters", { timeout: 30000 }, () => {
  let server, wire, owner, member, writer, other, database, providers, config;
  let shared, privateDoc, sensitive, target, source;
  let localFailure = false;
  const calls = [];
  const request = (actor, route, options = {}) => api(server.baseUrl, route, { ...actor, ...options });
  const createDoc = async (actor, body) => {
    const response = await request(actor, "/documents", { method: "POST", body });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  };
  const join = async (roles) => {
    const email = `rag-${crypto.randomUUID()}@example.com`;
    const invitation = await request(owner, "/members/invites", { method: "POST", body: { email, roles } });
    assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
    const signup = await api(server.baseUrl, "/auth/signup", {
      method: "POST", body: { email, name: "RAG reader", password: "password-1234", invitation_token: invitation.body.token },
    });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    return { token: signup.body.access_token, userId: signup.body.user.id, orgId: owner.orgId };
  };

  before(async () => {
    wire = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      calls.push({ path: req.url, body: JSON.parse(body) });
      if (localFailure && req.url.startsWith("/local/")) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub unavailable" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "wire-stub", choices: [{ message: { content: "stub answer" } }], usage: { total_tokens: 2 } }));
    });
    const listening = once(wire, "listening", { signal: AbortSignal.timeout(5000) });
    wire.listen(0, "127.0.0.1");
    await listening;
    const base = `http://127.0.0.1:${wire.address().port}`;
    process.env.OPENROUTER_BASE_URL = `${base}/external`;
    process.env.OPENROUTER_API_KEY = "local-test-key";
    process.env.OLLAMA_BASE_URL = `${base}/local`;
    server = await startTestServer();
    ({ db: database } = await import("../src/config/db.js"));
    providers = await import("../src/services/ai-provider.service.js");
    ({ env: config } = await import("../src/config/env.js"));
    config.aiProvider = "auto";
    owner = await createOwnerOrg(server.baseUrl, ["documents", "agent"]);
    member = await join(["member"]);
    writer = await join(["pm"]);
    other = await createOwnerOrg(server.baseUrl, ["documents", "agent"]);
    shared = await createDoc(owner, { title: "visible fixture", content: "sharedneedle" });
    privateDoc = await createDoc(owner, { title: "private fixture", content: "privateneedle", visibility: "private" });
    sensitive = await createDoc(owner, { title: "sensitive fixture", content: "sensitiveneedle", sensitivity: "sensitive" });
    target = await createDoc(owner, { title: "hidden-target-fixture", content: "targetneedle", sensitivity: "sensitive" });
    source = await createDoc(owner, { title: "source fixture", content: `[[${target.title}]] [[${shared.title}]] [[unresolved-fixture]]` });
  });

  after(async () => {
    if (server) await server.close();
    if (wire) await new Promise((resolve, reject) => wire.close((error) => error ? reject(error) : resolve()));
  });

  for (const surface of ["detail", "list", "search", "graph", "rag"]) {
    it(`hides private nonowner and sensitive documents on ${surface}`, async () => {
      // Given: a same-organization reader without write/audit permissions.
      // When: each real read surface is requested.
      const routes = { detail: `/documents/${privateDoc.id}`, list: "/documents", search: "/documents/search/query?q=needle", graph: "/documents/graph", rag: "/agent/chat" };
      const result = await request(member, routes[surface], surface === "rag" ? { method: "POST", body: { message: "privateneedle sensitiveneedle sharedneedle" } } : {});
      // Then: only authorized document identities/content are returned.
      if (surface === "detail") return assert.equal(result.status, 404);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const rows = surface === "graph" ? result.body.nodes : surface === "rag" ? result.body.answer.evidence : result.body.items;
      assert.ok(rows.some((row) => row.id === shared.id));
      assert.ok(!rows.some((row) => [privateDoc.id, sensitive.id, target.id].includes(row.id)));
    });
  }

  it("allows private owner detail and RAG retrieval", async () => {
    const detail = await request(owner, `/documents/${privateDoc.id}`);
    const chat = await request(owner, "/agent/chat", { method: "POST", body: { message: "privateneedle" } });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.content, "privateneedle");
    assert.deepEqual(chat.body.answer.evidence.map((item) => item.id), [privateDoc.id]);
  });

  it("does not grant administrators access to another user's private document", async () => {
    const doc = await createDoc(writer, { title: "writer private", content: "writerprivateneedle", visibility: "private" });
    const result = await request(owner, `/documents/${doc.id}`);
    assert.equal(result.status, 404);
  });

  for (const [method, suffix, body] of [["PATCH", "", { content: "tampered" }], ["POST", "/restore/1", {}], ["DELETE", "", undefined]]) {
    it(`denies private nonowner ${method} without side effects`, async () => {
      const doc = await createDoc(owner, { title: "write guard", content: "original", visibility: "private" });
      const result = await request(writer, `/documents/${doc.id}${suffix}`, { method, body });
      assert.equal(result.status, 404);
      const detail = await request(owner, `/documents/${doc.id}`);
      assert.equal(detail.body.content, "original");
      assert.equal(detail.body.version, 1);
    });
  }

  it("denies same-org low-ceiling writer reads and edits of sensitive documents", async () => {
    const detail = await request(writer, `/documents/${sensitive.id}`);
    const patch = await request(writer, `/documents/${sensitive.id}`, { method: "PATCH", body: { content: "tampered" } });
    assert.equal(detail.status, 404);
    assert.equal(patch.status, 404);
  });

  it("does not expose cross-organization documents on reads or RAG", async () => {
    const detail = await request(other, `/documents/${shared.id}`);
    const list = await request(other, "/documents");
    const graph = await request(other, "/documents/graph");
    const chat = await request(other, "/agent/chat", { method: "POST", body: { message: "sharedneedle privateneedle" } });
    assert.equal(detail.status, 404);
    assert.deepEqual(list.body.items, []);
    assert.deepEqual(graph.body.nodes, []);
    assert.deepEqual(chat.body.answer.evidence, []);
  });

  it("preserves links but removes hidden and unresolved target metadata and statistics", async () => {
    const result = await request(member, "/documents/graph");
    const edges = result.body.edges.filter((edge) => edge.source === source.id);
    assert.equal(edges.length, 3);
    assert.ok(edges.some((edge) => edge.target_id === shared.id && edge.target_title === shared.title));
    assert.equal(edges.filter((edge) => edge.target_id === null && edge.target_title === "").length, 2);
    assert.equal(result.body.stats.restricted, 0);
    assert.equal(result.body.stats.chunks, result.body.nodes.reduce((sum, node) => sum + node.chunks, 0));
    assert.ok(!JSON.stringify(result.body).includes(target.title));
  });

  it("uses parent authorization even when chunk metadata is stale or points across organizations", async () => {
    const doc = await createDoc(owner, { title: "stale fixture", content: "stalechunkneedle" });
    database().prepare("UPDATE document SET visibility = 'private', sensitivity = 'sensitive' WHERE id = ?").run(doc.id);
    const alien = await createDoc(other, { title: "alien fixture", content: "alienchunkneedle" });
    database().prepare("UPDATE document_chunk SET document_id = ? WHERE document_id = ?").run(alien.id, doc.id);
    const result = await request(member, "/agent/chat", { method: "POST", body: { message: "stalechunkneedle alienchunkneedle" } });
    assert.deepEqual(result.body.answer.evidence, []);
  });

  it("routes retrieved sensitive documents locally despite client public and records the effective class", async () => {
    const start = calls.length;
    const result = await request(owner, "/agent/chat", { method: "POST", body: { message: "sensitiveneedle", data_class: "public" } });
    assert.equal(result.status, 200);
    assert.equal(result.body.provider, "ollama");
    assert.deepEqual(calls.slice(start).map((call) => call.path), ["/local/v1/chat/completions"]);
    assert.ok(calls.at(-1).body.messages[0].content.includes("sensitiveneedle"));
    const log = database().prepare("SELECT data_class FROM ai_request_log WHERE user_id = ? ORDER BY rowid DESC LIMIT 1").get(owner.userId);
    assert.equal(log.data_class, "sensitive");
  });

  for (const kind of ["vault", "memory"]) {
    it(`routes sensitive ${kind} context locally despite client internal`, async () => {
      const actor = await createOwnerOrg(server.baseUrl, ["agent"]);
      const path = kind === "vault" ? "/vault/notes" : "/agent/memory";
      const created = await request(actor, path, { method: "POST", body: { title: "context fixture", content: "contextneedle", sensitivity: kind === "vault" ? "sensitive" : "confidential" } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const start = calls.length;
      const result = await request(actor, "/agent/chat", { method: "POST", body: { message: "contextneedle", data_class: "internal" } });
      assert.equal(result.body.provider, "ollama");
      assert.deepEqual(calls.slice(start).map((call) => call.path), ["/local/v1/chat/completions"]);
      assert.ok(calls.at(-1).body.messages[0].content.includes("contextneedle"));
    });
  }

  it("keeps permitted internal context on the configured external wire adapter", async () => {
    const result = await request(member, "/agent/chat", { method: "POST", body: { message: "sharedneedle" } });
    assert.equal(result.body.provider, "openrouter");
    assert.equal(calls.at(-1).path, "/external/chat/completions");
    assert.ok(calls.at(-1).body.messages[0].content.includes("sharedneedle"));
  });

  it("falls back locally on local HTTP failure without contacting the external adapter", async () => {
    const start = calls.length;
    localFailure = true;
    let result;
    try { result = await providers.complete("confidential", "fixture", "fixture", "external"); }
    finally { localFailure = false; }
    assert.equal(result.provider, "echo");
    assert.deepEqual(calls.slice(start).map((call) => call.path), ["/local/v1/chat/completions"]);
  });

  it("fails closed for unknown provider and retrieved classifications", async () => {
    const rag = await import("../src/services/rag.service.js");
    for (const value of ["unknown", "Sensitive", "__proto__", undefined]) {
      assert.ok(providers.route(value, "external").every(([provider]) => provider.local));
      assert.equal(rag.effectiveDataClass("public", [{ sensitivity: value }], []), "confidential");
    }
  });

  it("rejects unknown HTTP classifications rather than treating them as internal", async () => {
    const doc = await request(owner, "/documents", { method: "POST", body: { title: "invalid", sensitivity: "unknown" } });
    const chat = await request(owner, "/agent/chat", { method: "POST", body: { message: "fixture", data_class: "unknown" } });
    assert.equal(doc.status, 400);
    assert.equal(chat.status, 400);
  });
});
