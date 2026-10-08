import assert from "node:assert/strict";
import test, { before, beforeEach, after } from "node:test";
import { randomUUID } from "node:crypto";
import { api, startTestServer } from "./http.js";
import { verifyPassword } from "../src/utils/crypto.js";
process.env.DATABASE_URL = "";
process.env.PG_HOST = "127.0.0.1";
process.env.PG_PORT = "1";
let server, pool, originalQuery, originalConnect;
let failLog = false, duplicate = false;
let committed = [];
let pending = [];
const calls = [];
const token = randomUUID();
function savedUser() {
  const insert = committed.find(q => q.sql.includes("INSERT INTO auth.users"));
  if (!insert) return null;
  const [company_id, department_id, position_id, email, name, phone, password_hash] = insert.values;
  return { id: "101", company_id, department_id, position_id, email, name, phone, password_hash,
    company_name: "New company", is_admin: /'approved', true/.test(insert.sql),
    approval_status: /VALUES \([^']*'([^']+)'/.exec(insert.sql)?.[1], account_status: "active" };
}
before(async () => {
  server = await startTestServer(); ({ pgPool: pool } = await import("../src/config/pg.js"));
  originalQuery = pool.query; originalConnect = pool.connect;
  // SQL 경계만 대체한다. 요약/세션은 실제 트랜잭션의 저장 값에서 읽는다.
  pool.query = async (sql, values = []) => {
    assert.ok(sql.trim().startsWith("SELECT"), "signup mutations must use its transaction connection");
    if (sql.includes("SELECT 1 FROM auth.users")) return { rows: duplicate ? [{ exists: 1 }] : [] };
    if (sql.includes("LEFT JOIN org.companies")) return { rows: [savedUser()] };
    if (sql.includes("FROM auth.sessions s")) return { rows: values[0] === token && savedUser()
      ? [{ ...savedUser(), session_id: "201", login_at: new Date().toISOString() }] : [] };
    if (sql.includes("FROM org.company_memberships")) return { rows: committed
      .filter(q => q.sql.includes("INSERT INTO org.company_memberships"))
      .map(q => ({ company_id: q.values[0], user_id: q.values[1], name: "New company" })) };
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
      if (sql.includes("INSERT INTO auth.users")) return { rows: [{ id: "101" }] };
      if (sql.includes("INSERT INTO org.roles")) return { rows: [{ id: "7" }] };
      if (sql.includes("INSERT INTO auth.sessions")) return { rows: [{ session_token: token, login_at: new Date().toISOString() }] };
      if (sql.includes("INSERT INTO auth.login_logs") && failLog) throw new Error("injected signup audit failure");
      return { rows: [], rowCount: 1 };
    },
    release() { calls.push("RELEASE"); },
  });
});
beforeEach(() => { failLog = false; duplicate = false; committed = []; pending = []; calls.length = 0; });
after(async () => { pool.query = originalQuery; pool.connect = originalConnect; await pool.end(); await server.close(); });
const signup = (overrides = {}) => api(server.baseUrl, "/pg/auth/signup", { method: "POST", body: {
  email: "account@example.invalid", name: "Account", password: "password-1234", ...overrides,
} });
for (const overrides of [{}, { company_name: "Ignored company", is_admin: true, company_id: "77", department_id: "8", position_id: "9" }]) {
  test(`signup creates only an ordinary account/session/log when company input is ${Object.keys(overrides).length ? "supplied" : "absent"}`, async () => {
    // Given: 회사 없는 가입 또는 이전 클라이언트의 회사/권한 값. When: 가입. Then: 계정만 생성한다.
    const result = await signup(overrides);
    assert.equal(result.status, 201);
    assert.equal(result.body.user.company, null);
    assert.equal(result.body.user.department, null);
    assert.equal(result.body.user.position, null);
    assert.equal(result.body.user.is_admin, false);
    assert.deepEqual(committed.map(q => /INSERT INTO ([\w.]+)/.exec(q.sql)?.[1]), ["auth.users", "auth.sessions", "auth.login_logs"]);
    assert.equal(savedUser().approval_status, "approved");
    assert.equal(verifyPassword("password-1234", savedUser().password_hash), true);
    assert.deepEqual(calls.slice(-2), ["COMMIT", "RELEASE"]);
    for (const route of ["/auth/me", "/pg/auth/workspace"]) {
      const workspace = await api(server.baseUrl, route, { token: result.body.token });
      assert.equal(workspace.status, 200);
      assert.deepEqual(workspace.body.organizations, []);
    }
  });
}
test("signup audit failure rolls back the account and session on the same connection", async () => {
  // Given: 마지막 기록 쓰기 실패. When: 가입. Then: 계정/세션도 rollback한다.
  failLog = true;
  const result = await signup(); assert.equal(result.status, 500);
  assert.deepEqual(committed, []); assert.deepEqual(pending, []);
  assert.deepEqual(calls.slice(-2), ["ROLLBACK", "RELEASE"]);
  assert.ok(!calls.includes("COMMIT"));
});
test("duplicate email is rejected before any transaction", async () => {
  // Given: 등록된 이메일. When: 가입. Then: 중복 오류이며 쓰기가 없다.
  duplicate = true;
  const result = await signup(); assert.equal(result.status, 409);
  assert.deepEqual(calls, []);
});
for (const overrides of [{ password: "short" }, { email: "invalid" }, { name: " " }]) {
  test(`invalid ${Object.keys(overrides)[0]} is rejected before any transaction`, async () => {
    // Given: 잘못된 계정 입력. When: 가입. Then: 검증 오류이며 쓰기가 없다.
    const result = await signup(overrides); assert.equal(result.status, 400);
    assert.deepEqual(calls, []);
  });
}
