import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { randomUUID } from "node:crypto";
import { api, startTestServer } from "./http.js";
process.env.DATABASE_URL = "";
process.env.PG_HOST = "127.0.0.1";
process.env.PG_PORT = "1";
let server, pool, originalQuery, originalConnect;
let failLog = false;
let committed = [];
let pending = [];
const calls = [];
before(async () => {
  server = await startTestServer(); ({ pgPool: pool } = await import("../src/config/pg.js"));
  originalQuery = pool.query; originalConnect = pool.connect;
  pool.query = async (sql) => {
    assert.ok(sql.trim().startsWith("SELECT"), "signup mutations must use its transaction connection");
    if (sql.includes("SELECT 1 FROM auth.users")) return { rows: [] };
    if (sql.includes("LEFT JOIN org.companies")) return { rows: [{ id: "101", name: "Creator", email: "creator@example.invalid", company_id: "77", company_name: "New company", is_admin: true }] };
    throw new Error(`Unexpected outside-transaction query: ${sql}`);
  };
  pool.connect = async () => ({
    async query(sql, values = []) {
      calls.push(sql);
      if (sql === "BEGIN") { pending = []; return { rows: [] }; }
      if (sql === "COMMIT") { committed = [...pending]; return { rows: [] }; }
      if (sql === "ROLLBACK") { pending = []; return { rows: [] }; }
      pending.push({ sql, values });
      if (sql.includes("INSERT INTO org.companies")) return { rows: [{ id: "77" }] };
      if (sql.includes("INSERT INTO org.positions")) return { rows: [{ id: "9", name: "대표" }] };
      if (sql.includes("INSERT INTO org.departments")) return { rows: [{ id: "8" }] };
      if (sql.includes("INSERT INTO auth.users")) return { rows: [{ id: "101" }] };
      if (sql.includes("INSERT INTO org.roles")) return { rows: [{ id: "7" }] };
      if (sql.includes("INSERT INTO auth.sessions")) return { rows: [{ session_token: randomUUID(), login_at: new Date().toISOString() }] };
      if (sql.includes("INSERT INTO auth.login_logs") && failLog) throw new Error("injected signup audit failure");
      return { rows: [], rowCount: 1 };
    },
    release() { calls.push("RELEASE"); },
  });
});
after(async () => { pool.query = originalQuery; pool.connect = originalConnect; await pool.end(); await server.close(); });
const signup = () => api(server.baseUrl, "/pg/auth/signup", { method: "POST", body: { email: "creator@example.invalid", name: "Creator", password: "password-1234", company_name: "New company" } });
test("new PG company creator receives finite recorded permissions in the account/session transaction", async () => {
  const result = await signup(); assert.equal(result.status, 201);
  assert.equal(result.body.user.company.id, "77");
  for (const table of ["org.companies", "org.positions", "org.departments", "org.company_modules", "auth.users", "org.permissions", "org.roles", "org.role_permissions", "org.user_roles", "auth.sessions", "auth.login_logs"]) {
    assert.ok(committed.some(q => q.sql.includes(`INSERT INTO ${table}`)), table);
  }
  const permissions = committed.find(q => q.sql.includes("INSERT INTO org.permissions")).values[0];
  assert.ok(permissions.includes("project.write")); assert.ok(!permissions.includes("*"));
  assert.ok(!permissions.some(code => code.startsWith("platform.")));
  assert.deepEqual(calls.slice(-2), ["COMMIT", "RELEASE"]);
});
test("signup audit failure rolls back company, grants, account and session on the same connection", async () => {
  failLog = true; committed = []; calls.length = 0;
  const result = await signup(); assert.equal(result.status, 500);
  assert.deepEqual(committed, []); assert.deepEqual(pending, []);
  assert.deepEqual(calls.slice(-2), ["ROLLBACK", "RELEASE"]);
  assert.ok(!calls.includes("COMMIT"));
});
