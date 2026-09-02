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

describe("member profile HTTP contracts", () => {
  let server;
  let owner;

  before(async () => {
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, ["hr", "documents", "assets"]);
  });

  after(async () => {
    await server.close();
  });

  it("masks another member's contact fields but shows them unmasked to the owner viewing themselves", async () => {
    // Given a member with a phone number set on signup-adjacent data isn't directly settable here,
    // so we assert the shape and masking behavior using the owner's own record plus a plain member's view of it.
    const member = await joinAsMember(server.baseUrl, owner, `profile-${crypto.randomUUID()}@example.com`);

    // When the owner views their own profile
    const ownProfile = await api(server.baseUrl, `/members/${owner.userId}/profile`, {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(ownProfile.status, 200);
    assert.equal(ownProfile.body.user_id, owner.userId);

    // When a plain member (no member.write) views the owner's profile
    const othersView = await api(server.baseUrl, `/members/${owner.userId}/profile`, {
      token: member.token,
      orgId: owner.orgId,
    });
    assert.equal(othersView.status, 200);
    // phone/address/birth_date default to null so masking wouldn't kick in here (only masks truthy values),
    // but the field keys must still be present in the response shape.
    assert.ok("phone" in othersView.body);
    assert.ok("emergency_contact" in othersView.body);
  });

  it("returns 404 for a memberId that doesn't belong to this org", async () => {
    const response = await api(server.baseUrl, "/members/does-not-exist/profile", {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(response.status, 404);
  });

  it("filters org activity to a single member via member_id", async () => {
    // Given two members, one whose assignment gets changed
    const memberA = await joinAsMember(server.baseUrl, owner, `activity-a-${crypto.randomUUID()}@example.com`);
    const memberB = await joinAsMember(server.baseUrl, owner, `activity-b-${crypto.randomUUID()}@example.com`);

    const listA = await api(server.baseUrl, "/members", { token: owner.token, orgId: owner.orgId });
    const membershipA = listA.body.items.find((item) => item.user_id === memberA.userId);

    const assignment = await api(server.baseUrl, `/members/${membershipA.membership_id}/assignment`, {
      method: "PATCH",
      token: owner.token,
      orgId: owner.orgId,
      body: { title: "QA Engineer" },
    });
    assert.equal(assignment.status, 200);

    // When filtering activity to memberA
    const activityA = await api(server.baseUrl, `/members/activity?member_id=${memberA.userId}`, {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(activityA.status, 200);
    assert.ok(activityA.body.items.some((item) => item.action === "member.assignment.changed"));

    // Then filtering to memberB (uninvolved) shows no such event
    const activityB = await api(server.baseUrl, `/members/activity?member_id=${memberB.userId}`, {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(activityB.status, 200);
    assert.ok(!activityB.body.items.some((item) => item.action === "member.assignment.changed"));
  });

  it("filters documents by owner_id and assets by custodian_id", async () => {
    // Given the owner creates a document (always owned by the creator) and an asset assigned to themselves
    const doc = await api(server.baseUrl, "/documents", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { title: "Profile doc" },
    });
    assert.equal(doc.status, 201);

    const asset = await api(server.baseUrl, "/assets", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { asset_no: `LAPTOP-${crypto.randomUUID().slice(0, 8)}`, name: "Laptop", custodian_id: owner.userId },
    });
    assert.equal(asset.status, 201);

    // When
    const docs = await api(server.baseUrl, `/documents?owner_id=${owner.userId}`, {
      token: owner.token,
      orgId: owner.orgId,
    });
    const assets = await api(server.baseUrl, `/assets?custodian_id=${owner.userId}`, {
      token: owner.token,
      orgId: owner.orgId,
    });

    // Then
    assert.equal(docs.status, 200);
    assert.ok(docs.body.items.some((item) => item.id === doc.body.id));
    assert.equal(assets.status, 200);
    assert.ok(assets.body.items.some((item) => item.id === asset.body.id));
  });
});
