import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";

describe("new organization home layout", () => {
  let server;
  let owner;

  before(async () => {
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, ["projects", "tasks", "calendar"]);
  });

  after(async () => {
    await server.close();
  });

  it("does not fabricate a project block before the user configures home", async () => {
    // Given: a newly created organization with no saved home layout.

    // When: the owner opens the default home.
    const response = await api(server.baseUrl, "/members/home-layout", {
      token: owner.token,
      orgId: owner.orgId,
    });

    // Then: only blocks meaningful without existing project data are returned.
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.blocks, ["welcome", "tasks", "calendar"]);
  });
});
