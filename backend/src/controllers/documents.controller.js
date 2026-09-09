import path from "node:path";

import { z } from "zod";

import { transaction } from "../config/db.js";
import { resolvePrincipal } from "../middleware/auth.js";
import {
  getScoped,
  hardDelete,
  insert,
  listScoped,
  softDelete,
  update,
} from "../models/base.js";
import * as audit from "../services/audit.service.js";
import {
  DOCUMENT_CANDIDATE_LIMIT,
  documentSemantic,
  documentSemanticScope,
} from "../services/document-semantic.service.js";
import {
  extractSupportedTextUpload,
  persistUploadedSource,
} from "../services/document-ingestion.service.js";
import { canReadDocument } from "../services/rag.service.js";
import { graphEdge, graphIdentity, graphNode } from "../services/graph-identity.service.js";
import { ApiError, notFound } from "../utils/errors.js";

const spaceSchema = z.object({
  name: z.string().min(1).max(200),
  visibility: z.string().default("org"),
});

const documentSchema = z.object({
  title: z.string().min(1).max(300),
  content: z.string().default(""),
  space_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  doc_type: z.string().default("wiki"),
  tags: z.array(z.string()).default([]),
  visibility: z.enum(["org", "private", "public"]).default("org"),
  sensitivity: z.enum(["public", "internal", "personal", "sensitive", "confidential"]).default("internal"),
});

const patchSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  visibility: z.enum(["org", "private", "public"]).optional(),
  review_status: z.string().optional(),
  version: z.number().int().positive(),
});

const uploadSchema = z.object({
  filename: z.string().min(1).max(255),
  mime: z.string().min(1).max(100),
  content_base64: z.string().min(1).max(1_400_000),
  title: z.string().min(1).max(300).optional(),
  space_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  visibility: z.enum(["org", "private", "public"]).default("org"),
  sensitivity: z.enum(["public", "internal", "personal", "sensitive", "confidential"]).default("internal"),
});

const meetingSchema = z.object({
  title: z.string().min(1).max(300),
  held_at: z.string(),
  location: z.string().nullable().optional(),
  attendees: z.array(z.string()).default([]),
  agenda: z.string().default(""),
  notes: z.string().default(""),
  raw_source: z.string().default(""),
  event_id: z.string().nullable().optional(),
});

const decisionSchema = z.object({
  content: z.string().min(1),
  owner_id: z.string().nullable().optional(),
  due_at: z.string().nullable().optional(),
  source_quote: z.string().default(""),
});

const confirmSchema = z.object({ decision_ids: z.array(z.string()) });

const view = (d) => ({
  id: d.id,
  space_id: d.space_id,
  project_id: d.project_id,
  title: d.title,
  doc_type: d.doc_type,
  tags: (d.tags ?? "").split(",").filter(Boolean),
  visibility: d.visibility,
  sensitivity: d.sensitivity,
  owner_id: d.owner_id,
  archived: Boolean(d.archived),
  ai_generated: Boolean(d.ai_generated),
  review_status: d.review_status,
  version: d.version,
});

function reindex(principal, document) {
  hardDelete("document_chunk", "document_id = ?", [document.id]);
  const chunks = (document.content ?? "")
    .split("\n\n")
    .map((c) => c.trim())
    .filter(Boolean);
  const parts = chunks.length > 0 ? chunks : [document.title];
  parts.forEach((content, ordinal) => {
    insert("document_chunk", {
      tenant_id: document.tenant_id,
      org_id: document.org_id,
      document_id: document.id,
      ordinal,
      content: content.slice(0, 4000),
      sensitivity: document.sensitivity,
      visibility: document.visibility,
      created_by: principal.userId,
    });
  });
  return parts.length;
}

function analyze(principal, document) {
  if (!canReadDocument(principal, document)) return null;
  return documentSemantic.schedule(
    documentSemanticScope(principal),
    document,
    () => listScoped("document", principal, [], {
      limit: DOCUMENT_CANDIDATE_LIMIT + 1,
      orderBy: "updated_at DESC, id",
    }).filter((candidate) => canReadDocument(principal, candidate)),
  );
}

const insertUploadedDocument = transaction((principal, payload, extracted, stored) => {
  const document = insert("document", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    space_id: payload.space_id ?? null,
    project_id: payload.project_id ?? null,
    title: payload.title ?? path.basename(payload.filename, extracted.extension),
    content: extracted.text,
    doc_type: "upload",
    tags: payload.tags.join(","),
    visibility: payload.visibility,
    sensitivity: payload.sensitivity,
    owner_id: principal.userId,
    created_by: principal.userId,
  });
  insert("document_version", {
    tenant_id: principal.tenantId,
    document_id: document.id,
    revision: 1,
    content: document.content,
    author_id: principal.userId,
    created_by: principal.userId,
  });
  reindex(principal, document);
  const file = insert("file_object", {
    id: stored.id,
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    storage_key: stored.storageKey,
    filename: payload.filename,
    mime: extracted.mime,
    size: stored.size,
    checksum: stored.checksum,
    malware_status: "accepted_text_only",
    related_type: "document",
    related_id: document.id,
    created_by: principal.userId,
  });
  return { document, file };
});

export function createSpace(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.write");
  const payload = spaceSchema.parse(req.body);
  const space = insert("space", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    name: payload.name,
    visibility: payload.visibility,
    created_by: principal.userId,
  });
  res.status(201).json({ id: space.id, name: space.name, visibility: space.visibility });
}

export function listSpaces(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.read");
  const rows = listScoped("space", principal, [], { limit: 200 });
  res.json({ items: rows.map((s) => ({ id: s.id, name: s.name, visibility: s.visibility })) });
}

export function createDocument(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.write");
  const payload = documentSchema.parse(req.body);

  const document = insert("document", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    space_id: payload.space_id ?? null,
    project_id: payload.project_id ?? null,
    title: payload.title,
    content: payload.content,
    doc_type: payload.doc_type,
    tags: payload.tags.join(","),
    visibility: payload.visibility,
    sensitivity: payload.sensitivity,
    owner_id: principal.userId,
    created_by: principal.userId,
  });

  insert("document_version", {
    tenant_id: principal.tenantId,
    document_id: document.id,
    revision: 1,
    content: document.content,
    author_id: principal.userId,
    created_by: principal.userId,
  });
  reindex(principal, document);

  audit.record({
    tenantId: principal.tenantId,
    action: "document.created",
    resourceType: "document",
    resourceId: document.id,
    actorId: principal.userId,
    after: { title: document.title },
    requestId: req.requestId,
  });

  res.status(201).json({ ...view(document), analysis: analyze(principal, document) });
}

export async function uploadDocument(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.write");
  const payload = uploadSchema.parse(req.body);
  const extracted = extractSupportedTextUpload(payload);
  const stored = await persistUploadedSource({
    tenantId: principal.tenantId,
    orgId: principal.orgId,
    extension: extracted.extension,
    bytes: extracted.bytes,
  });

  let created;
  try {
    created = insertUploadedDocument(principal, payload, extracted, stored);
  } catch (error) {
    await stored.discard();
    throw error;
  }

  audit.record({
    tenantId: principal.tenantId,
    action: "document.uploaded",
    resourceType: "document",
    resourceId: created.document.id,
    actorId: principal.userId,
    after: { title: created.document.title, file_id: created.file.id, format: extracted.format },
    requestId: req.requestId,
  });

  res.status(201).json({
    ...view(created.document),
    file_id: created.file.id,
    filename: created.file.filename,
    extraction: { format: extracted.format, bytes: created.file.size, encoding: "utf-8" },
    analysis: analyze(principal, created.document),
  });
}

export function listDocuments(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.read");
  const filters = [];
  if (req.query.doc_type) filters.push({ sql: "doc_type = ?", params: [req.query.doc_type] });
  if (req.query.owner_id) filters.push({ sql: "owner_id = ?", params: [req.query.owner_id] });
  const rows = listScoped("document", principal, filters, {
    limit: Number(req.query.limit ?? 50),
    orderBy: "updated_at DESC",
  });
  res.json({
    items: rows.filter((document) => canReadDocument(principal, document)).map(view),
    next_cursor: null,
  });
}

export function getDocument(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.read");
  const document = getScoped("document", principal, req.params.documentId, "document");
  if (!canReadDocument(principal, document)) throw notFound("document");
  const versions = listScoped(
    "document_version",
    principal,
    [{ sql: "document_id = ?", params: [document.id] }],
    { limit: 100, orderBy: "revision DESC" },
  );
  res.json({
    ...view(document),
    content: document.content,
    versions: versions.map((v) => ({
      revision: v.revision,
      author_id: v.author_id,
      created_at: v.created_at,
    })),
    analysis: documentSemantic.status(documentSemanticScope(principal), document),
  });
}

export async function documentAnalysis(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.read");
  const document = getScoped("document", principal, req.params.documentId, "document");
  if (!canReadDocument(principal, document)) throw notFound("document");
  const scope = documentSemanticScope(principal);
  if (req.method === "POST") analyze(principal, document);
  if (req.query.wait === "1") await documentSemantic.wait(scope, document.id);
  res.json(documentSemantic.status(scope, getScoped("document", principal, document.id, "document")));
}

export function patchDocument(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.write");
  const document = getScoped("document", principal, req.params.documentId, "document");
  if (!canReadDocument(principal, document)) throw notFound("document");
  const payload = patchSchema.parse(req.body);

  if (payload.version !== document.version) {
    throw new ApiError("VERSION_CONFLICT", "document was modified by someone else");
  }

  const before = view(document);
  const patch = { version: document.version + 1 };
  if (payload.title !== undefined) patch.title = payload.title;
  if (payload.visibility !== undefined) patch.visibility = payload.visibility;
  if (payload.review_status !== undefined) patch.review_status = payload.review_status;

  if (payload.content !== undefined && payload.content !== document.content) {
    patch.content = payload.content;
    const revision =
      1 +
      listScoped(
        "document_version",
        principal,
        [{ sql: "document_id = ?", params: [document.id] }],
        { limit: 500 },
      ).length;
    insert("document_version", {
      tenant_id: principal.tenantId,
      document_id: document.id,
      revision,
      content: payload.content,
      author_id: principal.userId,
      created_by: principal.userId,
    });
  }

  const updated = update("document", document.id, patch, principal.userId);
  if (patch.content !== undefined) reindex(principal, updated);
  documentSemantic.invalidate(documentSemanticScope(principal), document.id, updated.version);

  audit.record({
    tenantId: principal.tenantId,
    action: "document.updated",
    resourceType: "document",
    resourceId: document.id,
    actorId: principal.userId,
    before,
    after: view(updated),
    requestId: req.requestId,
  });

  res.json({ ...view(updated), analysis: analyze(principal, updated) });
}

export function restoreVersion(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.write");
  const document = getScoped("document", principal, req.params.documentId, "document");
  if (!canReadDocument(principal, document)) throw notFound("document");
  const revision = Number(req.params.revision);
  const version = listScoped(
    "document_version",
    principal,
    [
      { sql: "document_id = ?", params: [document.id] },
      { sql: "revision = ?", params: [revision] },
    ],
    { limit: 1 },
  )[0];
  if (!version) throw notFound("document version");

  const updated = update(
    "document",
    document.id,
    { content: version.content, version: document.version + 1 },
    principal.userId,
  );
  reindex(principal, updated);
  documentSemantic.invalidate(documentSemanticScope(principal), document.id, updated.version);
  analyze(principal, updated);
  res.json({ id: document.id, restored_revision: revision });
}

export function archiveDocument(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.write");
  const document = getScoped("document", principal, req.params.documentId, "document");
  if (!canReadDocument(principal, document)) throw notFound("document");
  update("document", document.id, { archived: 1 }, principal.userId);
  softDelete("document", document.id, principal.userId);
  hardDelete("document_chunk", "document_id = ?", [document.id]);
  documentSemantic.invalidate(documentSemanticScope(principal), document.id);

  audit.record({
    tenantId: principal.tenantId,
    action: "document.archived",
    resourceType: "document",
    resourceId: document.id,
    actorId: principal.userId,
    requestId: req.requestId,
  });

  res.json({ id: document.id, archived: true });
}

export function createMeeting(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("meeting.write");
  const payload = meetingSchema.parse(req.body);
  const meeting = insert("meeting", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    event_id: payload.event_id ?? null,
    title: payload.title,
    held_at: payload.held_at,
    location: payload.location ?? null,
    attendees: payload.attendees.join(","),
    agenda: payload.agenda,
    notes: payload.notes,
    raw_source: payload.raw_source,
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "meeting.created",
    resourceType: "meeting",
    resourceId: meeting.id,
    actorId: principal.userId,
    requestId: req.requestId,
  });

  res.status(201).json({ id: meeting.id, title: meeting.title, review_status: meeting.review_status });
}

export function getMeeting(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.read");
  const meeting = getScoped("meeting", principal, req.params.meetingId, "meeting");
  const decisions = listScoped(
    "meeting_decision",
    principal,
    [{ sql: "meeting_id = ?", params: [meeting.id] }],
    { limit: 200, orderBy: "created_at ASC" },
  );
  res.json({
    id: meeting.id,
    title: meeting.title,
    held_at: meeting.held_at,
    location: meeting.location,
    attendees: (meeting.attendees ?? "").split(",").filter(Boolean),
    agenda: meeting.agenda,
    notes: meeting.notes,
    ai_summary: meeting.ai_summary,
    ai_generated: Boolean(meeting.ai_generated),
    review_status: meeting.review_status,
    decisions: decisions.map((d) => ({
      id: d.id,
      content: d.content,
      owner_id: d.owner_id,
      due_at: d.due_at,
      confirmed: Boolean(d.confirmed),
      task_id: d.task_id,
      source_quote: d.source_quote,
    })),
  });
}

export function addDecision(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("meeting.write");
  const payload = decisionSchema.parse(req.body);
  const meeting = getScoped("meeting", principal, req.params.meetingId, "meeting");
  const decision = insert("meeting_decision", {
    tenant_id: principal.tenantId,
    meeting_id: meeting.id,
    content: payload.content,
    owner_id: payload.owner_id ?? null,
    due_at: payload.due_at ?? null,
    source_quote: payload.source_quote,
    created_by: principal.userId,
  });
  res.status(201).json({ id: decision.id, confirmed: false, task_id: null });
}

export function confirmDecisions(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.write");
  const payload = confirmSchema.parse(req.body);
  const meeting = getScoped("meeting", principal, req.params.meetingId, "meeting");

  const created = [];
  for (const decisionId of payload.decision_ids) {
    const decision = listScoped(
      "meeting_decision",
      principal,
      [
        { sql: "id = ?", params: [decisionId] },
        { sql: "meeting_id = ?", params: [meeting.id] },
      ],
      { limit: 1 },
    )[0];
    if (!decision) throw notFound("meeting decision");
    if (decision.confirmed) continue;

    const task = insert("task", {
      tenant_id: principal.tenantId,
      org_id: principal.orgId,
      title: decision.content.slice(0, 300),
      assignee_id: decision.owner_id ?? principal.userId,
      due_at: decision.due_at,
      created_by: principal.userId,
    });
    update("meeting_decision", decision.id, { confirmed: 1, task_id: task.id }, principal.userId);
    created.push({ decision_id: decision.id, task_id: task.id });
  }

  update("meeting", meeting.id, { review_status: "reviewed" }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "meeting.decisions.confirmed",
    resourceType: "meeting",
    resourceId: meeting.id,
    actorId: principal.userId,
    after: { created_tasks: created.length },
    requestId: req.requestId,
  });

  res.json({ created, count: created.length });
}

export function searchDocuments(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.read");
  const needle = String(req.query.q ?? "").toLowerCase();
  const rows = listScoped("document", principal, [], { limit: 500 }).filter(
    (document) =>
      canReadDocument(principal, document) &&
      (document.title.toLowerCase().includes(needle) ||
        (document.content ?? "").toLowerCase().includes(needle)),
  );
  res.json({ query: req.query.q ?? "", items: rows.slice(0, 20).map(view) });
}

// GET /documents/graph
// 조직 지식(RAG)을 옵시디언식 그래프로 준다.
// - 공간(space)은 허브 노드, 문서는 그 주위 노드
// - 문서 본문의 [[제목]] 위키링크가 문서 사이 간선
// - 노출 범위는 RAG 검색(searchChunks)과 같은 민감도 상한을 따른다.
export async function graph(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.read");
  const scope = documentSemanticScope(principal);
  if (req.query.wait === "1") await documentSemantic.wait(scope);
  const spaces = listScoped("space", principal, [], { limit: 200 });
  const spaceName = new Map(spaces.map((s) => [s.id, s.name]));

  const documents = listScoped("document", principal, [], { limit: 1000 }).filter((document) =>
    canReadDocument(principal, document),
  );
  const readableIds = new Set(documents.map((document) => document.id));
  const spaceIdentities = new Map(spaces.map((space) => [space.id, graphIdentity({
    store: "legacy", company: principal.orgId, kind: "space", opaqueId: space.id,
  })]));
  const documentIdentities = new Map(documents.map((document) => [document.id, graphIdentity({
    store: "legacy", company: principal.orgId, kind: "document", opaqueId: document.id,
  })]));

  const chunkCount = new Map();
  for (const chunk of listScoped("document_chunk", principal, [], { limit: 5000 })) {
    if (!readableIds.has(chunk.document_id)) continue;
    chunkCount.set(chunk.document_id, (chunkCount.get(chunk.document_id) ?? 0) + 1);
  }

  const byTitle = new Map();
  for (const document of documents) {
    const ids = byTitle.get(document.title) ?? [];
    ids.push(document.id);
    byTitle.set(document.title, ids);
  }

  const nodes = [
    ...spaces.map((space) => graphNode({
      id: space.id,
      kind: "space",
      title: space.name,
      folder: space.name,
      sensitivity: space.visibility,
      chunks: 0,
      tags: [],
      updated_at: space.updated_at,
    }, spaceIdentities.get(space.id))),
    ...documents.map((document) => graphNode({
      id: document.id,
      kind: "document",
      title: document.title,
      folder: spaceName.get(document.space_id) ?? "미분류",
      sensitivity: document.sensitivity,
      chunks: chunkCount.get(document.id) ?? 0,
      tags: (document.tags ?? "").split(",").filter(Boolean),
      updated_at: document.updated_at,
    }, documentIdentities.get(document.id))),
  ];

  const edges = [];
  for (const document of documents) {
    const sourceIdentity = documentIdentities.get(document.id);
    if (document.space_id && spaceName.has(document.space_id)) {
      const targetIdentity = spaceIdentities.get(document.space_id);
      edges.push(graphEdge({
        source: document.id,
        target_id: document.space_id,
        target_title: spaceName.get(document.space_id),
        kind: "space",
      }, sourceIdentity, targetIdentity, { binding: "membership", resolution: "resolved" }));
    }
    const seen = new Set();
    for (const match of (document.content ?? "").matchAll(/\[\[([^\]]+)\]\]/g)) {
      const title = match[1].trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      const ids = byTitle.get(title) ?? [];
      const targetId = ids.length === 1 ? ids[0] : null;
      if (targetId === document.id) continue;
      const targetIdentity = targetId ? documentIdentities.get(targetId) : null;
      edges.push(graphEdge({
        source: document.id,
        target_id: targetId,
        target_title: targetId ? title : "",
        kind: "link",
      }, sourceIdentity, targetIdentity, targetIdentity
        ? { binding: "title", resolution: "resolved" }
        : { binding: "title", resolution: "unresolved", reason: ids.length > 1 ? "duplicate_title" : "title_not_found" }));
    }
  }

  const semantic = documentSemantic.graph(scope, documents);
  for (const edge of semantic.edges) {
    const sourceIdentity = documentIdentities.get(edge.source);
    const targetIdentity = documentIdentities.get(edge.target_id);
    if (sourceIdentity && targetIdentity) edges.push(graphEdge(edge, sourceIdentity, targetIdentity, { binding: "inference", resolution: "resolved" }));
  }
  const linked = new Set();
  for (const edge of edges.filter((item) => item.resolution === "resolved")) {
    linked.add(edge.source);
    if (edge.target_id) linked.add(edge.target_id);
  }

  res.json({
    nodes,
    edges,
    analysis: semantic.analysis,
    orphans: documents.filter((d) => !linked.has(d.id)).map((d) => d.id),
    stats: {
      documents: documents.length,
      spaces: spaces.length,
      chunks: [...chunkCount.values()].reduce((sum, n) => sum + n, 0),
      restricted: 0,
    },
  });
}
