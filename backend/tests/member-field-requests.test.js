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

describe("member competency and field-request HTTP contracts", () => {
  let server;
  let owner;

  before(async () => {
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, ["hr"]);
  });

  after(async () => {
    await server.close();
  });

  it("lets a member manage their own competencies but blocks another member", async () => {
    const member = await joinAsMember(server.baseUrl, owner, `comp-${crypto.randomUUID()}@example.com`);
    const otherMember = await joinAsMember(server.baseUrl, owner, `comp-other-${crypto.randomUUID()}@example.com`);

    // Given the member adds their own competency
    const added = await api(server.baseUrl, `/members/${member.userId}/competencies`, {
      method: "POST",
      token: member.token,
      orgId: owner.orgId,
      body: { label: "React", level: "advanced" },
    });
    assert.equal(added.status, 201);

    // Then it shows up when listed
    const listed = await api(server.baseUrl, `/members/${member.userId}/competencies`, {
      token: member.token,
      orgId: owner.orgId,
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].label, "React");

    // When another plain member (not the owner, no member.write) tries to add on their behalf
    const blocked = await api(server.baseUrl, `/members/${member.userId}/competencies`, {
      method: "POST",
      token: otherMember.token,
      orgId: owner.orgId,
      body: { label: "Should not work" },
    });
    assert.equal(blocked.status, 403);

    // And that same other member can't delete it either
    const blockedDelete = await api(server.baseUrl, `/members/competencies/${added.body.id}`, {
      method: "DELETE",
      token: otherMember.token,
      orgId: owner.orgId,
    });
    assert.equal(blockedDelete.status, 403);

    // But the owner (member.write) can delete it
    const deleted = await api(server.baseUrl, `/members/competencies/${added.body.id}`, {
      method: "DELETE",
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(deleted.status, 204);
  });

  it("applies a field change to app_user only after the owner approves it, and not after rejection", async () => {
    const member = await joinAsMember(server.baseUrl, owner, `field-${crypto.randomUUID()}@example.com`);

    // Given the member requests a phone number change
    const requested = await api(server.baseUrl, `/members/${member.userId}/field-requests`, {
      method: "POST",
      token: member.token,
      orgId: owner.orgId,
      body: { field: "phone", new_value: "010-1234-5678" },
    });
    assert.equal(requested.status, 201);
    assert.equal(requested.body.status, "pending");
    assert.equal(requested.body.old_value, null);

    // Then the profile still shows no phone number yet (not applied)
    const beforeDecision = await api(server.baseUrl, `/members/${member.userId}/profile`, {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(beforeDecision.body.phone, null);

    // When the owner approves it
    const approved = await api(server.baseUrl, `/members/field-requests/${requested.body.id}/decide`, {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { decision: "approve" },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, "approved");

    // Then the phone number is actually reflected on the profile
    const afterDecision = await api(server.baseUrl, `/members/${member.userId}/profile`, {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(afterDecision.body.phone, "010-1234-5678");

    // And deciding the same request again is rejected as a conflict
    const redecided = await api(server.baseUrl, `/members/field-requests/${requested.body.id}/decide`, {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { decision: "approve" },
    });
    assert.equal(redecided.status, 409);
  });

  it("does not apply the change when the request is rejected", async () => {
    const member = await joinAsMember(server.baseUrl, owner, `field-reject-${crypto.randomUUID()}@example.com`);

    const requested = await api(server.baseUrl, `/members/${member.userId}/field-requests`, {
      method: "POST",
      token: member.token,
      orgId: owner.orgId,
      body: { field: "address", new_value: "Seoul" },
    });
    assert.equal(requested.status, 201);

    const rejected = await api(server.baseUrl, `/members/field-requests/${requested.body.id}/decide`, {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { decision: "reject", comment: "다시 확인해주세요" },
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, "rejected");

    const profile = await api(server.baseUrl, `/members/${member.userId}/profile`, {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(profile.body.address, null);
  });

  it("only lets the member themselves file a field-change request, not another plain member", async () => {
    const member = await joinAsMember(server.baseUrl, owner, `field-self-${crypto.randomUUID()}@example.com`);
    const otherMember = await joinAsMember(server.baseUrl, owner, `field-self-other-${crypto.randomUUID()}@example.com`);

    const blocked = await api(server.baseUrl, `/members/${member.userId}/field-requests`, {
      method: "POST",
      token: otherMember.token,
      orgId: owner.orgId,
      body: { field: "phone", new_value: "010-0000-0000" },
    });
    assert.equal(blocked.status, 403);
  });
});
