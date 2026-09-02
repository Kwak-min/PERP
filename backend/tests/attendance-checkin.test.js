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

describe("attendance check-in/out and correction request HTTP contracts", () => {
  let server;
  let owner;

  before(async () => {
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, ["hr"]);
  });

  after(async () => {
    await server.close();
  });

  it("checks in, blocks a duplicate check-in, then checks out and computes hours", async () => {
    const member = await joinAsMember(server.baseUrl, owner, `checkin-${crypto.randomUUID()}@example.com`);

    const checkedIn = await api(server.baseUrl, "/hr/attendance/check-in", {
      method: "POST",
      token: member.token,
      orgId: owner.orgId,
    });
    assert.equal(checkedIn.status, 201);
    assert.ok(checkedIn.body.check_in_at);
    assert.equal(checkedIn.body.check_out_at, null);

    const duplicate = await api(server.baseUrl, "/hr/attendance/check-in", {
      method: "POST",
      token: member.token,
      orgId: owner.orgId,
    });
    assert.equal(duplicate.status, 409);

    const checkedOut = await api(server.baseUrl, "/hr/attendance/check-out", {
      method: "POST",
      token: member.token,
      orgId: owner.orgId,
    });
    assert.equal(checkedOut.status, 200);
    assert.ok(checkedOut.body.check_out_at);
    assert.equal(typeof checkedOut.body.hours, "number");

    const duplicateCheckout = await api(server.baseUrl, "/hr/attendance/check-out", {
      method: "POST",
      token: member.token,
      orgId: owner.orgId,
    });
    assert.equal(duplicateCheckout.status, 409);
  });

  it("blocks check-out before any check-in", async () => {
    const member = await joinAsMember(server.baseUrl, owner, `checkout-first-${crypto.randomUUID()}@example.com`);
    const response = await api(server.baseUrl, "/hr/attendance/check-out", {
      method: "POST",
      token: member.token,
      orgId: owner.orgId,
    });
    assert.equal(response.status, 409);
  });

  it("blocks a plain member from the pending-corrections queue", async () => {
    const member = await joinAsMember(server.baseUrl, owner, `pending-block-${crypto.randomUUID()}@example.com`);
    const response = await api(server.baseUrl, "/hr/attendance/corrections/pending", {
      token: member.token,
      orgId: owner.orgId,
    });
    assert.equal(response.status, 403);
  });

  it("applies an approved correction to attendance but not a rejected one, and blocks re-deciding", async () => {
    const member = await joinAsMember(server.baseUrl, owner, `correction-${crypto.randomUUID()}@example.com`);

    // Given a correction request for a date with no existing attendance row
    const requested = await api(server.baseUrl, "/hr/attendance/corrections", {
      method: "POST",
      token: member.token,
      orgId: owner.orgId,
      body: { on_date: "2026-09-01", kind: "present", hours: 8, note: "출근 깜빡함" },
    });
    assert.equal(requested.status, 201);
    assert.equal(requested.body.status, "pending");

    // It shows up in the owner's pending queue
    const pending = await api(server.baseUrl, "/hr/attendance/corrections/pending", {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(pending.status, 200);
    assert.ok(pending.body.items.some((item) => item.id === requested.body.id));

    // When approved
    const approved = await api(server.baseUrl, `/hr/attendance/corrections/${requested.body.id}/decide`, {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { decision: "approve" },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, "approved");

    // Then the attendance record actually reflects it (owner must pass member_id to view another member's attendance)
    const attendanceForMember = await api(
      server.baseUrl,
      `/hr/attendance?member_id=${member.userId}&from=2026-09-01&to=2026-09-01`,
      { token: owner.token, orgId: owner.orgId },
    );
    assert.equal(attendanceForMember.status, 200);
    assert.equal(attendanceForMember.body.items.length, 1);
    assert.equal(attendanceForMember.body.items[0].hours, 8);

    // And re-deciding the same request is a conflict
    const redecided = await api(server.baseUrl, `/hr/attendance/corrections/${requested.body.id}/decide`, {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { decision: "reject" },
    });
    assert.equal(redecided.status, 409);

    // A separate rejected request must not be applied
    const requested2 = await api(server.baseUrl, "/hr/attendance/corrections", {
      method: "POST",
      token: member.token,
      orgId: owner.orgId,
      body: { on_date: "2026-09-02", kind: "present", hours: 8, note: "재요청" },
    });
    assert.equal(requested2.status, 201);
    const rejected = await api(server.baseUrl, `/hr/attendance/corrections/${requested2.body.id}/decide`, {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { decision: "reject", comment: "사유 불충분" },
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, "rejected");

    const attendanceOn2 = await api(
      server.baseUrl,
      `/hr/attendance?member_id=${member.userId}&from=2026-09-02&to=2026-09-02`,
      { token: owner.token, orgId: owner.orgId },
    );
    assert.equal(attendanceOn2.body.items.length, 0);
  });
});
