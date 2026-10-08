import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";

describe("in-app agent HTTP turn boundary", { timeout: 30000 }, () => {
  let server;
  let owner;
  let provider;
  let financeTarget;
  const calls = [];
  const extractionCalls = [];
  before(async () => {
    provider = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "llama3.1:8b" }] }));
        return;
      }
      let text = "";
      for await (const bytes of req) text += bytes;
      const body = JSON.parse(text);
      if (body.messages[0]?.content.startsWith("Extract at most")) {
        extractionCalls.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"notes":[]}' } }], model: "loopback-agent" }));
        return;
      }
      body.transport = req.headers.authorization ? "cloud" : "local";
      calls.push(body);
      const observed = body.messages.findLast(message => message.role === "tool");
      const prompt = body.messages.findLast(message => message.role === "user")?.content ?? "";
      if (prompt === "HOLD") {
        res.once("close", () => provider.emit("held-closed"));
        provider.emit("held", res);
        return;
      }
      if (prompt === "FAIL_PROVIDER") {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "password=SYNTHETIC_PROVIDER_SECRET" }));
        return;
      }
      const proposal = prompt.includes("PROPOSE");
      const finance = prompt === "FINANCE";
      const tool = body.tools?.find(item => item.function.name === (finance ? "propose_confirm_transaction" : proposal ? "propose_create_task" : "query_search_tasks"));
      const message = observed ? { content: `관찰 결과: ${observed.content}` }
        : tool ? { content: null, tool_calls: [{
          id: "http-query-1", type: "function", function: {
            name: prompt === "SELF_CONFIRM" ? "execute_operation" : tool.function.name,
            arguments: finance ? JSON.stringify(financeTarget) : proposal ? JSON.stringify({ title: "INAPP_PROPOSED_TASK" }) : "{}",
          },
        }] } : { content: "BASELINE_TEXT_ONLY" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message }], model: "loopback-agent",
        usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
    const listening = once(provider, "listening", { signal: AbortSignal.timeout(5000) });
    provider.listen(0, "127.0.0.1");
    await listening;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${provider.address().port}`;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${provider.address().port}`;
    process.env.OPENROUTER_API_KEY = "synthetic-inapp-http-key";
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, ["agent", "tasks", "projects", "documents", "calendar", "finance", "approvals"]);
  });
  after(async () => {
    await server?.close();
    if (provider) await new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
  });

  it("requires a stable turn key before agent bookkeeping or provider dispatch", async () => {
    const { db } = await import("../src/config/db.js");
    const beforeCount = db().prepare("SELECT count(*) AS n FROM ai_conversation").get().n;
    const response = await api(server.baseUrl, "/agent/chat", {
      ...owner, method: "POST", body: { message: "업무를 찾아줘", agent_mode: true },
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, "VALIDATION_ERROR");
    assert.equal(db().prepare("SELECT count(*) AS n FROM ai_conversation").get().n, beforeCount);
  });

  it("queries real tasks then continues through the loopback provider and replays without model calls", async () => {
    const task = await api(server.baseUrl, "/tasks", {
      ...owner, method: "POST", body: { title: "INAPP_REAL_TASK", assignee_id: owner.userId },
    });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    const options = {
      ...owner, method: "POST", headers: { "Idempotency-Key": "http-query-turn" },
      body: { message: "내 업무를 조회해줘", agent_mode: true, knowledge_mode: "company" },
    };
    const initialCalls = calls.length;
    const response = await api(server.baseUrl, "/agent/chat", options);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(typeof response.body.run_id, "string");
    assert.ok(response.body.answer.conclusion.includes("INAPP_REAL_TASK"), JSON.stringify(response.body));
    assert.ok(response.body.answer.evidence.every(item => typeof item.type === "string"), "chat evidence must retain the typed panel's existing type field");
    assert.equal(calls.length, initialCalls + 2);
    assert.equal(calls.at(-1).transport, "local");
    assert.ok(!calls.filter(call => call.transport === "cloud").some(call => JSON.stringify(call).includes("INAPP_REAL_TASK")));
    assert.ok(calls.at(-1).messages.some(message => message.role === "tool" && message.tool_call_id === "http-query-1"
      && message.content.includes(task.body.id)));
    const replay = await api(server.baseUrl, "/agent/chat", options);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, response.body);
    assert.equal(calls.length, initialCalls + 2);
    const conflict = await api(server.baseUrl, "/agent/chat", {
      ...options, body: { ...options.body, message: "다른 요청" },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");
  });

  it("proposes without business writes, then human confirmation executes and replays one canonical write", async () => {
    const { db } = await import("../src/config/db.js");
    const count = () => db().prepare("SELECT count(*) AS n FROM task WHERE title='INAPP_PROPOSED_TASK'").get().n;
    const options = { ...owner, method: "POST", headers: { "Idempotency-Key": "proposal-turn" },
      body: { message: "PROPOSE", agent_mode: true, knowledge_mode: "company" } };
    const response = await api(server.baseUrl, "/agent/chat", options);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(count(), 0);
    assert.equal(response.body.actions.length, 1);
    const action = response.body.actions[0];
    assert.equal(action.status, "preview");
    const beforeReplay = calls.length;
    const replay = await api(server.baseUrl, "/agent/chat", options);
    assert.deepEqual(replay.body, response.body);
    assert.equal(calls.length, beforeReplay);
    assert.equal(db().prepare("SELECT count(*) AS n FROM agent_operations WHERE run_id=?").get(response.body.run_id).n, 1);
    const request = (suffix, body, key = null) => api(server.baseUrl, `/agent/operations/${action.id}${suffix}${body ? "" : "?knowledge_mode=company"}`, {
      ...owner, method: body ? "POST" : "GET", body: body ? { knowledge_mode: "company", ...body } : undefined,
      headers: key ? { "Idempotency-Key": key } : {},
    });
    assert.equal((await request("/execute", { expected_version: action.version }, "execute-once")).status, 409);
    const current = await request("");
    assert.equal(current.status, 200);
    const confirmed = await request("/confirm", { expected_version: current.body.version });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(count(), 0);
    assert.equal((await request("/execute", { expected_version: action.version }, "execute-once")).status, 409);
    const executed = await request("/execute", { expected_version: confirmed.body.version }, "execute-once");
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal(executed.body.status, "executed");
    assert.equal(count(), 1);
    const repeated = await request("/execute", { expected_version: confirmed.body.version }, "execute-once");
    assert.deepEqual(repeated.body, executed.body);
    assert.equal(count(), 1);
    assert.equal(db().prepare("SELECT count(*) AS n FROM audit_event WHERE resource_id=? AND action='task.created'")
      .get(executed.body.result.id).n, 1);
    const company = await api(server.baseUrl, `/agent/operations/${action.id}?knowledge_mode=personal`, owner);
    assert.equal(company.status, 404, JSON.stringify(company.body));
    const foreign = await createOwnerOrg(server.baseUrl, ["agent", "tasks"]);
    assert.equal((await api(server.baseUrl, `/agent/operations/${action.id}`, foreign)).status, 404);
    const modules = db().prepare("SELECT modules FROM organization WHERE id=?").get(owner.orgId).modules;
    try {
      db().prepare("UPDATE organization SET modules=? WHERE id=?").run(modules.split(",").filter(value => value !== "tasks").join(","), owner.orgId);
      assert.equal((await request("/execute", { expected_version: confirmed.body.version }, "execute-once")).status, 403);
      assert.equal((await api(server.baseUrl, "/agent/chat", options)).status, 403);
    } finally { db().prepare("UPDATE organization SET modules=? WHERE id=?").run(modules, owner.orgId); }
  });

  it("never accepts model self-confirmation and preserves failed runs without regenerating them", async () => {
    const { db } = await import("../src/config/db.js");
    for (const message of ["SELF_CONFIRM", "FAIL_PROVIDER"]) {
      const options = { ...owner, method: "POST", headers: { "Idempotency-Key": message },
        body: { message, agent_mode: true, knowledge_mode: "company" } };
      const response = await api(server.baseUrl, "/agent/chat", options);
      assert.equal(response.status, message === "SELF_CONFIRM" ? 403 : 503, JSON.stringify(response.body));
      assert.ok(!JSON.stringify(response.body).includes("SYNTHETIC_PROVIDER_SECRET"));
      const prior = calls.length;
      const replay = await api(server.baseUrl, "/agent/chat", options);
      assert.equal(replay.status, 409);
      assert.equal(replay.body.error.code, "AGENT_RUN_INCOMPLETE");
      assert.equal(calls.length, prior);
      assert.equal(db().prepare("SELECT status FROM agent_runs WHERE idempotency_key=?").get(message).status, "failed");
    }
  });

  it("reports a genuinely pending turn explicitly and completes the original request once", async () => {
    const held = once(provider, "held", { signal: AbortSignal.timeout(5000) });
    const options = { ...owner, method: "POST", headers: { "Idempotency-Key": "held-turn" },
      body: { message: "HOLD", agent_mode: true, knowledge_mode: "company" } };
    const initial = api(server.baseUrl, "/agent/chat", options);
    const [pendingResponse] = await held;
    try {
      const concurrent = await api(server.baseUrl, "/agent/chat", options);
      assert.equal(concurrent.status, 409);
      assert.equal(concurrent.body.error.code, "AGENT_RUN_IN_PROGRESS");
    } finally {
      pendingResponse.writeHead(200, { "Content-Type": "application/json" });
      pendingResponse.end(JSON.stringify({ choices: [{ message: { content: "HELD_FINISHED" } }], model: "loopback-agent" }));
    }
    const result = await initial;
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.answer.conclusion, "HELD_FINISHED");
  });

  it("cancels the real upstream request on client disconnect and leaves an explicit failed turn", async () => {
    const held = once(provider, "held", { signal: AbortSignal.timeout(5000) });
    const controller = new AbortController();
    const body = { message: "HOLD", agent_mode: true, knowledge_mode: "company" };
    const pending = fetch(`${server.baseUrl}/agent/chat`, { method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}`,
        "X-Org-Id": owner.orgId, "Idempotency-Key": "cancelled-turn" }, body: JSON.stringify(body) });
    const rejected = assert.rejects(pending, error => error.name === "AbortError");
    await held;
    const closed = once(provider, "held-closed", { signal: AbortSignal.timeout(5000) });
    controller.abort();
    await rejected;
    await closed;
    const replay = await api(server.baseUrl, "/agent/chat", { ...owner, method: "POST",
      headers: { "Idempotency-Key": "cancelled-turn" }, body });
    assert.equal(replay.body.error.code, "AGENT_RUN_INCOMPLETE", JSON.stringify(replay.body));
  });

  it("requires linked finance approval, reauthentication and an open period before a real transaction write", async () => {
    const { db } = await import("../src/config/db.js");
    const account = await api(server.baseUrl, "/finance/accounts", { ...owner, method: "POST",
      body: { code: "INAPP_HTTP", name: "Agent HTTP 검증", kind: "expense" } });
    assert.equal(account.status, 201);
    const tx = await api(server.baseUrl, "/finance/transactions", { ...owner, method: "POST",
      body: { kind: "expense", amount_minor: 12345, occurred_on: "2026-09-10", account_id: account.body.id, memo: "HTTP 승인 검증" } });
    assert.equal(tx.status, 201);
    financeTarget = { transaction_id: tx.body.id, expected_version: tx.body.version };
    const approvalsBefore = db().prepare("SELECT count(*) AS n FROM approval").get().n;
    const proposed = await api(server.baseUrl, "/agent/chat", { ...owner, method: "POST",
      headers: { "Idempotency-Key": "finance-turn" }, body: { message: "FINANCE", agent_mode: true, knowledge_mode: "company" } });
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    assert.equal(db().prepare("SELECT count(*) AS n FROM approval").get().n, approvalsBefore);
    const action = proposed.body.actions[0];
    assert.equal(action.requires_approval, true);
    assert.equal(action.requires_reauth, true);
    const confirm = approver_id => api(server.baseUrl, `/agent/operations/${action.id}/confirm`, { ...owner, method: "POST",
      body: { knowledge_mode: "company", expected_version: action.version, approver_id } });
    assert.equal((await confirm("foreign-approver")).status, 400);
    const confirmed = await confirm(owner.userId);
    assert.equal(confirmed.status, 200);
    const execute = password => api(server.baseUrl, `/agent/operations/${action.id}/execute`, { ...owner, method: "POST",
      headers: { "Idempotency-Key": "finance-execute" },
      body: { knowledge_mode: "company", expected_version: confirmed.body.version, ...(password ? { reauth_password: password } : {}) } });
    assert.equal((await execute()).body.error.code, "REAUTH_REQUIRED");
    assert.equal((await execute("password-1234")).body.error.code, "APPROVAL_REQUIRED");
    assert.equal((await api(server.baseUrl, `/approvals/requests/${confirmed.body.approval_id}/actions`, { ...owner, method: "POST",
      body: { decision: "approve", comment: "" } })).status, 200);
    assert.equal((await api(server.baseUrl, "/finance/close", { ...owner, method: "POST", body: { period: "2026-09" } })).status, 200);
    assert.equal((await execute("password-1234")).body.error.code, "PERIOD_LOCKED");
    db().prepare("UPDATE fiscal_period_lock SET status='open' WHERE org_id=? AND period='2026-09'").run(owner.orgId);
    const executed = await execute("password-1234");
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal(executed.body.result.status, "confirmed");
    assert.deepEqual((await execute("password-1234")).body, executed.body);
    assert.equal(db().prepare("SELECT count(*) AS n FROM audit_event WHERE action='transaction.confirmed' AND resource_id=?").get(tx.body.id).n, 1);
    assert.ok(!JSON.stringify([...calls, ...extractionCalls]).includes("password-1234"));
    assert.ok(!JSON.stringify(db().prepare("SELECT content,answer_json FROM ai_message").all()).includes("password-1234"));
  });
});
