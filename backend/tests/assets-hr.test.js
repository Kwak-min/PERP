import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";

describe("assets and HR HTTP contracts", () => {
  let server;
  let owner;

  before(async () => {
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, ["assets", "hr"]);
  });

  after(async () => {
    await server.close();
  });

  it("rejects an overlapping reservation for the same asset", async () => {
    // Given
    const asset = await api(server.baseUrl, "/assets", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { asset_no: "CAM-001", name: "Camera" },
    });
    assert.equal(asset.status, 201);
    const reservation = {
      resource_id: asset.body.id,
      start_at: "2026-08-10T09:00:00.000Z",
      end_at: "2026-08-10T11:00:00.000Z",
    };
    assert.equal(
      (
        await api(server.baseUrl, "/assets/reservations", {
          method: "POST",
          token: owner.token,
          orgId: owner.orgId,
          body: reservation,
        })
      ).status,
      201,
    );

    // When
    const overlap = await api(server.baseUrl, "/assets/reservations", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: {
        ...reservation,
        start_at: "2026-08-10T10:00:00.000Z",
        end_at: "2026-08-10T12:00:00.000Z",
      },
    });

    // Then
    assert.equal(overlap.status, 409);
    assert.equal(overlap.body.error.code, "CONFLICT");
  });

  it("rejects duplicate attendance for one member and date", async () => {
    // Given
    const attendance = {
      on_date: "2026-08-10",
      kind: "present",
      hours: 8,
    };
    assert.equal(
      (
        await api(server.baseUrl, "/hr/attendance", {
          method: "POST",
          token: owner.token,
          orgId: owner.orgId,
          body: attendance,
        })
      ).status,
      201,
    );

    // When
    const duplicate = await api(server.baseUrl, "/hr/attendance", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: attendance,
    });

    // Then
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "CONFLICT");
  });

  it("rejects leave requests beyond the granted balance", async () => {
    // Given
    const grant = await api(server.baseUrl, "/hr/leave-balances", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { member_id: owner.userId, kind: "annual", granted_days: 1 },
    });
    assert.equal(grant.status, 201);

    // When
    const leave = await api(server.baseUrl, "/hr/leaves", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: {
        kind: "annual",
        start_on: "2026-08-10",
        end_on: "2026-08-11",
        reason: "Vacation",
      },
    });

    // Then
    assert.equal(leave.status, 400);
    assert.equal(leave.body.error.code, "VALIDATION_ERROR");
  });
});
