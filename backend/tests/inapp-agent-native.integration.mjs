import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

import { startDailyNativePostgres } from "./daily-native-fixture.js";
import { api, createOwnerOrg, startTestServer } from "./http.js";
import { applyAgentPgMigrations } from "../src/config/agent-pg-migrations.js";

const native = await startDailyNativePostgres({ orgUi: true });
let server;
let provider;
let closePgPool;
const calls = [];
const extractionCalls = [];
const cloudOnly = process.argv.includes("--cloud-only");
const companyFact = "회사 운영 절차 NATIVE_COMPANY_FACT_SENTINEL은 매주 금요일 담당자가 검토하고 기록합니다.";
const personalFact = "개인 절차 NATIVE_PERSONAL_FACT_SENTINEL은 나의 비공개 노트에만 기록하며 회사에는 복사하지 않습니다.";
try {
  await applyAgentPgMigrations(native.pool);
  const userId = String(native.identity.users[0].id);
  const companyId = String(native.companyId);
  const codes = ["agent.chat", "menu.agent", "document.read", "document.write", "menu.documents"];
  await native.pool.query("INSERT INTO org.permissions(code,module,description) SELECT code,'agent',code FROM unnest($1::text[]) code ON CONFLICT DO NOTHING", [codes]);
  const roleId = (await native.pool.query("SELECT id FROM org.roles WHERE company_id=$1 AND name='DAILY_TEST_ROLE'", [companyId])).rows[0].id;
  await native.pool.query("INSERT INTO org.role_permissions(role_id,permission_id) SELECT $1,id FROM org.permissions WHERE code=ANY($2::text[]) ON CONFLICT DO NOTHING", [roleId, codes]);
  await native.pool.query("INSERT INTO org.company_modules(company_id,module_key) VALUES($1,'agent'),($1,'documents') ON CONFLICT DO NOTHING", [companyId]);
  const token = randomUUID();
  await native.pool.query("INSERT INTO auth.sessions(user_id,session_token) VALUES($1,$2)", [userId, token]);
  let projectId;
  let original;
  const foreignProject = (await native.pool.query("INSERT INTO project.projects(company_id,name) VALUES($1,'INAPP_FOREIGN_PROJECT') RETURNING id", [native.otherCompanyId])).rows[0];
  await native.pool.query("INSERT INTO project.tasks(project_id,title) VALUES($1,'INAPP_FOREIGN_TASK_SENTINEL')", [foreignProject.id]);

  provider = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "llama3.1:8b" }] }));
      return;
    }
    let raw = "";
    for await (const bytes of req) raw += bytes;
    const body = JSON.parse(raw);
    if (body.messages[0]?.content.startsWith("Extract at most")) {
      extractionCalls.push(body);
      const text = body.messages.at(-1).content;
      const sources = JSON.parse(text.slice(text.indexOf("\n") + 1));
      const source = sources.find(item => item.id.startsWith("attachment:") && (item.text.includes(personalFact) || item.text.includes(companyFact)));
      const quote = source?.text;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ notes: source ? [{
        useful: true, kind: "procedure", title: "운영 절차", source_id: source.id, quote,
      }] : [] }) } }], model: "native-loopback" }));
      return;
    }
    calls.push({ transport: req.headers.authorization ? "cloud" : "local", body });
    const observation = body.messages.findLast(message => message.role === "tool");
    const prompt = body.messages.findLast(message => message.role === "user")?.content ?? "";
    const create = prompt === "NATIVE_PROPOSE" || prompt.startsWith("BROWSER_PROPOSE:");
    const alias = create ? "propose_create_task" : "query_search_tasks";
    const tool = body.tools?.find(item => item.function.name === alias);
    const knowledge = prompt.startsWith("KNOWLEDGE_") || prompt.startsWith("BROWSER_KNOWLEDGE") || prompt === "개인 절차를 찾아줘";
    const message = knowledge ? { content: JSON.stringify(body.messages).includes(personalFact) ? personalFact
      : JSON.stringify(body.messages).includes(companyFact) ? companyFact : "현재 범위에 해당 근거가 없습니다." }
      : observation ? { content: `관찰: ${observation.content}` } : {
      content: null, tool_calls: [{ id: "native-call-1", type: "function", function: {
        name: prompt === "NATIVE_SELF_CONFIRM" ? "execute_operation" : tool?.function.name,
        arguments: JSON.stringify(create ? {
          title: prompt.startsWith("BROWSER_PROPOSE:") ? prompt.slice("BROWSER_PROPOSE:".length) : "INAPP_NATIVE_CREATED",
          ...(tool?.function.parameters.required.includes("project_id") ? { project_id: projectId } : {}),
        } : {}),
      } }],
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }], model: "native-loopback",
      usage: { prompt_tokens: 8, completion_tokens: 4 } }));
  });
  const listening = once(provider, "listening", { signal: AbortSignal.timeout(5000) });
  provider.listen(0, "127.0.0.1");
  await listening;
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${provider.address().port}`;
  process.env.OLLAMA_BASE_URL = cloudOnly ? "http://127.0.0.1:1" : `http://127.0.0.1:${provider.address().port}`;
  process.env.OPENROUTER_API_KEY = "synthetic-native-inapp-key";
  server = await startTestServer();
  ({ closePgPool } = await import("../src/config/pg.js"));
  const actor = { token, orgId: `pg:${companyId}` };
  const request = (route, options = {}) => api(server.baseUrl, `/pg/agent${route}`, { ...actor, ...options });
  const chat = (message, key, extra = {}) => request("/chat", { method: "POST",
    headers: { "Idempotency-Key": key }, body: { message, agent_mode: true, knowledge_mode: "company", ...extra } });

  await verifyKnowledge("company");
  projectId = String((await native.pool.query("INSERT INTO project.projects(company_id,name,lead_id) VALUES($1,'INAPP_NATIVE_PROJECT',$2) RETURNING id", [companyId, userId])).rows[0].id);
  original = (await native.pool.query("INSERT INTO project.tasks(project_id,assignee_id,title,status) VALUES($1,$2,'INAPP_NATIVE_TASK','todo') RETURNING id", [projectId, userId])).rows[0];
  const legacyDocument = (await native.pool.query("INSERT INTO project.documents(project_id,title,content_md,author_id) VALUES($1,'Legacy preserved','LEGACY_DOCUMENT_PRESERVED',$2) RETURNING id", [projectId, userId])).rows[0];
  await applyAgentPgMigrations(native.pool);
  assert.equal((await native.pool.query("SELECT content_md FROM project.documents WHERE id=$1", [legacyDocument.id])).rows[0].content_md, "LEGACY_DOCUMENT_PRESERVED");
  const queried = await chat("NATIVE_QUERY", "native-query");
  assert.equal(queried.status, 200, JSON.stringify(queried.body));
  assert.ok(JSON.stringify(cloudOnly ? queried.body.protected_results : queried.body.answer).includes("INAPP_NATIVE_TASK"), JSON.stringify(queried.body));
  assert.ok(!JSON.stringify(queried.body).includes("INAPP_FOREIGN_TASK_SENTINEL"));
  assert.ok(calls.at(-1).body.messages.some(message => message.role === "tool" && message.content.includes(String(original.id))));
  assert.equal(calls.at(-1).transport, cloudOnly ? "cloud" : "local");
  assert.ok(!calls.filter(call => call.transport === "cloud").some(call => JSON.stringify(call).includes("INAPP_NATIVE_TASK")));
  const callCount = calls.length;
  assert.deepEqual((await chat("NATIVE_QUERY", "native-query")).body, queried.body);
  assert.equal(calls.length, callCount);
  assert.equal((await chat("NATIVE_QUERY", "native-query", { knowledge_mode: "personal" })).status, 409);
  assert.equal((await chat("NATIVE_QUERY", "new-wrong-mode", {
    knowledge_mode: "personal", conversation_id: queried.body.conversation_id,
  })).status, 409);

  const count = async () => (await native.pool.query("SELECT count(*)::int AS n FROM project.tasks WHERE title='INAPP_NATIVE_CREATED'")).rows[0].n;
  const proposed = await chat("NATIVE_PROPOSE", "native-proposal");
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  assert.equal(await count(), 0);
  assert.equal(proposed.body.actions.length, 1);
  const action = proposed.body.actions[0];
  const execute = version => request(`/operations/${action.id}/execute`, { method: "POST",
    headers: { "Idempotency-Key": "native-execute" }, body: { expected_version: version, knowledge_mode: "company" } });
  assert.equal((await execute(action.version)).status, 409);
  const confirmed = await request(`/operations/${action.id}/confirm`, { method: "POST",
    body: { expected_version: action.version, knowledge_mode: "company" } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal((await execute(action.version)).status, 409);
  const executed = await execute(confirmed.body.version);
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.equal(await count(), 1);
  assert.deepEqual((await execute(confirmed.body.version)).body, executed.body);
  assert.equal(await count(), 1);
  assert.equal((await native.pool.query("SELECT count(*)::int AS n FROM org.daily_correction_events WHERE company_id=$1 AND resource_type='tasks' AND resource_id=$2 AND action='created'",
    [companyId, executed.body.result.id])).rows[0].n, 1);
  assert.equal((await request(`/operations/${action.id}?knowledge_mode=personal`)).status, 404);
  async function verifyKnowledge(mode) {
    if (mode === "company") assert.equal((await native.pool.query("SELECT count(*)::int AS n FROM project.projects WHERE company_id=$1", [companyId])).rows[0].n, 0);
    const fact = mode === "company" ? companyFact : personalFact;
    const uploaded = await request("/attachments", { method: "POST", body: {
      knowledge_mode: mode, filename: `${mode}.txt`, mime: "text/plain", content_base64: Buffer.from(fact).toString("base64"),
    } });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const body = { message: `KNOWLEDGE_${mode}_UPLOAD`, agent_mode: true, knowledge_mode: mode, attachment_ids: [uploaded.body.id] };
    const options = { method: "POST", headers: { "Idempotency-Key": `native-knowledge-${mode}` }, body };
    if (mode === "personal") {
      const denied = await request("/chat", options);
      assert.equal(denied.body.error.code, "CLOUD_CONSENT_REQUIRED", JSON.stringify(denied.body));
      const preview = await request("/knowledge/consent-preview", { method: "POST", body: {
        message: body.message, knowledge_mode: mode, attachment_ids: body.attachment_ids,
      } });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      body.cloud_consent = { token: preview.body.token, confirmed: true };
    }
    const completed = await request("/chat", options);
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.ok(completed.body.answer.conclusion.includes(fact));
    const saved = completed.body.knowledge_saves.find(item => item.status === "saved");
    assert.ok(saved, JSON.stringify(completed.body.knowledge_saves));
    const stored = mode === "company"
      ? (await native.pool.query("SELECT content_md,project_id,sensitivity,review_status,ai_generated FROM workspace.document_catalog WHERE id=$1 AND company_id=$2", [saved.id, companyId])).rows[0]
      : (await native.pool.query("SELECT n.content_md FROM notes.notes n JOIN notes.vaults v ON v.id=n.vault_id WHERE n.id=$1 AND v.owner_id=$2", [saved.id, userId])).rows[0];
    assert.ok(stored.content_md.includes(fact));
    if (mode === "company") {
      assert.equal(stored.project_id, null);
      assert.equal(stored.sensitivity, "internal");
      assert.equal(stored.review_status, "unreviewed");
      assert.equal(stored.ai_generated, true);
      assert.equal((await native.pool.query("SELECT count(*)::int AS n FROM project.projects WHERE company_id=$1", [companyId])).rows[0].n, 0);
    }
    const noteView = await request(`/knowledge/notes/${saved.id}?knowledge_mode=${mode}`);
    assert.equal(noteView.status, 200, JSON.stringify(noteView.body));
    assert.ok(noteView.body.content.includes(fact));
    const beforeReplay = calls.length + extractionCalls.length;
    assert.deepEqual((await request("/chat", options)).body, completed.body);
    assert.equal(calls.length + extractionCalls.length, beforeReplay);
    if (mode === "personal") {
      const documentIds = completed.body.answer.evidence.filter(item => item.type === 'document').map(item => item.id.split(':')[1]);
      const originals = (await native.pool.query('SELECT * FROM workspace.document_catalog WHERE id=ANY($1::bigint[])', [documentIds])).rows;
      assert.deepEqual(new Set(originals.map(row => row.storage)), new Set(['workspace', 'project']));
      for (const originalDocument of originals) {
        const table = originalDocument.storage === 'workspace' ? 'workspace.documents' : 'project.documents';
        const changes = [['version', originalDocument.version + 1], ['content_md', 'CHANGED_CANONICAL_CONTENT']];
        if (originalDocument.storage === 'workspace') changes.push(['sensitivity', 'confidential'], ['archived', true]);
        for (const [column, value] of changes) {
          await native.pool.query(`UPDATE ${table} SET ${column}=$1 WHERE id=$2`, [value, originalDocument.id]);
          try {
            const denied = await request('/chat', options);
            assert.equal(denied.status, 409, JSON.stringify(denied.body));
            assert.equal(denied.body.error.code, 'KNOWLEDGE_SCOPE_CHANGED');
            assert.equal(calls.length + extractionCalls.length, beforeReplay);
          } finally { await native.pool.query(`UPDATE ${table} SET ${column}=$1 WHERE id=$2`, [originalDocument[column], originalDocument.id]); }
        }
      }
      assert.deepEqual((await request('/chat', options)).body, completed.body);
      assert.equal((await request(`/attachments/${uploaded.body.id}?knowledge_mode=company`)).status, 404);
      const prior = calls.length;
      const companyAnswer = await chat("개인 절차를 찾아줘", "native-private-excluded");
      assert.equal(companyAnswer.status, 200, JSON.stringify(companyAnswer.body));
      assert.ok(!JSON.stringify(companyAnswer.body).includes("NATIVE_PERSONAL_FACT_SENTINEL"));
      assert.ok(!JSON.stringify(calls.slice(prior)).includes("NATIVE_PERSONAL_FACT_SENTINEL"));
    }
  }
  await verifyKnowledge("personal");
  if (process.argv.includes("--browser")) {
    const { exerciseRealAgentPanel } = await import("../../frontend/scripts/inapp-agent-real-browser.mjs");
    const session = { token, orgId: actor.orgId, name: "Native Agent QA", email: native.identity.users[0].email,
      mustChangePassword: false, organizationStatus: "ready",
      organizations: [{ org_id: actor.orgId, org_name: "INAPP Native", org_type: "perp_db", roles: ["DAILY_TEST_ROLE"] }] };
    const pgBrowser = await exerciseRealAgentPanel({ apiOrigin: server.baseUrl.replace("/api/v1", ""), session, source: "pg", companyFact, personalFact,
      taskCount: async title => (await native.pool.query("SELECT count(*)::int AS n FROM project.tasks WHERE title=$1", [title])).rows[0].n,
      knowledgeExists: async saved => saved.scope === "company"
        ? (await native.pool.query("SELECT 1 FROM workspace.document_catalog WHERE id=$1 AND company_id=$2", [saved.id, companyId])).rowCount === 1
        : (await native.pool.query("SELECT 1 FROM notes.notes n JOIN notes.vaults v ON v.id=n.vault_id WHERE n.id=$1 AND v.owner_id=$2", [saved.id, userId])).rowCount === 1 });
    const legacy = await createOwnerOrg(server.baseUrl, ["agent", "tasks", "projects", "documents", "calendar"]);
    assert.equal((await api(server.baseUrl, "/tasks", { ...legacy, method: "POST",
      body: { title: "INAPP_SQLITE_BROWSER_SOURCE", assignee_id: legacy.userId } })).status, 201);
    const { db } = await import("../src/config/db.js");
    const sqliteBrowser = await exerciseRealAgentPanel({ apiOrigin: server.baseUrl.replace("/api/v1", ""),
      session: { ...session, token: legacy.token, orgId: legacy.orgId,
        organizations: [{ org_id: legacy.orgId, org_name: "INAPP SQLite", org_type: "custom", roles: ["owner"] }] }, source: "legacy",
      companyFact, personalFact,
      taskCount: async title => db().prepare("SELECT count(*) AS n FROM task WHERE title=?").get(title).n,
      knowledgeExists: async saved => Boolean(db().prepare(`SELECT 1 FROM ${saved.scope === "company" ? "document" : "vault_note"} WHERE id=? AND org_id=?`).get(saved.id, legacy.orgId)) });
    console.log(JSON.stringify({ result: "INAPP_AGENT_REAL_BROWSER_PASS", surfaces: [pgBrowser, sqliteBrowser] }));
  }
  await native.pool.query("DELETE FROM org.role_permissions rp USING org.permissions p WHERE rp.role_id=$1 AND rp.permission_id=p.id AND p.code='task.write'", [roleId]);
  assert.equal((await execute(confirmed.body.version)).status, 403);
  assert.equal((await chat("NATIVE_PROPOSE", "native-proposal")).status, 403);
  assert.equal((await chat("NATIVE_SELF_CONFIRM", "native-self-confirm")).status, 403);
  const { db } = await import("../src/config/db.js");
  assert.equal(db().prepare("SELECT count(*) AS n FROM task WHERE title='INAPP_NATIVE_CREATED'").get().n, 0, "PG business writes must not fall back to SQLite");
  assert.equal((await native.pool.query("SELECT knowledge_mode,status FROM public.agent_runs WHERE id=$1", [proposed.body.run_id])).rows[0].knowledge_mode, "company");
  console.log(JSON.stringify({ result: "INAPP_AGENT_NATIVE_PASS", engine: (await native.pool.query("SELECT version()")).rows[0].version,
    loopbackProviderCalls: calls.length, extractionCalls: extractionCalls.length, cloudOnly, queryContinuation: true, proposalBusinessWrites: 0,
    canonicalTaskWrites: await count(), canonicalAuditEvents: 1, replay: true, modeIsolation: true, revocation: true, sqliteBusinessWrites: 0 }));
} finally {
  await server?.close();
  if (provider) await new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
  await closePgPool?.();
  await native.close();
}
