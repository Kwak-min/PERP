import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";

describe("recruitment pipeline HTTP contracts", () => {
  let server;
  let owner;

  before(async () => {
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, ["hr", "integrations"]);
  });

  after(async () => {
    await server.close();
  });

  it("lists applications across all postings when no postingId is given", async () => {
    // Given two postings each with an application
    const postingA = await api(server.baseUrl, "/hr/postings", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { title: "Designer" },
    });
    const postingB = await api(server.baseUrl, "/hr/postings", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { title: "Engineer" },
    });
    assert.equal(postingA.status, 201);
    assert.equal(postingB.status, 201);

    const applicantA = await api(server.baseUrl, `/hr/postings/${postingA.body.id}/applications`, {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { applicant_name: "Applicant A", applicant_email: "a@example.com" },
    });
    const applicantB = await api(server.baseUrl, `/hr/postings/${postingB.body.id}/applications`, {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { applicant_name: "Applicant B", applicant_email: "b@example.com" },
    });
    assert.equal(applicantA.status, 201);
    assert.equal(applicantB.status, 201);

    // When listing applications org-wide (no postingId in the route)
    const list = await api(server.baseUrl, "/hr/applications", {
      token: owner.token,
      orgId: owner.orgId,
    });

    // Then both applications, from both postings, come back
    assert.equal(list.status, 200);
    const ids = list.body.items.map((item) => item.id);
    assert.ok(ids.includes(applicantA.body.id));
    assert.ok(ids.includes(applicantB.body.id));
  });

  it("records an audit event when a posting is closed", async () => {
    // Given
    const posting = await api(server.baseUrl, "/hr/postings", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { title: "Closed soon" },
    });
    assert.equal(posting.status, 201);

    // When
    const closed = await api(server.baseUrl, `/hr/postings/${posting.body.id}/close`, {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, "closed");

    // Then
    const audit = await api(server.baseUrl, "/integrations/audit?limit=20", {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(audit.status, 200);
    const event = audit.body.items.find(
      (item) => item.action === "posting.closed" && item.resource_id === posting.body.id,
    );
    assert.ok(event, "expected a posting.closed audit event");
  });

  it("records an audit event when an onboarding checklist item is completed", async () => {
    // Given
    const onboarding = await api(server.baseUrl, "/hr/onboarding", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { member_id: owner.userId, flow: "onboarding", labels: ["장비 수령"] },
    });
    assert.equal(onboarding.status, 201);
    const itemId = onboarding.body.items[0].id;

    // When
    const completed = await api(server.baseUrl, `/hr/onboarding/${itemId}/complete`, {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.done, true);

    // Then
    const audit = await api(server.baseUrl, "/integrations/audit?limit=20", {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(audit.status, 200);
    const event = audit.body.items.find(
      (item) => item.action === "onboarding_item.completed" && item.resource_id === itemId,
    );
    assert.ok(event, "expected an onboarding_item.completed audit event");
  });
});
