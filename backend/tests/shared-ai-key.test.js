import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { api, createOwnerOrg, startTestServer } from "./http.js";
import { installPgKeyFixture } from "./pg-api-key-fixture.js";

describe("server-managed OpenRouter credential across isolated companies", { timeout: 30000 }, () => {
  const shared = "synthetic-central-openrouter";
  const personal = "synthetic-preserved-personal";
  const calls = [];
  let server, wire, fixture, env, conn, owners, pgActors, savedRow;
  let wireStatus = 200;
  const request = (actor, path = "/agent/api-key", options = {}) => api(server.baseUrl, path, { ...actor, ...options });
  before(async () => {
    wire = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      calls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(wireStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify(wireStatus === 200
        ? { choices: [{ message: { content: "OK" } }] }
        : { error: { message: req.headers.authorization } }));
    });
    const ready = once(wire, "listening", { signal: AbortSignal.timeout(5000) });
    wire.listen(0, "127.0.0.1"); await ready;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${wire.address().port}/external`;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${wire.address().port}/local`;
    process.env.OPENROUTER_API_KEY = "";
    process.env.ORBITFLOW_AI_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    server = await startTestServer();
    ({ env } = await import("../src/config/env.js"));
    conn = (await import("../src/config/db.js")).db();
    owners = await Promise.all([createOwnerOrg(server.baseUrl, ["agent", "documents"]), createOwnerOrg(server.baseUrl, ["agent", "documents"])]);
    assert.equal((await request(owners[0], undefined, { method: "PUT", body: { api_key: personal } })).status, 200);
    savedRow = conn.prepare("SELECT * FROM ai_user_key WHERE user_id=?").get(owners[0].userId);
    fixture = await installPgKeyFixture();
    pgActors = [fixture.actor("101", "77"), fixture.actor("102", "88")];
    env.openrouterApiKey = shared;
    // 중앙 키 모드에서는 기존 암호문을 읽거나 복호화할 필요가 없다.
    env.aiKeyEncryptionKey = "";
  });
  after(async () => {
    if (fixture) await fixture.close();
    if (server) await server.close();
    if (wire) await new Promise((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
  });

  it("returns only shared-mode readiness for authenticated legacy and PG companies", async () => {
    for (const [actors, path] of [[owners, "/agent/api-key"], [pgActors, "/pg/agent/api-key"]]) {
      for (const actor of actors) {
        const result = await request(actor, path);
        assert.equal(result.status, 200);
        assert.deepEqual(result.body, { provider: "openrouter", configured: true, credential_mode: "shared", model: env.externalModel });
        assert.ok(!JSON.stringify(result.body).includes(shared));
      }
    }
  });

  it("tests the same central credential from two PG companies without personal saves", async () => {
    const start = calls.length;
    const results = await Promise.all(pgActors.map(actor => request(actor, "/pg/agent/api-key/test", { method: "POST" })));
    assert.ok(results.every(result => result.status === 200 && result.body.connected === true));
    assert.ok(results.every(result => !JSON.stringify(result.body).includes(shared)));
    assert.deepEqual(calls.slice(start).map(call => call.authorization), [`Bearer ${shared}`, `Bearer ${shared}`]);
    assert.ok(calls.slice(start).every(call => call.body.max_tokens === 8 && call.body.messages.length === 2));
  });

  it("uses the same central key for real two-org chat while isolating context and conversations", async () => {
    const needles = ["firstcompanyuniqueneedle", "secondcompanyuniqueneedle"];
    for (const [i, owner] of owners.entries()) {
      assert.equal((await request(owner, "/documents", { method: "POST", body: { title: "synthetic", content: needles[i], sensitivity: "internal" } })).status, 201);
    }
    const start = calls.length;
    const results = await Promise.all(owners.map((owner, i) => request(owner, "/agent/chat", { method: "POST", body: { message: needles[i] } })));
    assert.ok(results.every(result => result.status === 200 && result.body.provider === "openrouter"));
    assert.deepEqual(calls.slice(start).map(call => call.authorization), [`Bearer ${shared}`, `Bearer ${shared}`]);
    for (const call of calls.slice(start)) {
      const i = needles.indexOf(call.body.messages[1].content);
      assert.ok(i >= 0);
      assert.ok(!JSON.stringify(call.body).includes(needles[1 - i]));
    }
    assert.equal((await request(owners[1], "/agent/chat", { method: "POST", body: { message: "cross-org", conversation_id: results[0].body.conversation_id } })).status, 404);
    assert.deepEqual(conn.prepare("SELECT * FROM ai_user_key WHERE user_id=?").get(owners[0].userId), savedRow);
  });

  it("preserves old personal ciphertext and rejects personal changes in shared mode", async () => {
    for (const [actor, path] of [[owners[0], "/agent/api-key"], [pgActors[0], "/pg/agent/api-key"]]) {
      for (const method of ["PUT", "DELETE"]) {
        const result = await request(actor, path, { method, body: method === "PUT" ? { api_key: "synthetic-unwanted-replacement" } : undefined });
        assert.equal(result.status, 409);
        assert.equal(result.body.error.code, "CONFLICT");
      }
    }
    assert.deepEqual(conn.prepare("SELECT * FROM ai_user_key WHERE user_id=?").get(owners[0].userId), savedRow);
  });

  it("retains classified-data and explicit-local policy ahead of the shared credential", async () => {
    const { completeForUser } = await import("../src/services/ai-key.service.js");
    const principal = { userId: owners[0].userId, orgId: owners[0].orgId, tenantId: savedRow.tenant_id };
    for (const options of [{ dataClass: "sensitive" }, { dataClass: "confidential" }, { dataClass: "unknown" }, { dataClass: "public", prefer: "local" }]) {
      const start = calls.length;
      const result = await completeForUser(principal, { system: "synthetic", user: "synthetic", ...options });
      assert.equal(result.provider, "ollama");
      assert.deepEqual(calls.slice(start).map(call => call.path), ["/local/v1/chat/completions"]);
      assert.equal(calls.at(-1).authorization, undefined);
    }
    assert.equal((await request(owners[0], "/documents", { method: "POST", body: { title: "classified", content: "sharedclassifiedneedle", sensitivity: "sensitive" } })).status, 201);
    const start = calls.length;
    assert.equal((await request(owners[0], "/agent/chat", { method: "POST", body: { message: "sharedclassifiedneedle", data_class: "public" } })).body.provider, "ollama");
    assert.deepEqual(calls.slice(start).map(call => call.path), ["/local/v1/chat/completions"]);
  });

  it("does not grant new permissions or leak central credentials in provider failures", async () => {
    assert.equal((await request({}, "/agent/api-key")).status, 401);
    const denied = fixture.actor("103", "77", ["platform.admin", "*"]);
    assert.equal((await request(denied, "/pg/agent/api-key")).status, 403);
    assert.equal((await request({ ...pgActors[0], orgId: "pg:88" }, "/pg/agent/api-key")).status, 403);
    wireStatus = 401;
    const start = calls.length;
    const original = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    let result;
    try { result = await request(owners[0], "/agent/api-key/test", { method: "POST" }); }
    finally { wireStatus = 200; console.error = original; }
    assert.equal(result.status, 503);
    assert.equal(calls.length - start, 1);
    assert.ok(!JSON.stringify([result.body, logged]).includes(shared));
    assert.ok(!JSON.stringify(result.body).includes("401"));
  });
});
