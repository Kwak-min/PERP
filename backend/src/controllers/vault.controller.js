import { z } from "zod";

import { resolvePrincipal } from "../middleware/auth.js";
import { getScoped, hardDelete, insert, listScoped, softDelete, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { CANDIDATE_LIMIT, legacyVaultScope, vaultSemantic } from "../services/vault-semantic.service.js";
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
    const target = listScoped(
      "vault_note",
      principal,
      [
        { sql: "owner_id = ?", params: [principal.userId] },
        { sql: "title = ?", params: [title] },
      ],
      { limit: 1 },
    )[0];
    insert("vault_link", {
      tenant_id: principal.tenantId,
      owner_id: principal.userId,
      source_id: note.id,
      target_title: title,
      target_id: target ? target.id : null,
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
  const known = new Set(notes.map((n) => n.id));
  const semantic = vaultSemantic.graph(scope, notes);
  const edges = [...links.filter(l => known.has(l.source_id))
    .map(l => ({ source: l.source_id, target_id: known.has(l.target_id) ? l.target_id : null, target_title: l.target_title })), ...semantic.edges];
  res.json({
    nodes: notes.map((n) => ({ id: n.id, title: n.title, folder: n.folder })),
    edges, analysis: semantic.analysis,
    orphans: notes.filter(n => !edges.some(e => e.source === n.id || e.target_id === n.id)).map(n => n.id),
  });
}
