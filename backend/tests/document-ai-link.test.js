import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";
import { startEmbeddingFixture } from "./vault-semantic-fixture.js";

let server, wire, owner, member, other, database, uploadRoot;
const request = (actor, route, options = {}) => api(server.baseUrl, route, { ...actor, ...options });
const createDoc = async (actor, body) => {
  const response = await request(actor, "/documents", { method: "POST", body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
};
const upload = async (actor, filename, content, extra = {}) => request(actor, "/documents/upload", {
  method: "POST",
  body: {
    filename,
    mime: filename.endsWith(".md") ? "text/markdown" : "text/plain",
    content_base64: Buffer.from(content).toString("base64"),
    ...extra,
  },
});

before(async () => {
  wire = await startEmbeddingFixture();
  process.env.OLLAMA_BASE_URL = wire.baseUrl;
  process.env.ORBITFLOW_DOCUMENT_EMBEDDING_MODEL = "synthetic-document-wire-v1";
  uploadRoot = path.join(tmpdir(), `orbitflow-document-upload-${crypto.randomUUID()}`);
  process.env.ORBITFLOW_UPLOAD_DIR = uploadRoot;
  server = await startTestServer();
  ({ db: database } = await import("../src/config/db.js"));
  owner = await createOwnerOrg(server.baseUrl, ["documents", "agent"]);
  other = await createOwnerOrg(server.baseUrl, ["documents", "agent"]);

  const email = `document-reader-${crypto.randomUUID()}@example.com`;
  const invitation = await request(owner, "/members/invites", { method: "POST", body: { email, roles: ["member"] } });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const signup = await api(server.baseUrl, "/auth/signup", {
    method: "POST",
    body: { email, name: "Document reader", password: "password-1234", invitation_token: invitation.body.token },
  });
  assert.equal(signup.status, 201, JSON.stringify(signup.body));
  member = { token: signup.body.access_token, orgId: owner.orgId, userId: signup.body.user.id };
});

after(async () => {
  await server?.close();
  await wire?.close();
  await rm(uploadRoot, { recursive: true, force: true });
  delete process.env.ORBITFLOW_DOCUMENT_EMBEDDING_MODEL;
  delete process.env.ORBITFLOW_UPLOAD_DIR;
});

test("a supported uploaded file is stored, extracted, indexed, and linked only to a related organization document", async () => {
  const related = await createDoc(owner, { title: "Launch handbook", content: "SYNTH_RELATED launchquartz" });
  const unrelated = await createDoc(owner, { title: "Cafeteria menu", content: "SYNTH_IRRELEVANT noodles" });
  const content = "# Launch checklist\n\nSYNTH_PARAPHRASE launchquartz deployment steps";
  const uploaded = await upload(owner, "launch-checklist.md", content, { title: "Uploaded launch checklist" });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.filename, "launch-checklist.md");
  assert.equal(uploaded.body.extraction.format, "markdown");
  assert.equal(uploaded.body.analysis.state, "pending");

  const detail = await request(owner, `/documents/${uploaded.body.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.content, content, "UTF-8 extracted text must be persisted as document content");
  const file = database().prepare("SELECT * FROM file_object WHERE related_type = 'document' AND related_id = ?").get(uploaded.body.id);
  assert.ok(file, "the uploaded source must have a file_object record");
  assert.equal(file.tenant_id, database().prepare("SELECT tenant_id FROM document WHERE id = ?").get(uploaded.body.id).tenant_id);
  assert.equal(file.org_id, owner.orgId);
  assert.deepEqual(await readFile(path.join(uploadRoot, file.storage_key)), Buffer.from(content));

  const analysis = await request(owner, `/documents/${uploaded.body.id}/analysis?wait=1`);
  assert.equal(analysis.status, 200);
  assert.equal(analysis.body.state, "ready");
  const graph = await request(owner, "/documents/graph?wait=1");
  const links = graph.body.edges.filter((edge) => edge.kind === "ai_similarity" && edge.source === uploaded.body.id);
  assert.equal(links.length, 1, JSON.stringify(graph.body.edges));
  assert.equal(links[0].target_id, related.id);
  assert.notEqual(links[0].target_id, unrelated.id);
  assert.equal(links[0].provenance.provider, "ollama-local");
  assert.equal(links[0].provenance.model, "synthetic-document-wire-v1");
  assert.equal(links[0].provenance.method, "embedding_cosine");

  const chat = await request(owner, "/agent/chat", { method: "POST", body: { message: "launchquartz" } });
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  assert.ok(chat.body.answer.evidence.some((item) => item.id === uploaded.body.id), "RAG must read extracted uploaded text");
  assert.ok(wire.calls.every((call) => call.path === "/api/embed"), "document inference must use only the local embedding wire");
});

test("unsupported binary formats and malformed UTF-8 fail before persistence or inference", async () => {
  const documentsBefore = database().prepare("SELECT COUNT(*) AS count FROM document").get().count;
  const filesBefore = database().prepare("SELECT COUNT(*) AS count FROM file_object").get().count;
  const callsBefore = wire.calls.length;
  const pdf = await request(owner, "/documents/upload", {
    method: "POST",
    body: { filename: "policy.pdf", mime: "application/pdf", content_base64: Buffer.from("%PDF-fixture").toString("base64") },
  });
  assert.equal(pdf.status, 415);
  const malformed = await request(owner, "/documents/upload", {
    method: "POST",
    body: { filename: "broken.txt", mime: "text/plain", content_base64: Buffer.from([0xc3, 0x28]).toString("base64") },
  });
  assert.equal(malformed.status, 400);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM document").get().count, documentsBefore);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM file_object").get().count, filesBefore);
  assert.equal(wire.calls.length, callsBefore);
});

test("document updates immediately invalidate semantic links and analyze only the new version", async () => {
  const related = await createDoc(owner, { title: "Update target", content: "SYNTH_RELATED" });
  const uploaded = await upload(owner, "update.md", "SYNTH_PARAPHRASE", { title: "Update source" });
  assert.equal(uploaded.status, 201);
  assert.equal((await request(owner, `/documents/${uploaded.body.id}/analysis?wait=1`)).body.state, "ready");
  let graph = await request(owner, "/documents/graph");
  assert.ok(graph.body.edges.some((edge) => edge.kind === "ai_similarity" && edge.source === uploaded.body.id && edge.target_id === related.id));

  const changed = await request(owner, `/documents/${uploaded.body.id}`, {
    method: "PATCH",
    body: { version: uploaded.body.version, content: "SYNTH_IRRELEVANT" },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  graph = await request(owner, "/documents/graph");
  assert.ok(!graph.body.edges.some((edge) => edge.kind === "ai_similarity" && edge.source === uploaded.body.id && edge.target_id === related.id), "the old-version relation must disappear synchronously");
  assert.ok(!graph.body.edges.some((edge) => edge.kind === "ai_similarity" && edge.source === uploaded.body.id && edge.provenance.source_version === uploaded.body.version), "old-version provenance must not survive an update");
  assert.equal((await request(owner, `/documents/${uploaded.body.id}/analysis?wait=1`)).body.state, "ready");
  graph = await request(owner, "/documents/graph");
  assert.ok(!graph.body.edges.some((edge) => edge.kind === "ai_similarity" && edge.source === uploaded.body.id && edge.target_id === related.id));
});

test("private and cross-organization uploaded documents cannot leak through nodes, semantic edges, status, or candidate payloads", async () => {
  const privateUpload = await upload(owner, "private.md", "SYNTH_PARAPHRASE PRIVATE_UPLOAD_ONLY", {
    title: "Private upload",
    visibility: "private",
  });
  assert.equal(privateUpload.status, 201);
  await request(owner, `/documents/${privateUpload.body.id}/analysis?wait=1`);
  const memberGraph = await request(member, "/documents/graph?wait=1");
  assert.ok(!memberGraph.body.nodes.some((node) => node.id === privateUpload.body.id));
  assert.ok(!memberGraph.body.edges.some((edge) => edge.source === privateUpload.body.id || edge.target_id === privateUpload.body.id));
  assert.equal((await request(member, `/documents/${privateUpload.body.id}/analysis`)).status, 404);

  const foreignUpload = await upload(other, "foreign.md", "SYNTH_RELATED FOREIGN_UPLOAD_ONLY", { title: "Foreign upload" });
  assert.equal(foreignUpload.status, 201);
  await request(other, `/documents/${foreignUpload.body.id}/analysis?wait=1`);
  const callsBefore = wire.calls.length;
  const own = await upload(owner, "own.md", "SYNTH_PARAPHRASE OWN_UPLOAD_ONLY", { title: "Own upload" });
  assert.equal(own.status, 201);
  await request(owner, `/documents/${own.body.id}/analysis?wait=1`);
  const ownCandidatePayloads = wire.calls.slice(callsBefore).map((call) => JSON.stringify(call.body));
  assert.ok(ownCandidatePayloads.some((body) => body.includes("OWN_UPLOAD_ONLY")), "the own upload must reach the local inference wire");
  assert.ok(ownCandidatePayloads.every((body) => !body.includes("FOREIGN_UPLOAD_ONLY")), "cross-org content must never enter candidate payloads");
  const ownerGraph = await request(owner, "/documents/graph?wait=1");
  assert.ok(!ownerGraph.body.nodes.some((node) => node.id === foreignUpload.body.id));
  assert.ok(!ownerGraph.body.edges.some((edge) => edge.source === foreignUpload.body.id || edge.target_id === foreignUpload.body.id));
});

test("missing models and non-loopback endpoints report unavailable without fabricating links or transferring content", async () => {
  const callsBefore = wire.calls.length;
  delete process.env.ORBITFLOW_DOCUMENT_EMBEDDING_MODEL;
  const noModel = await upload(owner, "no-model.md", "SYNTH_PARAPHRASE NO_MODEL_CONTENT", { title: "No model upload" });
  assert.equal(noModel.status, 201);
  assert.equal(noModel.body.analysis.state, "unavailable");
  assert.equal(noModel.body.analysis.reason, "model_not_configured");
  assert.equal(wire.calls.length, callsBefore);
  assert.ok(!(await request(owner, "/documents/graph")).body.edges.some((edge) => edge.kind === "ai_similarity"));

  process.env.ORBITFLOW_DOCUMENT_EMBEDDING_MODEL = "must-not-run-remotely";
  process.env.OLLAMA_BASE_URL = "https://example.invalid";
  const remote = await request(owner, `/documents/${noModel.body.id}/analysis`, { method: "POST" });
  assert.equal(remote.status, 200);
  assert.equal(remote.body.state, "unavailable");
  assert.equal(remote.body.reason, "local_endpoint_required");
  assert.equal(wire.calls.length, callsBefore);

  process.env.OLLAMA_BASE_URL = wire.baseUrl;
  process.env.ORBITFLOW_DOCUMENT_EMBEDDING_MODEL = "synthetic-document-wire-v1";
});
