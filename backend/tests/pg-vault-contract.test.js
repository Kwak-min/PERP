import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { randomUUID } from "node:crypto";
import { api, startTestServer } from "./http.js";
process.env.DATABASE_URL = "";
process.env.PG_HOST = "127.0.0.1";
process.env.PG_PORT = "1";
const token = randomUUID();
const alien = randomUUID();
const memberships = ["101", "202"].map(user_id => ({ user_id, company_id: "77", department_id: null, position_id: null, name: "PG Vault company" }));
const notes = new Map([
  ["1", { id: "1", owner: "101", title: "Source", content_md: "[[Target|label]] [[Duplicate#heading]] [[Missing]]", folder_path: "/", version: 21 }],
  ["2", { id: "2", owner: "101", title: "Target", content_md: "", folder_path: "/second", version: 22 }],
  ["3", { id: "3", owner: "101", title: "Duplicate", content_md: "", folder_path: "/", version: 23 }],
  ["4", { id: "4", owner: "101", title: "Duplicate", content_md: "", folder_path: "/second", version: 24 }],
  ["5", { id: "5", owner: "202", title: "Foreign", content_md: "private", folder_path: "/", version: 25 }],
]);
let server, pool, originalQuery;
const queries = [];
before(async () => {
  server = await startTestServer();
  ({ pgPool: pool } = await import("../src/config/pg.js")); originalQuery = pool.query;
  pool.query = async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.includes("FROM auth.sessions s")) return { rows: [{ id: values[0] === alien ? "202" : "101", session_id: "session", company_id: "77", name: "Fixture", email: "fixture@example.invalid", account_status: "active", approval_status: "approved", login_at: new Date().toISOString() }] };
    if (sql.includes("FROM org.company_memberships m JOIN org.companies c")) return { rows: memberships.filter(m => m.user_id === values[0] && m.company_id === values[1]) };
    if (sql.includes("FROM org.user_roles") || sql.includes("FROM org.company_modules")) return { rows: [] };
    if (sql.includes("FROM notes.vaults WHERE owner_id")) return { rows: [{ id: "12" }] };
    if (sql.includes("UPDATE notes.notes")) {
      assert.match(sql, /n\.xmin::text\s*=\s*\$6/);
      assert.match(sql, /v\.owner_id\s*=\s*\$2/);
      const row = notes.get(String(values[0]));
      if (!row || row.owner !== values[1] || String(row.version) !== String(values[5])) return { rows: [], rowCount: 0 };
      if (values[2] !== null) row.title = values[2];
      if (values[3] !== null) row.content_md = values[3];
      if (values[4] !== null) row.folder_path = values[4];
      row.version += 100;
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO notes.notes")) {
      assert.match(sql, /RETURNING.*xmin::text/s);
      const row = { id: "6", owner: "101", title: values[2], content_md: values[3], folder_path: values[1], version: 101 };
      notes.set(row.id, row); return { rows: [row], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM notes.notes")) {
      assert.match(sql, /v\.owner_id\s*=\s*\$2/);
      const row = notes.get(String(values[0]));
      if (!row || row.owner !== values[1]) return { rowCount: 0, rows: [] };
      notes.delete(row.id); return { rowCount: 1, rows: [] };
    }
    if (sql.includes("FROM notes.notes n JOIN notes.vaults v")) {
      assert.match(sql, /v\.owner_id\s*=\s*\$[12]/);
      if (sql.includes("n.id = $1")) {
        const row = notes.get(String(values[0]));
        return { rows: row?.owner === values[1] ? [{ ...row }] : [] };
      }
      return { rows: [...notes.values()].filter(row => row.owner === values[0]).map(row => ({ ...row })) };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
});
after(async () => { pool.query = originalQuery; await pool.end(); await server.close(); });
const request = (route, options = {}) => api(server.baseUrl, `/pg/vault${route}`, { token, orgId: "pg:77", ...options });

test("list and graph read the same owner-wide notes without creating a vault", async () => {
  const before = queries.length;
  const list = await request("/notes");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items.map(n => n.id).sort(), ["1", "2", "3", "4"]);
  assert.equal(list.body.items[0].version, 21);
  assert.deepEqual(list.body.capabilities, { tags: false, pinned: false, agent_enabled: false });
  const graph = await request("/graph");
  assert.equal(graph.status, 200);
  assert.deepEqual(graph.body.nodes.map(n => n.id).sort(), ["1", "2", "3", "4"]);
  assert.deepEqual(graph.body.edges, [
    { source: "1", target_id: "2", target_title: "Target" },
    { source: "1", target_id: null, target_title: "Duplicate" },
    { source: "1", target_id: null, target_title: "Missing" },
  ]);
  assert.deepEqual(graph.body.orphans.sort(), ["3", "4"]);
  assert.ok(!queries.slice(before).some(q => /INSERT|UPDATE|DELETE/.test(q.sql)));
});
test("full detail and atomic versioned saves share ownership and reject lost updates", async () => {
  const detail = await request("/notes/1"); assert.equal(detail.status, 200);
  const body = { content: "saved", title: "Source", folder: "/", version: detail.body.version };
  const saved = await request("/notes/1", { method: "PATCH", body });
  assert.equal(saved.status, 200); assert.equal(saved.body.content, "saved"); assert.notEqual(saved.body.version, body.version);
  const stale = await request("/notes/1", { method: "PATCH", body });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, "VERSION_CONFLICT");
  assert.equal((await request("/notes/1")).body.version, saved.body.version);
  assert.equal((await request("/notes/1", { method: "PATCH", body: { content: "blind" } })).status, 400);
  assert.equal((await request("/notes/1", { method: "PATCH", body: { version: saved.body.version, tags: ["unsupported"] } })).status, 400);
});
test("nonowners receive 404 for detail, update and delete without changing the record", async () => {
  for (const method of ["GET", "PATCH", "DELETE"]) {
    const result = await request("/notes/1", { token: alien, method, ...(method === "PATCH" ? { body: { version: notes.get("1").version, content: "attack" } } : {}) });
    assert.equal(result.status, 404);
  }
  assert.equal(notes.get("1").content_md, "saved");
});
test("create returns persisted detail and version, not an id-only receipt", async () => {
  const created = await request("/notes", { method: "POST", body: { title: "Created", content: "persisted", folder: "/new" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, "Created"); assert.equal(created.body.content, "persisted"); assert.equal(created.body.version, 101);
});
test("graph does not silently truncate a thousand persisted notes", async () => {
  for (let i = 100; i < 1100; i++) notes.set(String(i), { id: String(i), owner: "101", title: `Note ${i}`, content_md: "", folder_path: "/", version: i });
  const graph = await request("/graph");
  assert.equal(graph.status, 200); assert.equal(graph.body.nodes.length, 1005);
});
