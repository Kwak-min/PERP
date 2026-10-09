import { z } from "zod";

import { resolvePrincipal } from "../middleware/auth.js";
import { pgQuery, pgTransaction } from "../config/pg.js";
import * as audit from "../services/audit.service.js";
import { ApiError, notFound } from "../utils/errors.js";

// perp_db 전용 문서/회의록 컨트롤러 (SQLite 완전 제거).
//
// 매핑 테이블:
//   project.documents (id, project_id, title, content_md, file_id, author_id,
//                      version, created_at, updated_at)
//     -> company_id 컬럼이 없어 project.projects 를 JOIN 해 company 스코프.
//   project.meeting_minutes (id, project_id, company_id, title, meeting_at,
//                            location, content_md, author_id, created_at)
//   project.meeting_attendees (minute_id, user_id)
//
// perp_db 에 없어 프론트 계약 유지를 위해 상수로 반환하는 필드:
//   doc_type: "note" · tags: [] · sensitivity: "internal" · archived: false
//   review_status: "approved" · ai_generated: false
//
// 미지원 기능(스키마에 대응 테이블/컬럼 없음):
//   - 문서 스페이스(createSpace/listSpaces): 전용 테이블 없음 -> 빈 결과/비영속.
//   - 문서 버전 이력(getDocument.versions, restoreVersion): 이력 테이블 없음.
//   - 문서 보관(archiveDocument): archived/deleted 컬럼 없음 -> 비파괴로 미지원 명시.
//   - 회의 결정사항(addDecision/confirmDecisions, getMeeting.decisions):
//     project.meeting_decisions 테이블 없음 -> 빈 배열 / 미지원 명시.

const documentSchema = z.object({
  title: z.string().min(1).max(300),
  content: z.string().default(""),
  project_id: z.union([z.string(), z.number()]),
  // 아래는 프론트 호환용으로 받되 perp_db 스키마엔 없어 저장하지 않음.
  space_id: z.string().nullable().optional(),
  doc_type: z.string().default("note"),
  tags: z.array(z.string()).default([]),
  visibility: z.string().default("org"),
  sensitivity: z.string().default("internal"),
});

const patchSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  visibility: z.string().optional(),
  review_status: z.string().optional(),
  version: z.number().int().optional(),
});

const meetingSchema = z.object({
  title: z.string().min(1).max(300),
  held_at: z.string(),
  location: z.string().nullable().optional(),
  attendees: z.array(z.union([z.string(), z.number()])).default([]),
  agenda: z.string().default(""),
  notes: z.string().default(""),
  project_id: z.union([z.string(), z.number()]).nullable().optional(),
});

const DOC_COLS = `
  d.id, d.project_id, d.title, d.content_md, d.author_id, d.version,
  to_char(d.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  to_char(d.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at`;

const MEETING_COLS = `
  m.id, m.project_id, m.company_id, m.title, m.location, m.content_md, m.author_id,
  to_char(m.meeting_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS meeting_at,
  to_char(m.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at`;

// perp_db project.documents row -> 프론트(DocumentsScreen) 기대 Doc 형태
const view = (d) => ({
  id: String(d.id),
  title: d.title,
  doc_type: "note",
  tags: [],
  sensitivity: "internal",
  owner_id: d.author_id === null || d.author_id === undefined ? null : String(d.author_id),
  archived: false,
  review_status: "approved",
  ai_generated: false,
  version: d.version,
  updated_at: d.updated_at,
});

async function recordAudit(entry) {
  try {
    audit.record(entry);
  } catch {
    // 감사 로그 저장 실패는 요청을 막지 않는다.
  }
}

// company 스코프로 단일 문서 로드(project.projects JOIN).
async function ownDocument(orgId, documentId) {
  const { rows } = await pgQuery(
    `SELECT ${DOC_COLS}
       FROM project.documents d
       JOIN project.projects p ON p.id = d.project_id
      WHERE p.company_id::text = $1 AND d.id::text = $2`,
    [String(orgId), String(documentId)],
  );
  if (rows.length === 0) throw notFound("document");
  return rows[0];
}

// company 스코프로 단일 회의록 로드.
async function ownMeeting(orgId, meetingId) {
  const { rows } = await pgQuery(
    `SELECT ${MEETING_COLS}
       FROM project.meeting_minutes m
      WHERE m.company_id::text = $1 AND m.id::text = $2`,
    [String(orgId), String(meetingId)],
  );
  if (rows.length === 0) throw notFound("meeting");
  return rows[0];
}

// --- 문서 스페이스: 전용 테이블 없음. 프론트 미호출. 비영속/빈 결과 ---

export async function createSpace(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.write");
  // perp_db 에 문서 스페이스 테이블이 없어 영속화하지 않는다.
  throw new ApiError(
    "NOT_SUPPORTED",
    "문서 스페이스는 현재 perp_db 스키마에서 지원되지 않습니다",
  );
}

export async function listSpaces(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.read");
  res.json({ items: [] });
}

// --- 문서 ---

export async function createDocument(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.write");
  const payload = documentSchema.parse(req.body);

  const created = await pgTransaction(async (client) => {
    // project 가 같은 company 소속인지 검증(스코프 가드).
    const proj = await client.query(
      `SELECT id FROM project.projects WHERE id::text = $1 AND company_id::text = $2`,
      [String(payload.project_id), String(principal.orgId)],
    );
    if (proj.rows.length === 0) throw notFound("project");

    const inserted = await client.query(
      `INSERT INTO project.documents (project_id, title, content_md, author_id, version)
       VALUES ($1, $2, $3, $4, 1)
       RETURNING ${DOC_COLS.replaceAll("d.", "")}`,
      [String(payload.project_id), payload.title, payload.content, principal.userId],
    );
    return inserted.rows[0];
  });

  await recordAudit({
    tenantId: principal.tenantId,
    action: "document.created",
    resourceType: "document",
    resourceId: String(created.id),
    actorId: principal.userId,
    after: { title: created.title },
    requestId: req.requestId,
  });

  res.status(201).json(view(created));
}

export async function listDocuments(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.read");

  const { rows } = await pgQuery(
    `SELECT ${DOC_COLS}
       FROM project.documents d
       JOIN project.projects p ON p.id = d.project_id
      WHERE p.company_id::text = $1
      ORDER BY d.updated_at DESC
      LIMIT $2`,
    [String(principal.orgId), Number(req.query.limit ?? 50)],
  );

  res.json({ items: rows.map(view), next_cursor: null });
}

export async function getDocument(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.read");
  const document = await ownDocument(principal.orgId, req.params.documentId);
  res.json({
    ...view(document),
    content: document.content_md ?? "",
    // 버전 이력 테이블이 없어 현재 버전만 노출.
    versions: [
      {
        revision: document.version,
        author_id:
          document.author_id === null || document.author_id === undefined
            ? null
            : String(document.author_id),
        created_at: document.updated_at,
      },
    ],
  });
}

export async function patchDocument(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.write");
  const payload = patchSchema.parse(req.body);
  const document = await ownDocument(principal.orgId, req.params.documentId);

  if (payload.version !== undefined && payload.version !== document.version) {
    throw new ApiError("VERSION_CONFLICT", "document was modified by someone else");
  }

  const before = view(document);
  const sets = ["version = version + 1", "updated_at = now()"];
  const params = [];
  if (payload.title !== undefined) {
    params.push(payload.title);
    sets.push(`title = $${params.length}`);
  }
  if (payload.content !== undefined) {
    params.push(payload.content);
    sets.push(`content_md = $${params.length}`);
  }
  // visibility/review_status 는 perp_db documents 스키마에 없어 저장하지 않음.

  params.push(String(document.id));
  const { rows } = await pgQuery(
    `UPDATE project.documents SET ${sets.join(", ")}
      WHERE id::text = $${params.length}
      RETURNING ${DOC_COLS.replaceAll("d.", "")}`,
    params,
  );
  const updated = rows[0];

  await recordAudit({
    tenantId: principal.tenantId,
    action: "document.updated",
    resourceType: "document",
    resourceId: String(document.id),
    actorId: principal.userId,
    before,
    after: view(updated),
    requestId: req.requestId,
  });

  res.json(view(updated));
}

export async function restoreVersion(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.write");
  // 버전 이력 테이블이 없어 복원 불가.
  await ownDocument(principal.orgId, req.params.documentId);
  throw new ApiError(
    "NOT_SUPPORTED",
    "문서 버전 복원은 현재 perp_db 스키마에서 지원되지 않습니다",
  );
}

export async function archiveDocument(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.write");
  // archived/deleted 컬럼이 없어 비파괴 원칙상 미지원으로 명시(하드삭제 지양).
  await ownDocument(principal.orgId, req.params.documentId);
  throw new ApiError(
    "NOT_SUPPORTED",
    "문서 보관/삭제는 현재 perp_db 스키마에서 지원되지 않습니다",
  );
}

// --- 회의록 ---

export async function createMeeting(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("meeting.write");
  const payload = meetingSchema.parse(req.body);

  const meeting = await pgTransaction(async (client) => {
    if (payload.project_id !== null && payload.project_id !== undefined) {
      const proj = await client.query(
        `SELECT id FROM project.projects WHERE id::text = $1 AND company_id::text = $2`,
        [String(payload.project_id), String(principal.orgId)],
      );
      if (proj.rows.length === 0) throw notFound("project");
    }

    const content = payload.agenda
      ? `${payload.agenda}\n\n${payload.notes}`.trim()
      : payload.notes;

    const inserted = await client.query(
      `INSERT INTO project.meeting_minutes
         (project_id, company_id, title, meeting_at, location, content_md, author_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${MEETING_COLS.replaceAll("m.", "")}`,
      [
        payload.project_id ?? null,
        principal.orgId,
        payload.title,
        payload.held_at,
        payload.location ?? null,
        content,
        principal.userId,
      ],
    );
    const row = inserted.rows[0];

    for (const userId of payload.attendees) {
      await client.query(
        `INSERT INTO project.meeting_attendees (minute_id, user_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [row.id, String(userId)],
      );
    }
    return row;
  });

  await recordAudit({
    tenantId: principal.tenantId,
    action: "meeting.created",
    resourceType: "meeting",
    resourceId: String(meeting.id),
    actorId: principal.userId,
    requestId: req.requestId,
  });

  res.status(201).json({ id: String(meeting.id), title: meeting.title, review_status: "approved" });
}

export async function getMeeting(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.read");
  const meeting = await ownMeeting(principal.orgId, req.params.meetingId);

  const { rows: attendees } = await pgQuery(
    `SELECT user_id FROM project.meeting_attendees WHERE minute_id = $1 ORDER BY user_id`,
    [meeting.id],
  );

  res.json({
    id: String(meeting.id),
    title: meeting.title,
    held_at: meeting.meeting_at,
    location: meeting.location,
    attendees: attendees.map((a) => String(a.user_id)),
    agenda: "",
    notes: meeting.content_md ?? "",
    ai_summary: null,
    ai_generated: false,
    review_status: "approved",
    // 결정사항 테이블(project.meeting_decisions)이 없어 빈 배열.
    decisions: [],
  });
}

export async function addDecision(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("meeting.write");
  await ownMeeting(principal.orgId, req.params.meetingId);
  throw new ApiError(
    "NOT_SUPPORTED",
    "회의 결정사항 저장은 현재 perp_db 스키마에서 지원되지 않습니다",
  );
}

export async function confirmDecisions(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.write");
  await ownMeeting(principal.orgId, req.params.meetingId);
  res.json({ created: [], count: 0 });
}

// --- 검색: 제목/본문 부분일치(프론트 미호출) ---

export async function searchDocuments(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("document.read");
  const q = String(req.query.q ?? "");

  const { rows } = await pgQuery(
    `SELECT ${DOC_COLS}
       FROM project.documents d
       JOIN project.projects p ON p.id = d.project_id
      WHERE p.company_id::text = $1
        AND ($2 = '' OR d.title ILIKE '%' || $2 || '%' OR d.content_md ILIKE '%' || $2 || '%')
      ORDER BY d.updated_at DESC
      LIMIT 20`,
    [String(principal.orgId), q],
  );

  res.json({ query: q, items: rows.map(view) });
}
