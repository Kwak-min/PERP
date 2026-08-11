import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { db } from "../src/config/db.js";
import { api, createOwnerOrg, startTestServer } from "./http.js";

async function joinAsMember(baseUrl, owner, email) {
  const invite = await api(baseUrl, "/members/invites", {
    method: "POST",
    token: owner.token,
    orgId: owner.orgId,
    body: { email, roles: ["member"] },
  });
  assert.equal(invite.status, 201);

  const signup = await api(baseUrl, "/auth/signup", {
    method: "POST",
    body: {
      email,
      name: "Member",
      password: "member-password-1234",
      invitation_token: invite.body.token,
    },
  });
  assert.equal(signup.status, 201);
  return { token: signup.body.access_token, userId: signup.body.user.id };
}

describe("tenant isolation, RBAC, and module gating", () => {
  let server;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.close();
  });

  it("hides another organization's resource and list from an owner token", async () => {
    // Given
    const ownerA = await createOwnerOrg(server.baseUrl, ["projects"]);
    const ownerB = await createOwnerOrg(server.baseUrl, ["projects"]);
    const projectB = await api(server.baseUrl, "/projects", {
      method: "POST",
      token: ownerB.token,
      orgId: ownerB.orgId,
      body: { name: "Organization B secret" },
    });
    assert.equal(projectB.status, 201);

    // When
    const direct = await api(server.baseUrl, `/projects/${projectB.body.id}`, {
      token: ownerA.token,
      orgId: ownerA.orgId,
    });
    const list = await api(server.baseUrl, "/projects", {
      token: ownerA.token,
      orgId: ownerA.orgId,
    });
    const spoofedOrg = await api(server.baseUrl, `/projects/${projectB.body.id}`, {
      token: ownerA.token,
      orgId: ownerB.orgId,
    });

    // Then
    assert.equal(direct.status, 404);
    assert.deepEqual(list.body.items, []);
    assert.equal(spoofedOrg.status, 403);
  });

  it("keeps Vault notes owner-only inside the same organization", async () => {
    // Given
    const owner = await createOwnerOrg(server.baseUrl, ["agent"]);
    const member = await joinAsMember(
      server.baseUrl,
      owner,
      `vault-${crypto.randomUUID()}@example.com`,
    );
    const note = await api(server.baseUrl, "/vault/notes", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { title: "Private note", content: "Owner only" },
    });
    assert.equal(note.status, 201);

    // When
    const direct = await api(server.baseUrl, `/vault/notes/${note.body.id}`, {
      token: member.token,
      orgId: owner.orgId,
    });
    const list = await api(server.baseUrl, "/vault/notes", {
      token: member.token,
      orgId: owner.orgId,
    });

    // Then
    assert.equal(direct.status, 404);
    assert.deepEqual(list.body.items, []);
  });

  it("denies transaction and role writes to a regular member", async () => {
    // Given
    const owner = await createOwnerOrg(server.baseUrl, ["finance"]);
    const member = await joinAsMember(
      server.baseUrl,
      owner,
      `rbac-${crypto.randomUUID()}@example.com`,
    );
    const members = await api(server.baseUrl, "/members", {
      token: owner.token,
      orgId: owner.orgId,
    });
    const membership = members.body.items.find((item) => item.user_id === member.userId);
    assert(membership);

    // When
    const transaction = await api(server.baseUrl, "/finance/transactions", {
      method: "POST",
      token: member.token,
      orgId: owner.orgId,
      body: {
        kind: "expense",
        amount_minor: 1000,
        occurred_on: "2026-08-10",
      },
    });
    const roleChange = await api(
      server.baseUrl,
      `/members/${membership.membership_id}/roles`,
      {
        method: "PATCH",
        token: member.token,
        orgId: owner.orgId,
        body: { roles: ["owner"] },
      },
    );
    const simulation = await api(
      server.baseUrl,
      "/members/permissions/simulate",
      {
        method: "POST",
        token: member.token,
        orgId: owner.orgId,
        body: { roles: ["owner"], permissions: ["role.assign"] },
      },
    );

    // Then
    assert.equal(transaction.status, 403);
    assert.equal(transaction.body.error.code, "PERMISSION_DENIED");
    assert.equal(roleChange.status, 403);
    assert.equal(roleChange.body.error.code, "PERMISSION_DENIED");
    assert.equal(simulation.status, 403);
    assert.equal(simulation.body.error.code, "PERMISSION_DENIED");
  });

  it("masks another member's private fields from a regular member", async () => {
    // Given
    const owner = await createOwnerOrg(server.baseUrl, []);
    const member = await joinAsMember(
      server.baseUrl,
      owner,
      `mask-${crypto.randomUUID()}@example.com`,
    );
    db()
      .prepare(
        `UPDATE app_user
         SET phone = ?, address = ?, birth_date = ?
         WHERE id = ?`,
      )
      .run("010-1234-5678", "서울시", "1990-01-01", owner.userId);
    db()
      .prepare(
        `UPDATE membership
         SET emergency_contact = ?
         WHERE org_id = ? AND user_id = ?`,
      )
      .run("010-9999-9999", owner.orgId, owner.userId);

    // When
    const members = await api(server.baseUrl, "/members", {
      token: member.token,
      orgId: owner.orgId,
    });

    // Then
    assert.equal(members.status, 200);
    const masked = members.body.items.find((item) => item.user_id === owner.userId);
    assert(masked);
    assert.equal(masked.phone, "***");
    assert.equal(masked.address, "***");
    assert.equal(masked.birth_date, "***");
    assert.equal(masked.emergency_contact, "***");
  });

  it("changes a disabled finance module from 403 to 200 when enabled", async () => {
    // Given
    const owner = await createOwnerOrg(server.baseUrl, []);
    const disabled = await api(server.baseUrl, "/finance/transactions", {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(disabled.status, 403);
    assert.equal(disabled.body.error.code, "MODULE_DISABLED");

    // When
    const enabled = await api(server.baseUrl, "/tenants/current", {
      method: "PATCH",
      token: owner.token,
      orgId: owner.orgId,
      body: { modules: ["finance"] },
    });
    assert.equal(enabled.status, 200);
    const transactions = await api(server.baseUrl, "/finance/transactions", {
      token: owner.token,
      orgId: owner.orgId,
    });

    // Then
    assert.equal(transactions.status, 200);
    assert.deepEqual(transactions.body.items, []);
  });
});
