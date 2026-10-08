import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";

describe("scoped AI chat workflows", { timeout: 30000 }, () => {
  let server;
  let owner;
  let database;
  const request = (path, options = {}) => api(server.baseUrl, path, { ...owner, ...options });

  before(async () => {
    server = await startTestServer();
    ({ db: database } = await import("../src/config/db.js"));
    owner = await createOwnerOrg(server.baseUrl, ["agent", "documents", "tasks", "approvals"]);
  });

  after(async () => {
    await server?.close();
  });

  it("excludes personal Vault by default and binds scope for the conversation", async () => {
    const note = await request("/vault/notes", {
      method: "POST",
      body: { title: "개인 근거", content: "personalvaultneedle" },
    });
    assert.equal(note.status, 201);

    const excluded = await request("/agent/chat", {
      method: "POST",
      body: { message: "personalvaultneedle", vault_mode: "off" },
    });
    assert.equal(excluded.status, 200, JSON.stringify(excluded.body));
    assert.equal(excluded.body.scope.vault_mode, "off");
    assert.equal(excluded.body.answer.related_data.vault_notes_used, 0);
    assert.ok(!excluded.body.answer.evidence.some((item) => item.type === "vault_note"));

    const changed = await request("/agent/chat", {
      method: "POST",
      body: { message: "personalvaultneedle", conversation_id: excluded.body.conversation_id, vault_mode: "on" },
    });
    assert.equal(changed.status, 409);

    const included = await request("/agent/chat", {
      method: "POST",
      body: { message: "personalvaultneedle", vault_mode: "on" },
    });
    assert.equal(included.status, 200, JSON.stringify(included.body));
    assert.equal(included.body.scope.vault_mode, "on");
    assert.ok(included.body.answer.evidence.some((item) => item.id === note.body.id && item.type === "vault_note"));
  });

  it("returns live briefing and only the caller's actionable approvals", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const task = await request("/tasks", {
      method: "POST",
      body: { title: "CHAT_BRIEF_TASK", assignee_id: owner.userId, due_at: `${today}T12:00:00.000Z` },
    });
    assert.equal(task.status, 201);
    const approval = await request("/approvals/requests", {
      method: "POST",
      body: { title: "CHAT_PENDING_APPROVAL", amount: 1_000_000, steps: [{ approver_id: owner.userId }] },
    });
    assert.equal(approval.status, 201, JSON.stringify(approval.body));

    const brief = await request("/agent/brief");
    assert.equal(brief.status, 200);
    assert.ok(brief.body.items.some((item) => item.title === "CHAT_BRIEF_TASK" && item.evidence.id === task.body.id));
    assert.ok(brief.body.items.some((item) => item.kind === "approval"));

    const pending = await request("/agent/pending-approvals");
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    const item = pending.body.items.find((candidate) => candidate.id === approval.body.id);
    assert.equal(item.title, "CHAT_PENDING_APPROVAL");
    assert.equal(item.requires_reauth, true);

    const blocked = await request(`/approvals/requests/${approval.body.id}/actions`, {
      method: "POST",
      body: { decision: "approve", comment: "" },
    });
    assert.equal(blocked.status, 403);
    const approved = await request(`/approvals/requests/${approval.body.id}/actions`, {
      method: "POST",
      body: { decision: "approve", comment: "", reauth_password: "password-1234" },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, "approved");
  });


  it("enforces legacy task and approval source menu/module/feature boundaries", async () => {
    const role = await request("/settings/roles", { method: "POST", body: { name: "Agent source reader", scope: "self",
      permissions: ["agent.chat", "menu.agent", "task.read", "menu.projects", "approval.decide", "menu.approvals"] } });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    const email = `agent-source-${crypto.randomUUID()}@example.invalid`;
    const invite = await request("/members/invites", { method: "POST", body: { email, roles: [role.body.key] } });
    assert.equal(invite.status, 201);
    const signup = await api(server.baseUrl, "/auth/signup", { method: "POST", body: {
      email, name: "Agent source actor", password: "password-1234", invitation_token: invite.body.token,
    } });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    const actor = { token: signup.body.access_token, orgId: owner.orgId, userId: signup.body.user.id };
    const actorRequest = (path, options = {}) => api(server.baseUrl, path, { ...actor, ...options });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const task = await request("/tasks", { method: "POST", body: { title: "LEGACY_VISIBLE_TASK", assignee_id: actor.userId, due_at: today } });
    const cancelled = await request("/tasks", { method: "POST", body: { title: "LEGACY_CANCELLED_TASK", assignee_id: actor.userId, due_at: today } });
    assert.equal(task.status, 201); assert.equal(cancelled.status, 201);
    assert.equal((await request(`/tasks/${cancelled.body.id}`, { method: "PATCH", body: { status: "cancelled", version: cancelled.body.version } })).status, 200);
    const approval = await request("/approvals/requests", { method: "POST", body: { title: "LEGACY_VISIBLE_APPROVAL", steps: [{ approver_id: actor.userId }] } });
    assert.equal(approval.status, 201);

    const org = database().prepare("SELECT modules,enabled_features FROM organization WHERE id=?").get(owner.orgId);
    const full = ["agent.chat", "menu.agent", "task.read", "menu.projects", "approval.decide", "menu.approvals"];
    const setPermissions = permissions => database().prepare("UPDATE company_role SET permissions_json=? WHERE id=?").run(JSON.stringify(permissions), role.body.key);
    const setModules = modules => database().prepare("UPDATE organization SET modules=? WHERE id=?").run(modules, owner.orgId);
    const setFeatures = features => database().prepare("UPDATE organization SET enabled_features=? WHERE id=?").run(features, owner.orgId);
    try {
      let brief = await actorRequest("/agent/brief");
      assert.ok(brief.body.items.some(item => item.title === "LEGACY_VISIBLE_TASK"));
      assert.ok(!brief.body.items.some(item => item.title === "LEGACY_CANCELLED_TASK"));
      assert.ok(brief.body.items.some(item => item.kind === "approval"));

      setPermissions(full.filter(code => code !== "menu.projects"));
      brief = await actorRequest("/agent/brief");
      assert.ok(!brief.body.items.some(item => item.title === "LEGACY_VISIBLE_TASK"));
      setPermissions(full.filter(code => code !== "task.read"));
      brief = await actorRequest("/agent/brief");
      assert.ok(!brief.body.items.some(item => item.title === "LEGACY_VISIBLE_TASK"));
      setPermissions(full);
      setModules(org.modules.split(",").filter(key => key !== "tasks").join(","));
      brief = await actorRequest("/agent/brief");
      assert.ok(!brief.body.items.some(item => item.title === "LEGACY_VISIBLE_TASK"));
      setModules(org.modules);

      setPermissions(full.filter(code => code !== "menu.approvals"));
      brief = await actorRequest("/agent/brief");
      assert.ok(!brief.body.items.some(item => item.kind === "approval"));
      setPermissions(full.filter(code => code !== "approval.decide"));
      brief = await actorRequest("/agent/brief");
      assert.ok(!brief.body.items.some(item => item.kind === "approval"));
      setPermissions(full);

      setFeatures("");
      const disabled = await actorRequest("/agent/pending-approvals");
      assert.equal(disabled.status, 403, JSON.stringify(disabled.body));
      assert.equal(disabled.body.error.code, "FEATURE_DISABLED");
      brief = await actorRequest("/agent/brief");
      assert.ok(!brief.body.items.some(item => item.kind === "approval"));

      setFeatures("approvals");
      setModules(org.modules.split(",").filter(key => key !== "approvals").join(","));
      const moduleDisabled = await actorRequest("/agent/pending-approvals");
      assert.equal(moduleDisabled.status, 403, JSON.stringify(moduleDisabled.body));
      assert.equal(moduleDisabled.body.error.code, "MODULE_DISABLED");
      brief = await actorRequest("/agent/brief");
      assert.ok(!brief.body.items.some(item => item.kind === "approval"));
    } finally {
      setPermissions(full); setModules(org.modules); setFeatures(org.enabled_features);
    }
  });

  it("manages personal AI memory through owner-scoped APIs", async () => {
    const created = await request("/agent/memory", {
      method: "POST",
      body: { content: "답변은 한국어로 간결하게" },
    });
    assert.equal(created.status, 201);
    const listed = await request("/agent/memory");
    assert.ok(listed.body.items.some((item) => item.id === created.body.id && item.content === "답변은 한국어로 간결하게"));
    const deleted = await request(`/agent/memory/${created.body.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal((await request("/agent/memory")).body.items.some((item) => item.id === created.body.id), false);
  });
});
