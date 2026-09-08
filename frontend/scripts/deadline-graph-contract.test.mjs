import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildScene,
  graphIdentitySchema,
  graphRendererId,
  graphSchema,
} from "../src/screens/vault/graph3d.ts";
import {
  knowledgeGraphSchema,
  membersOfKnowledgeHub,
  parseDocumentDetail,
} from "../src/screens/knowledge/model.ts";
import { noteSchema, parseNoteDetail } from "../src/screens/vault/model.ts";
import * as formContract from "../src/components/common/createFormContract.ts";
const { buildFormRequestBody } = formContract;

const identity = (store, company, owner, kind, opaque_id) =>
  graphIdentitySchema.parse({ store, company, owner, kind, opaque_id });
const node = (recordIdentity, title) => ({
  id: recordIdentity.opaque_id,
  renderer_id: graphRendererId(recordIdentity),
  identity: recordIdentity,
  title,
  folder: "/",
});
const edge = (source, target, resolution = "resolved", binding = "explicit") => ({
  source: source.id,
  target_id: resolution === "resolved" ? target.id : null,
  source_renderer_id: source.renderer_id,
  target_renderer_id: resolution === "resolved" ? target.renderer_id : null,
  target_title: target.title,
  resolution,
  binding,
});

test("record identity is title-independent and separates stores, companies, owners, kinds and opaque IDs", () => {
  const variants = [
    identity("legacy", "company-a", null, "document", "42"),
    identity("pg", "company-a", null, "document", "42"),
    identity("pg", "company-b", null, "document", "42"),
    identity("pg", null, "owner-a", "note", "42"),
    identity("pg", null, "owner-b", "note", "42"),
    identity("pg", "company-a", null, "space", "42"),
  ];
  assert.equal(new Set(variants.map(graphRendererId)).size, variants.length);
  const stable = variants[0];
  assert.equal(node(stable, "old title").renderer_id, node(stable, "renamed").renderer_id);
  assert.equal(graphIdentitySchema.safeParse({ store: "pg", company: null, owner: null, kind: "document", opaque_id: "42" }).success, false);
  assert.equal(graphIdentitySchema.safeParse({ store: "pg", company: "company-a", owner: null, kind: "unsupported", opaque_id: "42" }).success, false);
});

test("renderer accepts only server-resolved endpoints and never repairs stale IDs from a matching title", () => {
  const source = node(identity("pg", null, "owner-a", "note", "1"), "Source");
  const target = node(identity("pg", null, "owner-a", "note", "2"), "Same title");
  const graph = graphSchema.parse({
    nodes: [source, target],
    edges: [
      { ...edge(source, target), provenance: { provider: "local", model: "m", method: "fixture", source_version: "987", target_version: "654", analyzed_at: "2026-09-08T00:00:00Z", endpointVersion: "v2", nested: { retained: true } } },
      { ...edge(source, target, "unavailable"), target_title: target.title },
      { ...edge(source, target, "unresolved", "title"), target_title: target.title },
    ],
    orphans: [],
  });
  const snapshot = structuredClone(graph);
  const scene = buildScene(graph);
  assert.equal(scene.linkCount, 1);
  assert.equal(scene.unresolved, 1);
  assert.equal(scene.unavailable, 1);
  assert.deepEqual(graph.edges[0].provenance.nested, { retained: true });
  assert.deepEqual(graph, snapshot, "physics preparation must not mutate source DTO/provenance");
  assert.equal(graphSchema.safeParse({ ...graph, edges: [{ ...graph.edges[0], resolution: "resolved", target_renderer_id: null }] }).success, false);
});

test("reciprocal and same-kind parallel links retain direction and independent provenance", () => {
  const a = node(identity("pg", null, "owner", "note", "a"), "A");
  const b = node(identity("pg", null, "owner", "note", "b"), "B");
  const edges = [edge(a, b), edge(b, a), edge(a, b)].map((item, i) => ({
    ...item, id: `edge-${i}`, kind: "manual", declaration: { span: [i, i + 1] },
  }));
  const graph = graphSchema.parse({ nodes: [a, b], edges });
  const snapshot = structuredClone(graph);
  const scene = buildScene(graph);
  assert.equal(scene.linkCount, 3);
  assert.deepEqual([...scene.links], [0, 1, 1, 0, 0, 1]);
  assert.deepEqual(scene.linkEdges, edges);
  scene.linkEdges[0].declaration.span[0] = 999;
  assert.deepEqual(graph, snapshot, "render metadata is an independent per-edge clone");
});

test("both graph parsers bind API endpoints to the same authorized typed renderer nodes", () => {
  for (const company of [false, true]) {
    const kind = company ? "document" : "note";
    const a = { ...node(identity("pg", company ? "77" : null, company ? null : "owner", kind, "a"), "A"), kind };
    const b = { ...node(identity("pg", company ? "77" : null, company ? null : "owner", kind, "b"), "B"), kind };
    const parser = company ? knowledgeGraphSchema : graphSchema;
    const valid = { nodes: [a, b], edges: [{ ...edge(a, b), kind: company ? "link" : "manual" }] };
    assert.equal(parser.safeParse(valid).success, true);
    for (const forged of [
      { source_renderer_id: b.renderer_id, target_renderer_id: a.renderer_id },
      { source: "foreign" }, { target_id: "foreign" },
      { target_renderer_id: "foreign" },
    ]) assert.equal(parser.safeParse({ ...valid, edges: [{ ...valid.edges[0], ...forged }] }).success, false, JSON.stringify(forged));
    assert.equal(parser.safeParse({ ...valid, nodes: [a, b, a] }).success, false, "duplicate renderer identities are ambiguous");
    const foreignIdentity = { ...a.identity, ...(company ? { company: "foreign" } : { owner: "foreign" }) };
    const ambiguous = { ...a, identity: foreignIdentity, renderer_id: graphRendererId(foreignIdentity) };
    assert.equal(parser.safeParse({ ...valid, nodes: [a, b, ambiguous] }).success, false, "duplicate API IDs cannot be rebound to another typed identity");
  }
});

test("generic document detail and PATCH receipts reject target forgery before completion", () => {
  const detail = { id: "42", title: "Doc", content_md: "body", version: 7 };
  assert.deepEqual(formContract.parseDocumentFormDetail("42", detail), detail);
  for (const id of [undefined, null, 42, "43"]) {
    assert.throws(() => formContract.parseDocumentFormDetail("42", { ...detail, id }));
    assert.throws(() => formContract.validateDocumentFormResult("42", { id, version: 8 }));
  }
  assert.throws(() => formContract.validateDocumentFormResult("42", { id: "42" }));
  assert.equal(formContract.validateDocumentFormResult("42", { id: "42", version: 8 }).version, 8);
});

test("company hub membership uses typed renderer identity instead of duplicate titles or raw IDs", () => {
  const company = "77";
  const firstHubIdentity = identity("pg", company, null, "space", "10");
  const secondHubIdentity = identity("pg", company, null, "space", "11");
  const documentIdentity = identity("pg", company, null, "document", "10");
  const firstHub = { ...node(firstHubIdentity, "Duplicate project"), id: "project:10", kind: "space", sensitivity: "org", chunks: 0, tags: [], updated_at: "" };
  const secondHub = { ...node(secondHubIdentity, "Duplicate project"), id: "project:11", kind: "space", sensitivity: "org", chunks: 0, tags: [], updated_at: "" };
  const document = { ...node(documentIdentity, "Document"), kind: "document", sensitivity: "internal", chunks: 1, tags: [], updated_at: "" };
  const graph = knowledgeGraphSchema.parse({
    nodes: [firstHub, secondHub, document],
    edges: [{ ...edge(document, firstHub), kind: "space" }],
    analysis: [],
    orphans: [],
    stats: { documents: 1, spaces: 2, chunks: 1, restricted: 0 },
  });
  assert.notEqual(firstHub.renderer_id, document.renderer_id, "project hub 10 and document 10 are distinct entities");
  assert.deepEqual(membersOfKnowledgeHub(graph.nodes, graph.edges, firstHub.renderer_id).map((item) => item.renderer_id), [document.renderer_id]);
  assert.deepEqual(membersOfKnowledgeHub(graph.nodes, graph.edges, secondHub.renderer_id), []);
});

test("generic document and finance forms use their returned version under the correct contract name", () => {
  assert.deepEqual(
    buildFormRequestBody(["content_md"], { content_md: "saved" }, "version", { version: "7" }),
    { content_md: "saved", version: 7 },
  );
  assert.deepEqual(
    buildFormRequestBody(["amount"], { amount: "10.00" }, "expected_version", { version: "8" }),
    { amount: "10.00", expected_version: 8 },
  );
  assert.throws(() => buildFormRequestBody(["content_md"], { content_md: "blind" }, "version", undefined), /MISSING_VERSION/);
  assert.throws(() => buildFormRequestBody(["content_md"], { content_md: "blind" }, "version", { version: "9007199254740993" }), /MISSING_VERSION/);
});

test("detail parsing requires exact target identity and a returned version token without defaulting to one", () => {
  assert.throws(() => parseDocumentDetail("requested", { id: "different", title: "Doc", content: "body", version: 7, versions: [] }), /DETAIL_ID_MISMATCH/);
  assert.throws(() => parseDocumentDetail("requested", { id: "requested", title: "Doc", content: "body", versions: [] }));
  assert.equal(parseDocumentDetail("requested", { id: "requested", title: "Doc", content: "body", version: 7, versions: [] }).version, 7);

  assert.throws(() => parseNoteDetail("requested", { id: "different", title: "Note", content: "body", version: "987", folder: "/" }), /DETAIL_ID_MISMATCH/);
  const note = parseNoteDetail("requested", { id: "requested", title: "Note", content: "body", version: "987", folder: "/" });
  assert.equal(note.version, "987", "PG xmin remains the opaque server token");
  assert.equal(noteSchema.safeParse({ id: "requested", title: "Note" }).success, false);
});
