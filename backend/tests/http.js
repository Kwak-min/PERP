import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function startTestServer() {
  const root = await mkdtemp(path.join(tmpdir(), "orbitflow-test-"));
  process.env.ORBITFLOW_DATABASE_FILE = path.join(root, "test.db");
  process.env.ORBITFLOW_AI_PROVIDER = "echo";
  process.env.PORT = "0";

  const [{ createApp }, { migrate }, { closeDb }] = await Promise.all([
    import("../src/app.js"),
    import("../src/config/migrate.js"),
    import("../src/config/db.js"),
  ]);
  migrate();

  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address === "object");

  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      closeDb();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function api(baseUrl, route, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.orgId) headers["X-Org-Id"] = options.orgId;
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { status: response.status, body };
}

export async function createOwnerOrg(baseUrl, modules) {
  const signup = await api(baseUrl, "/auth/signup", {
    method: "POST",
    body: {
      email: `owner-${crypto.randomUUID()}@example.com`,
      name: "Owner",
      password: "password-1234",
    },
  });
  assert.equal(signup.status, 201);

  const token = signup.body.access_token;
  const org = await api(baseUrl, "/tenants", {
    method: "POST",
    token,
    body: { name: "Test Org", type: "custom", modules, departments: [] },
  });
  assert.equal(org.status, 201);
  return { token, orgId: org.body.org_id, userId: signup.body.user.id };
}
