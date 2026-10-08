import { z } from "zod";

import { resolvePrincipal } from "../middleware/auth.js";
import { getScoped, hardDelete, insert, listScoped, softDelete, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { CANDIDATE_LIMIT, legacyVaultScope, vaultSemantic } from "../services/vault-semantic.service.js";
import { graphEdge, graphIdentity, graphNode } from "../services/graph-identity.service.js";
import { ApiError, notFound } from "../utils/errors.js";

const WIKILINK = /\[\[([^\]]+)\]\]/g;

const HIGH_RISK_PATTERNS = [
  /비밀번호\s*[:=]/i,
  /password\s*[:=]/i,
  /api[_ -]?key\s*[:=]/i,
  /\b\d{6}-\d{7}\b/,
];

export function credentialReason(text) {
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(text ?? "")) return "자격증명으로 보이는 값은 Vault 에 저장할 수 없습니다";
  }
  return null;
}

const noteSchema = z.object({
  title: z.string().min(1).max(300),
  content: z.string().default(""),
  folder: z.string().default("/"),
  tags: z.array(z.string()).default([]),
  sensitivity: z.enum(["personal", "internal", "sensitive"]).default("personal"),
  agent_enabled: z.boolean().default(true),
  pinned: z.boolean().default(false),
});

const patchSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  folder: z.string().optional(),
  tags: z.array(z.string()).optional(),
  agent_enabled: z.boolean().optional(),
  pinned: z.boolean().optional(),
  version: z.number().int().nonnegative(),
});

const view = (note, backlinks = []) => ({
  id: note.id,
  folder: note.folder,
  title: note.title,
  tags: (note.tags ?? "").split(",").filter(Boolean),
  sensitivity: note.sensitivity,
  agent_enabled: Boolean(note.agent_enabled),
  pinned: Boolean(note.pinned),
  version: note.version,
  backlinks,
  updated_at: note.updated_at,
});

function own(principal, noteId) {
  const note = getScoped("vault_note", principal, noteId, "vault note");
  if (note.owner_id !== principal.userId) throw notFound("vault note");
  return note;
}

function reindexLinks(principal, note) {
  hardDelete("vault_link", "source_id = ?", [note.id]);
  const targets = [...(note.content ?? "").matchAll(WIKILINK)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  for (const title of [...new Set(targets)]) {
    // 본문의 [[제목]]은 재계산 가능한 선언이다. 현재 제목 조회 결과를 영구 ID binding으로 저장하지 않는다.
    insert("vault_link", {
      tenant_id: principal.tenantId,
      owner_id: principal.userId,
      source_id: note.id,
      target_title: title,
      target_id: null,
      created_by: principal.userId,
    });
  }
  return targets;
}

function backlinksOf(principal, note) {
  return listScoped(
    "vault_link",
    principal,
    [
      { sql: "owner_id = ?", params: [principal.userId] },
      { sql: "target_title = ?", params: [note.title] },
    ],
    { limit: 200 },
  ).map((l) => l.source_id);
}

function analyze(principal, note) {
  return vaultSemantic.schedule(legacyVaultScope(principal), note, () => listScoped("vault_note", principal,
    [{ sql: "owner_id = ? AND agent_enabled = 1", params: [principal.userId] }],
    { limit: CANDIDATE_LIMIT + 1, orderBy: "updated_at DESC, id" }), !note.agent_enabled);
}

export async function noteAnalysis(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const note = own(principal, req.params.noteId);
  const scope = legacyVaultScope(principal);
  if (req.method === "POST") analyze(principal, note);
  if (req.query.wait === "1") await vaultSemantic.wait(scope, note.id);
  res.json(vaultSemantic.status(scope, own(principal, note.id)));
}

export function createNote(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const payload = noteSchema.parse(req.body);

  const reason = credentialReason(payload.content) ?? credentialReason(payload.title);
  if (reason) throw new ApiError("VALIDATION_ERROR", reason);

  const duplicate = listScoped(
    "vault_note",
    principal,
    [
      { sql: "owner_id = ?", params: [principal.userId] },
      { sql: "title = ?", params: [payload.title] },
    ],
    { limit: 1 },
  )[0];
  if (duplicate) throw new ApiError("CONFLICT", "같은 제목의 노트가 이미 있습니다");

  const note = insert("vault_note", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    owner_id: principal.userId,
    title: payload.title,
    content: payload.content,
    folder: payload.folder,
    tags: payload.tags.join(","),
    sensitivity: payload.sensitivity,
    agent_enabled: payload.agent_enabled,
    pinned: payload.pinned,
    created_by: principal.userId,
  });

  const links = reindexLinks(principal, note);

  audit.record({
    tenantId: principal.tenantId,
    action: "vault.note.created",
    resourceType: "vault_note",
    resourceId: note.id,
    actorId: principal.userId,
    after: { title: note.title, links: links.length },
    requestId: req.requestId,
  });

  res.status(201).json({ ...view(note), links, analysis: analyze(principal, note) });
}

export function listNotes(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const filters = [{ sql: "owner_id = ?", params: [principal.userId] }];
  if (req.query.folder) filters.push({ sql: "folder = ?", params: [req.query.folder] });

  let rows = listScoped("vault_note", principal, filters, {
    limit: Number(req.query.limit ?? 100),
    orderBy: "updated_at DESC",
  });
  if (req.query.tag) rows = rows.filter((n) => (n.tags ?? "").split(",").includes(req.query.tag));
  if (req.query.q) {
    const needle = String(req.query.q).toLowerCase();
    rows = rows.filter(
      (n) => n.title.toLowerCase().includes(needle) || n.content.toLowerCase().includes(needle),
    );
  }

  res.json({
    items: rows.map((n) => view(n)),
    folders: [...new Set(rows.map((n) => n.folder))].sort(),
    tags: [...new Set(rows.flatMap((n) => (n.tags ?? "").split(",").filter(Boolean)))].sort(),
  });
}

export function getNote(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const note = own(principal, req.params.noteId);
  const links = listScoped(
    "vault_link",
    principal,
    [{ sql: "source_id = ?", params: [note.id] }],
    { limit: 200 },
  );
  res.json({
    ...view(note, backlinksOf(principal, note)),
    content: note.content,
    analysis: vaultSemantic.status(legacyVaultScope(principal), note),
    links: links.map((l) => ({ title: l.target_title, target_id: l.target_id })),
  });
}

export function patchNote(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const payload = patchSchema.parse(req.body);
  const note = own(principal, req.params.noteId);

  if (payload.version !== undefined && payload.version !== note.version) {
    throw new ApiError("VERSION_CONFLICT", "노트가 다른 곳에서 수정되었습니다");
  }

  const patch = { version: note.version + 1 };
  if (payload.content !== undefined) {
    const reason = credentialReason(payload.content);
    if (reason) throw new ApiError("VALIDATION_ERROR", reason);
    patch.content = payload.content;
  }
  if (payload.title !== undefined) patch.title = payload.title;
  if (payload.folder !== undefined) patch.folder = payload.folder;
  if (payload.tags !== undefined) patch.tags = payload.tags.join(",");
  if (payload.agent_enabled !== undefined) patch.agent_enabled = payload.agent_enabled;
  if (payload.pinned !== undefined) patch.pinned = payload.pinned;

  const updated = update("vault_note", note.id, patch, principal.userId);
  reindexLinks(principal, updated);
  vaultSemantic.invalidate(legacyVaultScope(principal), note.id, updated.version);
  res.json({ ...view(updated, backlinksOf(principal, updated)), analysis: analyze(principal, updated) });
}

export function deleteNote(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const note = own(principal, req.params.noteId);
  softDelete("vault_note", note.id, principal.userId);
  vaultSemantic.invalidate(legacyVaultScope(principal), note.id);
  hardDelete("vault_link", "source_id = ?", [note.id]);

  audit.record({
    tenantId: principal.tenantId,
    action: "vault.note.deleted",
    resourceType: "vault_note",
    resourceId: note.id,
    actorId: principal.userId,
    requestId: req.requestId,
  });

  res.json({ id: note.id, deleted: true });
}

export async function graph(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const scope = legacyVaultScope(principal);
  if (req.query.wait === "1") await vaultSemantic.wait(scope);
  const notes = listScoped(
    "vault_note",
    principal,
    [{ sql: "owner_id = ?", params: [principal.userId] }],
    { limit: 1000 },
  );
  const links = listScoped(
    "vault_link",
    principal,
    [{ sql: "owner_id = ?", params: [principal.userId] }],
    { limit: 2000 },
  );
  const identities = new Map(notes.map((note) => [note.id, graphIdentity({
    store: "legacy", company: principal.orgId, owner: principal.userId, kind: "note", opaqueId: note.id,
  })]));
  const titleIds = new Map();
  for (const note of notes) {
    const key = note.title.trim().toLowerCase();
    const ids = titleIds.get(key) ?? [];
    ids.push(note.id);
    titleIds.set(key, ids);
  }
  const edges = [];
  for (const link of links) {
    const sourceIdentity = identities.get(link.source_id);
    if (!sourceIdentity) continue;
    if (link.target_id != null) {
      const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(link.target_id);
      const targetIdentity = validId ? identities.get(link.target_id) : null;
      edges.push(graphEdge(
        { source: link.source_id, target_id: link.target_id, target_title: link.target_title },
        sourceIdentity,
        targetIdentity,
        targetIdentity
          ? { binding: "explicit", resolution: "resolved" }
          : { binding: "explicit", resolution: validId ? "unavailable" : "unresolved", reason: validId ? "target_unavailable" : "malformed_target_id" },
      ));
      continue;
    }
    const ids = titleIds.get(link.target_title.trim().toLowerCase()) ?? [];
    const targetIdentity = ids.length === 1 ? identities.get(ids[0]) : null;
    edges.push(graphEdge(
      { source: link.source_id, target_id: ids.length === 1 ? ids[0] : null, target_title: link.target_title },
      sourceIdentity,
      targetIdentity,
      targetIdentity
        ? { binding: "title", resolution: "resolved" }
        : { binding: "title", resolution: "unresolved", reason: ids.length > 1 ? "duplicate_title" : "title_not_found" },
    ));
  }
  const semantic = vaultSemantic.graph(scope, notes);
  for (const edge of semantic.edges) {
    const sourceIdentity = identities.get(edge.source);
    const targetIdentity = identities.get(edge.target_id);
    if (sourceIdentity && targetIdentity) edges.push(graphEdge(edge, sourceIdentity, targetIdentity, { binding: "inference", resolution: "resolved" }));
  }
  const connected = new Set(edges.filter((edge) => edge.resolution === "resolved")
    .flatMap((edge) => [edge.source, edge.target_id]).filter(Boolean));
  res.json({
    nodes: notes.map((note) => graphNode({ id: note.id, title: note.title, folder: note.folder }, identities.get(note.id))),
    edges, analysis: semantic.analysis,
    orphans: notes.filter((note) => !connected.has(note.id)).map((note) => note.id),
  });
}
