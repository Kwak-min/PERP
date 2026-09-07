import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { api, startTestServer } from "./http.js";

const FEATURE_PATHS = {
  attendance: "/hr/attendance",
  leave: "/hr/leaves",
  approvals: "/approvals/requests",
};

describe("organization feature opt-ins", () => {
  let server;
  let token;
  let db;

  before(async () => {
    server = await startTestServer();
    ({ db } = await import("../src/config/db.js"));
    const signup = await api(server.baseUrl, "/auth/signup", {
      method: "POST",
      body: {
        email: "feature-optins@example.invalid",
        name: "Feature owner",
        password: "password-1234",
      },
    });
    assert.equal(signup.status, 201);
    token = signup.body.access_token;
  });

  after(async () => {
    await server.close();
  });

  async function create(name, modules = [], features = []) {
    return api(server.baseUrl, "/tenants", {
      method: "POST",
      token,
      body: { name, type: "custom", modules, features, departments: [] },
    });
  }

  async function status(orgId, path) {
    return (await api(server.baseUrl, path, { token, orgId })).status;
  }

  it("keeps every unchecked feature unavailable for a new organization", async () => {
    const created = await api(server.baseUrl, "/tenants", {
      method: "POST",
      token,
      body: { name: "No selected features", type: "custom", modules: [], departments: [] },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.enabled_features, []);
    for (const path of Object.values(FEATURE_PATHS)) {
      const response = await api(server.baseUrl, path, { token, orgId: created.body.org_id });
      assert.equal(response.status, 403, path);
      assert.equal(response.body.error.code, "FEATURE_DISABLED", path);
    }
  });

  it("enables attendance, leave, and approvals independently", async () => {
    for (const feature of Object.keys(FEATURE_PATHS)) {
      const created = await create(`Only ${feature}`, [], [feature]);
      assert.equal(created.status, 201);
      assert.deepEqual(created.body.enabled_features, [feature]);
      for (const [candidate, path] of Object.entries(FEATURE_PATHS)) {
        assert.equal(await status(created.body.org_id, path), candidate === feature ? 200 : 403, `${feature} -> ${candidate}`);
      }
    }
  });

  it("returns the persisted explicit selection after a new login", async () => {
    const created = await create("Relogin selection", [], ["leave", "approvals"]);
    const login = await api(server.baseUrl, "/auth/login", {
      method: "POST",
      body: { email: "feature-optins@example.invalid", password: "password-1234" },
    });
    assert.equal(login.status, 200);
    const current = await api(server.baseUrl, "/tenants/current", {
      token: login.body.access_token,
      orgId: created.body.org_id,
    });
    assert.deepEqual(current.body.enabled_features, ["approvals", "leave"]);
  });

  it("keeps recruitment separate from attendance and leave", async () => {
    const recruitmentOnly = await create("Recruitment only", ["hr"], []);
    assert.equal(recruitmentOnly.status, 201);
    assert.equal(await status(recruitmentOnly.body.org_id, "/hr/postings"), 200);
    assert.equal(await status(recruitmentOnly.body.org_id, FEATURE_PATHS.attendance), 403);
    assert.equal(await status(recruitmentOnly.body.org_id, FEATURE_PATHS.leave), 403);

    const attendanceOnly = await create("Attendance only", [], ["attendance"]);
    assert.equal(await status(attendanceOnly.body.org_id, FEATURE_PATHS.attendance), 200);
    assert.equal(await status(attendanceOnly.body.org_id, "/hr/postings"), 403);
  });

  it("preserves pre-feature organizations through null legacy fallback", async () => {
    const created = await create("Legacy compatibility", ["hr", "approvals"], []);
    db().prepare("UPDATE organization SET modules = 'hr,approvals', enabled_features = NULL WHERE id = ?").run(created.body.org_id);
    const current = await api(server.baseUrl, "/tenants/current", { token, orgId: created.body.org_id });
    assert.deepEqual(current.body.enabled_features, ["approvals", "attendance", "leave"]);
    for (const path of Object.values(FEATURE_PATHS)) assert.equal(await status(created.body.org_id, path), 200, path);
  });

  it("rejects unknown feature keys before creating an organization", async () => {
    const before = db().prepare("SELECT count(*) AS count FROM organization").get().count;
    const response = await create("Unknown feature", [], ["not-a-feature"]);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "VALIDATION_ERROR");
    assert.equal(db().prepare("SELECT count(*) AS count FROM organization").get().count, before);
  });
});
