import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";

import { api, startTestServer } from "./http.js";

describe("PG agent chat against an actual isolated PGlite engine", { timeout: 120000 }, () => {
  let engine;
  let server;
  let pool;
  let originalQuery;
  let actor;
  const sqlLog = [];

  before(async () => {
    process.env.OPENROUTER_API_KEY = "";
    engine = new PGlite();
    await engine.exec(`
      CREATE SCHEMA auth; CREATE SCHEMA org; CREATE SCHEMA project; CREATE SCHEMA notes; CREATE SCHEMA ai;
      CREATE TABLE auth.users(id bigint PRIMARY KEY,company_id bigint,department_id bigint,position_id bigint,email text,name text,is_admin boolean DEFAULT false,
        account_status text DEFAULT 'active',approval_status text DEFAULT 'approved');
      CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id bigint,session_token uuid,is_active boolean DEFAULT true,login_at timestamptz DEFAULT now());
      CREATE TABLE org.companies(id bigint PRIMARY KEY,name text,is_active boolean DEFAULT true);
      CREATE TABLE org.company_memberships(company_id bigint,user_id bigint,department_id bigint,position_id bigint,status text DEFAULT 'active',created_at timestamptz DEFAULT now());
      CREATE TABLE org.roles(id bigint PRIMARY KEY,company_id bigint,name text,deleted_at timestamptz);
      CREATE TABLE org.permissions(id bigint PRIMARY KEY,code text);
      CREATE TABLE org.role_permissions(role_id bigint,permission_id bigint);
      CREATE TABLE org.user_roles(user_id bigint,role_id bigint,workspace_id bigint);
      CREATE TABLE org.company_modules(company_id bigint,module_key text);
      CREATE TABLE org.approval_requests(id bigint PRIMARY KEY,company_id bigint,requester_id bigint,title text,request_type text,status text,
        created_at timestamptz DEFAULT now(),workflow_locked boolean DEFAULT true,version integer DEFAULT 1);
      CREATE TABLE project.projects(id bigint PRIMARY KEY,company_id bigint,name text);
      CREATE TABLE project.documents(id bigint PRIMARY KEY,project_id bigint,title text,content_md text,updated_at timestamptz DEFAULT now());
      CREATE TABLE project.tasks(id bigint PRIMARY KEY,project_id bigint,assignee_id bigint,title text,due_on date,status text);
      CREATE TABLE notes.vaults(id bigint PRIMARY KEY,owner_id bigint);
      CREATE TABLE notes.notes(id bigint PRIMARY KEY,vault_id bigint,title text,content_md text,updated_at timestamptz DEFAULT now());
      CREATE TABLE ai.agent_memory(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_id bigint,user_id bigint,key text,value text,
        updated_at timestamptz DEFAULT now(),UNIQUE(user_id,key));
    `);
    const token = randomUUID();
    await engine.query("INSERT INTO auth.users(id,company_id,email,name) VALUES(501,77,'native@example.invalid','Native Agent')");
    await engine.query("INSERT INTO auth.sessions(id,user_id,session_token) VALUES($1,501,$2)", [randomUUID(), token]);
    await engine.query("INSERT INTO org.companies(id,name) VALUES(77,'Native Company')");
    await engine.query("INSERT INTO org.company_memberships(company_id,user_id) VALUES(77,501)");
    await engine.query("INSERT INTO org.roles(id,company_id,name) VALUES(1,77,'agent-owner')");
    const codes = ["agent.chat", "menu.agent", "task.read", "document.read", "approval.decide", "menu.approvals"];
    for (const [index, code] of codes.entries()) await engine.query("INSERT INTO org.permissions(id,code) VALUES($1,$2)", [index + 1, code]);
    await engine.query("INSERT INTO org.role_permissions(role_id,permission_id) SELECT 1,id FROM org.permissions");
    await engine.query("INSERT INTO org.user_roles(user_id,role_id) VALUES(501,1)");
    for (const module of ["agent", "documents", "tasks", "approvals"]) await engine.query("INSERT INTO org.company_modules(company_id,module_key) VALUES(77,$1)", [module]);
    await engine.query("INSERT INTO project.projects(id,company_id,name) VALUES(7,77,'Native Project')");
    await engine.query("INSERT INTO project.documents(id,project_id,title,content_md) VALUES(31,7,'Native document','nativecompanyneedle')");
    await engine.query("INSERT INTO project.tasks(id,project_id,assignee_id,title,due_on,status) VALUES(41,7,501,'NATIVE_CHAT_TASK',$1,'todo')", [new Date().toISOString().slice(0, 10)]);
    await engine.query("INSERT INTO org.approval_requests(id,company_id,requester_id,title,request_type,status) VALUES(51,77,700,'NATIVE_CHAT_APPROVAL','generic','pending')");
    await engine.query("INSERT INTO notes.vaults(id,owner_id) VALUES(9,501)");
    await engine.query("INSERT INTO notes.notes(id,vault_id,title,content_md) VALUES(99,9,'Native private','nativevaultneedle')");

    server = await startTestServer();
    ({ pgPool: pool } = await import("../src/config/pg.js"));
    originalQuery = pool.query;
    pool.query = async (sql, values = []) => { sqlLog.push(sql); return engine.query(sql, values); };
    actor = { token, orgId: "pg:77" };
  });

  after(async () => {
    if (pool) pool.query = originalQuery;
    await pool?.end();
    await server?.close();
    await engine?.close();
  });

  const request = (path, options = {}) => api(server.baseUrl, path, { ...actor, ...options });

  it("executes scoped chat, briefing, approvals and memory SQL on the PG engine", async () => {
    const start = sqlLog.length;
    const chat = await request("/pg/agent/chat", { method: "POST", body: { message: "nativecompanyneedle nativevaultneedle", vault_mode: "off" } });
    assert.equal(chat.status, 200, JSON.stringify(chat.body));
    assert.equal(chat.body.scope.vault_mode, "off");
    assert.deepEqual(chat.body.answer.evidence.map(item => item.id), ["31"]);
    assert.ok(!sqlLog.slice(start).some(sql => sql.includes("notes.notes")));

    const brief = await request("/pg/agent/brief");
    assert.equal(brief.status, 200, JSON.stringify(brief.body));
    assert.ok(brief.body.items.some(item => item.title === "NATIVE_CHAT_TASK"));
    const pending = await request("/pg/agent/pending-approvals");
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.deepEqual(pending.body.items.map(item => item.title), ["NATIVE_CHAT_APPROVAL"]);

    const created = await request("/pg/agent/memory", { method: "POST", body: { key: "style", value: "brief" } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual((await request("/pg/agent/memory")).body.items, [{ id: created.body.id, key: "style", value: "brief" }]);
    assert.equal((await request(`/pg/agent/memory/${created.body.id}`, { method: "DELETE" })).status, 200);
    assert.deepEqual((await request("/pg/agent/memory")).body.items, []);
  });
});
