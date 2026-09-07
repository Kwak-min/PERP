import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { api, startTestServer } from "./http.js";
import { ORG_TEMPLATES } from "../src/config/org-templates.js";

let server, token;
before(async () => {
  server = await startTestServer();
  const signup = await api(server.baseUrl, "/auth/signup", {
    method: "POST", body: { email: "no-defaults@example.invalid", name: "Owner", password: "password-1234" },
  });
  assert.equal(signup.status, 201);
  token = signup.body.access_token;
});
after(async () => { await server.close(); });

for (const type of Object.keys(ORG_TEMPLATES)) {
  for (const departments of [undefined, null, []]) {
    test(`${type}: ${JSON.stringify(departments)} departments creates no implicit branches`, async () => {
      const created = await api(server.baseUrl, "/tenants", {
        method: "POST", token, body: { name: `No defaults ${type}`, type, departments },
      });
      assert.equal(created.status, 201);
      const options = { token, orgId: created.body.org_id };
      const listed = await api(server.baseUrl, "/members/departments", options);
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.body.items, []);
      const chart = await api(server.baseUrl, "/members/org-chart", options);
      assert.equal(chart.status, 200);
      assert.deepEqual(chart.body.roots, []);
      assert.equal(chart.body.unassigned.length, 1);
    });
  }
}

test("explicit departments are preserved for every organization type", async () => {
  for (const type of Object.keys(ORG_TEMPLATES)) {
    const created = await api(server.baseUrl, "/tenants", {
      method: "POST", token, body: { name: `Explicit ${type}`, type, departments: ["Explicit Alpha", "Explicit Beta"] },
    });
    assert.equal(created.status, 201);
    const options = { token, orgId: created.body.org_id };
    const listed = await api(server.baseUrl, "/members/departments", options);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.items.map(row => row.name).sort(), ["Explicit Alpha", "Explicit Beta"]);
    const repeated = await api(server.baseUrl, "/members/departments", options);
    assert.deepEqual(repeated.body, listed.body);
  }
});
