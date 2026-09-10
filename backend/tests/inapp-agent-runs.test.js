import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createOwnerOrg, startTestServer } from "./http.js";

describe("scoped agent run receipts", () => {
  let server;
  let context;
  let runs;
  let database;
  before(async () => {
    server = await startTestServer();
    const owner = await createOwnerOrg(server.baseUrl, ["agent"]);
    ({ db: database } = await import("../src/config/db.js"));
    runs = await import("../src/services/agent-run.service.js");
    const org = database().prepare("SELECT tenant_id FROM organization WHERE id=?").get(owner.orgId);
    context = { source: "legacy", knowledgeMode: "personal",
      principal: { tenantId: org.tenant_id, orgId: owner.orgId, userId: owner.userId } };
  });
  after(async () => { await server?.close(); });

  it("claims exactly once and hashes canonical request values", async () => {
    const first = await runs.claimRun(context, { message: "진행", agent_mode: true }, "run-live");
    assert.equal(first.run.conversation_id, null);
    await assert.rejects(runs.claimRun(context, { agent_mode: true, message: "진행" }, "run-live"),
      error => error.code === "AGENT_RUN_IN_PROGRESS" && error.status === 409);
    assert.equal(database().prepare("SELECT count(*) AS n FROM agent_runs WHERE idempotency_key='run-live'").get().n, 1);
    await assert.rejects(runs.claimRun(context, { message: "다른 요청" }, "run-live"),
      error => error.code === "IDEMPOTENCY_CONFLICT");
    await runs.bindRunConversation(context, first.run.id, "conversation-live");
    assert.equal((await runs.getRun(context, first.run.id)).conversation_id, "conversation-live");
    await runs.finishRun(context, first.run.id, { response: { run_id: first.run.id } });
    const replay = await runs.claimRun(context, { message: "진행", agent_mode: true }, "run-live");
    assert.deepEqual(replay.receipt, { response: { run_id: first.run.id } });
  });

  it("fails closed for incomplete runs and stores only a sanitized error code", async () => {
    const first = await runs.claimRun(context, { message: "실패" }, "run-failed");
    await runs.finishRun(context, first.run.id, null, Object.assign(new Error("password=SYNTHETIC_SECRET"), { code: "SERVICE_UNAVAILABLE" }));
    const stored = await runs.getRun(context, first.run.id);
    assert.equal(stored.status, "failed");
    assert.equal(stored.error_json, '{"code":"SERVICE_UNAVAILABLE"}');
    await assert.rejects(runs.claimRun(context, { message: "실패" }, "run-failed"), error =>
      error.code === "AGENT_RUN_INCOMPLETE" && error.details.run_id === first.run.id);
  });

  it("never returns another owner, workspace or knowledge mode's run", async () => {
    const first = await runs.claimRun(context, { message: "PRIVATE_RUN_SENTINEL" }, "run-private");
    await runs.finishRun(context, first.run.id, { response: { content: "PRIVATE_RUN_SENTINEL" } });
    for (const principal of [
      { ...context.principal, userId: "other-owner" },
      { ...context.principal, orgId: "other-workspace" },
    ]) await assert.rejects(runs.getRun({ ...context, principal }, first.run.id), error => error.code === "NOT_FOUND");
    const company = { ...context, knowledgeMode: "company" };
    await assert.rejects(runs.getRun(company, first.run.id), error => error.code === "NOT_FOUND");
    await assert.rejects(runs.claimRun(company, { message: "PRIVATE_RUN_SENTINEL" }, "run-private"),
      error => ["IDEMPOTENCY_CONFLICT", "NOT_FOUND"].includes(error.code));
  });
});
