import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";

describe("agent knowledge HTTP integration", { timeout: 30000 }, () => {
  let server;
  let wire;
  let owner;
  const calls = [];
  const procedure = "정산 검토는 매주 금요일 오후에 담당자가 증빙을 확인한 뒤 진행합니다.";
  const privateProcedure = "개인 절차 PERSONAL_KB_PRIVATE_SENTINEL은 개인 작업 노트에만 기록하고 회사 자료로 복사하지 않습니다.";
  const operational = "먼저 프로젝트 목록에서 '합성 프로젝트 legacy_eeb66fde'를 조회하세요. 찾은 실제 프로젝트 ID를 사용해 'PROBE_TASK_legacy_eeb66fde' 업무를 나에게 배정하는 생성 초안만 제안하세요. 직접 실행하지 마세요.";
  before(async () => {
    wire = createServer(async (req, res) => {
      let raw = "";
      for await (const bytes of req) raw += bytes;
      const body = JSON.parse(raw);
      calls.push(body);
      const extracting = body.response_format?.json_schema?.name === "knowledge_notes";
      const prompt = body.messages.findLast(message => message.role === "user")?.content;
      const observations = body.messages.filter(message => message.role === "tool");
      if (!extracting && prompt === operational && observations.length < 2) {
        const input = observations.length ? { title: "PROBE_TASK_legacy_eeb66fde",
          project_id: JSON.parse(observations[0].content).items[0].id } : { query: "합성 프로젝트 legacy_eeb66fde" };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: `operational-${observations.length}`, type: "function", function: {
            name: observations.length ? "propose_create_task" : "query_search_projects", arguments: JSON.stringify(input),
          },
        }] } }], model: "knowledge-loopback" }));
        return;
      }
      let content;
      if (extracting) {
        const text = body.messages.at(-1).content;
        const sources = JSON.parse(text.slice(text.indexOf("\n") + 1));
        const source = sources.find(item => item.text.includes(privateProcedure)) ?? sources.find(item => item.text.includes(procedure));
        const quote = source?.text.includes(privateProcedure) ? privateProcedure : procedure;
        const user = sources.find(item => item.id === "user:current");
        content = JSON.stringify({ notes: user?.text === operational
          ? [{ useful: true, kind: "procedure", title: "업무 배정 절차", source_id: user.id, quote: user.text }]
          : source ? [{ useful: true, kind: "procedure", title: "주간 정산 검토", source_id: source.id, quote }] : [] });
      } else content = JSON.stringify(body.messages).includes(privateProcedure) ? privateProcedure
        : JSON.stringify(body.messages).includes(procedure) ? procedure : "관련 근거가 없습니다.";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }], model: "knowledge-loopback",
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
    });
    const listening = once(wire, "listening", { signal: AbortSignal.timeout(5000) });
    wire.listen(0, "127.0.0.1");
    await listening;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${wire.address().port}`;
    process.env.OPENROUTER_API_KEY = "synthetic-knowledge-http-key";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:1";
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, ["agent", "documents", "projects", "tasks"]);
  });
  after(async () => {
    await server?.close();
    if (wire) await new Promise((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
  });
  const request = (route, options = {}) => api(server.baseUrl, `/agent${route}`, { ...owner, ...options });
  const upload = mode => request("/attachments", { method: "POST", body: {
    knowledge_mode: mode, filename: "procedure.txt", mime: "text/plain",
    content_base64: Buffer.from(mode === "personal" ? privateProcedure : procedure).toString("base64"),
  } });

  it("does not autosave the real-provider operational quote after a real query and proposal", async () => {
    const project = await api(server.baseUrl, "/projects", { ...owner, method: "POST",
      body: { name: "합성 프로젝트 legacy_eeb66fde" } });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const { db } = await import("../src/config/db.js");
    const counts = () => ["document", "vault_note", "task"].map(table =>
      db().prepare(`SELECT count(*) AS n FROM ${table} WHERE org_id=?`).get(owner.orgId).n);
    const before = counts();
    const options = { method: "POST", headers: { "Idempotency-Key": "operational-knowledge-regression" },
      body: { message: operational, agent_mode: true, knowledge_mode: "company" } };
    const response = await request("/chat", options);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.tool_activity.map(item => item.stage), ["query", "propose"]);
    assert.equal(response.body.actions[0].status, "preview");
    assert.ok(response.body.knowledge_saves.some(item => item.code === "NO_USEFUL_KNOWLEDGE"));
    assert.ok(!response.body.knowledge_saves.some(item => item.status === "saved"));
    assert.deepEqual(counts(), before);
    const callCount = calls.length;
    const replay = await request("/chat", options);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, response.body);
    assert.equal(calls.length, callCount);
    assert.deepEqual(counts(), before);
  });

  it("uploads company evidence and saves a canonical ordinary document exactly once", async () => {
    const attachment = await upload("company");
    assert.equal(attachment.status, 201, JSON.stringify(attachment.body));
    const body = { message: "첨부한 운영 절차를 요약해줘", agent_mode: true, knowledge_mode: "company",
      attachment_ids: [attachment.body.id] };
    const options = { method: "POST", headers: { "Idempotency-Key": "company-knowledge" }, body };
    const response = await request("/chat", options);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.answer.conclusion.includes(procedure));
    const saved = response.body.knowledge_saves.find(item => item.status === "saved");
    assert.equal(saved.scope, "company");
    const { db } = await import("../src/config/db.js");
    const document = db().prepare("SELECT * FROM document WHERE id=?").get(saved.id);
    assert.ok(document.content.includes(procedure));
    assert.equal(document.visibility, "org");
    assert.equal(document.ai_generated, 1);
    const usage = db().prepare("SELECT prompt_tokens,completion_tokens,cost_micro FROM ai_request_log WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(owner.userId);
    assert.equal(usage.prompt_tokens, 4, "chat and note extraction must both be accounted");
    assert.equal(usage.completion_tokens, 2);
    assert.equal(usage.cost_micro, 12);
    const count = calls.length;
    const replay = await request("/chat", options);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, response.body);
    assert.equal(calls.length, count);
    assert.equal(db().prepare("SELECT count(*) AS n FROM agent_knowledge_receipt WHERE run_id=?").get(response.body.run_id).n, 1);
  });

  it("requires exact personal consent before admitting a run and rejects mode-forged attachments", async () => {
    const attachment = await upload("personal");
    assert.equal(attachment.status, 201, JSON.stringify(attachment.body));
    const body = { message: "첨부한 개인 절차를 요약해줘", agent_mode: true, knowledge_mode: "personal",
      attachment_ids: [attachment.body.id] };
    const options = { method: "POST", headers: { "Idempotency-Key": "personal-knowledge" }, body };
    const before = calls.length;
    const denied = await request("/chat", options);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, "CLOUD_CONSENT_REQUIRED");
    assert.equal(calls.length, before);
    const { db } = await import("../src/config/db.js");
    assert.equal(db().prepare("SELECT count(*) AS n FROM agent_runs WHERE idempotency_key='personal-knowledge'").get().n, 0);
    const preview = await request("/knowledge/consent-preview", { method: "POST", body: {
      message: body.message, knowledge_mode: body.knowledge_mode, attachment_ids: body.attachment_ids,
    } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.provider, "openrouter");
    const approved = await request("/chat", { ...options, body: { ...body, cloud_consent: { token: preview.body.token, confirmed: true } } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.ok(approved.body.knowledge_saves.some(item => item.status === "saved" && item.scope === "personal"));
    assert.ok(approved.body.answer.conclusion.includes(privateProcedure));
    const callCount = calls.length;
    const replay = await request("/chat", options);
    assert.deepEqual(replay.body, approved.body);
    assert.equal(calls.length, callCount);
    const modeForgedHistory = await request("/chat", { method: "POST", headers: { "Idempotency-Key": "forged-history" },
      body: { message: "개인 절차를 찾아줘", agent_mode: true, knowledge_mode: "company", conversation_id: approved.body.conversation_id } });
    assert.equal(modeForgedHistory.status, 409);
    const companyStart = calls.length;
    const company = await request("/chat", { method: "POST", headers: { "Idempotency-Key": "separate-company-history" },
      body: { message: "개인 절차를 찾아줘", agent_mode: true, knowledge_mode: "company" } });
    assert.equal(company.status, 200, JSON.stringify(company.body));
    assert.ok(!JSON.stringify(company.body).includes("PERSONAL_KB_PRIVATE_SENTINEL"));
    assert.ok(!JSON.stringify(calls.slice(companyStart)).includes("PERSONAL_KB_PRIVATE_SENTINEL"));
    assert.equal(db().prepare("SELECT count(*) AS n FROM document WHERE content LIKE '%PERSONAL_KB_PRIVATE_SENTINEL%'").get().n, 0);
    const forged = await request("/chat", { method: "POST", headers: { "Idempotency-Key": "forged-attachment" },
      body: { ...body, knowledge_mode: "company" } });
    assert.equal(forged.status, 404);
    assert.equal((await request(`/attachments/${attachment.body.id}?knowledge_mode=company`)).status, 404);
    assert.equal((await request("/knowledge/consent-preview", { method: "POST", body: {
      message: "질문", knowledge_mode: "personal", provider: "openrouter", model: "forged",
    } })).status, 400);
  });

  it("uses approved canonical personal KB on the real cloud adapter but never sends credential input", async () => {
    const body = { message: "개인 절차를 찾아줘", agent_mode: true, knowledge_mode: "personal" };
    const options = { method: "POST", headers: { "Idempotency-Key": "personal-kb-retrieval" }, body };
    const before = calls.length;
    assert.equal((await request("/chat", options)).body.error.code, "CLOUD_CONSENT_REQUIRED");
    assert.equal(calls.length, before);
    const preview = await request("/knowledge/consent-preview", { method: "POST",
      body: { message: body.message, knowledge_mode: body.knowledge_mode } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.ok(preview.body.sources.some(source => source.kind === "note"));
    const answer = await request("/chat", { ...options, body: { ...body, cloud_consent: { token: preview.body.token, confirmed: true } } });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.provider, "openrouter");
    assert.ok(answer.body.answer.conclusion.includes(privateProcedure));
    const afterApproved = calls.length;
    const secret = await request("/chat", { method: "POST", headers: { "Idempotency-Key": "never-egress-secret" },
      body: { message: "password=SYNTHETIC_NEVER_EGRESS_SECRET", agent_mode: true, knowledge_mode: "company" } });
    assert.equal(secret.status, 503, JSON.stringify(secret.body));
    assert.equal(calls.length, afterApproved);
    assert.ok(!JSON.stringify(calls).includes("SYNTHETIC_NEVER_EGRESS_SECRET"));
  });
});
