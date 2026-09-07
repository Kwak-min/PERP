import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { api, createOwnerOrg, startTestServer } from "./http.js";
import { installPgKeyFixture } from "./pg-api-key-fixture.js";

describe("PG selected-company personal keys through verified grants and actual HTTP", { timeout: 30000 }, () => {
  let server, fixture, owner, peer, foreign, wire, conn;
  const calls = [];
  const secret = "sk-or-v1-pg-synthetic-owner";
  const request = (actor, method = "GET", body, suffix = "") => api(server.baseUrl, `/pg/agent/api-key${suffix}`, { ...actor, method, body });
  before(async () => {
    wire = createServer(async (req, res) => {
      let data = "";
      for await (const chunk of req) data += chunk;
      calls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(data) });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { total_tokens: 2 } }));
    });
    const ready = once(wire, "listening", { signal: AbortSignal.timeout(5000) });
    wire.listen(0, "127.0.0.1"); await ready;
    const base = `http://127.0.0.1:${wire.address().port}`;
    process.env.OPENROUTER_BASE_URL = `${base}/external`;
    process.env.OLLAMA_BASE_URL = `${base}/local`;
    process.env.OPENROUTER_API_KEY = "";
    process.env.ORBITFLOW_AI_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    server = await startTestServer();
    fixture = await installPgKeyFixture();
    owner = fixture.actor("101"); peer = fixture.actor("102"); foreign = fixture.actor("103", "88");
    conn = (await import("../src/config/db.js")).db();
  });
  after(async () => {
    if (fixture) await fixture.close();
    if (server) await server.close();
    if (wire) await new Promise((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
  });

  it("saves and uses the PG company's personal key without any SQLite membership", async () => {
    const saved = await request(owner, "PUT", { api_key: secret });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.configured, true);
    const identity = conn.prepare("SELECT user_id FROM auth_identity WHERE provider='perp_db' AND subject='101'").get();
    assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM membership WHERE user_id=?").get(identity.user_id).n, 0);
    const record = conn.prepare("SELECT * FROM ai_user_key WHERE user_id=? AND deleted_at IS NULL").get(identity.user_id);
    assert.equal(record.tenant_id, "pg:77"); assert.equal(record.org_id, "pg:77");
    assert.ok(!JSON.stringify(record).includes(secret));
    const result = await request(owner, "POST", undefined, "/test");
    assert.equal(result.status, 200); assert.equal(result.body.connected, true);
    assert.equal(calls.at(-1).authorization, `Bearer ${secret}`);
    assert.equal(calls.at(-1).body.max_tokens, 8);
  });

  it("isolates another same-company user and another company", async () => {
    await request(owner, "PUT", { api_key: secret });
    for (const actor of [peer, foreign]) {
      const result = await request(actor);
      assert.equal(result.status, 200);
      assert.equal(result.body.configured, false);
      assert.equal((await request(actor, "POST", undefined, "/test")).status, 409);
    }
    await request(peer, "PUT", { api_key: "synthetic-peer" });
    await Promise.all([owner, peer].map(actor => request(actor, "POST", undefined, "/test")));
    assert.deepEqual(calls.slice(-2).map(call => call.authorization).sort(), [`Bearer ${secret}`, "Bearer synthetic-peer"].sort());
  });

  it("requires explicit PG permission/module rather than is_admin or legacy owner", async () => {
    const denied = fixture.actor("104", "77", ["*", "platform.admin"]);
    for (const method of ["GET", "PUT", "DELETE", "POST"]) {
      assert.equal((await request(denied, method, method === "PUT" ? { api_key: secret } : undefined, method === "POST" ? "/test" : "")).status, 403);
    }
    fixture.modules.set("77", []);
    try { assert.equal((await request(owner)).body.error.code, "MODULE_DISABLED"); }
    finally { fixture.modules.set("77", ["agent"]); }
    const legacy = await createOwnerOrg(server.baseUrl, ["agent"]);
    assert.equal((await request({ token: legacy.token, orgId: "pg:77" })).status, 401);
  });

  it("rejects missing/foreign company selection and spoofed owner payloads", async () => {
    for (const orgId of ["pg:88", "legacy-org"]) assert.equal((await request({ ...owner, orgId })).status, 403);
    assert.equal((await request({ token: owner.token })).status, 400);
    assert.equal((await request(owner, "PUT", { api_key: secret, user_id: "102", company_id: "88" })).status, 400);
  });

  it("blocks revoked, expired, unapproved and disabled PG identities", async () => {
    for (const patch of [{ active: false }, { login_at: "2000-01-01" }, { approval_status: "pending" }, { account_status: "disabled" }]) {
      const actor = fixture.actor(`invalid-${Object.keys(patch)[0]}`);
      Object.assign(fixture.sessions.get(actor.token), patch);
      const start = calls.length;
      assert.equal((await request(actor, "POST", undefined, "/test")).status, 401);
      assert.equal(calls.length, start);
    }
  });

  it("shares the encrypted scope service without allowing classified external requests", async () => {
    await request(owner, "PUT", { api_key: secret });
    const { completeForUser } = await import("../src/services/ai-key.service.js");
    const identity = conn.prepare("SELECT user_id FROM auth_identity WHERE provider='perp_db' AND subject='101'").get();
    const scope = { tenantId: "pg:77", orgId: "pg:77", userId: identity.user_id };
    for (const dataClass of ["sensitive", "confidential", "unknown"]) {
      const start = calls.length;
      const result = await completeForUser(scope, { dataClass, system: "synthetic", user: "classified", prefer: "external" });
      assert.equal(result.provider, "ollama");
      assert.deepEqual(calls.slice(start).map(call => call.path), ["/local/v1/chat/completions"]);
      assert.equal(calls.at(-1).authorization, undefined);
    }
  });

  it("sanitizes malformed JSON for the PG key path before controller dispatch", async () => {
    const logged = []; const original = console.error;
    let response;
    console.error = (...values) => logged.push(values);
    try {
      response = await fetch(`${server.baseUrl}/pg/agent/api-key`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: `{"api_key":"${secret}",` });
    } finally { console.error = original; }
    assert.equal(response.status, 400);
    assert.ok(!JSON.stringify(logged).includes(secret));
  });

  it("replaces and deletes only the selected PG user's saved key", async () => {
    const saved = await request(owner, "PUT", { api_key: "pg-replacement" });
    assert.equal(saved.status, 200);
    await request(owner, "POST", undefined, "/test");
    assert.equal(calls.at(-1).authorization, "Bearer pg-replacement");
    const deleted = await request(owner, "DELETE");
    assert.equal(deleted.status, 200); assert.equal(deleted.body.configured, false);
    assert.equal((await request(owner, "POST", undefined, "/test")).status, 409);
    assert.equal((await request(peer)).body.configured, true);
  });

  it("uses verified secondary membership and separates the same user's company keys", async () => {
    const companyB = fixture.join(owner, "88");
    assert.equal(fixture.users.get(owner.externalId).company_id, "77");
    await request(owner, "PUT", { api_key: secret });
    const empty = await request(companyB);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.configured, false);
    assert.equal((await request(companyB, "PUT", { api_key: "same-user-company-B" })).status, 200);
    const start = calls.length;
    await Promise.all([owner, companyB].map(actor => request(actor, "POST", undefined, "/test")));
    assert.deepEqual(calls.slice(start).map(call => call.authorization).sort(), [`Bearer ${secret}`, "Bearer same-user-company-B"].sort());
    assert.equal((await request(companyB, "DELETE")).status, 200);
    assert.equal((await request(owner)).body.configured, true);
    assert.equal((await request(companyB)).body.configured, false);
  });

  it("rejects left/suspended memberships and grants without membership", async () => {
    const actor = fixture.actor("membership-guard");
    const companyB = fixture.join(actor, "88");
    const membership = fixture.memberships.get(fixture.scopeKey(actor.externalId, "88"));
    for (const status of ["left", "suspended"]) {
      membership.status = status;
      assert.equal((await request(companyB)).status, 403);
    }
    fixture.memberships.delete(fixture.scopeKey(actor.externalId, "88"));
    assert.equal((await request(companyB)).status, 403);
    assert.equal(fixture.grants.get(fixture.scopeKey(actor.externalId, "88")).includes("agent.chat"), true);
  });
});
