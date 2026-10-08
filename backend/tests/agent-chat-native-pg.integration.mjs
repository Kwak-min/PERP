import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { startDailyNativePostgres } from "./daily-native-fixture.js";
import { api, startTestServer } from "./http.js";
import { localDate } from "../src/services/analytics-contract.service.js";

const native = await startDailyNativePostgres();
let server;
let closePgPool;
try {
  const ownerId = native.identity.users[0].id;
  const foreignId = native.identity.users[2].id;
  const codes = ["agent.chat", "menu.agent", "document.read", "menu.documents", "task.read", "approval.decide", "approval.request", "menu.approvals"];
  await native.pool.query("INSERT INTO org.permissions(code,module,description) SELECT code,'agent',code FROM unnest($1::text[]) code ON CONFLICT(code) DO NOTHING", [codes]);
  const roleId = (await native.pool.query("SELECT id FROM org.roles WHERE company_id=$1 AND name='DAILY_TEST_ROLE'", [native.companyId])).rows[0].id;
  await native.pool.query("INSERT INTO org.role_permissions(role_id,permission_id) SELECT $1,id FROM org.permissions WHERE code=ANY($2::text[]) ON CONFLICT DO NOTHING", [roleId, codes]);
  await native.pool.query("INSERT INTO org.company_modules(company_id,module_key) SELECT $1,key FROM unnest($2::text[]) key ON CONFLICT DO NOTHING", [native.companyId, ["agent", "documents", "approvals"]]);
  const token = randomUUID();
  await native.pool.query("INSERT INTO auth.sessions(user_id,session_token) VALUES($1,$2)", [ownerId, token]);
  const projectId = (await native.pool.query("INSERT INTO project.projects(company_id,name) VALUES($1,'CHAT_NATIVE_PROJECT') RETURNING id", [native.companyId])).rows[0].id;
  await native.pool.query("INSERT INTO project.documents(project_id,title,content_md,author_id) VALUES($1,'CHAT_NATIVE_DOCUMENT','native-company-chat-needle',$2)", [projectId, ownerId]);
  await native.pool.query("INSERT INTO project.tasks(project_id,assignee_id,title,due_on) VALUES($1,$2,'CHAT_NATIVE_TASK',$3)", [projectId, ownerId, localDate(new Date(), "Asia/Seoul")]);
  const approvalId = (await native.pool.query("INSERT INTO org.approval_requests(company_id,request_type,requester_id,title,status,workflow_locked) VALUES($1,'generic',$2,'CHAT_NATIVE_APPROVAL','pending',true) RETURNING id", [native.companyId, ownerId])).rows[0].id;
  const vaultId = (await native.pool.query("INSERT INTO notes.vaults(owner_id,name) VALUES($1,'Chat Native Vault') RETURNING id", [ownerId])).rows[0].id;
  await native.pool.query("INSERT INTO notes.notes(vault_id,title,content_md) VALUES($1,'CHAT_NATIVE_PRIVATE','native-private-vault-needle')", [vaultId]);

  const foreignProjectId = (await native.pool.query("INSERT INTO project.projects(company_id,name) VALUES($1,'CHAT_FOREIGN_PROJECT') RETURNING id", [native.otherCompanyId])).rows[0].id;
  await native.pool.query("INSERT INTO project.documents(project_id,title,content_md,author_id) VALUES($1,'CHAT_FOREIGN_DOCUMENT','foreign-company-chat-needle',$2)", [foreignProjectId, foreignId]);
  await native.pool.query("INSERT INTO project.tasks(project_id,assignee_id,title,due_on) VALUES($1,$2,'CHAT_FOREIGN_TASK',$3)", [foreignProjectId, ownerId, localDate(new Date(), "Asia/Seoul")]);
  await native.pool.query("INSERT INTO org.approval_requests(company_id,request_type,requester_id,title,status,workflow_locked) VALUES($1,'generic',$2,'CHAT_FOREIGN_APPROVAL','pending',true)", [native.otherCompanyId, foreignId]);
  const foreignVaultId = (await native.pool.query("INSERT INTO notes.vaults(owner_id,name) VALUES($1,'Chat Foreign Vault') RETURNING id", [foreignId])).rows[0].id;
  await native.pool.query("INSERT INTO notes.notes(vault_id,title,content_md) VALUES($1,'CHAT_FOREIGN_PRIVATE','foreign-private-vault-needle')", [foreignVaultId]);
  await native.pool.query("INSERT INTO ai.agent_memory(company_id,user_id,key,value) VALUES($1,$2,'foreign-style','foreign-memory-sentinel')", [native.otherCompanyId, foreignId]);
  const globalMemoryId = (await native.pool.query("INSERT INTO ai.agent_memory(company_id,user_id,key,value) VALUES($1,$2,'user-global-style','user-global-memory-sentinel') RETURNING id", [native.otherCompanyId, ownerId])).rows[0].id;

  server = await startTestServer();
  ({ closePgPool } = await import("../src/config/pg.js"));
  const actor = { token, orgId: `pg:${native.companyId}` };
  const request = (path, options = {}) => api(server.baseUrl, path, { ...actor, ...options });

  const chat = await request("/pg/agent/chat", { method: "POST", body: {
    message: "native-company-chat-needle native-private-vault-needle foreign-company-chat-needle foreign-private-vault-needle",
    vault_mode: "off",
  } });
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  assert.equal(chat.body.scope.vault_mode, "off");
  assert.equal(chat.body.scope.personal_vault_used, false);
  assert.equal(chat.body.answer.related_data.vault_notes_used, 0);
  assert.ok(chat.body.answer.evidence.some(item => item.type === "document"));
  assert.ok(!chat.body.answer.evidence.some(item => item.type === "vault_note"));
  assert.ok(!JSON.stringify(chat.body.answer.evidence).includes("CHAT_FOREIGN_DOCUMENT"));

  async function setRolePermission(code, enabled) {
    if (enabled) await native.pool.query(`INSERT INTO org.role_permissions(role_id,permission_id)
      SELECT $1,id FROM org.permissions WHERE code=$2 ON CONFLICT DO NOTHING`, [roleId, code]);
    else await native.pool.query(`DELETE FROM org.role_permissions rp USING org.permissions p
      WHERE rp.role_id=$1 AND rp.permission_id=p.id AND p.code=$2`, [roleId, code]);
  }
  async function assertReadGrant(code) {
    const count = await native.pool.query(`SELECT count(*)::int AS n FROM org.role_permissions rp JOIN org.permissions p ON p.id=rp.permission_id
      WHERE rp.role_id=$1 AND p.code=$2`, [roleId, code]);
    assert.equal(count.rows[0].n, 1, `${code} must remain granted during menu/module denial`);
  }
  for (const denied of ["menu", "module"]) {
    if (denied === "menu") await setRolePermission("menu.documents", false);
    else await native.pool.query("DELETE FROM org.company_modules WHERE company_id=$1 AND module_key='documents'", [native.companyId]);
    await assertReadGrant("document.read");
    const hidden = await request("/pg/agent/chat", { method: "POST", body: { message: "native-company-chat-needle", vault_mode: "off" } });
    assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
    assert.deepEqual(hidden.body.answer.evidence, [], `document ${denied} denial`);
    if (denied === "menu") await setRolePermission("menu.documents", true);
    else await native.pool.query("INSERT INTO org.company_modules(company_id,module_key) VALUES($1,'documents')", [native.companyId]);
  }

  const brief = await request("/pg/agent/brief");
  assert.equal(brief.status, 200, JSON.stringify(brief.body));
  assert.ok(brief.body.items.some(item => item.title === "CHAT_NATIVE_TASK" && item.kind === "today_task"), JSON.stringify(brief.body));
  assert.ok(!brief.body.items.some(item => item.title === "CHAT_FOREIGN_TASK"));
  for (const denied of ["menu", "module"]) {
    if (denied === "menu") await setRolePermission("menu.projects", false);
    else await native.pool.query("DELETE FROM org.company_modules WHERE company_id=$1 AND module_key='tasks'", [native.companyId]);
    await assertReadGrant("task.read");
    const hidden = await request("/pg/agent/brief");
    assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
    assert.ok(!hidden.body.items.some(item => item.title === "CHAT_NATIVE_TASK"), `task ${denied} denial`);
    if (denied === "menu") await setRolePermission("menu.projects", true);
    else await native.pool.query("INSERT INTO org.company_modules(company_id,module_key) VALUES($1,'tasks')", [native.companyId]);
  }
  const pending = await request("/pg/agent/pending-approvals");
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  assert.deepEqual(pending.body.items.map(item => item.title), ["CHAT_NATIVE_APPROVAL"]);
  const approval = pending.body.items.find(item => item.id === String(approvalId));
  assert.equal(approval.title, "CHAT_NATIVE_APPROVAL");
  assert.equal(approval.confirm_self_decision, true);
  assert.equal((await request(`/pg/approvals/${approval.id}/actions`, { method: "POST", body: { decision: "approve", comment: "" } })).status, 400);
  assert.equal((await request(`/pg/approvals/${approval.id}/actions`, { method: "POST", body: { decision: "approve", comment: "", confirm_self_decision: true } })).status, 200);

  const memory = await request("/pg/agent/memory", { method: "POST", body: { key: "말투", value: "핵심부터" } });
  assert.equal(memory.status, 201, JSON.stringify(memory.body));
  const ownedMemory = (await request("/pg/agent/memory")).body.items;
  assert.ok(ownedMemory.some(item => item.id === memory.body.id && item.value === "핵심부터"));
  assert.ok(ownedMemory.some(item => item.id === String(globalMemoryId) && item.value === "user-global-memory-sentinel"), "PG memory remains user-global across company selections");
  assert.ok(!JSON.stringify(ownedMemory).includes("foreign-memory-sentinel"));
  assert.equal((await request(`/pg/agent/memory/${memory.body.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await request(`/pg/agent/memory/${globalMemoryId}`, { method: "DELETE" })).status, 200);
  assert.equal((await request("/pg/agent/memory")).body.items.length, 0);

  console.log(JSON.stringify({ result: "AGENT_CHAT_NATIVE_PG_PASS", engine: (await native.pool.query("SELECT version()")).rows[0].version,
    vaultMode: chat.body.scope.vault_mode, documentEvidence: chat.body.answer.evidence.length,
    sourceAccess: ["document menu", "document module", "task menu", "task module"], businessTimezone: "Asia/Seoul",
    approvalGate: "explicit self-decision confirmation", memoryScope: "user-global owner-only", memoryCrud: true }, null, 2));
} finally {
  await server?.close();
  await closePgPool?.();
  await native.close();
}
