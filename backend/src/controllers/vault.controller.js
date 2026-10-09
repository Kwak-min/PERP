import { z } from "zod";

import { resolvePrincipal } from "../middleware/auth.js";
import { pgQuery, pgTransaction } from "../config/pg.js";
import * as audit from "../services/audit.service.js";
import { ApiError, notFound } from "../utils/errors.js";

// perp_db(notes.*) 전용 개인 Vault 컨트롤러.
// 3 테이블 매핑:
//   notes.vaults  (id, owner_id -> auth.users, name)        : 소유자 1인당 "My Vault"
//   notes.notes   (id, vault_id, folder_path, title, content_md, created_at, updated_at)
//   notes.links   (from_note_id, to_note_id)                : 해석된 위키링크 (to NOT NULL)
// 개인 노트이므로 스코프는 vault.owner_id = principal.userId (회사 컬럼 없음).
// id/vault_id/note_id 는 GENERATED ALWAYS AS IDENTITY -> INSERT 시 공급 금지, 조회는 ::text 비교.
// perp_db 에 없는 필드는 프론트 계약 유지를 위해 상수로 반환:
//   tags: [] · sensitivity: "personal" · agent_enabled: true · pinned: false · version: 1
// 위키링크/백링크/그래프는 content_md 의 [[제목]] 파싱을 단일 진실원으로 사용(고스트 노드 지원),
// notes.links 는 쓰기 시 해석된 링크만 동기화(FK/영속 목적).

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
  version: z.number().int().optional(),
});

const NOTE_COLS = `
  n.id, n.vault_id, n.folder_path, n.title, n.content_md,
  to_char(n.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at`;

// perp_db row -> 프론트 기대 형태
const view = (note, backlinks = []) => ({
  id: String(note.id),
  folder: note.folder_path,
  title: note.title,
  tags: [],
  sensitivity: "personal",
  agent_enabled: true,
  pinned: false,
  version: 1,
  backlinks,
  updated_at: note.updated_at,
});

const parseTitles = (content) =>
  [...new Set([...(content ?? "").matchAll(WIKILINK)].map((m) => m[1].trim()).filter(Boolean))];

async function recordAudit(entry) {
  try {
    audit.record(entry);
  } catch {
    // 감사 로그 저장 실패는 요청을 막지 않는다.
  }
}

// 소유자의 vault id 조회. 없고 create=true 면 생성.
async function vaultIdFor(userId, { create = false } = {}) {
  const found = await pgQuery(
    `SELECT id FROM notes.vaults WHERE owner_id::text = $1 ORDER BY id LIMIT 1`,
    [String(userId)],
  );
  if (found.rows.length > 0) return found.rows[0].id;
  if (!create) return null;
  const made = await pgQuery(
    `INSERT INTO notes.vaults (owner_id, name) VALUES ($1, 'My Vault')
     ON CONFLICT (owner_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [String(userId)],
  );
  return made.rows[0].id;
}

// 소유자 스코프로 단일 노트 로드.
async function ownNote(userId, noteId) {
  const { rows } = await pgQuery(
    `SELECT ${NOTE_COLS}
       FROM notes.notes n
       JOIN notes.vaults v ON v.id = n.vault_id
      WHERE v.owner_id::text = $1 AND n.id::text = $2`,
    [String(userId), String(noteId)],
  );
  if (rows.length === 0) throw notFound("vault note");
  return rows[0];
}

// vault 의 모든 노트(그래프/백링크 파싱용).
async function allNotes(vaultId) {
  const { rows } = await pgQuery(
    `SELECT ${NOTE_COLS} FROM notes.notes n
      WHERE n.vault_id = $1 ORDER BY n.updated_at DESC`,
    [vaultId],
  );
  return rows;
}

// content 의 [[제목]] 을 해석해 notes.links 를 재동기화(해석된 링크만, to NOT NULL).
async function reindexLinks(client, vaultId, noteId, content) {
  await client.query(`DELETE FROM notes.links WHERE from_note_id = $1`, [noteId]);
  const titles = parseTitles(content);
  if (titles.length === 0) return;
  const { rows } = await client.query(
    `SELECT id, title FROM notes.notes WHERE vault_id = $1 AND title = ANY($2::text[])`,
    [vaultId, titles],
  );
  const idByTitle = new Map(rows.map((r) => [r.title, r.id]));
  for (const t of titles) {
    const to = idByTitle.get(t);
    if (!to || String(to) === String(noteId)) continue;
    await client.query(
      `INSERT INTO notes.links (from_note_id, to_note_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [noteId, to],
    );
  }
}

export async function createNote(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const payload = noteSchema.parse(req.body);

  const reason = credentialReason(payload.content) ?? credentialReason(payload.title);
  if (reason) throw new ApiError("VALIDATION_ERROR", reason);

  const note = await pgTransaction(async (client) => {
    const vaultId = await vaultIdForTx(client, principal.userId);

    const dup = await client.query(
      `SELECT 1 FROM notes.notes WHERE vault_id = $1 AND title = $2 LIMIT 1`,
      [vaultId, payload.title],
    );
    if (dup.rows.length > 0) throw new ApiError("CONFLICT", "같은 제목의 노트가 이미 있습니다");

    const inserted = await client.query(
      `INSERT INTO notes.notes (vault_id, folder_path, title, content_md)
       VALUES ($1, $2, $3, $4)
       RETURNING ${NOTE_COLS.replaceAll("n.", "")}`,
      [vaultId, payload.folder, payload.title, payload.content],
    );
    const created = inserted.rows[0];
    await reindexLinks(client, vaultId, created.id, payload.content);
    return created;
  });

  const links = parseTitles(note.content_md);

  await recordAudit({
    tenantId: principal.tenantId,
    action: "vault.note.created",
    resourceType: "vault_note",
    resourceId: String(note.id),
    actorId: principal.userId,
    after: { title: note.title, links: links.length },
    requestId: req.requestId,
  });

  res.status(201).json({ ...view(note), links });
}

// 트랜잭션 클라이언트용 vault 확보 헬퍼.
async function vaultIdForTx(client, userId) {
  const found = await client.query(
    `SELECT id FROM notes.vaults WHERE owner_id::text = $1 ORDER BY id LIMIT 1`,
    [String(userId)],
  );
  if (found.rows.length > 0) return found.rows[0].id;
  const made = await client.query(
    `INSERT INTO notes.vaults (owner_id, name) VALUES ($1, 'My Vault')
     ON CONFLICT (owner_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [String(userId)],
  );
  return made.rows[0].id;
}

export async function listNotes(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");

  const vaultId = await vaultIdFor(principal.userId);
  if (!vaultId) {
    res.json({ items: [], folders: [], tags: [] });
    return;
  }

  const clauses = ["n.vault_id = $1"];
  const params = [vaultId];
  if (req.query.folder) {
    params.push(req.query.folder);
    clauses.push(`n.folder_path = $${params.length}`);
  }
  params.push(Number(req.query.limit ?? 100));
  const limitIdx = params.length;

  const { rows } = await pgQuery(
    `SELECT ${NOTE_COLS} FROM notes.notes n
      WHERE ${clauses.join(" AND ")}
      ORDER BY n.updated_at DESC
      LIMIT $${limitIdx}`,
    params,
  );

  let items = rows;
  if (req.query.q) {
    const needle = String(req.query.q).toLowerCase();
    items = items.filter(
      (n) =>
        n.title.toLowerCase().includes(needle) ||
        (n.content_md ?? "").toLowerCase().includes(needle),
    );
  }

  res.json({
    items: items.map((n) => view(n)),
    folders: [...new Set(items.map((n) => n.folder_path))].sort(),
    tags: [],
  });
}

export async function getNote(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const note = await ownNote(principal.userId, req.params.noteId);

  // vault 전체를 파싱해 백링크/링크(고스트 포함) 구성.
  const notes = await allNotes(note.vault_id);
  const idByTitle = new Map(notes.map((n) => [n.title, String(n.id)]));

  const links = parseTitles(note.content_md).map((title) => ({
    title,
    target_id: idByTitle.get(title) ?? null,
  }));

  const backlinks = notes
    .filter((n) => String(n.id) !== String(note.id) && parseTitles(n.content_md).includes(note.title))
    .map((n) => String(n.id));

  res.json({
    ...view(note, backlinks),
    content: note.content_md ?? "",
    links,
  });
}

export async function patchNote(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const payload = patchSchema.parse(req.body);
  const note = await ownNote(principal.userId, req.params.noteId);

  if (payload.content !== undefined) {
    const reason = credentialReason(payload.content);
    if (reason) throw new ApiError("VALIDATION_ERROR", reason);
  }

  const sets = [];
  const params = [];
  if (payload.title !== undefined) {
    params.push(payload.title);
    sets.push(`title = $${params.length}`);
  }
  if (payload.content !== undefined) {
    params.push(payload.content);
    sets.push(`content_md = $${params.length}`);
  }
  if (payload.folder !== undefined) {
    params.push(payload.folder);
    sets.push(`folder_path = $${params.length}`);
  }
  // tags/agent_enabled/pinned/version 은 perp_db notes 스키마에 없어 저장하지 않음.

  const updated = await pgTransaction(async (client) => {
    let row = note;
    if (sets.length > 0) {
      params.push(note.id);
      const idIdx = params.length;
      let result;
      try {
        result = await client.query(
          `UPDATE notes.notes SET ${sets.join(", ")}, updated_at = now()
            WHERE id = $${idIdx}
            RETURNING ${NOTE_COLS.replaceAll("n.", "")}`,
          params,
        );
      } catch (err) {
        if (err.code === "23505") {
          throw new ApiError("CONFLICT", "같은 제목/폴더의 노트가 이미 있습니다");
        }
        throw err;
      }
      row = result.rows[0];
    }
    await reindexLinks(client, note.vault_id, note.id, row.content_md);
    return row;
  });

  const notes = await allNotes(note.vault_id);
  const backlinks = notes
    .filter(
      (n) => String(n.id) !== String(updated.id) && parseTitles(n.content_md).includes(updated.title),
    )
    .map((n) => String(n.id));

  res.json(view(updated, backlinks));
}

export async function deleteNote(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const note = await ownNote(principal.userId, req.params.noteId);

  // notes.links 는 FK ON DELETE CASCADE 로 자동 정리.
  await pgQuery(`DELETE FROM notes.notes WHERE id = $1`, [note.id]);

  await recordAudit({
    tenantId: principal.tenantId,
    action: "vault.note.deleted",
    resourceType: "vault_note",
    resourceId: String(note.id),
    actorId: principal.userId,
    requestId: req.requestId,
  });

  res.json({ id: String(note.id), deleted: true });
}

export async function graph(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");

  const vaultId = await vaultIdFor(principal.userId);
  if (!vaultId) {
    res.json({ nodes: [], edges: [], orphans: [] });
    return;
  }

  const notes = await allNotes(vaultId);
  const idByTitle = new Map(notes.map((n) => [n.title, String(n.id)]));

  const edges = [];
  const touched = new Set();
  for (const n of notes) {
    const src = String(n.id);
    for (const title of parseTitles(n.content_md)) {
      const targetId = idByTitle.get(title) ?? null;
      edges.push({ source: src, target_id: targetId, target_title: title });
      touched.add(src);
      if (targetId) touched.add(targetId);
    }
  }

  res.json({
    nodes: notes.map((n) => ({ id: String(n.id), title: n.title, folder: n.folder_path })),
    edges,
    orphans: notes.filter((n) => !touched.has(String(n.id))).map((n) => String(n.id)),
  });
}
