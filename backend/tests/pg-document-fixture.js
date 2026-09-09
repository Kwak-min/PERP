import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startTestServer } from "./http.js";

export async function startPgDocumentFixture() {
  process.env.DATABASE_URL = "";
  process.env.PG_HOST = "127.0.0.1";
  process.env.PG_PORT = "1";
  const uploadRoot = path.join(tmpdir(), `orbitflow-pg-documents-${randomUUID()}`);
  process.env.ORBITFLOW_UPLOAD_DIR = uploadRoot;
  const server = await startTestServer();
  const { pgPool } = await import("../src/config/pg.js");
  const originalQuery = pgPool.query;
  const originalConnect = pgPool.connect;
  const actors = {
    writer: { token: randomUUID(), userId: "101", companyId: "77", orgId: "pg:77" },
    reader: { token: randomUUID(), userId: "102", companyId: "77", orgId: "pg:77" },
    foreign: { token: randomUUID(), userId: "201", companyId: "88", orgId: "pg:88" },
  };
  const sessions = new Map(Object.values(actors).map((actor) => [actor.token, {
    id: actor.userId,
    session_id: randomUUID(),
    company_id: actor.companyId,
    name: `PG ${actor.userId}`,
    email: `${actor.userId}@example.invalid`,
    account_status: "active",
    approval_status: "approved",
    login_at: new Date().toISOString(),
  }]));
  let state = {
    projects: [
      { id: "10", company_id: "77", name: "출시 프로젝트" },
      { id: "11", company_id: "77", name: "운영 프로젝트" },
      { id: "20", company_id: "88", name: "외부 프로젝트" },
    ],
    documents: [
      { id: "1", project_id: "10", title: "출시 안내서", content_md: "SYNTH_RELATED pglaunch", file_id: null, author_id: "101", version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: "2", project_id: "11", title: "점심 메뉴", content_md: "SYNTH_IRRELEVANT noodles", file_id: null, author_id: "101", version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: "3", project_id: "20", title: "외부 문서", content_md: "SYNTH_RELATED FOREIGN_PG_DOCUMENT_ONLY", file_id: null, author_id: "201", version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ],
    files: [],
    nextDocumentId: 4,
    nextFileId: 1,
  };
  const queries = [];

  const projectOf = (data, document) => data.projects.find((project) => project.id === document.project_id);
  const documentView = (data, document) => {
    const project = projectOf(data, document);
    return {
      ...document,
      id: String(document.id),
      project_id: String(document.project_id),
      project_name: project?.name ?? "",
      file_id: document.file_id == null ? null : String(document.file_id),
      author_id: document.author_id == null ? null : String(document.author_id),
    };
  };

  function execute(data, sql, values = []) {
    const text = sql.replace(/\s+/g, " ").trim();
    queries.push({ sql: text, values });
    if (text.includes("FROM auth.sessions s")) return { rows: sessions.has(values[0]) ? [sessions.get(values[0])] : [] };
    if (text.includes("FROM org.company_memberships m JOIN org.companies c")) {
      const session = [...sessions.values()].find((row) => row.id === values[0]);
      return { rows: session && (!values[1] || session.company_id === values[1]) ? [{ user_id: session.id, company_id: session.company_id, department_id: null, position_id: null, name: `Company ${session.company_id}` }] : [] };
    }
    if (text.startsWith("SELECT DISTINCT p.code")) {
      const codes = values[0] === actors.reader.userId ? ["document.read"] : ["document.read", "document.write"];
      return { rows: codes.map((code) => ({ code, role: values[0] === actors.reader.userId ? "reader" : "writer" })) };
    }
    if (text.includes("FROM org.company_modules")) return { rows: [{ module_key: "documents" }] };
    if (text.includes("FROM org.company_feature_settings")) return { rows: [] };
    if (text.includes("SELECT 1 FROM project.projects")) {
      return { rows: data.projects.some((project) => project.id === String(values[0]) && project.company_id === String(values[1])) ? [{ exists: 1 }] : [] };
    }
    if (text.includes("FROM project.projects") && !text.includes("project.documents")) {
      return { rows: data.projects.filter((project) => project.company_id === String(values[values.length - 1])) };
    }
    if (text.startsWith("INSERT INTO files.objects")) {
      const file = { id: String(data.nextFileId++), company_id: String(values[0]), uploader_id: String(values[1]), original_name: values[2], extension: values[3], mime_type: values[4], size_bytes: Number(values[5]), checksum_sha256: values[6], storage_bucket: values[7], storage_key: values[8] };
      data.files.push(file);
      return { rows: [file], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO project.documents")) {
      const document = { id: String(data.nextDocumentId++), project_id: String(values[0]), title: values[1], content_md: values[2], file_id: values[3] == null ? null : String(values[3]), author_id: String(values[4]), version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      data.documents.push(document);
      return { rows: [documentView(data, document)], rowCount: 1 };
    }
    if (text.startsWith("UPDATE project.documents d")) {
      const document = data.documents.find((row) => row.id === String(values[0]));
      const project = document && projectOf(data, document);
      if (!document || project?.company_id !== String(values[1]) || document.version !== Number(values[4])) return { rows: [], rowCount: 0 };
      if (values[2] !== null) document.title = values[2];
      if (values[3] !== null) document.content_md = values[3];
      document.version += 1;
      document.updated_at = new Date().toISOString();
      return { rows: [documentView(data, document)], rowCount: 1 };
    }
    if (text.startsWith("UPDATE project.documents t")) {
      const document = data.documents.find((row) => row.id === String(values[0]));
      const project = document && projectOf(data, document);
      const expectedVersion = Number(values.at(-1));
      if (!document || project?.company_id !== String(values[1]) || document.version !== expectedVersion) return { rows: [], rowCount: 0 };
      for (let index = 2; index < values.length - 1; index += 1) {
        if (text.includes(`title = $${index + 1}`)) document.title = values[index];
        if (text.includes(`content_md = $${index + 1}`)) document.content_md = values[index];
      }
      if (text.includes("version = t.version + 1")) document.version += 1;
      document.updated_at = new Date().toISOString();
      return { rows: [{ id: document.id, version: document.version }], rowCount: 1 };
    }
    if (text.startsWith("DELETE FROM project.documents")) {
      const index = data.documents.findIndex((row) => row.id === String(values[0]) && projectOf(data, row)?.company_id === String(values[1]));
      if (index < 0) return { rows: [], rowCount: 0 };
      data.documents.splice(index, 1);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("FROM project.documents t")) {
      const document = data.documents.find((row) => row.id === String(values[0]));
      const project = document && projectOf(data, document);
      if (!document || project?.company_id !== String(values[1])) return { rows: [], rowCount: 0 };
      return { rows: [{ ...(text.includes("SELECT t.id") ? { id: document.id } : {}), title: document.title, content_md: document.content_md, version: document.version }], rowCount: 1 };
    }
    if (text.includes("FROM project.documents d") && text.includes("JOIN project.projects p")) {
      const companyId = String(text.includes("d.id = $1") ? values[1] : values[0]);
      let documents = data.documents.filter((document) => projectOf(data, document)?.company_id === companyId);
      if (text.includes("d.id = $1")) documents = documents.filter((document) => document.id === String(values[0]));
      if (text.includes("LIMIT $2")) documents = documents.slice(0, Number(values[1]));
      return { rows: documents.map((document) => documentView(data, document)), rowCount: documents.length };
    }
    throw new Error(`Unexpected PG document fixture SQL: ${text}`);
  }

  pgPool.query = async (sql, values) => execute(state, sql, values);
  pgPool.connect = async () => {
    let pending;
    return {
      async query(sql, values) {
        if (sql === "BEGIN") { pending = structuredClone(state); return { rows: [] }; }
        if (sql === "COMMIT") { state = pending; pending = undefined; return { rows: [] }; }
        if (sql === "ROLLBACK") { pending = undefined; return { rows: [] }; }
        return execute(pending, sql, values);
      },
      release() {},
    };
  };

  return {
    ...server,
    actors,
    queries,
    uploadRoot,
    get state() { return state; },
    async close() {
      pgPool.query = originalQuery;
      pgPool.connect = originalConnect;
      await pgPool.end();
      await server.close();
      await rm(uploadRoot, { recursive: true, force: true });
      delete process.env.ORBITFLOW_UPLOAD_DIR;
    },
  };
}
