import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { api, createOwnerOrg, startTestServer } from "./http.js";

describe("personal OpenRouter credentials through authenticated HTTP and wire adapters", { timeout: 30000 }, () => {
  let server, wire, owner, member, other, config, conn, pool, originalQuery;
  let wireStatus = 200;
  const calls = [];
  const pgSessions = new Map();
  const key = "sk-or-v1-synthetic-owner-only";
  const memberKey = "sk-or-v1-synthetic-member-only";
  const request = (actor, route = "/agent/api-key", options = {}) => api(server.baseUrl, route, { ...actor, ...options });
  const save = (actor, apiKey = key) => request(actor, "/agent/api-key", { method: "PUT", body: { api_key: apiKey } });
  before(async () => {
    wire = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      calls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(wireStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify(wireStatus === 200
        ? { choices: [{ message: { content: "wire-ok" } }], model: "wire-model", usage: { total_tokens: 2 } }
        : { error: { message: req.headers.authorization } }));
    });
    const ready = once(wire, "listening", { signal: AbortSignal.timeout(5000) });
    wire.listen(0, "127.0.0.1");
    await ready;
    const base = `http://127.0.0.1:${wire.address().port}`;
    process.env.OPENROUTER_BASE_URL = `${base}/external`;
    process.env.OLLAMA_BASE_URL = `${base}/local`;
    process.env.OPENROUTER_API_KEY = "synthetic-server-key";
    process.env.ORBITFLOW_AI_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    server = await startTestServer();
    ({ env: config } = await import("../src/config/env.js"));
    conn = (await import("../src/config/db.js")).db();
    pool = (await import("../src/config/pg.js")).pgPool;
    originalQuery = pool.query;
    pool.query = async (sql, values) => {
      if (sql.includes("FROM auth.sessions s")) return { rows: pgSessions.has(values[0]) ? [pgSessions.get(values[0])] : [] };
      throw new Error("Unexpected PG fixture query");
    };
    owner = await createOwnerOrg(server.baseUrl, ["agent", "documents"]);
    other = await createOwnerOrg(server.baseUrl, ["agent"]);
    const email = `member-${randomUUID()}@example.com`;
    const invite = await request(owner, "/members/invites", { method: "POST", body: { email, roles: ["member"] } });
    const signup = await api(server.baseUrl, "/auth/signup", { method: "POST", body: { email, name: "Member", password: "password-1234", invitation_token: invite.body.token } });
    assert.equal(signup.status, 201);
    member = { token: signup.body.access_token, userId: signup.body.user.id, orgId: owner.orgId };
  });
  after(async () => {
    if (pool) { pool.query = originalQuery; await pool.end(); }
    if (server) await server.close();
    if (wire) await new Promise((resolve, reject) => wire.close((error) => error ? reject(error) : resolve()));
  });

  it("rejects unauthenticated metadata and secret writes", async () => {
    for (const method of ["GET", "PUT", "DELETE", "POST"]) {
      const result = await request({}, method === "POST" ? "/agent/api-key/test" : "/agent/api-key", { method, body: method === "PUT" ? { api_key: key } : undefined });
      assert.equal(result.status, 401);
    }
  });

  it("rejects malformed secret JSON without logging the raw parser body", async () => {
    const logged = [];
    const original = console.error;
    console.error = (...values) => logged.push(values);
    let response;
    try {
      response = await fetch(`${server.baseUrl}/agent/api-key`, {
        method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
        body: `{"api_key":"${key}",`,
      });
    } finally { console.error = original; }
    assert.ok(!JSON.stringify(logged).includes(key));
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes(key));
  });

  it("saves encrypted credentials and returns only owner metadata", async () => {
    const result = await save(owner);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { provider: "openrouter", configured: true, model: config.externalModel });
    const row = conn.prepare("SELECT * FROM ai_user_key WHERE user_id = ? AND deleted_at IS NULL").get(owner.userId);
    assert.ok(row.ciphertext && row.nonce && row.auth_tag);
    assert.ok(!JSON.stringify(row).includes(key));
    const audit = conn.prepare("SELECT * FROM audit_event WHERE actor_id = ?").all(owner.userId);
    assert.ok(!JSON.stringify(audit).includes(key));
    assert.deepEqual((await request(member)).body, { provider: "openrouter", configured: false, model: config.externalModel });
    assert.deepEqual((await request(other)).body, { provider: "openrouter", configured: false, model: config.externalModel });
  });

  it("rejects invalid key payloads without echoing submitted credentials", async () => {
    for (const apiKey of ["", "contains\nnewline", "x".repeat(4097), { private: key }]) {
      const result = await save(owner, apiKey);
      assert.equal(result.status, 400);
      assert.ok(!JSON.stringify(result.body).includes(key));
    }
    const spoof = await request(owner, "/agent/api-key", { method: "PUT", body: { api_key: key, user_id: member.userId } });
    assert.equal(spoof.status, 400);
  });

  it("fails closed on missing/invalid master key and preserves the prior credential", async () => {
    await save(owner);
    const beforeRow = conn.prepare("SELECT ciphertext FROM ai_user_key WHERE user_id = ? AND deleted_at IS NULL").get(owner.userId);
    const master = config.aiKeyEncryptionKey;
    try {
      for (const value of ["", "invalid", Buffer.alloc(16).toString("base64")]) {
        config.aiKeyEncryptionKey = value;
        const result = await save(owner, "synthetic-replacement");
        assert.equal(result.status, 503);
        assert.equal(result.body.error.code, "SERVICE_UNAVAILABLE");
      }
    } finally { config.aiKeyEncryptionKey = master; }
    assert.deepEqual(conn.prepare("SELECT ciphertext FROM ai_user_key WHERE user_id = ? AND deleted_at IS NULL").get(owner.userId), beforeRow);
  });

  it("uses each user's saved key on real HTTP requests without context or shared mutation", async () => {
    await save(owner);
    await save(member, memberKey);
    const start = calls.length;
    const results = await Promise.all([owner, member].map((actor) => request(actor, "/agent/api-key/test", { method: "POST" })));
    assert.ok(results.every((result) => result.status === 200 && result.body.provider === "openrouter" && result.body.connected === true));
    const sent = calls.slice(start);
    assert.deepEqual(sent.map((call) => call.authorization).sort(), [`Bearer ${key}`, `Bearer ${memberKey}`].sort());
    assert.ok(sent.every((call) => call.path === "/external/chat/completions" && call.body.max_tokens === 8));
    assert.ok(sent.every((call) => call.body.messages.length === 2));
    assert.equal((await request(other, "/agent/api-key/test", { method: "POST" })).status, 409);
    const providers = await import("../src/services/ai-provider.service.js");
    assert.equal(providers.REGISTRY.openrouter.apiKey, "synthetic-server-key");
  });

  it("replaces the credential used by chat even when the server default is echo", async () => {
    const replacement = "synthetic-replaced-key";
    await save(owner, replacement);
    const result = await request(owner, "/agent/chat", { method: "POST", body: { message: "ordinary-synthetic-message" } });
    assert.equal(result.status, 200);
    assert.equal(result.body.provider, "openrouter");
    assert.equal(calls.at(-1).authorization, `Bearer ${replacement}`);
  });

  it("never reports local fallback as a successful saved-key connection", async () => {
    await save(owner);
    wireStatus = 401;
    const start = calls.length;
    let result;
    try { result = await request(owner, "/agent/api-key/test", { method: "POST" }); }
    finally { wireStatus = 200; }
    assert.equal(result.status, 503);
    assert.ok(!JSON.stringify(result.body).includes(key));
    assert.equal(calls.length - start, 1);
  });

  for (const dataClass of ["sensitive", "confidential"]) {
    it(`keeps ${dataClass} requests local with a saved key`, async () => {
      await save(owner);
      const start = calls.length;
      const result = await request(owner, "/agent/chat", { method: "POST", body: { message: "classified-synthetic-message", data_class: dataClass } });
      assert.equal(result.body.provider, "ollama");
      assert.deepEqual(calls.slice(start).map((call) => call.path), ["/local/v1/chat/completions"]);
      assert.equal(calls.at(-1).authorization, undefined);
    });
  }

  it("honors explicit local policy without decrypting an unavailable personal key", async () => {
    await save(owner);
    const profile = await request(owner, "/agent/profile", { method: "PUT", body: { model_policy: "local" } });
    assert.equal(profile.status, 200);
    const master = config.aiKeyEncryptionKey;
    const start = calls.length;
    config.aiKeyEncryptionKey = "";
    try {
      const result = await request(owner, "/agent/chat", { method: "POST", body: { message: "local-policy-synthetic" } });
      assert.equal(result.body.provider, "ollama");
      assert.deepEqual(calls.slice(start).map((call) => call.path), ["/local/v1/chat/completions"]);
    } finally {
      config.aiKeyEncryptionKey = master;
      await request(owner, "/agent/profile", { method: "PUT", body: { model_policy: "auto" } });
    }
  });

  it("keeps an unconfigured user's chat on server defaults, not another user's key", async () => {
    await save(owner);
    const start = calls.length;
    const result = await request(other, "/agent/chat", { method: "POST", body: { message: "isolated-synthetic" } });
    assert.equal(result.body.provider, "echo");
    assert.equal(calls.length, start);
  });

  it("keeps retrieved sensitive context local despite client public and saved key", async () => {
    await save(owner);
    const doc = await request(owner, "/documents", { method: "POST", body: { title: "classification fixture", content: "secretcontextneedle", sensitivity: "sensitive" } });
    assert.equal(doc.status, 201);
    const start = calls.length;
    const result = await request(owner, "/agent/chat", { method: "POST", body: { message: "secretcontextneedle", data_class: "public" } });
    assert.equal(result.body.provider, "ollama");
    assert.deepEqual(calls.slice(start).map((call) => call.path), ["/local/v1/chat/completions"]);
  });

  it("rejects ciphertext swapped between owners without contacting any provider", async () => {
    await save(owner);
    await save(member, memberKey);
    const source = conn.prepare("SELECT ciphertext, nonce, auth_tag FROM ai_user_key WHERE user_id = ? AND deleted_at IS NULL").get(owner.userId);
    conn.prepare("UPDATE ai_user_key SET ciphertext = ?, nonce = ?, auth_tag = ? WHERE user_id = ? AND deleted_at IS NULL").run(source.ciphertext, source.nonce, source.auth_tag, member.userId);
    const start = calls.length;
    const result = await request(member, "/agent/api-key/test", { method: "POST" });
    assert.equal(result.status, 503);
    assert.equal(calls.length, start);
  });

  it("deletes and scrubs only the requesting user's credential", async () => {
    await save(owner);
    await save(member, memberKey);
    const result = await request(owner, "/agent/api-key", { method: "DELETE" });
    assert.deepEqual(result.body, { provider: "openrouter", configured: false, model: config.externalModel });
    const rows = conn.prepare("SELECT ciphertext, nonce, auth_tag, deleted_at FROM ai_user_key WHERE user_id = ?").all(owner.userId);
    assert.ok(rows.every((row) => row.deleted_at && row.ciphertext === "" && row.nonce === "" && row.auth_tag === ""));
    assert.equal((await request(member)).body.configured, true);
    assert.equal((await request(owner, "/agent/api-key/test", { method: "POST" })).status, 409);
  });

  it("binds PG sessions to operational identities, not matching external email or company", async () => {
    const token = randomUUID();
    pgSessions.set(token, { session_id: randomUUID(), id: "9001", email: conn.prepare("SELECT email FROM app_user WHERE id = ?").get(owner.userId).email, name: "PG fixture", is_admin: true, company_id: "77", account_status: "active", approval_status: "approved", login_at: new Date().toISOString() });
    assert.equal((await request({ token, orgId: owner.orgId })).status, 403);
    const org = await request({ token }, "/tenants", { method: "POST", body: { name: "PG 운영 조직", type: "custom", modules: ["agent"], departments: [] } });
    assert.equal(org.status, 201);
    const actor = { token, orgId: org.body.org_id };
    assert.equal((await save(actor, "synthetic-pg-key")).status, 200);
    const identity = conn.prepare("SELECT user_id FROM auth_identity WHERE provider = 'perp_db' AND subject = '9001'").get();
    assert.notEqual(identity.user_id, "9001");
    assert.ok(conn.prepare("SELECT id FROM ai_user_key WHERE user_id = ? AND deleted_at IS NULL").get(identity.user_id));
    const result = await request(actor, "/agent/api-key/test", { method: "POST" });
    assert.equal(result.status, 200);
    assert.equal(calls.at(-1).authorization, "Bearer synthetic-pg-key");
  });
});
