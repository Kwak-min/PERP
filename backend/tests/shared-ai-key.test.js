import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { api, createOwnerOrg, startTestServer } from "./http.js";
import { installPgKeyFixture } from "./pg-api-key-fixture.js";

describe("effective owner OpenRouter credential with a configured shared key", { timeout: 30000 }, () => {
  const shared = "synthetic-central-openrouter";
  const personal = "synthetic-owner-openrouter";
  const replacement = "synthetic-replacement-openrouter";
  const calls = [];
  let server, wire, fixture, env, conn, owners, pgActors;
  let wireMode = 200;
  const request = (actor, path = "/agent/api-key", options = {}) => api(server.baseUrl, path, { ...actor, ...options });
  const save = (actor, path, apiKey = personal) => request(actor, path, { method: "PUT", body: { api_key: apiKey } });
  before(async () => {
    wire = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      calls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
      if (wireMode === "network") { req.socket.destroy(); return; }
      res.writeHead(typeof wireMode === "number" ? wireMode : 200, { "Content-Type": "application/json" });
      res.end(wireMode === "malformed" ? "{" : JSON.stringify(wireMode === 200
        ? { choices: [{ message: { content: "actual-upstream-answer" } }], model: "actual-upstream-model" }
        : { error: { message: req.headers.authorization } }));
    });
    const ready = once(wire, "listening", { signal: AbortSignal.timeout(5000) });
    wire.listen(0, "127.0.0.1"); await ready;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${wire.address().port}/external`;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${wire.address().port}/local`;
    process.env.OPENROUTER_API_KEY = shared;
    process.env.ORBITFLOW_AI_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    server = await startTestServer();
    ({ env } = await import("../src/config/env.js"));
    conn = (await import("../src/config/db.js")).db();
    owners = await Promise.all([createOwnerOrg(server.baseUrl, ["agent", "documents"]), createOwnerOrg(server.baseUrl, ["agent", "documents"])]);
    fixture = await installPgKeyFixture();
    pgActors = [fixture.actor("101", "77"), fixture.actor("102", "88")];
  });
  after(async () => {
    if (fixture) await fixture.close();
    if (server) await server.close();
    if (wire) await new Promise((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
  });

  it("saves, replaces and deletes personal credentials while shared configuration remains enabled", async () => {
    for (const [actor, path] of [[owners[0], "/agent/api-key"], [pgActors[0], "/pg/agent/api-key"]]) {
      assert.equal((await request(actor, path)).body.credential_mode, "shared");
      for (const key of [personal, replacement]) {
        const saved = await save(actor, path, key);
        assert.equal(saved.status, 200);
        assert.deepEqual(saved.body, { provider: "openrouter", configured: true, credential_mode: "personal", model: env.externalModel });
        const tested = await request(actor, `${path}/test`, { method: "POST" });
        assert.equal(tested.status, 200);
        assert.equal(calls.at(-1).authorization, `Bearer ${key}`);
        assert.equal(calls.at(-1).body.max_tokens, 8);
        assert.ok(!JSON.stringify([saved.body, tested.body]).includes(key));
      }
      const deleted = await request(actor, path, { method: "DELETE" });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.credential_mode, "shared");
      assert.equal((await request(actor, `${path}/test`, { method: "POST" })).status, 200);
      assert.equal(calls.at(-1).authorization, `Bearer ${shared}`);
    }
    const rows = conn.prepare("SELECT ciphertext, nonce, auth_tag FROM ai_user_key").all();
    assert.ok(rows.every(row => row.ciphertext === "" && row.nonce === "" && row.auth_tag === ""));
  });

  it("selects external profile policy on save without changing other users or preferences", async () => {
    await request(owners[0], "/agent/profile", { method: "PUT", body: { model_policy: "local", preferences: { synthetic: true } } });
    assert.equal((await save(owners[0], "/agent/api-key")).status, 200);
    const profile = (await request(owners[0], "/agent/profile")).body;
    assert.equal(profile.model_policy, "external");
    assert.deepEqual(profile.preferences, { synthetic: true });
    assert.equal((await request(owners[1], "/agent/profile")).body.model_policy, "auto");
    assert.equal((await save(pgActors[0], "/pg/agent/api-key")).status, 200);
    const identity = conn.prepare("SELECT user_id FROM auth_identity WHERE provider='perp_db' AND subject='101'").get();
    assert.equal(conn.prepare("SELECT model_policy FROM agent_profile WHERE tenant_id='pg:77' AND org_id='pg:77' AND user_id=?").get(identity.user_id).model_policy, "external");
    assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM membership WHERE user_id=?").get(identity.user_id).n, 0);
  });

  it("uses personal then shared for real two-org RAG chat with isolated context and actual response", async () => {
    const needles = ["firstcompanyuniqueneedle", "secondcompanyuniqueneedle"];
    for (const [i, owner] of owners.entries()) {
      assert.equal((await request(owner, "/documents", { method: "POST", body: { title: "synthetic", content: needles[i], sensitivity: "internal" } })).status, 201);
    }
    const start = calls.length;
    const results = await Promise.all(owners.map((owner, i) => request(owner, "/agent/chat", { method: "POST", body: { message: needles[i] } })));
    assert.ok(results.every(result => result.status === 200 && result.body.provider === "openrouter" && result.body.model === "actual-upstream-model" && result.body.answer.conclusion === "actual-upstream-answer"));
    for (const call of calls.slice(start)) {
      const i = needles.indexOf(call.body.messages[1].content);
      assert.ok(i >= 0);
      assert.equal(call.authorization, `Bearer ${i === 0 ? personal : shared}`);
      assert.ok(JSON.stringify(call.body).includes(needles[i]));
      assert.ok(!JSON.stringify(call.body).includes(needles[1 - i]));
    }
    assert.equal((await request(owners[1], "/agent/chat", { method: "POST", body: { message: "cross-org", conversation_id: results[0].body.conversation_id } })).status, 404);
    const rows = conn.prepare("SELECT * FROM ai_user_key").all();
    const audit = conn.prepare("SELECT * FROM audit_event").all();
    assert.ok(!JSON.stringify([rows, audit, results]).includes(personal));
  });

  it("retains classified-data and explicit-local policy without decrypting credentials", async () => {
    const { completeForUser } = await import("../src/services/ai-key.service.js");
    const row = conn.prepare("SELECT tenant_id FROM ai_user_key WHERE user_id=? AND deleted_at IS NULL").get(owners[0].userId);
    const principal = { userId: owners[0].userId, orgId: owners[0].orgId, tenantId: row.tenant_id };
    const master = env.aiKeyEncryptionKey;
    env.aiKeyEncryptionKey = "";
    try {
      for (const options of [{ dataClass: "sensitive" }, { dataClass: "confidential" }, { dataClass: "unknown" }, { dataClass: "public", prefer: "local" }]) {
        const start = calls.length;
        const result = await completeForUser(principal, { system: "synthetic", user: "synthetic", ...options });
        assert.equal(result.provider, "ollama");
        assert.deepEqual(calls.slice(start).map(call => call.path), ["/local/v1/chat/completions"]);
        assert.equal(calls.at(-1).authorization, undefined);
      }
      const start = calls.length;
      assert.equal((await request(owners[0], "/agent/api-key/test", { method: "POST" })).status, 503);
      assert.equal(calls.length, start);
    } finally { env.aiKeyEncryptionKey = master; }
    assert.equal((await request(owners[0], "/documents", { method: "POST", body: { title: "classified", content: "sharedclassifiedneedle", sensitivity: "sensitive" } })).status, 201);
    const start = calls.length;
    assert.equal((await request(owners[0], "/agent/chat", { method: "POST", body: { message: "sharedclassifiedneedle", data_class: "public" } })).body.provider, "ollama");
    assert.deepEqual(calls.slice(start).map(call => call.path), ["/local/v1/chat/completions"]);
  });

  it("returns errors for invalid key, quota, malformed or disconnected upstream without fallback or secret exposure", async () => {
    const original = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
      for (const mode of [401, 429, "malformed", "empty", "network"]) {
        wireMode = mode;
        for (const [actor, path, body] of [[owners[0], "/agent/chat", { message: "synthetic-failure" }], [owners[1], "/agent/chat", { message: "synthetic-shared-failure" }], [pgActors[0], "/pg/agent/api-key/test", undefined]]) {
          const start = calls.length;
          const result = await request(actor, path, { method: "POST", body });
          assert.equal(result.status, 503);
          assert.equal(result.body.error.code, "SERVICE_UNAVAILABLE");
          assert.equal(calls.length - start, 1);
          assert.equal(calls.at(-1).path, "/external/chat/completions");
          assert.ok(!JSON.stringify(result.body).includes(personal) && !JSON.stringify(result.body).includes(shared));
        }
      }
    } finally { wireMode = 200; console.error = original; }
    assert.ok(!JSON.stringify(logged).includes(personal) && !JSON.stringify(logged).includes(shared));
    assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM ai_message WHERE content='synthetic-failure'").get().n, 0);
  });

  it("preserves a first-time owner's effective chair profile except for cloud policy", async () => {
    const actor = await createOwnerOrg(server.baseUrl, ["agent"]);
    const before = await request(actor, "/agent/profile");
    assert.equal(before.status, 200);
    assert.equal(before.body.preset, "chair");
    assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM agent_profile WHERE user_id=?").get(actor.userId).n, 0);
    for (const key of [personal, replacement]) {
      assert.equal((await save(actor, "/agent/api-key", key)).status, 200);
      const after = await request(actor, "/agent/profile");
      assert.equal(after.status, 200);
      assert.deepEqual(after.body, { ...before.body, model_policy: "external" });
    }
  });

  it("preserves an existing custom profile and all non-policy stored fields on key save", async () => {
    const actor = await createOwnerOrg(server.baseUrl, ["agent"]);
    assert.equal((await request(actor, "/agent/profile", { method: "PUT", body: {
      preset: "successor", model_policy: "local", preferences: { synthetic: true, nested: { mode: "custom" } },
    } })).status, 200);
    const before = await request(actor, "/agent/profile");
    assert.equal(before.status, 200);
    assert.equal(before.body.preset, "successor");
    const storedFields = () => {
      const { model_policy, version, updated_at, updated_by, ...fields } = conn.prepare("SELECT * FROM agent_profile WHERE user_id=?").get(actor.userId);
      return fields;
    };
    const storedBefore = storedFields();
    assert.equal((await save(actor, "/agent/api-key")).status, 200);
    const after = await request(actor, "/agent/profile");
    assert.equal(after.status, 200);
    assert.deepEqual(after.body, { ...before.body, model_policy: "external" });
    assert.deepEqual(storedFields(), storedBefore);
  });

  for (const [role, preset] of [["treasurer", "treasurer"], ["pm", "dept_lead"], ["member", "member"]]) {
    it(`preserves the first-time ${role} role fallback on key save`, async () => {
      const org = await createOwnerOrg(server.baseUrl, ["agent"]);
      const email = `profile-${randomUUID()}@example.invalid`;
      const invite = await request(org, "/members/invites", { method: "POST", body: { email, roles: [role] } });
      assert.equal(invite.status, 201);
      const signup = await api(server.baseUrl, "/auth/signup", { method: "POST", body: {
        email, name: "Profile fixture", password: "password-1234", invitation_token: invite.body.token,
      } });
      assert.equal(signup.status, 201);
      const actor = { token: signup.body.access_token, orgId: org.orgId, userId: signup.body.user.id };
      const before = await request(actor, "/agent/profile");
      assert.equal(before.status, 200);
      assert.equal(before.body.preset, preset);
      assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM agent_profile WHERE user_id=?").get(actor.userId).n, 0);
      assert.equal((await save(actor, "/agent/api-key")).status, 200);
      const after = await request(actor, "/agent/profile");
      assert.equal(after.status, 200);
      assert.deepEqual(after.body, { ...before.body, model_policy: "external" });
    });
  }

  it("reports none when neither credential exists and preserves all authorization gates", async () => {
    env.openrouterApiKey = "";
    try {
      assert.deepEqual((await request(owners[1])).body, { provider: "openrouter", configured: false, credential_mode: "none", model: env.externalModel });
      assert.equal((await request(owners[1], "/agent/api-key/test", { method: "POST" })).status, 409);
    } finally { env.openrouterApiKey = shared; }
    assert.equal((await request({}, "/agent/api-key")).status, 401);
    const denied = fixture.actor("103", "77", ["platform.admin", "*"]);
    assert.equal((await request(denied, "/pg/agent/api-key")).status, 403);
    assert.equal((await request({ ...pgActors[0], orgId: "pg:88" }, "/pg/agent/api-key")).status, 403);
  });
});
