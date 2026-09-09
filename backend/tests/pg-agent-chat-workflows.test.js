import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { api, startTestServer } from "./http.js";
import { installPgKeyFixture } from "./pg-api-key-fixture.js";

describe("PG scoped AI chat workflows", { timeout: 30000 }, () => {
  let server;
  let fixture;
  let actor;
  let pgPool;
  let fixtureQuery;
  let wire;
  const providerCalls = [];
  const memories = new Map();
  const observedSql = [];
  let nextMemoryId = 1;

  before(async () => {
    wire = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      providerCalls.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "PG_CLOUD_CHAT_OK" } }], model: "openai/gpt-4o-mini" }));
    });
    const listening = once(wire, "listening", { signal: AbortSignal.timeout(5000) });
    wire.listen(0, "127.0.0.1"); await listening;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${wire.address().port}`;
    process.env.OPENROUTER_API_KEY = "synthetic-pg-shared-key";
    process.env.ORBITFLOW_AI_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    server = await startTestServer();
    fixture = await installPgKeyFixture();
    actor = fixture.actor("501", "77", ["agent.chat", "document.read", "task.read", "approval.decide", "menu.approvals"]);
    fixture.modules.set("77", ["agent", "documents", "tasks", "approvals"]);
    ({ pgPool } = await import("../src/config/pg.js"));
    fixtureQuery = pgPool.query;
    pgPool.query = async (sql, values = []) => {
      observedSql.push(sql);
      if (sql.includes("FROM project.documents")) return { rows: [{ id: "31", project_id: "7", title: "운영 문서", content_md: "companychatneedle", updated_at: new Date("2026-09-09T00:00:00Z") }] };
      if (sql.includes("FROM notes.notes")) return { rows: [{ id: "99", title: "개인 노트", content_md: "personalpgvaultneedle", updated_at: new Date("2026-09-09T00:00:00Z") }] };
      if (sql.includes("FROM project.tasks") && sql.includes("assignee_id")) return { rows: [{ id: "41", title: "PG_CHAT_TASK", due_on: "2026-09-09", status: "todo" }] };
      if (sql.includes("FROM org.approval_requests")) return { rows: [{ id: "51", requester_id: "700", title: "PG_CHAT_APPROVAL", request_type: "generic", status: "pending", created_at: new Date("2026-09-09T00:00:00Z"), workflow_locked: true }] };
      if (sql.includes("INSERT INTO ai.agent_memory")) {
        const current = [...memories.values()].find(row => row.user_id === values[1] && row.key === values[2]);
        const row = current ?? { id: String(nextMemoryId++), company_id: values[0], user_id: values[1], key: values[2] };
        row.value = values[3]; memories.set(row.id, row); return { rows: [{ id: row.id }] };
      }
      if (sql.includes("DELETE FROM ai.agent_memory")) {
        const row = memories.get(String(values[0]));
        if (!row || row.user_id !== values[1]) return { rows: [] };
        memories.delete(String(values[0])); return { rows: [{ id: String(values[0]) }] };
      }
      if (sql.includes("FROM ai.agent_memory")) return { rows: [...memories.values()].filter(row => row.user_id === values[0]) };
      return fixtureQuery(sql, values);
    };
  });

  after(async () => {
    if (pgPool) pgPool.query = fixtureQuery;
    await fixture?.close();
    await server?.close();
    if (wire) await new Promise((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
  });

  const request = (path, options = {}) => api(server.baseUrl, path, { ...actor, ...options });
  const setAccess = (permissions, modules) => {
    fixture.grants.set(fixture.scopeKey(actor.externalId, "77"), permissions);
    fixture.modules.set("77", modules);
  };
  const fullPermissions = ["agent.chat", "document.read", "task.read", "approval.decide", "menu.approvals"];
  const fullModules = ["agent", "documents", "tasks", "approvals"];

  it("uses personal then shared OpenRouter routing while excluding the personal PG Vault", async () => {
    assert.equal((await request("/pg/agent/api-key", { method: "PUT", body: { api_key: "synthetic-pg-personal-key" } })).status, 200);
    const start = observedSql.length;
    const response = await request("/pg/agent/chat", { method: "POST", body: { message: "companychatneedle personalpgvaultneedle", vault_mode: "off" } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.answer.conclusion, "PG_CLOUD_CHAT_OK");
    assert.equal(providerCalls.at(-1).authorization, "Bearer synthetic-pg-personal-key");
    assert.equal(response.body.scope.vault_mode, "off");
    assert.ok(response.body.answer.evidence.some(item => item.id === "31"));
    assert.ok(!response.body.answer.evidence.some(item => item.id === "99"));
    assert.ok(!observedSql.slice(start).some(sql => sql.includes("notes.notes")));
    assert.ok(!providerCalls.at(-1).body.messages[0].content.includes("personalpgvaultneedle"));

    assert.equal((await request("/pg/agent/api-key", { method: "DELETE" })).status, 200);
    const shared = await request("/pg/agent/chat", { method: "POST", body: { message: "companychatneedle", vault_mode: "off" } });
    assert.equal(shared.status, 200);
    assert.equal(providerCalls.at(-1).authorization, "Bearer synthetic-pg-shared-key");
  });

  it("never reads or dispatches document/task sources hidden by their existing menu or module contracts", async () => {
    const customBase = ["agent.chat", "menu.agent", "menu.configured"];
    const cases = [
      { label: "missing menus", permissions: [...customBase, "document.read", "task.read"], modules: fullModules },
      { label: "disabled modules", permissions: [...customBase, "document.read", "menu.documents", "task.read", "menu.projects"], modules: ["agent", "approvals"] },
    ];
    try {
      for (const scenario of cases) {
        setAccess(scenario.permissions, scenario.modules);
        let start = observedSql.length;
        const providerStart = providerCalls.length;
        const response = await request("/pg/agent/chat", { method: "POST", body: { message: "companychatneedle", vault_mode: "off" } });
        assert.equal(response.status, 200, `${scenario.label}: ${JSON.stringify(response.body)}`);
        assert.deepEqual(response.body.answer.evidence, [], scenario.label);
        assert.equal(providerCalls.length, providerStart + 1, scenario.label);
        assert.ok(!observedSql.slice(start).some(sql => sql.includes("FROM project.documents")), scenario.label);
        assert.ok(!providerCalls.at(-1).body.messages[0].content.includes("companychatneedle"), scenario.label);

        start = observedSql.length;
        const brief = await request("/pg/agent/brief");
        assert.equal(brief.status, 200, `${scenario.label}: ${JSON.stringify(brief.body)}`);
        assert.ok(!brief.body.items.some(item => item.title === "PG_CHAT_TASK"), scenario.label);
        assert.ok(!observedSql.slice(start).some(sql => sql.includes("FROM project.tasks")), scenario.label);
      }
    } finally { setAccess(fullPermissions, fullModules); }
  });

  it("returns PG briefing and pending approvals scoped to the selected company", async () => {
    const brief = await request("/pg/agent/brief");
    assert.equal(brief.status, 200, JSON.stringify(brief.body));
    assert.ok(brief.body.items.some(item => item.title === "PG_CHAT_TASK"));
    const pending = await request("/pg/agent/pending-approvals");
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.deepEqual(pending.body.items.map(item => item.id), ["51"]);
  });

  it("creates, lists and deletes only the PG user's memory", async () => {
    const created = await request("/pg/agent/memory", { method: "POST", body: { key: "말투", value: "간결하게" } });
    assert.equal(created.status, 201);
    const listed = await request("/pg/agent/memory");
    assert.ok(listed.body.items.some(item => item.id === created.body.id && item.value === "간결하게"));
    const deleted = await request(`/pg/agent/memory/${created.body.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal((await request("/pg/agent/memory")).body.items.length, 0);
  });
});
