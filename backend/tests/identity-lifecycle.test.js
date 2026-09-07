import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { randomUUID } from "node:crypto";
import { startTestServer, api, createOwnerOrg } from "./http.js";

process.env.DATABASE_URL = "";
process.env.PG_HOST = "127.0.0.1";
process.env.PG_PORT = "1";
let server, conn, pool, originalQuery;
const pgSessions = new Map();
before(async () => {
  server = await startTestServer();
  conn = (await import("../src/config/db.js")).db();
  pool = (await import("../src/config/pg.js")).pgPool;
  originalQuery = pool.query;
  // SQL 경계만 대체하고 HTTP, 인증, SQLite 소속/RBAC/모듈은 실제로 실행한다.
  pool.query = async (sql, values = []) => {
    if (sql.includes("FROM auth.sessions s")) {
      const row = pgSessions.get(values[0]);
      return { rows: row?.is_active ? [row] : [] };
    }
    if (sql.includes("UPDATE auth.sessions")) {
      for (const row of pgSessions.values()) {
        if (String(row.session_id) === String(values[0]) || row.token === values[0] || String(row.id) === String(values[0])) row.is_active = false;
      }
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected PG fixture query: ${sql}`);
  };
});
after(async () => { pool.query = originalQuery; await pool.end(); await server.close(); });

function pgSession(overrides = {}) {
  const token = randomUUID();
  pgSessions.set(token, { token, session_id: randomUUID(), id: "9001", email: "pg-user@example.com", name: "PG 사용자", is_admin: true, company_id: "77", account_status: "active", approval_status: "approved", login_at: new Date().toISOString(), is_active: true, ...overrides });
  return token;
}
async function invite(owner, email) {
  const result = await api(server.baseUrl, "/members/invites", { method: "POST", token: owner.token, orgId: owner.orgId, body: { email, roles: ["member"] } });
  assert.equal(result.status, 201);
  return result.body;
}

test("조직 생성 검증 실패는 tenant를 남기지 않는다", async () => {
  const owner = await createOwnerOrg(server.baseUrl, []);
  const beforeCount = conn.prepare("SELECT count(*) AS n FROM tenant").get().n;
  const result = await api(server.baseUrl, "/tenants", { method: "POST", token: owner.token, body: { name: "invalid", modules: ["not-a-module"] } });
  assert.equal(result.status, 400);
  assert.equal(conn.prepare("SELECT count(*) AS n FROM tenant").get().n, beforeCount);
});

test("잘못된 초대 회원가입은 사용자와 세션을 남기지 않는다", async () => {
  const email = "invalid-invite@example.com";
  const result = await api(server.baseUrl, "/auth/signup", { method: "POST", body: { email, name: "Invalid", password: "password-1234", invitation_token: "missing" } });
  assert.equal(result.status, 400);
  assert.equal(conn.prepare("SELECT id FROM app_user WHERE email = ?").get(email), undefined);
});

test("자기 신고 이메일만으로 초대 목록이나 ID 수락 권한을 얻지 않는다", async () => {
  const owner = await createOwnerOrg(server.baseUrl, []);
  const invitation = await invite(owner, "claimed@example.com");
  const signup = await api(server.baseUrl, "/auth/signup", { method: "POST", body: { email: "claimed@example.com", name: "Claim", password: "password-1234" } });
  const token = signup.body.access_token;
  const mailbox = await api(server.baseUrl, "/auth/invitations", { token });
  assert.deepEqual(mailbox.body.items, []);
  const refused = await api(server.baseUrl, "/auth/invitations/accept", { method: "POST", token, body: { invitation_id: invitation.id } });
  assert.equal(refused.status, 400);
  const accepted = await api(server.baseUrl, "/auth/invitations/accept", { method: "POST", token, body: { token: invitation.token } });
  assert.equal(accepted.status, 201);
});

test("실제 선택 조직의 principal만 노출하고 삭제된 조직은 거절한다", async () => {
  const owner = await createOwnerOrg(server.baseUrl, []);
  const result = await api(server.baseUrl, "/auth/principal", { token: owner.token, orgId: owner.orgId });
  assert.equal(result.status, 200);
  assert.equal(result.body.userId, owner.userId);
  assert.equal(result.body.orgId, owner.orgId);
  assert.ok(result.body.permissions.includes("*"));
  const denied = await api(server.baseUrl, "/auth/principal", { token: owner.token, orgId: randomUUID() });
  assert.equal(denied.status, 403);
  conn.prepare("UPDATE organization SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), owner.orgId);
  assert.equal((await api(server.baseUrl, "/auth/principal", { token: owner.token, orgId: owner.orgId })).status, 403);
});

test("PG 주체는 이메일/숫자 ID를 자동 연결하지 않고 실제 소속으로 권한을 해석한다", async () => {
  const owner = await createOwnerOrg(server.baseUrl, []);
  const email = conn.prepare("SELECT email FROM app_user WHERE id = ?").get(owner.userId).email;
  const token = pgSession({ id: owner.userId, email });
  const me = await api(server.baseUrl, "/auth/me", { token });
  assert.equal(me.status, 200);
  assert.notEqual(me.body.id, owner.userId);
  assert.deepEqual(me.body.organizations, []);
  assert.equal((await api(server.baseUrl, "/tenants/current", { token, orgId: owner.orgId })).status, 403);
  const created = await api(server.baseUrl, "/tenants", { method: "POST", token, body: { name: "PG 운영조직", type: "custom", modules: [], departments: [] } });
  assert.equal(created.status, 201);
  const orgId = created.body.org_id;
  const principal = await api(server.baseUrl, "/auth/principal", { token, orgId });
  assert.equal(principal.status, 200);
  assert.equal(principal.body.userId, me.body.id);
  assert.ok(conn.prepare("SELECT id FROM app_user WHERE id = ?").get(me.body.id));
  conn.prepare("UPDATE membership SET roles = ? WHERE user_id = ? AND org_id = ?").run("member", me.body.id, orgId);
  const member = await api(server.baseUrl, "/auth/principal", { token, orgId });
  assert.deepEqual(member.body.roles, ["member"]);
  assert.ok(!member.body.permissions.includes("*"));
  assert.ok(member.body.permissions.includes("reservation.create"));
  assert.equal((await api(server.baseUrl, "/tenants/current", { method: "PATCH", token, orgId, body: { name: "no" } })).status, 403);
  assert.equal((await api(server.baseUrl, "/assets", { token, orgId })).body.error.code, "MODULE_DISABLED");
});

test("PG 만료/비활성 토큰 거절 및 공통 로그아웃은 PG 세션을 폐기한다", async () => {
  const expired = pgSession({ login_at: "2000-01-01T00:00:00.000Z" });
  assert.equal((await api(server.baseUrl, "/auth/me", { token: expired })).status, 401);
  const inactive = pgSession({ account_status: "disabled" });
  assert.equal((await api(server.baseUrl, "/pg/auth/me", { token: inactive })).status, 401);
  const token = pgSession({ id: "9002", email: "logout@example.com" });
  assert.equal((await api(server.baseUrl, "/auth/logout", { method: "POST", token })).status, 200);
  assert.equal(pgSessions.get(token).is_active, false);
  assert.equal((await api(server.baseUrl, "/auth/me", { token })).status, 401);
});
