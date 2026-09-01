import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { api, startTestServer } from "./http.js";

describe("development seed account", () => {
  let server;

  before(async () => {
    server = await startTestServer();
    const { seed } = await import("../src/config/seed.js");
    seed();
    seed();
  });

  after(async () => {
    await server.close();
  });

  it("authenticates the permanent dummy user after idempotent seeding", async () => {
    // Given
    const credentials = { email: "a@naver.com", password: "aaaaaaaa" };

    // When
    const login = await api(server.baseUrl, "/auth/login", {
      method: "POST",
      body: credentials,
    });

    // Then
    assert.equal(login.status, 200);
    assert.equal(login.body.user.email, credentials.email);
    assert.equal(typeof login.body.access_token, "string");
  });
});
