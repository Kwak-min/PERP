import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { createOwnerOrg, startTestServer } from "./http.js";

describe("agent turns preserve owner credential and privacy isolation", { timeout: 30000 }, () => {
  let server, wire, keys, config, principals;
  const calls = [];
  const options = { messages: [{ role: "user", content: "Find tasks" }], tools: [], classification: "internal" };
  before(async () => {
    wire = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      calls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(text) });
      res.end(JSON.stringify({ choices: [{ message: { content: "Actual turn" } }] }));
    });
    const ready = once(wire, "listening", { signal: AbortSignal.timeout(5000) });
    wire.listen(0, "127.0.0.1"); await ready;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${wire.address().port}/external`;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${wire.address().port}/local`;
    process.env.OPENROUTER_API_KEY = "";
    process.env.ORBITFLOW_AI_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    server = await startTestServer();
    ({ env: config } = await import("../src/config/env.js"));
    keys = await import("../src/services/ai-key.service.js");
    const { db } = await import("../src/config/db.js");
    const actors = await Promise.all([createOwnerOrg(server.baseUrl, ["agent"]), createOwnerOrg(server.baseUrl, ["agent"])]);
    principals = actors.map(actor => ({
      ...actor, tenantId: db().prepare("SELECT tenant_id FROM organization WHERE id=?").get(actor.orgId).tenant_id, roles: ["owner"],
    }));
    principals.forEach((principal, index) => keys.saveKey(principal, `synthetic-turn-owner-${index}`, "test-request"));
  });
  after(async () => {
    await server?.close();
    wire.closeAllConnections();
    await new Promise((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
  });

  it("uses each owner's key independently without mutating the shared registry", async () => {
    const results = await Promise.all(principals.map(principal => keys.completeTurnForUser(principal, options)));
    assert.ok(results.every(result => result.content === "Actual turn" && result.provider === "openrouter"));
    assert.deepEqual(calls.map(call => call.authorization).sort(), ["Bearer synthetic-turn-owner-0", "Bearer synthetic-turn-owner-1"]);
    const { REGISTRY } = await import("../src/services/ai-provider.service.js");
    assert.equal(REGISTRY.openrouter.apiKey, "");
  });

  it("rechecks history before decrypting owner credentials on every turn", async () => {
    const master = config.aiKeyEncryptionKey;
    config.aiKeyEncryptionKey = "";
    try {
      for (const extra of [
        { classification: "sensitive" }, { classification: "unknown" }, { prefer: "local" },
        { messages: [{ role: "user", content: "password=synthetic-history" }] },
      ]) {
        const result = await keys.completeTurnForUser(principals[0], { ...options, ...extra });
        assert.equal(result.provider, "ollama");
        assert.equal(calls.at(-1).authorization, undefined);
      }
    } finally { config.aiKeyEncryptionKey = master; }
  });

  it("previews target metadata without decrypting credentials or making HTTP requests", async () => {
    const start = calls.length;
    const master = config.aiKeyEncryptionKey;
    config.aiKeyEncryptionKey = "";
    try {
      assert.deepEqual(await keys.agentTurnTarget(principals[0], options), {
        provider: "openrouter", model: config.externalModel, external: true,
      });
      for (const extra of [{ classification: "sensitive" }, { classification: "unknown" }, { prefer: "local" },
        { messages: [{ role: "user", content: "password=synthetic-history" }] }]) {
        assert.deepEqual(await keys.agentTurnTarget(principals[0], { ...options, ...extra }), {
          provider: "ollama", model: config.localModel, external: false,
        });
      }
      assert.equal(calls.length, start);
    } finally { config.aiKeyEncryptionKey = master; }
  });

  it("sends no HTTP when the consent guard rejects the chosen target", async () => {
    const start = calls.length;
    const denied = Object.assign(new Error("scoped consent required"), { code: "PERMISSION_DENIED" });
    let target;
    await assert.rejects(keys.completeTurnForUser(principals[0], {
      ...options, beforeDispatch: async chosen => { target = chosen; throw denied; },
    }), error => error === denied);
    assert.deepEqual(target, { provider: "openrouter", model: config.externalModel, external: true });
    assert.equal(calls.length, start);
  });

  it("awaits the chosen-target guard before dispatch and matches preview to actual HTTP", async () => {
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    const start = calls.length;
    const preview = await keys.agentTurnTarget(principals[0], options);
    const pending = keys.completeTurnForUser(principals[0], {
      ...options, beforeDispatch: async chosen => {
        assert.deepEqual(chosen, preview);
        assert.deepEqual(Object.keys(chosen).sort(), ["external", "model", "provider"]);
        entered.resolve();
        await released.promise;
      },
    });
    await entered.promise;
    assert.equal(calls.length, start);
    released.resolve();
    assert.equal((await pending).provider, preview.provider);
    assert.equal(calls.length, start + 1);
    assert.equal(calls.at(-1).body.model, preview.model);
  });

  it("guards the current local target when the profile changes after preview", async () => {
    const { db } = await import("../src/config/db.js");
    const principal = principals[0];
    assert.equal((await keys.agentTurnTarget(principal, options)).external, true);
    db().prepare("UPDATE agent_profile SET model_policy='local' WHERE user_id=?").run(principal.userId);
    const master = config.aiKeyEncryptionKey;
    config.aiKeyEncryptionKey = "";
    let chosen;
    try {
      const result = await keys.completeTurnForUser(principal, {
        ...options, beforeDispatch: async target => { chosen = target; },
      });
      assert.deepEqual(chosen, { provider: "ollama", model: config.localModel, external: false });
      assert.equal(result.provider, "ollama");
      assert.equal(calls.at(-1).authorization, undefined);
    } finally {
      config.aiKeyEncryptionKey = master;
      db().prepare("UPDATE agent_profile SET model_policy='external' WHERE user_id=?").run(principal.userId);
    }
  });

  it("fails closed if target policy or model changes while consent is being checked", async () => {
    const { db } = await import("../src/config/db.js");
    const principal = principals[0];
    const model = config.externalModel;
    const start = calls.length;
    for (const change of [
      () => { config.externalModel = "changed-after-consent"; },
      () => db().prepare("UPDATE agent_profile SET model_policy='local' WHERE user_id=?").run(principal.userId),
    ]) {
      try {
        await assert.rejects(keys.completeTurnForUser(principal, {
          ...options, beforeDispatch: async () => { change(); },
        }), error => error.code === "CONFLICT" && error.details.reason === "provider_target_changed");
      } finally {
        config.externalModel = model;
        db().prepare("UPDATE agent_profile SET model_policy='external' WHERE user_id=?").run(principal.userId);
      }
    }
    assert.equal(calls.length, start);
  });
});
