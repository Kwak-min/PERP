import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test, { after, before } from "node:test";

import { api } from "./http.js";
import { startEmbeddingFixture } from "./vault-semantic-fixture.js";
import { startPgDocumentFixture } from "./pg-document-fixture.js";

let fixture, wire;
const request = (actor, route, options = {}) => api(fixture.baseUrl, `/pg/documents${route}`, { ...actor, ...options });
const upload = (actor, filename, content, extra = {}) => request(actor, "/upload", {
  method: "POST",
  body: {
    filename,
    mime: filename.endsWith(".md") ? "text/markdown" : "text/plain",
    content_base64: Buffer.from(content).toString("base64"),
    project_id: "10",
    ...extra,
  },
});

before(async () => {
  delete process.env.ORBITFLOW_DOCUMENT_EMBEDDING_MODEL;
  fixture = await startPgDocumentFixture();
});

after(async () => {
  await fixture?.close();
  await wire?.close();
  delete process.env.ORBITFLOW_DOCUMENT_EMBEDDING_MODEL;
});

test("PG upload persists source metadata and extracted text in the selected company while honestly reporting no model", async () => {
  const content = "# PG uploaded launch\n\npglaunch persisted extracted body";
  const response = await upload(fixture.actors.writer, "pg-launch.md", content);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.analysis.state, "unavailable");
  assert.equal(response.body.analysis.reason, "model_not_configured");
  assert.equal(response.body.filename, "pg-launch.md");
  assert.equal(response.body.extraction.format, "markdown");

  const document = fixture.state.documents.find((row) => row.id === response.body.id);
  assert.equal(document.content_md, content);
  assert.equal(document.project_id, "10");
  const file = fixture.state.files.find((row) => row.id === document.file_id);
  assert.equal(file.company_id, "77");
  assert.equal(file.uploader_id, "101");
  assert.equal(file.original_name, "pg-launch.md");
  assert.deepEqual(await readFile(path.join(fixture.uploadRoot, file.storage_key)), Buffer.from(content));

  const detail = await request(fixture.actors.writer, `/${response.body.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.content, content);
  assert.equal(detail.body.version, 1);
  const graph = await request(fixture.actors.writer, "/graph");
  assert.equal(graph.status, 200, JSON.stringify(graph.body));
  assert.ok(graph.body.nodes.some((node) => node.id === response.body.id && node.folder === "출시 프로젝트"));
  assert.equal(graph.body.edges.filter((edge) => edge.kind === "ai_similarity").length, 0);
  assert.ok(graph.body.analysis.every((item) => item.state === "unavailable"));
});

test("PG document routes enforce write/read/module company boundaries and reject unsupported formats before side effects", async () => {
  const before = { documents: fixture.state.documents.length, files: fixture.state.files.length };
  assert.equal((await upload(fixture.actors.reader, "denied.md", "denied")).status, 403);
  assert.equal((await upload(fixture.actors.writer, "cross-company.md", "denied", { project_id: "20" })).status, 400);
  const pdf = await request(fixture.actors.writer, "/upload", {
    method: "POST",
    body: { filename: "policy.pdf", mime: "application/pdf", content_base64: Buffer.from("%PDF").toString("base64"), project_id: "10" },
  });
  assert.equal(pdf.status, 415);
  assert.equal(fixture.state.documents.length, before.documents);
  assert.equal(fixture.state.files.length, before.files);

  const foreignGraph = await request(fixture.actors.foreign, "/graph");
  assert.equal(foreignGraph.status, 200);
  assert.deepEqual(foreignGraph.body.nodes.map((node) => node.title), ["외부 프로젝트", "외부 문서"]);
  assert.ok(!JSON.stringify(foreignGraph.body).includes("pglaunch"));
  assert.equal((await request(fixture.actors.writer, "/3")).status, 404);
  assert.equal((await request(fixture.actors.writer, "/3/analysis")).status, 404);

  const storedFiles = await readdir(fixture.uploadRoot, { recursive: true });
  assert.equal(storedFiles.filter((entry) => entry.endsWith(".md") || entry.endsWith(".txt")).length, 1);
});

test("configured localhost embeddings relate only selected-company PG documents and versioned updates invalidate old edges", async () => {
  wire = await startEmbeddingFixture();
  process.env.OLLAMA_BASE_URL = wire.baseUrl;
  process.env.ORBITFLOW_DOCUMENT_EMBEDDING_MODEL = "synthetic-pg-document-wire-v1";
  const uploaded = await upload(fixture.actors.writer, "semantic.md", "SYNTH_PARAPHRASE pglaunch", { title: "PG semantic upload" });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.analysis.state, "pending");
  const analyzed = await request(fixture.actors.writer, `/${uploaded.body.id}/analysis?wait=1`);
  assert.equal(analyzed.status, 200);
  assert.equal(analyzed.body.state, "ready");
  let graph = await request(fixture.actors.writer, "/graph?wait=1");
  const edges = graph.body.edges.filter((edge) => edge.kind === "ai_similarity" && edge.source === uploaded.body.id);
  assert.equal(edges.length, 1, JSON.stringify(graph.body.edges));
  assert.equal(edges[0].target_id, "1");
  assert.notEqual(edges[0].target_id, "2");
  assert.equal(edges[0].provenance.provider, "ollama-local");
  assert.ok(wire.calls.every((call) => !JSON.stringify(call.body).includes("FOREIGN_PG_DOCUMENT_ONLY")));

  const changed = await request(fixture.actors.writer, `/${uploaded.body.id}`, {
    method: "PATCH",
    body: { version: uploaded.body.version, content: "SYNTH_IRRELEVANT changed" },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.version, uploaded.body.version + 1);
  graph = await request(fixture.actors.writer, "/graph");
  assert.ok(!graph.body.edges.some((edge) => edge.kind === "ai_similarity" && edge.source === uploaded.body.id && edge.target_id === "1"));
  assert.equal((await request(fixture.actors.writer, `/${uploaded.body.id}`, { method: "PATCH", body: { version: uploaded.body.version, content: "stale" } })).status, 409);

  const generic = await api(fixture.baseUrl, `/pg/records/documents/${uploaded.body.id}`, {
    ...fixture.actors.writer,
    method: "PATCH",
    body: { content_md: "SYNTH_RELATED generic editor change", version: changed.body.version },
  });
  assert.equal(generic.status, 200);
  assert.equal(generic.body.version, changed.body.version + 1);
  const genericDetail = await request(fixture.actors.writer, `/${uploaded.body.id}`);
  assert.equal(genericDetail.body.version, changed.body.version + 1);
  assert.equal(genericDetail.body.analysis.state, "not_analyzed");
  const removed = await api(fixture.baseUrl, `/pg/records/documents/${uploaded.body.id}`, { ...fixture.actors.writer, method: "DELETE" });
  assert.equal(removed.status, 200);
  graph = await request(fixture.actors.writer, "/graph");
  assert.ok(!graph.body.nodes.some((node) => node.id === uploaded.body.id));
  assert.ok(!graph.body.edges.some((edge) => edge.source === uploaded.body.id || edge.target_id === uploaded.body.id));
});
