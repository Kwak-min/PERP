import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { randomUUID } from "node:crypto";
import { api, startTestServer } from "./http.js";

process.env.DATABASE_URL = "";
process.env.PG_HOST = "127.0.0.1";
process.env.PG_PORT = "1";
let server, pool, originalQuery;
const sessions = new Map();
// 검증된 소속 픽스처는 역할 grant와 독립적이다.
const memberships = [{ user_id: "101", company_id: "77", department_id: null, position_id: null, name: "PG company" }];
const queries = [];
let grants = [];
let modules = ["projects", "tasks", "documents", "calendar", "finance", "hr", "agent"];
function session(overrides = {}) {
  const token = randomUUID();
  sessions.set(token, { id: "101", session_id: randomUUID(), company_id: "77", name: "PG", email: "pg@example.invalid", is_admin: true, account_status: "active", approval_status: "approved", login_at: new Date().toISOString(), ...overrides });
  return token;
}
before(async () => {
  server = await startTestServer();
  ({ pgPool: pool } = await import("../src/config/pg.js"));
  originalQuery = pool.query;
  pool.query = async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.includes("FROM auth.sessions s")) return { rows: sessions.has(values[0]) ? [sessions.get(values[0])] : [] };
    if (sql.includes("FROM org.company_memberships m JOIN org.companies c")) return { rows: memberships.filter(m => m.user_id === values[0] && (!values[1] || m.company_id === values[1])) };
    if (sql.includes("FROM org.user_roles")) return { rows: grants.map(code => ({ code, role: "configured" })) };
    if (sql.includes("FROM org.company_modules")) return { rows: modules.map(module_key => ({ module_key })) };
    if (sql.includes("FROM org.companies")) return { rows: [{ name: "PG company" }] };
    if (sql.includes("FROM notes.vaults WHERE owner_id")) return { rows: [{ id: "12" }] };
    if (sql.includes("FROM notes.notes n JOIN notes.vaults v")) return { rows: [{ id: "5", title: "Personal", content_md: "body", folder_path: "/", version: "1" }] };
    if (sql.includes("SELECT 1 FROM project.projects")) return { rows: [{ exists: 1 }] };
    if (/INSERT INTO (project.tasks|org.approval_requests|org.departments)/.test(sql)) return { rows: [{ id: "44" }], rowCount: 1 };
    if (sql.includes("AS revenue")) return { rows: [{ revenue: 0, expense: 0 }] };
    if (sql.includes("FROM project.projects p")) return { rows: [{ __id: "10", 프로젝트: "PG project" }] };
    if (sql.includes("INSERT INTO project.projects")) return { rows: [{ id: "11" }], rowCount: 1 };
    if (sql.includes("UPDATE notes.notes")) return { rows: [{ id: "5", title: "Personal", content_md: "updated", folder_path: "/", version: "2" }], rowCount: values[1] === "101" ? 1 : 0 };
    return { rows: [], rowCount: 1 };
  };
});
after(async () => { pool.query = originalQuery; await pool.end(); await server.close(); });

test("PG endpoints reject expired, inactive and unapproved identities before domain SQL", async () => {
  for (const overrides of [{ login_at: "2000-01-01" }, { account_status: "disabled" }, { approval_status: "pending" }]) {
    const token = session(overrides);
    const before = queries.length;
    const response = await api(server.baseUrl, "/pg/projects", { token, orgId: "pg:77" });
    assert.equal(response.status, 401);
    assert.ok(!queries.slice(before).some(q => q.sql.includes("FROM project.projects")));
  }
});
test("PG admin flag alone cannot read finance, provision accounts, mutate modules or decide leave", async () => {
  const token = session(); grants = [];
  for (const [route, method, body] of [["/pg/finance/summary", "GET"], ["/pg/members", "POST", { email: "new@example.invalid", name: "New", password: "password-123" }], ["/pg/org/modules", "PATCH", { enabled: [] }], ["/pg/hr/leaves/4/decide", "POST", { decision: "approve" }]]) {
    const result = await api(server.baseUrl, route, { token, orgId: "pg:77", method, body });
    assert.equal(result.status, 403, route);
  }
});
test("PG company selection, explicit grants and modules govern real project SQL", async () => {
  const token = session(); grants = ["project.read", "project.write"];
  assert.equal((await api(server.baseUrl, "/pg/projects", { token, orgId: "pg:88" })).status, 403);
  assert.equal((await api(server.baseUrl, "/pg/projects", { token, orgId: "legacy-org" })).status, 403);
  assert.equal((await api(server.baseUrl, "/pg/projects", { token })).status, 400);
  const list = await api(server.baseUrl, "/pg/projects", { token, orgId: "pg:77" });
  assert.equal(list.status, 200); assert.equal(list.body.items[0].__id, "10");
  const created = await api(server.baseUrl, "/pg/projects", { method: "POST", token, orgId: "pg:77", body: { name: "Created" } });
  assert.equal(created.status, 201); assert.deepEqual(created.body, { id: "11" });
  assert.ok(queries.some(q => q.sql.includes("INSERT INTO project.projects") && q.values[0] === "77" && q.values.at(-1) === "101"));
  modules = [];
  assert.equal((await api(server.baseUrl, "/pg/projects", { token, orgId: "pg:77" })).body.error.code, "MODULE_DISABLED");
  modules = ["projects", "agent"];
});
test("personal PG Vault remains owner-scoped without organization permissions", async () => {
  const token = session(); grants = [];
  const result = await api(server.baseUrl, "/pg/vault/notes", { token, orgId: "pg:77" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.items, [{ id: "5", title: "Personal", content: "body", folder: "/", tags: [], pinned: false, agent_enabled: false, version: 1 }]);
  const patched = await api(server.baseUrl, "/pg/vault/notes/5", { method: "PATCH", token, orgId: "pg:77", body: { content: "updated", version: 1 } });
  assert.equal(patched.status, 200);
  assert.ok(queries.some(q => q.sql.includes("UPDATE notes.notes") && q.values[1] === "101"));
});
test("unimplemented PG writes cannot report operational success", async () => {
  const token = session(); grants = ["organization.settings"];
  for (const path of ["/pg/members/home-layout", "/pg/members/departments/1/access"]) {
    const result = await api(server.baseUrl, path, { method: "PUT", token, orgId: "pg:77", body: {} });
    assert.equal(result.status, 501);
    assert.equal(result.body.error.code, "NOT_IMPLEMENTED");
  }
});
test("cross-company relationship IDs are rejected before insertion or reassignment", async () => {
  const token = session(); grants = ["task.write", "approval.request", "department.write"]; modules = ["tasks", "approvals"];
  for (const [route, method, body] of [
    ["/pg/tasks", "POST", { project_id: "10", title: "Fixture", assignee_id: "foreign" }],
    ["/pg/approvals", "POST", { request_type: "Fixture", target_user_id: "foreign" }],
    ["/pg/members/departments", "POST", { name: "Fixture", parent_id: "foreign" }],
    ["/pg/members/departments/1", "PATCH", { leader_id: "foreign" }],
  ]) {
    const start = queries.length;
    const result = await api(server.baseUrl, route, { token, orgId: "pg:77", method, body });
    assert.equal(result.status, 400, route);
    assert.ok(!queries.slice(start).some(q => /^(INSERT|UPDATE)/.test(q.sql.trim())), route);
  }
});

test("record resource whitelist rejects inherited object keys", async () => {
  const token = session(); grants = ["project.write"];
  for (const method of ["GET", "PATCH", "DELETE"]) {
    assert.equal((await api(server.baseUrl, "/pg/records/constructor/1", { token, orgId: "pg:77", method, ...(method === "GET" ? {} : { body: {} }) })).status, 400);
  }
});
