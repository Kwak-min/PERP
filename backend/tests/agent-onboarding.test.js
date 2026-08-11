import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";

describe("AI approval gate and temporary-password onboarding", () => {
  let server;
  let owner;

  before(async () => {
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, ["agent", "approvals", "finance", "tasks"]);
  });

  after(async () => {
    await server.close();
  });

  it("executes a high-risk tool only after approval and re-authentication, then rolls back", async () => {
    // Given
    const transaction = await api(server.baseUrl, "/finance/transactions", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: {
        kind: "expense",
        amount_minor: 5_000,
        occurred_on: "2026-08-10",
        memo: "Agent gate",
      },
    });
    assert.equal(transaction.status, 201);
    const action = await api(server.baseUrl, "/agent/actions", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: {
        tool: "confirm.transaction",
        input: { transaction_id: transaction.body.id },
        approver_id: owner.userId,
      },
    });
    assert.equal(action.status, 201);
    assert.equal(action.body.status, "awaiting_approval");
    assert.equal(action.body.requires_approval, true);

    const blocked = await api(
      server.baseUrl,
      `/agent/actions/${action.body.id}/execute`,
      {
        method: "POST",
        token: owner.token,
        orgId: owner.orgId,
        body: { reauth_password: "password-1234" },
      },
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "APPROVAL_REQUIRED");

    const approved = await api(
      server.baseUrl,
      `/approvals/requests/${action.body.approval_id}/actions`,
      {
        method: "POST",
        token: owner.token,
        orgId: owner.orgId,
        body: { decision: "approve" },
      },
    );
    assert.equal(approved.status, 200);

    const missingReauth = await api(
      server.baseUrl,
      `/agent/actions/${action.body.id}/execute`,
      {
        method: "POST",
        token: owner.token,
        orgId: owner.orgId,
        body: {},
      },
    );
    assert.equal(missingReauth.status, 403);

    // When
    const executed = await api(
      server.baseUrl,
      `/agent/actions/${action.body.id}/execute`,
      {
        method: "POST",
        token: owner.token,
        orgId: owner.orgId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: { reauth_password: "password-1234" },
      },
    );

    // Then
    assert.equal(executed.status, 200);
    assert.equal(executed.body.status, "executed");
    assert.deepEqual(executed.body.rollback_ref, {
      kind: "restore_field",
      resource: "transaction_record",
      id: transaction.body.id,
      field: "status",
      value: "draft",
    });
    const confirmed = await api(server.baseUrl, "/finance/transactions?status=confirmed", {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.deepEqual(
      confirmed.body.items.map((item) => item.id),
      [transaction.body.id],
    );

    const rollback = await api(
      server.baseUrl,
      `/agent/actions/${action.body.id}/rollback`,
      {
        method: "POST",
        token: owner.token,
        orgId: owner.orgId,
      },
    );
    assert.equal(rollback.status, 200);
    assert.equal(rollback.body.status, "rolled_back");
    const drafts = await api(server.baseUrl, "/finance/transactions?status=draft", {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.deepEqual(
      drafts.body.items.map((item) => item.id),
      [transaction.body.id],
    );
  });

  it("blocks an administrator-provisioned user until the temporary password changes", async () => {
    // Given
    const email = `provisioned-${crypto.randomUUID()}@example.com`;
    const provisioned = await api(server.baseUrl, "/members/provision", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { email, name: "Provisioned Member", roles: ["member"] },
    });
    assert.equal(provisioned.status, 201);
    assert.equal(provisioned.body.must_change_password, true);

    const login = await api(server.baseUrl, "/auth/login", {
      method: "POST",
      body: { email, password: provisioned.body.temporary_password },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.must_change_password, true);

    const blocked = await api(server.baseUrl, "/tenants/current", {
      token: login.body.access_token,
      orgId: owner.orgId,
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, "PASSWORD_CHANGE_REQUIRED");

    // When
    const changed = await api(server.baseUrl, "/auth/password", {
      method: "POST",
      token: login.body.access_token,
      body: {
        current_password: provisioned.body.temporary_password,
        new_password: "new-member-password-1234",
      },
    });

    // Then
    assert.equal(changed.status, 200);
    assert.equal(changed.body.sessions_revoked, true);
    const revokedSession = await api(server.baseUrl, "/auth/me", {
      token: login.body.access_token,
    });
    assert.equal(revokedSession.status, 401);

    const relogin = await api(server.baseUrl, "/auth/login", {
      method: "POST",
      body: { email, password: "new-member-password-1234" },
    });
    assert.equal(relogin.status, 200);
    assert.equal(relogin.body.must_change_password, false);
    const currentOrg = await api(server.baseUrl, "/tenants/current", {
      token: relogin.body.access_token,
      orgId: owner.orgId,
    });
    assert.equal(currentOrg.status, 200);
  });
});
