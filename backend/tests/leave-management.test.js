import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

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

describe("leave policy, grant, and stats HTTP contracts", () => {
  let server;
  let owner;

  before(async () => {
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, ["hr"]);
  });

  after(async () => {
    await server.close();
  });

  it("upserts a leave policy by kind and blocks members without leave.approve", async () => {
    // Given / When
    const created = await api(server.baseUrl, "/hr/leave-policies", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: {
        kind: "annual",
        default_days: 15,
        carryover_enabled: true,
        carryover_max_days: 5,
        expiry_note: "매년 12월 31일 소멸",
      },
    });

    // Then
    assert.equal(created.status, 201);
    assert.equal(created.body.default_days, 15);
    assert.equal(created.body.carryover_enabled, true);

    // When updating the same kind
    const updated = await api(server.baseUrl, "/hr/leave-policies", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { kind: "annual", default_days: 18 },
    });

    // Then it upserts in place rather than duplicating
    assert.equal(updated.status, 200);
    const list = await api(server.baseUrl, "/hr/leave-policies", {
      token: owner.token,
      orgId: owner.orgId,
    });
    const annualPolicies = list.body.items.filter((item) => item.kind === "annual");
    assert.equal(annualPolicies.length, 1);
    assert.equal(annualPolicies[0].default_days, 18);

    // When a regular member (no leave.approve) tries to read policies
    const member = await joinAsMember(server.baseUrl, owner, `policy-${crypto.randomUUID()}@example.com`);
    const denied = await api(server.baseUrl, "/hr/leave-policies", {
      token: member.token,
      orgId: owner.orgId,
    });

    // Then
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "PERMISSION_DENIED");
  });

  it("reflects granted and approved leave in org-wide stats with a formula and generated_at", async () => {
    // Given a member with a granted balance
    const member = await joinAsMember(server.baseUrl, owner, `stats-${crypto.randomUUID()}@example.com`);
    const grant = await api(server.baseUrl, "/hr/leave-balances", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { member_id: member.userId, kind: "annual", granted_days: 10 },
    });
    assert.equal(grant.status, 201);

    // When the member requests and the owner approves a 3-day leave
    const leave = await api(server.baseUrl, "/hr/leaves", {
      method: "POST",
      token: member.token,
      orgId: owner.orgId,
      body: { kind: "annual", start_on: "2026-09-01", end_on: "2026-09-03", reason: "test" },
    });
    assert.equal(leave.status, 201);

    const decided = await api(server.baseUrl, `/hr/leaves/${leave.body.id}/decide`, {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { decision: "approve" },
    });
    assert.equal(decided.status, 200);

    const stats = await api(server.baseUrl, "/hr/leave-stats", {
      token: owner.token,
      orgId: owner.orgId,
    });

    // Then the balance row is reflected accurately, alongside formula/as-of metadata
    assert.equal(stats.status, 200);
    const memberStat = stats.body.items.find(
      (item) => item.member_id === member.userId && item.kind === "annual",
    );
    assert.equal(memberStat.granted_days, 10);
    assert.equal(memberStat.used_days, 3);
    assert.equal(memberStat.remaining_days, 7);
    assert.equal(memberStat.usage_rate, 30);
    assert.equal(stats.body.totals.granted_days, 10);
    assert.equal(stats.body.totals.used_days, 3);
    assert.equal(typeof stats.body.formula, "string");
    assert.ok(stats.body.formula.length > 0);
    assert.ok(!Number.isNaN(Date.parse(stats.body.generated_at)));
  });
});
