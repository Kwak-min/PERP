import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";

describe("configured-cloud protected agent flow without a local model", { timeout: 30000 }, () => {
  let wire;
  let server;
  let owner;
  let task;
  const calls = [];
  const extractionCalls = [];
  before(async () => {
    wire = createServer(async (req, res) => {
      let text = "";
      for await (const bytes of req) text += bytes;
      const body = JSON.parse(text);
      if (body.messages[0]?.content.startsWith("Extract at most")) {
        extractionCalls.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"notes":[]}' } }], model: "cloud-only-loopback" }));
        return;
      }
      calls.push(body);
      const observations = body.messages.filter(message => message.role === "tool");
      let message;
      if (!observations.length) message = { content: "업무 참조를 확인하겠습니다.", tool_calls: [{
        id: "cloud-query", type: "function", function: { name: "query_search_tasks", arguments: "{}" },
      }] };
      else if (observations.length === 1) {
        const observed = JSON.parse(observations[0].content);
        const references = observed.result?.items ?? observed.items;
        const reference = references?.[0];
        message = { content: "원문은 앱에서만 확인할 수 있습니다. 변경 초안을 제안하겠습니다.", tool_calls: [{
          id: "cloud-proposal", type: "function", function: { name: "propose_update_task_status",
            arguments: JSON.stringify({ task_id: reference?.id, expected_version: reference?.version, status: "in_progress" }) },
        }] };
      } else message = { content: "보호된 조회 결과와 변경 초안을 앱에서 검토하세요. 아직 실행하지 않았습니다." };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message }], model: "cloud-only-loopback",
        usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
    const listening = once(wire, "listening", { signal: AbortSignal.timeout(5000) });
    wire.listen(0, "127.0.0.1");
    await listening;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${wire.address().port}`;
    process.env.OPENROUTER_API_KEY = "synthetic-cloud-only-key";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:1";
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, ["agent", "tasks", "projects"]);
    const created = await api(server.baseUrl, "/tasks", { ...owner, method: "POST", body: {
      title: "CLOUD_PROTECTED_TITLE", description: "CLOUD_PRIVATE_BODY_MUST_STAY_IN_APP", assignee_id: owner.userId,
    } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    task = created.body;
  });
  after(async () => {
    await server?.close();
    if (wire) await new Promise((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
  });

  it("uses source-approved references for query-to-proposal while withholding protected content", async () => {
    const options = { ...owner, method: "POST", headers: { "Idempotency-Key": "cloud-only-turn" },
      body: { message: "내 업무의 진행 상태를 변경하는 초안을 제안해줘", agent_mode: true, knowledge_mode: "company" } };
    const response = await api(server.baseUrl, "/agent/chat", options);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.provider, "openrouter");
    assert.equal(calls.length, 3);
    assert.ok(!JSON.stringify([...calls, ...extractionCalls]).includes("CLOUD_PRIVATE_BODY_MUST_STAY_IN_APP"));
    assert.ok(!JSON.stringify([...calls, ...extractionCalls]).includes("CLOUD_PROTECTED_TITLE"));
    assert.equal(response.body.actions.length, 1);
    assert.equal(response.body.actions[0].tool, "update.task_status");
    assert.equal(response.body.classification, "confidential");
    assert.equal(response.body.content_classification, "internal");
    assert.ok(JSON.stringify(response.body.protected_results).includes("CLOUD_PRIVATE_BODY_MUST_STAY_IN_APP"));
    const clock = calls[0].messages.flatMap(message => {
      try { return [JSON.parse(message.content)]; } catch { return []; }
    }).find(value => value.business_timezone === "Asia/Seoul");
    assert.ok(clock && Number.isFinite(Date.parse(clock.current_time)) && /^\d{4}-\d{2}-\d{2}$/.test(clock.business_date));
    const { db } = await import("../src/config/db.js");
    const history = JSON.parse(db().prepare("SELECT answer_json FROM ai_message WHERE conversation_id=? AND role='assistant'").get(response.body.conversation_id).answer_json);
    assert.ok(Array.isArray(history.model_transcript), "persist the actual model-visible receipt transcript");
    assert.ok(history.model_transcript.some(message => message.role === "tool"));
    assert.ok(!JSON.stringify(history.model_transcript).includes("CLOUD_PRIVATE_BODY_MUST_STAY_IN_APP"));
    assert.equal(history.classification, "internal");
    assert.equal(db().prepare("SELECT status FROM task WHERE id=?").get(task.id).status, "todo");
    const replay = await api(server.baseUrl, "/agent/chat", options);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(calls.length, 3);
    assert.deepEqual(replay.body, response.body);
    const action = response.body.actions[0];
    const confirmed = await api(server.baseUrl, `/agent/operations/${action.id}/confirm`, { ...owner, method: "POST",
      body: { knowledge_mode: "company", expected_version: action.version } });
    assert.equal(confirmed.status, 200);
    const execute = () => api(server.baseUrl, `/agent/operations/${action.id}/execute`, { ...owner, method: "POST",
      headers: { "Idempotency-Key": "cloud-human-execute" }, body: { knowledge_mode: "company", expected_version: confirmed.body.version } });
    const executed = await execute();
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal(db().prepare("SELECT status FROM task WHERE id=?").get(task.id).status, "in_progress");
    assert.deepEqual((await execute()).body, executed.body);
    assert.equal(db().prepare("SELECT count(*) AS n FROM audit_event WHERE action='task.updated' AND resource_id=?").get(task.id).n, 1);
    assert.equal(calls.length, 3);
  });
});
