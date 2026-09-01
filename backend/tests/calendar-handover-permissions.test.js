import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";

describe("calendar, handover, and permission simulation contracts", () => {
  let server;
  let owner;

  before(async () => {
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, ["calendar", "handover"]);
  });

  after(async () => {
    await server.close();
  });

  it("creates an event, lists it, and records an attendee response", async () => {
    // Given
    const event = await api(server.baseUrl, "/calendar", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: {
        title: "운영 회의",
        start_at: "2026-08-12T09:00:00.000Z",
        end_at: "2026-08-12T10:00:00.000Z",
        attendee_ids: [owner.userId],
      },
    });
    assert.equal(event.status, 201);

    // When
    const response = await api(
      server.baseUrl,
      `/calendar/${event.body.id}/respond`,
      {
        method: "POST",
        token: owner.token,
        orgId: owner.orgId,
        body: { response: "accepted" },
      },
    );

    // Then
    assert.equal(response.status, 200);
    assert.equal(response.body.response, "accepted");
    const list = await api(server.baseUrl, "/calendar", {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.deepEqual(list.body.items.map((item) => item.id), [event.body.id]);
    const detail = await api(server.baseUrl, `/calendar/${event.body.id}`, {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(detail.body.attendees[0].response, "accepted");
  });

  it("completes a handover only after required items and both confirmations", async () => {
    // Given
    const handover = await api(server.baseUrl, "/handovers", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: {
        title: "회장 인수인계",
        position: "회장",
        predecessor_id: owner.userId,
        successor_id: owner.userId,
      },
    });
    assert.equal(handover.status, 201);
    const item = await api(
      server.baseUrl,
      `/handovers/${handover.body.id}/items`,
      {
        method: "POST",
        token: owner.token,
        orgId: owner.orgId,
        body: { category: "finance", label: "통장 확인", required: true },
      },
    );
    assert.equal(item.status, 201);
    assert.equal(
      (
        await api(server.baseUrl, `/handovers/${handover.body.id}/submit`, {
          method: "POST",
          token: owner.token,
          orgId: owner.orgId,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await api(
          server.baseUrl,
          `/handovers/${handover.body.id}/items/${item.body.id}/complete`,
          {
            method: "POST",
            token: owner.token,
            orgId: owner.orgId,
          },
        )
      ).status,
      200,
    );

    // When
    for (const role of ["predecessor", "successor"]) {
      const confirmation = await api(
        server.baseUrl,
        `/handovers/${handover.body.id}/confirm`,
        {
          method: "POST",
          token: owner.token,
          orgId: owner.orgId,
          body: { role, comment: `${role} 확인` },
        },
      );
      assert.equal(confirmation.status, 200);
    }

    // Then
    const detail = await api(
      server.baseUrl,
      `/handovers/${handover.body.id}`,
      {
        token: owner.token,
        orgId: owner.orgId,
      },
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.status, "completed");
    assert.equal(detail.body.items[0].done, true);
    assert.deepEqual(
      detail.body.confirmations.map((confirmation) => confirmation.role).sort(),
      ["predecessor", "successor"],
    );
  });

  it("simulates role permissions without mutating the caller", async () => {
    // When
    const simulation = await api(server.baseUrl, "/members/permissions/simulate", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: {
        roles: ["member"],
        permissions: ["task.read", "transaction.write", "role.assign"],
      },
    });

    // Then
    assert.equal(simulation.status, 200);
    assert.equal(simulation.body.scope, "self");
    assert.deepEqual(simulation.body.granted, ["task.read"]);
    assert.deepEqual(simulation.body.denied, ["transaction.write", "role.assign"]);
    const current = await api(server.baseUrl, "/tenants/current", {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.deepEqual(current.body.roles, ["owner"]);
  });
});
