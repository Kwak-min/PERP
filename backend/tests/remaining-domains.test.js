import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";

describe("automation, integration, analytics, and import HTTP contracts", () => {
  let server;
  let owner;

  before(async () => {
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, [
      "analytics",
      "assets",
      "automations",
      "hr",
      "integrations",
      "tasks",
    ]);
  });

  after(async () => {
    await server.close();
  });

  it("publishes and executes an automation in sandbox mode", async () => {
    // Given
    const workflow = await api(server.baseUrl, "/automations/workflows", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: {
        name: "Welcome",
        trigger_type: "manual",
        definition: {
          steps: [{ kind: "notify", config: { title: "Welcome" } }],
        },
      },
    });
    assert.equal(workflow.status, 201);
    const published = await api(
      server.baseUrl,
      `/automations/workflows/${workflow.body.id}/publish`,
      {
        method: "POST",
        token: owner.token,
        orgId: owner.orgId,
        body: { revision: 1 },
      },
    );
    assert.equal(published.status, 200);

    // When
    const run = await api(server.baseUrl, `/automations/workflows/${workflow.body.id}/run`, {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { sandbox: true, input: {} },
    });

    // Then
    assert.equal(run.status, 200);
    assert.equal(run.body.status, "succeeded");
    assert.equal(run.body.steps[0].output.simulated, true);
  });

  it("dispatches a subscribed webhook through its endpoint route", async () => {
    // Given
    const endpoint = await api(server.baseUrl, "/integrations/webhooks", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { url: "https://example.com/hook", events: ["task.created"] },
    });
    assert.equal(endpoint.status, 201);

    // When
    const delivery = await api(
      server.baseUrl,
      `/integrations/webhooks/${endpoint.body.id}/dispatch`,
      {
        method: "POST",
        token: owner.token,
        orgId: owner.orgId,
        body: { event: "task.created", payload: { id: "task-1" } },
      },
    );

    // Then
    assert.equal(delivery.status, 201);
    assert.equal(delivery.body.endpoint_id, endpoint.body.id);
    assert.equal(delivery.body.status, "delivered");
  });

  it("downloads a ready analytics export as CSV", async () => {
    // Given
    const task = await api(server.baseUrl, "/tasks", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { title: "Export me" },
    });
    assert.equal(task.status, 201);
    const job = await api(server.baseUrl, "/analytics/exports", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { kind: "tasks" },
    });
    assert.equal(job.status, 201);

    // When
    const response = await fetch(
      `${server.baseUrl}/analytics/exports/${job.body.id}/download`,
      {
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "X-Org-Id": owner.orgId,
        },
      },
    );

    // Then
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/csv/);
    assert.match(await response.text(), /Export me/);
  });

  it("lists applications only for the requested posting", async () => {
    // Given
    const posting = await api(server.baseUrl, "/hr/postings", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { title: "Engineer" },
    });
    assert.equal(posting.status, 201);
    const application = await api(
      server.baseUrl,
      `/hr/postings/${posting.body.id}/applications`,
      {
        method: "POST",
        token: owner.token,
        orgId: owner.orgId,
        body: {
          applicant_name: "Applicant",
          applicant_email: "applicant@example.com",
        },
      },
    );
    assert.equal(application.status, 201);

    // When
    const list = await api(
      server.baseUrl,
      `/hr/postings/${posting.body.id}/applications`,
      {
        token: owner.token,
        orgId: owner.orgId,
      },
    );

    // Then
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.items.map((item) => item.id),
      [application.body.id],
    );
  });

  it("does not partially apply an import containing an invalid row", async () => {
    // Given
    const csv = [
      "asset_no,name,category,quantity",
      "A-1,Valid asset,equipment,1",
      ",Invalid asset,equipment,1",
    ].join("\n");

    // When
    const result = await api(server.baseUrl, "/imports", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { kind: "assets", csv, dry_run: false },
    });

    // Then
    assert.equal(result.status, 400);
    const assets = await api(server.baseUrl, "/assets", {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.deepEqual(assets.body.items, []);
  });
});
