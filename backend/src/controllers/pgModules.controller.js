import path from "node:path";

import { z } from "zod";
import { pgIdentity, resolvePgCompanyPrincipal } from "../middleware/pgAccess.js";
import { money, idempotentMutation, MONEY_TABLES, mutateFinancialRecord } from '../services/pg-finance.service.js';
import { pgQuery, pgTransaction } from "../config/pg.js";
import { MODULE_CATALOG } from "../config/modules.js";
import { enabledFeatures, FEATURE_CATALOG, modulesForFeatures, validateFeatureSelection } from "../config/features.js";
import { pgEnabledFeatures } from "../middleware/features.js";
import { validateSelection } from "../middleware/modules.js";
import { hashPassword } from "../utils/crypto.js";
import { isCompanyMember } from "../services/pg-company.service.js";
import { mutatePgRoles } from '../services/pg-company-roles.service.js';
import { readOrgActivity } from "../services/pg-org-audit.service.js";
import { ApiError } from "../utils/errors.js";
import { CANDIDATE_LIMIT, pgVaultScope, vaultSemantic } from "../services/vault-semantic.service.js";
import {
  DOCUMENT_CANDIDATE_LIMIT,
  documentSemantic,
  pgDocumentSemanticScope,
} from "../services/document-semantic.service.js";
import { extractSupportedTextUpload, persistUploadedSource } from "../services/document-ingestion.service.js";

// perp_db(PostgreSQL) 모듈 read 슬라이스.
// strangler-fig 1단계: 홈/프로젝트/캘린더/재무/HR 화면을 실데이터로 전환.
// 모든 조회는 로그인 사용자의 회사(company_id)로 스코프한다.
// 응답은 프론트 ScreenPage 의 제네릭 매퍼(liveTable/liveStats)가 렌더한다.

const resolveUser = pgIdentity;

async function resolveCompanyId(req) {
  return (await resolveUser(req)).companyId;
}

// POST /api/v1/pg/calendar — 일정 생성
export async function createCalendarEvent(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) {
    throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 일정을 만들 수 있습니다");
  }
  const body = req.body ?? {};
  const title = String(body.title ?? "").trim();
  const startsAt = body.starts_at;
  const endsAt = body.ends_at;
  const location = String(body.location ?? "").trim() || null;
  if (!title || !startsAt || !endsAt) {
    throw new ApiError("VALIDATION_ERROR", "제목·시작·종료는 필수입니다");
  }
  if (new Date(endsAt) < new Date(startsAt)) {
    throw new ApiError("VALIDATION_ERROR", "종료가 시작보다 빠를 수 없습니다");
  }
  const { rows } = await pgQuery(
    `INSERT INTO calendar.events (company_id, owner_id, title, location, starts_at, ends_at, scope)
     VALUES ($1, $2, $3, $4, $5, $6, 'company')
     RETURNING id`,
    [companyId, userId, title, location, startsAt, endsAt],
  );
  res.status(201).json({ id: String(rows[0].id) });
}

// GET /api/v1/pg/usage — 홈/조직 대시보드 집계
// 업무 총계는 목록과 동일하게 취소(cancelled)를 포함한 회사의 모든 업무 행을 센다.
export async function usage(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) {
    return res.json({ members: 0, projects: 0, tasks: 0, documents: 0 });
  }
  const { rows } = await pgQuery(
    `SELECT
       (SELECT count(*) FROM org.company_memberships WHERE company_id = $1 AND status = 'active') AS members,
       (SELECT count(*) FROM project.projects  WHERE company_id = $1) AS projects,
       (SELECT count(*) FROM project.tasks t
          JOIN project.projects p ON p.id = t.project_id
         WHERE p.company_id = $1) AS tasks,
       (SELECT count(*) FROM project.documents d
          JOIN project.projects p ON p.id = d.project_id
         WHERE p.company_id = $1) AS documents`,
    [companyId],
  );
  const r = rows[0];
  res.json({
    members: Number(r.members),
    projects: Number(r.projects),
    tasks: Number(r.tasks),
    documents: Number(r.documents),
  });
}

// POST /api/v1/pg/projects — 프로젝트 생성
export async function createProject(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) {
    throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 프로젝트를 만들 수 있습니다");
  }
  const body = req.body ?? {};
  const name = String(body.name ?? "").trim();
  const startsOn = body.starts_on || null;
  const endsOn = body.ends_on || null;
  const description = String(body.description ?? "").trim() || null;
  if (!name) {
    throw new ApiError("VALIDATION_ERROR", "이름은 필수입니다");
  }
  if (startsOn && endsOn && new Date(endsOn) < new Date(startsOn)) {
    throw new ApiError("VALIDATION_ERROR", "종료가 시작보다 빠를 수 없습니다");
  }
  const { rows } = await pgQuery(
    `INSERT INTO project.projects (company_id, name, description, status, starts_on, ends_on, lead_id)
     VALUES ($1, $2, $3, 'active', $4, $5, $6)
     RETURNING id`,
    [companyId, name, description, startsOn, endsOn, userId],
  );
  res.status(201).json({ id: String(rows[0].id) });
}

// GET /api/v1/pg/projects
export async function projects(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT p.id AS __id, p.name AS 프로젝트, p.status AS status,
            u.name AS 책임자, to_char(p.starts_on, 'YYYY-MM-DD') AS 시작, to_char(p.ends_on, 'YYYY-MM-DD') AS 종료, p.version, p.description
       FROM project.projects p
       LEFT JOIN auth.users u ON u.id = p.lead_id
      WHERE p.company_id = $1
      ORDER BY p.starts_on DESC NULLS LAST, p.id DESC`,
    [companyId],
  );
  res.json({ items: rows });
}

// GET /api/v1/pg/calendar
export async function calendar(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const window = z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), event_id: z.string().regex(/^\d+$/).optional() })
    .refine(value => Boolean(value.from) === Boolean(value.to) && (!value.from || (Date.parse(value.to) > Date.parse(value.from) && Date.parse(value.to) - Date.parse(value.from) <= 32 * 86_400_000)), "조회 기간은 32일 이내여야 합니다")
    .parse(req.query);
  const params = [companyId];
  const filters = ["company_id = $1", "cancelled_at IS NULL"];
  if (window.from && window.to) { params.push(window.from, window.to); filters.push("ends_at >= $2 AND starts_at < $3"); }
  if (window.event_id) { params.push(window.event_id); filters.push(`id = $${params.length}`); }
  const { rows } = await pgQuery(
    `SELECT id AS __id, title AS 일정, starts_at AS 시작, ends_at AS 종료,
            location AS 장소, scope AS status, version
       FROM calendar.events
      WHERE ${filters.join(" AND ")}
      ORDER BY starts_at DESC
      ${window.from || window.event_id ? "" : "LIMIT 100"}`,
    params,
  );
  res.json({ items: rows });
}

// GET /api/v1/pg/finance/summary — 재무 홈 지표
export async function financeSummary(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ 수입: '0.00', 지출: '0.00', 잔액: '0.00' });
  const { rows } = await pgQuery(
    `SELECT
       COALESCE(SUM(CASE WHEN a.account_type = 'revenue' THEN l.credit - l.debit END), 0.00)::text AS revenue,
       COALESCE(SUM(CASE WHEN a.account_type = 'expense' THEN l.debit - l.credit END), 0.00)::text AS expense,
       COALESCE(SUM(CASE WHEN a.account_type IN ('revenue','expense') THEN l.credit - l.debit END), 0.00)::text AS balance
       FROM accounting.journal_lines l
       JOIN accounting.journal_entries e ON e.id = l.entry_id
       JOIN accounting.accounts a ON a.id = l.account_id
      WHERE e.company_id = $1`,
    [companyId],
  );
  // Keep aggregate NUMERIC precision, including totals larger than a single entry.
  res.json({ 수입: rows[0].revenue, 지출: rows[0].expense, 잔액: rows[0].balance });
}

// GET /api/v1/pg/finance/accounts — 거래 입력용 계정 선택지(수입·지출 계정)
export async function financeAccounts(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT id, code, name, account_type
       FROM accounting.accounts
      WHERE company_id = $1 AND is_active = true
        AND account_type IN ('revenue', 'expense')
      ORDER BY account_type, code`,
    [companyId],
  );
  const typeLabel = { revenue: "수입", expense: "지출" };
  const items = rows.map((r) => ({
    value: String(r.id),
    label: `[${typeLabel[r.account_type] ?? r.account_type}] ${r.code} ${r.name}`,
  }));
  res.json({ items });
}

// POST /api/v1/pg/finance/transactions — 거래 생성(복식부기 2줄 자동 생성)
// 선택한 계정이 수입이면 (현금 차변 / 수입 대변), 지출이면 (지출 차변 / 현금 대변).
export async function createTransaction(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) {
    throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 거래를 만들 수 있습니다");
  }
  const body = req.body ?? {};
  const accountId = body.account_id;
  const amount = money(body.amount);
  const entryDate = body.entry_date || null;
  if (entryDate) z.string().date().parse(entryDate);
  const memo = String(body.memo ?? "").trim() || null;
  if (!accountId) throw new ApiError("VALIDATION_ERROR", "계정을 선택하세요");
  const result = await idempotentMutation(req, 'transaction.create', { account_id: String(accountId), amount, entry_date: entryDate, memo }, async client => {
  // 계정 조회부터 게시까지 같은 트랜잭션이다.
  const { rows: accRows } = await client.query(
    `SELECT id, account_type FROM accounting.accounts
      WHERE id = $1 AND company_id = $2 AND is_active = true AND account_type IN ('revenue','expense') FOR SHARE`,
    [accountId, companyId],
  );
  const account = accRows[0];
  if (!account) throw new ApiError("VALIDATION_ERROR", "유효하지 않은 계정입니다");

  // 상대 계정 = 회사의 자산(현금) 계정 중 코드 최소값
  const { rows: cashRows } = await client.query(
    `SELECT id FROM accounting.accounts
      WHERE company_id = $1 AND account_type = 'asset' AND is_active = true
      ORDER BY code LIMIT 1 FOR SHARE`,
    [companyId],
  );
  const cash = cashRows[0];
  if (!cash) throw new ApiError("VALIDATION_ERROR", "현금(자산) 계정이 없어 거래를 만들 수 없습니다");

  const { rows: entryRows } = await client.query(
    `INSERT INTO accounting.journal_entries (company_id, entry_date, memo, created_by, posted)
     VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, false) RETURNING id`,
    [companyId, entryDate, memo, userId],
  );
  const entryId = entryRows[0].id;

  // 수입: 현금 차변 / 수입 대변 · 지출: 지출 차변 / 현금 대변
  const lines =
    account.account_type === "revenue"
      ? [
          { accountId: cash.id, debit: amount, credit: 0 },
          { accountId: account.id, debit: 0, credit: amount },
        ]
      : [
          { accountId: account.id, debit: amount, credit: 0 },
          { accountId: cash.id, debit: 0, credit: amount },
        ];
  for (const l of lines) {
    await client.query(
      `INSERT INTO accounting.journal_lines (entry_id, account_id, debit, credit)
       VALUES ($1, $2, $3, $4)`,
      [entryId, l.accountId, l.debit, l.credit],
    );
  }
  await client.query('UPDATE accounting.journal_entries SET posted=true WHERE id=$1', [entryId]);
  return { id: String(entryId), version: 1 };
  });
  res.status(201).json(result);
}

// GET /api/v1/pg/finance/transactions
export async function financeTransactions(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT e.id AS __id, e.entry_date AS 일자, e.memo AS 내용,
            COALESCE(SUM(l.debit), 0) AS 차변,
            COALESCE(SUM(l.credit), 0) AS 대변,
            CASE WHEN e.posted THEN 'confirmed' ELSE 'pending' END AS status, e.version AS __version
       FROM accounting.journal_entries e
       LEFT JOIN accounting.journal_lines l ON l.entry_id = e.id
      WHERE e.company_id = $1
      GROUP BY e.id
      ORDER BY e.entry_date DESC, e.id DESC`,
    [companyId],
  );
  res.json({ items: rows });
}

// GET /api/v1/pg/approvals — 결재(승인요청)
export async function approvals(req, res) {
  const principal = await resolvePgCompanyPrincipal(req);
  const { companyId, userId } = principal;
  if (!principal.has('approval.decide')) principal.require('approval.request');
  const canDecide = principal.has('approval.decide');
  const { rows } = await pgQuery(
    `SELECT ar.id AS __id, ar.request_type AS 유형, r.name AS 신청자, t.name AS 대상,
            ar.status AS status, ar.created_at AS 신청일, ar.payload, ar.decision_note, ar.decided_at
       FROM org.approval_requests ar
       LEFT JOIN auth.users r ON r.id = ar.requester_id
       LEFT JOIN auth.users t ON t.id = ar.target_user_id
      WHERE ar.company_id = $1 AND ($2::boolean OR ar.requester_id = $3)
      ORDER BY ar.created_at DESC, ar.id DESC`,
    [companyId, canDecide, userId],
  );
  res.json({ items: rows, can_decide: canDecide, can_request: principal.has('approval.request') });
}

// GET /api/v1/pg/tasks — 업무 (project.tasks)
export async function tasks(req, res) {
  const filter = z.object({ project_id: z.string().regex(/^[1-9]\d*$/).optional(), task_id: z.string().regex(/^[1-9]\d*$/).optional() }).parse(req.query);
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT t.id AS __id, t.project_id, t.title AS 업무, p.name AS 프로젝트, u.name AS 담당,
            t.status AS status, to_char(t.due_on, 'YYYY-MM-DD') AS 기한, t.description, t.assignee_id, t.version
       FROM project.tasks t
       JOIN project.projects p ON p.id = t.project_id
       LEFT JOIN auth.users u ON u.id = t.assignee_id
      WHERE p.company_id = $1
        ${filter.project_id ? "AND t.project_id = $2" : ""}
        ${filter.task_id ? `AND t.id = $${filter.project_id ? 3 : 2}` : ""}
      ORDER BY t.sort_order, t.id DESC`,
    [companyId, ...(filter.project_id ? [filter.project_id] : []), ...(filter.task_id ? [filter.task_id] : [])],
  );
  res.json({ items: rows });
}

// ── 조직 문서 / 로컬 의미 그래프 ─────────────────────────────────
const pgDocumentId = z.string().regex(/^\d+$/);
const pgDocumentUploadInput = z.object({
  filename: z.string().min(1).max(255),
  mime: z.string().min(1).max(100),
  content_base64: z.string().min(1).max(1_400_000),
  project_id: z.string().regex(/^[1-9]\d*$/),
  title: z.string().trim().min(1).max(300).optional(),
}).strict();
const pgDocumentPatchInput = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  content: z.string().optional(),
  version: z.number().int().positive(),
}).strict().refine((value) => value.title !== undefined || value.content !== undefined, "변경할 내용을 입력하세요");
const PG_DOCUMENT_FIELDS = `d.id, d.project_id, p.name AS project_name, d.title,
  COALESCE(d.content_md, '') AS content_md, d.file_id, d.author_id, d.version,
  d.created_at, d.updated_at`;

const toPgDocument = (row) => ({
  id: String(row.id),
  project_id: String(row.project_id),
  project_name: row.project_name,
  title: row.title,
  content: row.content_md ?? "",
  file_id: row.file_id == null ? null : String(row.file_id),
  author_id: row.author_id == null ? null : String(row.author_id),
  version: Number(row.version),
  updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ""),
  created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ""),
});

async function pgDocumentsFor(companyId, bounded = false) {
  const { rows } = await pgQuery(
    `SELECT ${PG_DOCUMENT_FIELDS}
       FROM project.documents d
       JOIN project.projects p ON p.id = d.project_id
      WHERE p.company_id = $1
      ORDER BY d.updated_at DESC, d.id
      ${bounded ? "LIMIT $2" : ""}`,
    bounded ? [companyId, DOCUMENT_CANDIDATE_LIMIT + 1] : [companyId],
  );
  return rows.map(toPgDocument);
}

async function pgDocumentFor(companyId, id) {
  const { rows } = await pgQuery(
    `SELECT ${PG_DOCUMENT_FIELDS}
       FROM project.documents d
       JOIN project.projects p ON p.id = d.project_id
      WHERE d.id = $1 AND p.company_id = $2`,
    [pgDocumentId.parse(String(id)), companyId],
  );
  if (!rows[0]) throw new ApiError("NOT_FOUND", "문서를 찾을 수 없습니다");
  return toPgDocument(rows[0]);
}

function analyzePgDocument(identity, document) {
  return documentSemantic.schedule(
    pgDocumentSemanticScope(identity),
    document,
    () => pgDocumentsFor(identity.companyId, true),
  );
}

async function requirePgProject(companyId, projectId) {
  const { rows } = await pgQuery(
    `SELECT 1 FROM project.projects WHERE id = $1 AND company_id = $2`,
    [projectId, companyId],
  );
  if (!rows[0]) throw new ApiError("VALIDATION_ERROR", "선택한 회사의 유효한 프로젝트가 아닙니다");
}

// GET /api/v1/pg/documents — 문서 목록
export async function documents(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const rows = await pgDocumentsFor(companyId);
  res.json({ items: rows.map((document) => ({
    __id: document.id,
    제목: document.title,
    프로젝트: document.project_name,
    작성자: document.author_id ?? "—",
    버전: document.version,
    수정일: document.updated_at,
  })) });
}

// GET /api/v1/pg/documents/graph — 선택 회사의 프로젝트/문서/직접·AI 연결
export async function pgDocumentsGraph(req, res) {
  const identity = resolveUser(req);
  const scope = pgDocumentSemanticScope(identity);
  if (req.query.wait === "1") await documentSemantic.wait(scope);
  const [{ rows: projectRows }, documents] = await Promise.all([
    pgQuery(`SELECT id, name, updated_at FROM project.projects WHERE company_id = $1 ORDER BY name`, [identity.companyId]),
    pgDocumentsFor(identity.companyId),
  ]);
  const projectName = new Map(projectRows.map((project) => [String(project.id), project.name]));
  const titleIds = new Map();
  for (const document of documents) {
    const ids = titleIds.get(document.title) ?? [];
    ids.push(document.id);
    titleIds.set(document.title, ids);
  }
  const chunks = new Map(documents.map((document) => [document.id,
    Math.max(1, document.content.split("\n\n").map((part) => part.trim()).filter(Boolean).length)]));
  const nodes = [
    ...projectRows.map((project) => ({
      id: `project:${project.id}`, kind: "space", title: project.name, folder: project.name,
      sensitivity: "org", chunks: 0, tags: [], updated_at: project.updated_at instanceof Date ? project.updated_at.toISOString() : String(project.updated_at ?? ""),
    })),
    ...documents.map((document) => ({
      id: document.id, kind: "document", title: document.title, folder: document.project_name,
      sensitivity: "internal", chunks: chunks.get(document.id), tags: [], updated_at: document.updated_at,
    })),
  ];
  const edges = [];
  for (const document of documents) {
    if (projectName.has(document.project_id)) {
      edges.push({ source: document.id, target_id: `project:${document.project_id}`, target_title: document.project_name, kind: "space" });
    }
    const seen = new Set();
    for (const match of document.content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
      const title = match[1].trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      const ids = titleIds.get(title) ?? [];
      const targetId = ids.length === 1 ? ids[0] : null;
      if (targetId === document.id) continue;
      edges.push({ source: document.id, target_id: targetId, target_title: targetId ? title : "", kind: "link" });
    }
  }
  const semantic = documentSemantic.graph(scope, documents);
  edges.push(...semantic.edges);
  const linked = new Set(edges.flatMap((edge) => [edge.source, edge.target_id]).filter(Boolean));
  res.json({
    nodes,
    edges,
    analysis: semantic.analysis,
    orphans: documents.filter((document) => !linked.has(document.id)).map((document) => document.id),
    stats: {
      documents: documents.length,
      spaces: projectRows.length,
      chunks: [...chunks.values()].reduce((sum, count) => sum + count, 0),
      restricted: 0,
    },
  });
}

export async function pgDocumentDetail(req, res) {
  const identity = resolveUser(req);
  const document = await pgDocumentFor(identity.companyId, req.params.id);
  res.json({
    ...document,
    visibility: "org",
    sensitivity: "internal",
    tags: [],
    versions: [{ revision: document.version, author_id: document.author_id, created_at: document.updated_at }],
    analysis: documentSemantic.status(pgDocumentSemanticScope(identity), document),
  });
}

export async function pgDocumentAnalysis(req, res) {
  const identity = resolveUser(req);
  let document = await pgDocumentFor(identity.companyId, req.params.id);
  const scope = pgDocumentSemanticScope(identity);
  if (req.method === "POST") analyzePgDocument(identity, document);
  if (req.query.wait === "1") await documentSemantic.wait(scope, document.id);
  document = await pgDocumentFor(identity.companyId, document.id);
  res.json(documentSemantic.status(scope, document));
}

export async function pgUploadDocument(req, res) {
  const identity = resolveUser(req);
  const payload = pgDocumentUploadInput.parse(req.body);
  const extracted = extractSupportedTextUpload(payload);
  await requirePgProject(identity.companyId, payload.project_id);
  const stored = await persistUploadedSource({ tenantId: "pg", orgId: identity.companyId, extension: extracted.extension, bytes: extracted.bytes });
  let row;
  try {
    row = await pgTransaction(async (client) => {
      const { rows: files } = await client.query(
        `INSERT INTO files.objects
          (company_id, uploader_id, original_name, extension, mime_type, size_bytes,
           checksum_sha256, storage_bucket, storage_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [identity.companyId, identity.userId, payload.filename, extracted.extension.slice(1), extracted.mime,
          stored.size, stored.checksum, "orbitflow-local", stored.storageKey],
      );
      const { rows } = await client.query(
        `INSERT INTO project.documents (project_id, title, content_md, file_id, author_id)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, project_id, title, content_md, file_id, author_id, version, created_at, updated_at`,
        [payload.project_id, payload.title ?? path.basename(payload.filename, extracted.extension), extracted.text, files[0].id, identity.userId],
      );
      return { ...rows[0], project_name: (await client.query("SELECT name FROM project.projects WHERE id = $1 AND company_id = $2", [payload.project_id, identity.companyId])).rows[0].name };
    });
  } catch (error) {
    await stored.discard();
    throw error;
  }
  const document = toPgDocument(row);
  res.status(201).json({
    ...document,
    filename: payload.filename,
    extraction: { format: extracted.format, bytes: stored.size, encoding: "utf-8" },
    analysis: analyzePgDocument(identity, document),
  });
}

export async function pgPatchDocument(req, res) {
  const identity = resolveUser(req);
  const payload = pgDocumentPatchInput.parse(req.body);
  const { rows } = await pgQuery(
    `UPDATE project.documents d
        SET title = COALESCE($3, d.title), content_md = COALESCE($4, d.content_md),
            version = d.version + 1
       FROM project.projects p
      WHERE d.id = $1 AND p.id = d.project_id AND p.company_id = $2 AND d.version = $5
      RETURNING d.id, d.project_id, p.name AS project_name, d.title,
                COALESCE(d.content_md, '') AS content_md, d.file_id, d.author_id,
                d.version, d.created_at, d.updated_at`,
    [pgDocumentId.parse(String(req.params.id)), identity.companyId, payload.title ?? null, payload.content ?? null, payload.version],
  );
  if (!rows[0]) {
    await pgDocumentFor(identity.companyId, req.params.id);
    throw new ApiError("VERSION_CONFLICT", "문서가 다른 곳에서 수정되었습니다");
  }
  const document = toPgDocument(rows[0]);
  documentSemantic.invalidate(pgDocumentSemanticScope(identity), document.id, document.version);
  res.json({ ...document, analysis: analyzePgDocument(identity, document) });
}

// GET /api/v1/pg/projects/options — 선택지(프로젝트) { value, label }
export async function projectOptions(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT id, name FROM project.projects WHERE company_id = $1 ORDER BY name`,
    [companyId],
  );
  res.json({ items: rows.map((r) => ({ value: String(r.id), label: r.name })) });
}

// POST /api/v1/pg/documents — 문서 생성
export async function createDocument(req, res) {
  const identity = resolveUser(req);
  const body = req.body ?? {};
  const projectId = String(body.project_id ?? "");
  const title = String(body.title ?? "").trim();
  const contentMd = String(body.content_md ?? "");
  if (!projectId) throw new ApiError("VALIDATION_ERROR", "프로젝트를 선택하세요");
  if (!title) throw new ApiError("VALIDATION_ERROR", "제목은 필수입니다");
  await requirePgProject(identity.companyId, projectId);
  const { rows } = await pgQuery(
    `INSERT INTO project.documents (project_id, title, content_md, file_id, author_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, project_id, title, content_md, file_id, author_id, version, created_at, updated_at`,
    [projectId, title, contentMd, null, identity.userId],
  );
  const document = toPgDocument({ ...rows[0], project_name: "" });
  res.status(201).json({ ...document, analysis: analyzePgDocument(identity, document) });
}

// GET /api/v1/pg/members/options — 구성원 선택지 { value, label }
export async function memberOptions(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT u.id, u.name FROM org.company_memberships m JOIN auth.users u ON u.id = m.user_id
       WHERE m.company_id = $1 AND m.status = 'active' AND u.account_status = 'active'
         AND u.approval_status = 'approved' ORDER BY u.name`,
    [companyId],
  );
  res.json({ items: rows.map((r) => ({ value: String(r.id), label: r.name })) });
}

// DELETE /api/v1/pg/records/:resource/:id — 회사 소유 검증 후 삭제(화이트리스트)
const DELETABLE = {
  calendar: `DELETE FROM calendar.events WHERE id = $1 AND company_id = $2`,
  projects: `DELETE FROM project.projects WHERE id = $1 AND company_id = $2`,
  assets: `DELETE FROM asset.assets WHERE id = $1 AND company_id = $2`,
  budgets: `DELETE FROM accounting.budgets WHERE id = $1 AND company_id = $2`,
  settlements: `DELETE FROM accounting.settlements WHERE id = $1 AND company_id = $2`,
  dues: `DELETE FROM accounting.dues_charges WHERE id = $1 AND company_id = $2`,
  transactions: `DELETE FROM accounting.journal_entries WHERE id = $1 AND company_id = $2`,
  approvals: `DELETE FROM org.approval_requests WHERE id = $1 AND company_id = $2`,
  documents: `DELETE FROM project.documents d USING project.projects p
              WHERE d.id = $1 AND d.project_id = p.id AND p.company_id = $2`,
  tasks: `DELETE FROM project.tasks t USING project.projects p
          WHERE t.id = $1 AND t.project_id = p.id AND p.company_id = $2`,
};

export async function deleteRecord(req, res) {
  const identity = resolveUser(req);
  const { companyId } = identity;
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 삭제할 수 있습니다");
  const { resource, id } = req.params;
  const sql = Object.hasOwn(DELETABLE, resource) ? DELETABLE[resource] : null;
  if (!sql) throw new ApiError("VALIDATION_ERROR", "삭제할 수 없는 항목입니다");
  if (!/^\d+$/.test(String(id))) throw new ApiError("VALIDATION_ERROR", "잘못된 id");
  if (Object.hasOwn(MONEY_TABLES, resource)) {
    return res.json(await mutateFinancialRecord(req, resource, id, [], [id, companyId], true));
  }
  if (resource === 'approvals') {
    await pgTransaction(async client => {
      const { rows } = await client.query('SELECT status FROM org.approval_requests WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
      if (!rows[0]) throw new ApiError('NOT_FOUND', '대상을 찾을 수 없습니다');
      if (rows[0].status !== 'pending') throw new ApiError('CONFLICT', '처리된 결재 기록은 보존해야 합니다');
      await client.query(sql, [id, companyId]);
    });
    return res.json({ ok: true });
  }
  const result = await pgQuery(sql, [id, companyId]);
  if (result.rowCount === 0) throw new ApiError("NOT_FOUND", "대상을 찾을 수 없습니다");
  if (resource === "documents") documentSemantic.invalidate(pgDocumentSemanticScope(identity), String(id));
  res.json({ ok: true });
}

// ── 수정(단건 조회/PATCH) ────────────────────────────────────────
// 편집 가능한 리소스: 테이블 · 스코프 · 필드(이름/타입). FK·불변 컬럼은 제외.
const EDITABLE = {
  projects: { table: "project.projects", scope: "company",
    fields: [["name", "text"], ["starts_on", "date"], ["ends_on", "date"], ["description", "text"]] },
  calendar: { table: "calendar.events", scope: "company",
    fields: [["title", "text"], ["starts_at", "ts"], ["ends_at", "ts"], ["location", "text"]] },
  assets: { table: "asset.assets", scope: "company",
    fields: [["name", "text"], ["category", "text"], ["location", "text"]] },
  budgets: { table: "accounting.budgets", scope: "company",
    fields: [["name", "text"], ["amount", "num"]] },
  settlements: { table: "accounting.settlements", scope: "company",
    fields: [["title", "text"], ["amount", "num"]] },
  tasks: { table: "project.tasks", scope: "project",
    fields: [["title", "text"], ["due_on", "date"], ["status", "taskStatus"]] },
  documents: { table: "project.documents", scope: "project",
    fields: [["title", "text"], ["content_md", "text"]] },
  dues: { table: "accounting.dues_charges", scope: "company",
    fields: [["amount", "num"], ["due_date", "date"]] },
};

function ownershipClause(scope, tableAlias) {
  // company 스코프: 테이블에 company_id. project 스코프: project_id → projects.company_id.
  return scope === "project"
    ? `${tableAlias}.project_id IN (SELECT id FROM project.projects WHERE company_id = $2)`
    : `${tableAlias}.company_id = $2`;
}

// GET /api/v1/pg/records/:resource/:id — 편집용 단건 조회
export async function getRecord(req, res) {
  const { companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "권한이 없습니다");
  const { resource, id } = req.params;
  const def = EDITABLE[resource];
  if (!def) throw new ApiError("VALIDATION_ERROR", "수정할 수 없는 항목입니다");
  if (!/^\d+$/.test(String(id))) throw new ApiError("VALIDATION_ERROR", "잘못된 id");
  const selects = def.fields.map(([col, type]) =>
    type === "date" ? `to_char(t.${col}, 'YYYY-MM-DD') AS ${col}`
    : type === "ts" ? `to_char(t.${col}, 'YYYY-MM-DD"T"HH24:MI') AS ${col}`
    : `t.${col} AS ${col}`,
  ).join(", ");
  const { rows } = await pgQuery(
    `SELECT ${selects}${Object.hasOwn(MONEY_TABLES, resource) ? ', t.version' : ''} FROM ${def.table} t WHERE t.id = $1 AND ${ownershipClause(def.scope, "t")}`,
    [id, companyId],
  );
  if (!rows[0]) throw new ApiError("NOT_FOUND", "대상을 찾을 수 없습니다");
  res.json(rows[0]);
}

// PATCH /api/v1/pg/records/:resource/:id — 수정
export async function updateRecord(req, res) {
  const identity = resolveUser(req);
  const { companyId } = identity;
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 수정할 수 있습니다");
  const { resource, id } = req.params;
  const def = EDITABLE[resource];
  if (!def) throw new ApiError("VALIDATION_ERROR", "수정할 수 없는 항목입니다");
  if (!/^\d+$/.test(String(id))) throw new ApiError("VALIDATION_ERROR", "잘못된 id");
  const body = req.body ?? {};
  const sets = [];
  const params = [id, companyId];
  for (const [col, type] of def.fields) {
    if (!(col in body)) continue;
    let value = body[col];
    if (type === "taskStatus") {
      value = z.enum(["todo", "in_progress", "done", "blocked", "cancelled"]).parse(value);
    } else if (type === "num") {
      value = money(value);
    } else {
      value = value === "" ? null : value;
    }
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length === 0) throw new ApiError("VALIDATION_ERROR", "변경할 내용이 없습니다");
  if (Object.hasOwn(MONEY_TABLES, resource)) return res.json(await mutateFinancialRecord(req, resource, id, sets, params));
  if (resource === "documents") sets.push("version = t.version + 1");
  const result = await pgQuery(
    `UPDATE ${def.table} t SET ${sets.join(", ")} WHERE t.id = $1 AND ${ownershipClause(def.scope, "t")}`,
    params,
  );
  if (result.rowCount === 0) throw new ApiError("NOT_FOUND", "대상을 찾을 수 없습니다");
  if (resource === "documents") documentSemantic.invalidate(pgDocumentSemanticScope(identity), String(id));
  res.json({ ok: true });
}

// ── 조직 변경 로그 / 브랜치 접근 (간이) ──────────────────────────
// GET /api/v1/pg/members/activity — 선택 회사의 실제 조직 감사 기록
export async function membersActivity(req, res) {
  return readOrgActivity(req, res);
}
// PUT /api/v1/pg/members/departments/:id/access — 접근권한은 perp_db 미모델 → no-op
export async function departmentAccess() {
  throw new ApiError("NOT_IMPLEMENTED", "PG 부서 접근권한 저장 기능은 아직 지원하지 않습니다", {}, 501);
}
// 홈 레이아웃 — perp_db 테이블 없음 → 빈 블록(저장 no-op)
export async function homeLayoutGet() {
  throw new ApiError("NOT_IMPLEMENTED", "PG 홈 레이아웃 저장소가 아직 연결되지 않았습니다", {}, 501);
}
export async function homeLayoutSave() {
  throw new ApiError("NOT_IMPLEMENTED", "PG 홈 레이아웃 저장 기능은 아직 지원하지 않습니다", {}, 501);
}

// ── 개인 노트(Vault) : notes.vaults / notes.notes ────────────────
async function ensureVault(userId) {
  const { rows } = await pgQuery(
    `SELECT id FROM notes.vaults WHERE owner_id = $1 ORDER BY id LIMIT 1`,
    [userId],
  );
  if (rows[0]) return rows[0].id;
  const { rows: created } = await pgQuery(
    `INSERT INTO notes.vaults (owner_id, name) VALUES ($1, 'My Vault')
     ON CONFLICT (owner_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [userId],
  );
  return created[0].id;
}
const toNote = (r) => ({
  id: String(r.id),
  title: r.title,
  content: r.content_md ?? "",
  folder: r.folder_path ?? "/",
  tags: [],
  pinned: false,
  agent_enabled: false,
  version: Number(r.version),
});
const noteFields = "n.id, n.title, n.content_md, n.folder_path, n.xmin::text AS version";
const noteInput = z.object({
  title: z.string().trim().min(1), content: z.string().default(""), folder: z.string().min(1).default("/"),
}).strict();
const notePatch = noteInput.partial().extend({ version: z.number().int().nonnegative() }).strict();
const noteId = z.string().regex(/^\d+$/);
async function ownedNotes(userId, bounded = false) {
  const { rows } = await pgQuery(
    `SELECT ${noteFields} FROM notes.notes n JOIN notes.vaults v ON v.id = n.vault_id
     WHERE v.owner_id = $1 ORDER BY n.updated_at DESC, n.id${bounded ? " LIMIT $2" : ""}`, bounded ? [userId, CANDIDATE_LIMIT + 1] : [userId]);
  return rows.map(toNote);
}
function analyzeVault(identity, note) {
  return vaultSemantic.schedule(pgVaultScope(identity), note, () => ownedNotes(identity.userId, true));
}
export async function vaultAnalysis(req, res) {
  const identity = resolveUser(req);
  const { rows } = await pgQuery(`SELECT ${noteFields} FROM notes.notes n JOIN notes.vaults v ON v.id = n.vault_id
    WHERE n.id = $1 AND v.owner_id = $2`, [noteId.parse(req.params.id), identity.userId]);
  if (!rows[0]) throw new ApiError("NOT_FOUND", "노트를 찾을 수 없습니다");
  const note = toNote(rows[0]), scope = pgVaultScope(identity);
  if (req.method === "POST") analyzeVault(identity, note);
  if (req.query.wait === "1") await vaultSemantic.wait(scope, note.id);
  res.json(vaultSemantic.status(scope, note));
}

// 목록과 그래프는 같은 소유자 전체 노트를 읽으며 GET은 저장소를 만들지 않는다.
export async function vaultNotes(req, res) {
  const { userId } = resolveUser(req);
  const items = await ownedNotes(userId);
  const folders = [...new Set(items.map((i) => i.folder))];
  res.json({ items, folders, capabilities: { tags: false, pinned: false, agent_enabled: false } });
}

export async function vaultGraph(req, res) {
  const identity = resolveUser(req);
  const scope = pgVaultScope(identity);
  if (req.query.wait === "1") await vaultSemantic.wait(scope);
  const items = await ownedNotes(identity.userId);
  const byTitle = new Map();
  for (const note of items) {
    const key = note.title.trim().toLowerCase();
    byTitle.set(key, byTitle.has(key) ? null : note.id);
  }
  const edges = [];
  const connected = new Set();
  for (const note of items) {
    const seen = new Set();
    for (const match of note.content.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      const title = match[1].split(/[|#]/, 1)[0].trim();
      const key = title.toLowerCase();
      if (!title || seen.has(key)) continue;
      seen.add(key);
      const target = byTitle.get(key) ?? null;
      edges.push({ source: note.id, target_id: target, target_title: title });
      if (target) { connected.add(note.id); connected.add(target); }
    }
  }
  const semantic = vaultSemantic.graph(scope, items);
  edges.push(...semantic.edges);
  for (const edge of semantic.edges) { connected.add(edge.source); connected.add(edge.target_id); }
  res.json({ nodes: items.map(({ id, title, folder }) => ({ id, title, folder })), edges, analysis: semantic.analysis,
    orphans: items.filter(note => !connected.has(note.id)).map(note => note.id) });
}

// GET /api/v1/pg/vault/notes/:id
export async function vaultNote(req, res) {
  const { userId } = await resolveUser(req);
  const { rows } = await pgQuery(
    `SELECT ${noteFields}
       FROM notes.notes n JOIN notes.vaults v ON v.id = n.vault_id
      WHERE n.id = $1 AND v.owner_id = $2`,
    [noteId.parse(req.params.id), userId],
  );
  if (!rows[0]) throw new ApiError("NOT_FOUND", "노트를 찾을 수 없습니다");
  const note = toNote(rows[0]);
  res.json({ ...note, analysis: vaultSemantic.status(pgVaultScope(resolveUser(req)), note) });
}

// POST /api/v1/pg/vault/notes
export async function vaultCreateNote(req, res) {
  const { userId } = await resolveUser(req);
  const body = noteInput.parse(req.body);
  const vaultId = await ensureVault(userId);
  const { rows } = await pgQuery(
    `INSERT INTO notes.notes (vault_id, folder_path, title, content_md)
     VALUES ($1, $2, $3, $4) RETURNING id, title, content_md, folder_path, xmin::text AS version`,
    [vaultId, body.folder, body.title, body.content],
  );
  const note = toNote(rows[0]);
  res.status(201).json({ ...note, analysis: analyzeVault(resolveUser(req), note) });
}

// PATCH /api/v1/pg/vault/notes/:id
export async function vaultUpdateNote(req, res) {
  const { userId } = await resolveUser(req);
  const body = notePatch.parse(req.body);
  const id = noteId.parse(req.params.id);
  const result = await pgQuery(
    `UPDATE notes.notes n
        SET title = COALESCE($3, n.title),
            content_md = COALESCE($4, n.content_md),
            folder_path = COALESCE($5, n.folder_path),
            updated_at = now()
       FROM notes.vaults v
      WHERE n.id = $1 AND n.vault_id = v.id AND v.owner_id = $2 AND n.xmin::text = $6
      RETURNING ${noteFields}`,
    [id, userId, body.title ?? null, body.content ?? null, body.folder ?? null, String(body.version)],
  );
  if (result.rowCount === 0) {
    const owned = await pgQuery(`SELECT n.id FROM notes.notes n JOIN notes.vaults v ON v.id = n.vault_id
      WHERE n.id = $1 AND v.owner_id = $2`, [id, userId]);
    if (!owned.rows[0]) throw new ApiError("NOT_FOUND", "노트를 찾을 수 없습니다");
    throw new ApiError("VERSION_CONFLICT", "다른 창에서 노트가 변경되었습니다. 새 내용을 확인하세요");
  }
  const note = toNote(result.rows[0]), identity = resolveUser(req);
  vaultSemantic.invalidate(pgVaultScope(identity), note.id, note.version);
  res.json({ ...note, analysis: analyzeVault(identity, note) });
}

// DELETE /api/v1/pg/vault/notes/:id
export async function vaultDeleteNote(req, res) {
  const { userId } = await resolveUser(req);
  const result = await pgQuery(
    `DELETE FROM notes.notes n USING notes.vaults v
      WHERE n.id = $1 AND n.vault_id = v.id AND v.owner_id = $2`,
    [req.params.id, userId],
  );
  if (result.rowCount === 0) throw new ApiError("NOT_FOUND", "노트를 찾을 수 없습니다");
  vaultSemantic.invalidate(pgVaultScope(resolveUser(req)), req.params.id);
  res.json({ ok: true });
}

// ── 조직 모듈 활성 ───────────────────────────────────────────────
// GET /api/v1/pg/org/modules — 카탈로그 + 회사 활성 여부
export async function getOrgModules(req, res) {
  const { companyId } = await resolveUser(req);
  if (!companyId) return res.json({ items: [], features: [] });
  const { rows } = await pgQuery(
    `SELECT module_key FROM org.company_modules WHERE company_id = $1`,
    [companyId],
  );
  const enabled = new Set(rows.map((r) => r.module_key));
  const items = MODULE_CATALOG.map((m) => ({
    key: m.key,
    label: m.label ?? m.key,
    core: Boolean(m.core),
    enabled: m.core ? true : enabled.has(m.key),
  }));
  const features = await pgEnabledFeatures(companyId, [...enabled]);
  res.json({ items, features: FEATURE_CATALOG.map(feature => ({ ...feature, enabled: features.includes(feature.key) })) });
}

const orgModulesSchema = z.object({
  enabled: z.array(z.string()).optional(),
  features: z.array(z.string()).optional(),
}).strict().refine(body => body.enabled !== undefined || body.features !== undefined);

// 모듈과 독립 기능을 같은 트랜잭션에서 저장한다. 역할 권한은 변경하지 않는다.
export async function updateOrgModules(req, res) {
  const { companyId, userId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 모듈을 변경할 수 있습니다");
  const body = orgModulesSchema.parse(req.body);
  const requested = body.enabled === undefined ? undefined : validateSelection(body.enabled);
  const features = body.features === undefined ? undefined : validateFeatureSelection(body.features);
  const saved = await pgTransaction(async (client) => {
    await client.query('SELECT id FROM org.companies WHERE id = $1 AND is_active = true FOR UPDATE', [companyId]);
    const { rows: modules } = await client.query('SELECT module_key FROM org.company_modules WHERE company_id = $1', [companyId]);
    const selected = requested ?? modules.map(row => row.module_key);
    const valid = features === undefined ? selected : modulesForFeatures(selected, features);
    await client.query(`DELETE FROM org.company_modules WHERE company_id = $1`, [companyId]);
    if (valid.length > 0) {
      await client.query(
        `INSERT INTO org.company_modules (company_id, module_key)
         SELECT $1, k FROM unnest($2::text[]) AS k`,
        [companyId, valid],
      );
    }
    if (features !== undefined) {
      try {
        await client.query(`INSERT INTO org.company_feature_settings (company_id, enabled_features)
          VALUES ($1, $2::text[]) ON CONFLICT (company_id)
          DO UPDATE SET enabled_features = EXCLUDED.enabled_features, configured_at = now()`, [companyId, features]);
      } catch (error) {
        if (error?.code === '42P01') throw new ApiError('SERVICE_UNAVAILABLE', 'PG 회사 기능 스키마가 없습니다. perp_additions_v6.sql 적용 상태를 확인하세요.');
        throw error;
      }
    }
    await client.query("INSERT INTO org.company_events (company_id, actor_id, action) VALUES ($1, $2, 'company.settings.updated')", [companyId, userId]);
    return { enabled: valid };
  });
  res.json({ ok: true, ...saved, enabled_features: features === undefined
    ? await pgEnabledFeatures(companyId, saved.enabled) : enabledFeatures(features, saved.enabled) });
}

// GET /api/v1/pg/departments/options
export async function departmentOptions(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT id, name FROM org.departments WHERE company_id = $1 ORDER BY name`,
    [companyId],
  );
  res.json({ items: rows.map((r) => ({ value: String(r.id), label: r.name })) });
}

// GET /api/v1/pg/positions/options
export async function positionOptions(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT id, name FROM org.positions WHERE company_id = $1 ORDER BY rank_level DESC`,
    [companyId],
  );
  res.json({ items: rows.map((r) => ({ value: String(r.id), label: r.name })) });
}

// POST /api/v1/pg/members — 구성원 추가(회사에 사용자 생성)
export async function createMember(req, res) {
  const principal = await resolvePgCompanyPrincipal(req);
  const { companyId } = principal;
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 구성원을 추가할 수 있습니다");
  const body = req.body ?? {};
  const email = String(body.email ?? "").trim();
  const name = String(body.name ?? "").trim();
  const password = String(body.password ?? "");
  const departmentId = body.department_id || null;
  const positionId = body.position_id || null;
  if (Object.hasOwn(body, 'roles')) throw new ApiError('VALIDATION_ERROR', '역할 배정은 현재 역할 버전으로 역할 설정에서 요청하세요');
  if (!email || !email.includes("@")) throw new ApiError("VALIDATION_ERROR", "올바른 이메일을 입력하세요");
  if (!name) throw new ApiError("VALIDATION_ERROR", "이름은 필수입니다");
  if (password.length < 8) throw new ApiError("VALIDATION_ERROR", "초기 비밀번호는 8자 이상이어야 합니다");
  const { rows: dup } = await pgQuery(`SELECT 1 FROM auth.users WHERE lower(email) = lower($1)`, [email]);
  if (dup.length > 0) throw new ApiError("CONFLICT", "이미 가입된 이메일입니다");
  // 부서·직급이 지정되면 회사 소속인지 검증
  if (departmentId) {
    const { rows } = await pgQuery(`SELECT 1 FROM org.departments WHERE id=$1 AND company_id=$2`, [departmentId, companyId]);
    if (!rows[0]) throw new ApiError("VALIDATION_ERROR", "유효하지 않은 부서입니다");
  }
  if (positionId) {
    const { rows } = await pgQuery(`SELECT 1 FROM org.positions WHERE id=$1 AND company_id=$2`, [positionId, companyId]);
    if (!rows[0]) throw new ApiError("VALIDATION_ERROR", "유효하지 않은 직급입니다");
  }
  const value = await mutatePgRoles(principal, req.requestId, async ({ query, authority }) => {
    authority.require('member.write');
    const created = await query(
      `INSERT INTO auth.users (company_id, department_id, position_id, email, name, password_hash, approval_status, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'approved', now()) RETURNING id`,
      [companyId, departmentId, positionId, email, name, hashPassword(password)],
    );
    await query(`INSERT INTO org.company_memberships (company_id, user_id, department_id, position_id, created_by)
      VALUES ($1, $2, $3, $4, $5)`, [companyId, created.rows[0].id, departmentId, positionId, principal.userId]);
    const value = { id: String(created.rows[0].id) };
    return { action: 'member.provisioned', resourceId: value.id, after: { roles: [] }, value };
  }, 'menu.members');
  res.status(201).json(value);
}

// POST /api/v1/pg/tasks — 업무 생성 (project.tasks)
export async function createTask(req, res) {
  const { companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 업무를 만들 수 있습니다");
  const body = req.body ?? {};
  const projectId = body.project_id;
  const title = String(body.title ?? "").trim();
  const assignee = body.assignee_id || null;
  const dueOn = body.due_on || null;
  if (!projectId) throw new ApiError("VALIDATION_ERROR", "프로젝트를 선택하세요");
  if (!title) throw new ApiError("VALIDATION_ERROR", "제목은 필수입니다");
  const { rows: ok } = await pgQuery(`SELECT 1 FROM project.projects WHERE id=$1 AND company_id=$2`, [projectId, companyId]);
  if (!ok[0]) throw new ApiError("VALIDATION_ERROR", "유효하지 않은 프로젝트입니다");
  if (assignee) {
    if (!await isCompanyMember(assignee, companyId)) throw new ApiError("VALIDATION_ERROR", "유효하지 않은 담당자입니다");
  }
  const { rows } = await pgQuery(
    `INSERT INTO project.tasks (project_id, assignee_id, title, due_on, status)
     VALUES ($1, $2, $3, $4, 'todo') RETURNING id`,
    [projectId, assignee, title, dueOn],
  );
  res.status(201).json({ id: String(rows[0].id) });
}

// POST /api/v1/pg/approvals — 결재(승인요청) 생성
export async function createApproval(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 결재를 올릴 수 있습니다");
  const body = req.body ?? {};
  const requestType = String(body.request_type ?? "").trim();
  const target = body.target_user_id || null;
  const note = String(body.note ?? "").trim();
  if (!requestType) throw new ApiError("VALIDATION_ERROR", "유형은 필수입니다");
  if (target) {
    if (!await isCompanyMember(target, companyId)) throw new ApiError("VALIDATION_ERROR", "유효하지 않은 대상자입니다");
  }
  const { rows } = await pgQuery(
    `INSERT INTO org.approval_requests (company_id, request_type, requester_id, target_user_id, payload, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
    [companyId, requestType, userId, target, JSON.stringify({ note })],
  );
  res.status(201).json({ id: String(rows[0].id) });
}

// ── 자산 ─────────────────────────────────────────────────────────
// GET /api/v1/pg/assets
export async function assets(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT a.id AS __id, a.name AS 이름, a.category AS 분류, a.status AS status,
            u.name AS 담당, a.location AS 위치, a.acquired_on AS 취득일, a.assignee_id, a.version
       FROM asset.assets a
       LEFT JOIN auth.users u ON u.id = a.assignee_id
      WHERE a.company_id = $1
      ORDER BY a.id DESC`,
    [companyId],
  );
  res.json({ items: rows });
}

// POST /api/v1/pg/assets
export async function createAsset(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 자산을 만들 수 있습니다");
  const body = req.body ?? {};
  const name = String(body.name ?? "").trim();
  if (!name) throw new ApiError("VALIDATION_ERROR", "이름은 필수입니다");
  const category = String(body.category ?? "").trim() || null;
  const location = String(body.location ?? "").trim() || null;
  const result = await idempotentMutation(req, 'asset.create', { name, category, location }, async client => {
    const { rows } = await client.query(
      `INSERT INTO asset.assets (company_id, name, category, location) VALUES ($1, $2, $3, $4) RETURNING id`,
      [companyId, name, category, location],
    );
    await client.query(
      `INSERT INTO asset.history (asset_id, event_type, actor_id, note) VALUES ($1, 'created', $2, '생성')`,
      [rows[0].id, userId],
    );
    return { id: String(rows[0].id) };
  });
  res.status(201).json(result);
}

// GET /api/v1/pg/assets/reservations
export async function assetReservations(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT a.name AS 자산, u.name AS 예약자, r.starts_at AS 시작, r.ends_at AS 종료, r.status AS status
       FROM asset.reservations r
       JOIN asset.assets a ON a.id = r.asset_id
       LEFT JOIN auth.users u ON u.id = r.reserved_by
      WHERE a.company_id = $1
      ORDER BY r.starts_at DESC`,
    [companyId],
  );
  res.json({ items: rows });
}

// ── 예산 ─────────────────────────────────────────────────────────
// GET /api/v1/pg/finance/budgets
export async function budgets(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT b.id AS __id, b.name AS 이름, b.amount AS 편성액, b.spent AS 집행액, b.status AS status, b.version AS __version
       FROM accounting.budgets b WHERE b.company_id = $1 ORDER BY b.id DESC`,
    [companyId],
  );
  res.json({ items: rows });
}

// POST /api/v1/pg/finance/budgets
export async function createBudget(req, res) {
  const { companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 예산을 만들 수 있습니다");
  const body = req.body ?? {};
  const name = String(body.name ?? "").trim();
  const amount = money(body.amount);
  if (!name) throw new ApiError("VALIDATION_ERROR", "이름은 필수입니다");
  const result = await idempotentMutation(req, 'budget.create', { name, amount }, async client => {
    const { rows } = await client.query(
      `INSERT INTO accounting.budgets (company_id, name, amount, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
      [companyId, name, amount],
    );
    return { id: String(rows[0].id), version: 1 };
  });
  res.status(201).json(result);
}

// ── 회비 ─────────────────────────────────────────────────────────
// GET /api/v1/pg/finance/dues
export async function dues(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT c.id AS __id, u.name AS 대상, c.amount AS 금액, c.due_date AS 기한, c.status AS status,
            c.version, COALESCE(p.paid,0)::numeric(18,2)::text AS paid,
            (c.amount-COALESCE(p.paid,0))::numeric(18,2)::text AS outstanding
       FROM accounting.dues_charges c
       LEFT JOIN auth.users u ON u.id = c.target_user_id
       LEFT JOIN LATERAL (SELECT SUM(amount) AS paid FROM accounting.dues_payments WHERE charge_id=c.id) p ON true
      WHERE c.company_id = $1 ORDER BY c.id DESC`,
    [companyId],
  );
  res.json({ items: rows });
}

// POST /api/v1/pg/finance/dues — 회비 청구 생성
export async function createDuesCharge(req, res) {
  const { companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 회비를 청구할 수 있습니다");
  const body = req.body ?? {};
  const target = body.target_user_id;
  const amount = money(body.amount);
  const dueDate = body.due_date || null;
  if (dueDate) z.string().date().parse(dueDate);
  if (!target) throw new ApiError("VALIDATION_ERROR", "대상자를 선택하세요");
  const result = await idempotentMutation(req, 'dues.create', { target_user_id: String(target), amount, due_date: dueDate }, async client => {
    const member = await client.query(`SELECT m.user_id FROM org.company_memberships m JOIN auth.users u ON u.id=m.user_id
      WHERE m.user_id=$1 AND m.company_id=$2 AND m.status='active' AND u.account_status='active' AND u.approval_status='approved' FOR SHARE OF m,u`, [target,companyId]);
    if (!member.rows[0]) throw new ApiError('VALIDATION_ERROR', '유효하지 않은 대상자입니다');
    const { rows } = await client.query(
      `INSERT INTO accounting.dues_charges (company_id, target_user_id, amount, due_date) VALUES ($1, $2, $3, $4) RETURNING id`,
      [companyId, target, amount, dueDate],
    );
    return { id: String(rows[0].id), version: 1 };
  });
  res.status(201).json(result);
}

// ── 정산 ─────────────────────────────────────────────────────────
// GET /api/v1/pg/finance/settlements
export async function settlements(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT s.id AS __id, s.title AS 제목, u.name AS 신청자, s.amount AS 금액, s.status AS status, s.created_at AS 신청일, s.version AS __version
       FROM accounting.settlements s
       LEFT JOIN auth.users u ON u.id = s.requester_id
      WHERE s.company_id = $1 ORDER BY s.id DESC`,
    [companyId],
  );
  res.json({ items: rows });
}

// POST /api/v1/pg/finance/settlements
export async function createSettlement(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 정산을 신청할 수 있습니다");
  const body = req.body ?? {};
  const title = String(body.title ?? "").trim();
  const amount = money(body.amount);
  if (!title) throw new ApiError("VALIDATION_ERROR", "제목은 필수입니다");
  const result = await idempotentMutation(req, 'settlement.create', { title, amount }, async client => {
    const { rows } = await client.query(
      `INSERT INTO accounting.settlements (company_id, requester_id, title, amount) VALUES ($1, $2, $3, $4) RETURNING id`,
      [companyId, userId, title, amount],
    );
    return { id: String(rows[0].id), version: 1 };
  });
  res.status(201).json(result);
}

// ── 알림 ─────────────────────────────────────────────────────────
// GET /api/v1/pg/notifications — 내 알림
export async function notifications(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT kind AS 유형, title AS 제목, body AS 내용,
            CASE WHEN is_read THEN 'done' ELSE 'pending' END AS status, created_at AS 시각, id AS __id, kind, link
       FROM notice.notifications WHERE user_id = $1 AND company_id = $2 ORDER BY created_at DESC, id DESC LIMIT 200`,
    [userId, companyId],
  );
  res.json({ items: rows });
}

// ── AI 템플릿 / 기억 ─────────────────────────────────────────────
// GET /api/v1/pg/agent/templates
export async function agentTemplates(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT t.name AS 이름, t.prompt AS 프롬프트, u.name AS 생성자
       FROM ai.agent_templates t LEFT JOIN auth.users u ON u.id = t.created_by
      WHERE t.company_id = $1 ORDER BY t.id DESC`,
    [companyId],
  );
  res.json({ items: rows });
}

// POST /api/v1/pg/agent/templates
export async function createAgentTemplate(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 템플릿을 만들 수 있습니다");
  const body = req.body ?? {};
  const name = String(body.name ?? "").trim();
  const prompt = String(body.prompt ?? "").trim();
  if (!name) throw new ApiError("VALIDATION_ERROR", "이름은 필수입니다");
  if (!prompt) throw new ApiError("VALIDATION_ERROR", "프롬프트는 필수입니다");
  const { rows } = await pgQuery(
    `INSERT INTO ai.agent_templates (company_id, name, prompt, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [companyId, name, prompt, userId],
  );
  res.status(201).json({ id: String(rows[0].id) });
}

// GET /api/v1/pg/agent/memory — 내 기억
export async function agentMemory(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT key AS 키, value AS 값 FROM ai.agent_memory WHERE user_id = $1 ORDER BY id DESC`,
    [userId],
  );
  res.json({ items: rows });
}

// POST /api/v1/pg/agent/memory (upsert)
export async function createAgentMemory(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 기억을 저장할 수 있습니다");
  const body = req.body ?? {};
  const key = String(body.key ?? "").trim();
  const value = String(body.value ?? "").trim() || null;
  if (!key) throw new ApiError("VALIDATION_ERROR", "키는 필수입니다");
  const { rows } = await pgQuery(
    `INSERT INTO ai.agent_memory (company_id, user_id, key, value) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     RETURNING id`,
    [companyId, userId, key, value],
  );
  res.status(201).json({ id: String(rows[0].id) });
}

// ── 자동화 실행기록 ──────────────────────────────────────────────
// GET /api/v1/pg/automation/runs
export async function automationRuns(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT w.name AS 워크플로, r.status AS status, r.started_at AS 시작, r.ended_at AS 종료
       FROM automation.workflow_runs r JOIN automation.workflows w ON w.id = r.workflow_id
      WHERE w.company_id = $1 ORDER BY r.started_at DESC LIMIT 200`,
    [companyId],
  );
  res.json({ items: rows });
}

// GET /api/v1/pg/hr/attendance?from=&to= — 내 근태 (AttendanceScreen 계약)
export async function hrAttendance(req, res) {
  const { userId, companyId } = await resolveUser(req);
  const empty = { items: [], summary: { total_days: 0, total_hours: 0, by_kind: {} } };
  if (!companyId) return res.json(empty);
  const params = [userId];
  let dateFilter = "";
  if (req.query.from && req.query.to) {
    params.push(req.query.from, req.query.to);
    dateFilter = "AND at.work_date BETWEEN $2 AND $3";
  }
  const { rows } = await pgQuery(
    `SELECT at.id, at.user_id, to_char(at.work_date,'YYYY-MM-DD') AS work_date,
            at.check_in_at, at.check_out_at, at.source, at.note
       FROM hr.attendances at
      WHERE at.user_id = $1 ${dateFilter}
      ORDER BY at.work_date DESC`,
    params,
  );
  const items = rows.map((r) => {
    const hours = r.check_in_at && r.check_out_at
      ? Math.round(((new Date(r.check_out_at) - new Date(r.check_in_at)) / 3.6e6) * 10) / 10
      : 0;
    return {
      id: String(r.id),
      member_id: String(r.user_id),
      on_date: r.work_date,
      kind: r.check_in_at ? "present" : "absent",
      hours,
      source: r.source ?? "manual",
      note: r.note ?? "",
      check_in_at: r.check_in_at,
      check_out_at: r.check_out_at,
    };
  });
  const by_kind = {};
  for (const i of items) by_kind[i.kind] = (by_kind[i.kind] ?? 0) + 1;
  const total_hours = Math.round(items.reduce((s, i) => s + i.hours, 0) * 10) / 10;
  res.json({ items, summary: { total_days: items.length, total_hours, by_kind } });
}

// POST /api/v1/pg/hr/attendance/check-in
export async function hrCheckIn(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 출근할 수 있습니다");
  await pgQuery(
    `INSERT INTO hr.attendances (company_id, user_id, work_date, check_in_at, source)
     VALUES ($1, $2, CURRENT_DATE, now(), 'button')
     ON CONFLICT (user_id, work_date)
       DO UPDATE SET check_in_at = COALESCE(hr.attendances.check_in_at, now())`,
    [companyId, userId],
  );
  res.json({ ok: true });
}

// POST /api/v1/pg/hr/attendance/check-out
export async function hrCheckOut(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 퇴근할 수 있습니다");
  const result = await pgQuery(
    `UPDATE hr.attendances SET check_out_at = now()
      WHERE user_id = $1 AND work_date = CURRENT_DATE AND check_in_at IS NOT NULL`,
    [userId],
  );
  if (result.rowCount === 0) throw new ApiError("VALIDATION_ERROR", "먼저 출근을 기록하세요");
  res.json({ ok: true });
}

// 근태 수정요청(corrections) — perp_db 테이블 미구현. 화면이 깨지지 않게 빈/준비중 처리.
export async function hrCorrections(_req, res) {
  res.json({ items: [] });
}
export async function hrCorrectionSubmit(_req, res) {
  throw new ApiError("VALIDATION_ERROR", "근태 수정요청 기능은 준비 중입니다");
}
export async function hrCorrectionDecide(_req, res) {
  throw new ApiError("VALIDATION_ERROR", "근태 수정요청 기능은 준비 중입니다");
}

// GET /api/v1/pg/hr/leaves — 휴가 목록 (LeaveScreen 계약; 관리자는 전체)
export async function hrLeaves(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT lr.id, lr.user_id, lr.leave_type,
            to_char(lr.starts_on,'YYYY-MM-DD') AS start_on,
            to_char(lr.ends_on,'YYYY-MM-DD') AS end_on,
            lr.days, lr.reason, lr.status
       FROM hr.leave_requests lr
      WHERE lr.company_id = $1
      ORDER BY lr.created_at DESC`,
    [companyId],
  );
  const items = rows.map((r) => ({
    id: String(r.id),
    member_id: String(r.user_id),
    kind: r.leave_type,
    start_on: r.start_on,
    end_on: r.end_on,
    days: Number(r.days),
    reason: r.reason ?? "",
    status: r.status,
    substitute_id: null,
  }));
  res.json({ items });
}

// POST /api/v1/pg/hr/leaves — 휴가 신청
export async function hrLeaveApply(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 휴가를 신청할 수 있습니다");
  const b = req.body ?? {};
  const kind = String(b.kind ?? "").trim() || "annual";
  const startOn = b.start_on;
  const endOn = b.end_on;
  const reason = String(b.reason ?? "").trim() || null;
  if (!startOn || !endOn) throw new ApiError("VALIDATION_ERROR", "시작·종료일은 필수입니다");
  if (new Date(endOn) < new Date(startOn)) throw new ApiError("VALIDATION_ERROR", "종료가 시작보다 빠를 수 없습니다");
  const days = Math.round((new Date(endOn) - new Date(startOn)) / 8.64e7) + 1;
  const { rows } = await pgQuery(
    `INSERT INTO hr.leave_requests (company_id, user_id, leave_type, starts_on, ends_on, days, reason, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') RETURNING id`,
    [companyId, userId, kind, startOn, endOn, days, reason],
  );
  res.status(201).json({ id: String(rows[0].id) });
}

// POST /api/v1/pg/hr/leaves/:id/decide — 승인/반려
export async function hrLeaveDecide(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "권한이 없습니다");
  const decision = (req.body ?? {}).decision;
  const status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : null;
  if (!status) throw new ApiError("VALIDATION_ERROR", "decision 은 approve/reject 여야 합니다");
  const result = await pgQuery(
    `UPDATE hr.leave_requests SET status = $3, approver_id = $4, decided_at = now()
      WHERE id = $1 AND company_id = $2`,
    [req.params.id, companyId, status, userId],
  );
  if (result.rowCount === 0) throw new ApiError("NOT_FOUND", "대상을 찾을 수 없습니다");
  res.json({ ok: true });
}

// GET /api/v1/pg/hr/leaves/calendar?from=&to=
export async function hrLeaveCalendar(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const from = req.query.from ?? "1900-01-01";
  const to = req.query.to ?? "2999-12-31";
  const { rows } = await pgQuery(
    `SELECT lr.id, lr.user_id, u.name, lr.leave_type,
            to_char(lr.starts_on,'YYYY-MM-DD') AS start_on,
            to_char(lr.ends_on,'YYYY-MM-DD') AS end_on, lr.status
       FROM hr.leave_requests lr JOIN auth.users u ON u.id = lr.user_id
      WHERE lr.company_id = $1 AND lr.starts_on <= $3 AND lr.ends_on >= $2
      ORDER BY lr.starts_on`,
    [companyId, from, to],
  );
  const items = rows.map((r) => ({
    leave_id: String(r.id),
    member_id: String(r.user_id),
    member_name: r.name,
    kind: r.leave_type,
    start_on: r.start_on,
    end_on: r.end_on,
    status: r.status,
  }));
  res.json({ items });
}

// GET /api/v1/pg/hr/leave-balances — 내 잔여
export async function hrLeaveBalances(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT year, total_days, used_days FROM hr.leave_balances WHERE user_id = $1 ORDER BY year DESC`,
    [userId],
  );
  const items = rows.map((r) => ({
    id: `${userId}-${r.year}`,
    kind: "annual",
    granted_days: Number(r.total_days),
    used_days: Number(r.used_days),
    remaining_days: Number(r.total_days) - Number(r.used_days),
  }));
  res.json({ items });
}

// GET /api/v1/pg/hr/leave-policies — perp_db 미구현 → 빈 목록
export async function hrLeavePolicies(_req, res) {
  res.json({ items: [] });
}

// GET /api/v1/pg/hr/leave-stats — 요약(잔여 기반 최소 집계)
export async function hrLeaveStats(req, res) {
  res.json({
    items: [],
    totals: { granted_days: 0, used_days: 0, usage_rate: 0 },
    formula: "",
    generated_at: new Date().toISOString(),
  });
}

// GET /api/v1/pg/hr/postings — 채용 공고 (RecruitmentScreen 계약)
export async function hrPostings(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT jp.id, jp.title, jp.status,
            to_char(jp.closed_at,'YYYY-MM-DD') AS closes_on,
            to_char(jp.opened_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
       FROM hr.job_postings jp
      WHERE jp.company_id = $1
      ORDER BY jp.opened_at DESC`,
    [companyId],
  );
  const items = rows.map((r) => ({
    id: String(r.id),
    title: r.title,
    status: r.status,
    closes_on: r.closes_on,
    created_at: r.created_at ?? "",
  }));
  res.json({ items });
}

// POST /api/v1/pg/hr/postings/:id/close — 공고 마감
export async function hrPostingClose(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "권한이 없습니다");
  const result = await pgQuery(
    `UPDATE hr.job_postings SET status = 'closed', closed_at = now()
      WHERE id = $1 AND company_id = $2`,
    [req.params.id, companyId],
  );
  if (result.rowCount === 0) throw new ApiError("NOT_FOUND", "공고를 찾을 수 없습니다");
  res.json({ ok: true });
}

// GET /api/v1/pg/hr/postings/:id/applications — 공고 지원자
export async function hrPostingApplications(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT a.id, a.posting_id, a.name, a.email, a.phone, a.stage
       FROM hr.applicants a
       JOIN hr.job_postings jp ON jp.id = a.posting_id
      WHERE a.posting_id = $1 AND jp.company_id = $2
      ORDER BY a.id`,
    [req.params.id, companyId],
  );
  const items = rows.map((r) => ({
    id: String(r.id),
    posting_id: String(r.posting_id),
    applicant_name: r.name,
    applicant_email: r.email ?? "",
    applicant_phone: r.phone,
    score: null,
    stage: r.stage,
    retain_until: null,
  }));
  res.json({ items });
}

// POST /api/v1/pg/hr/applications/:id/stage — 지원자 단계 변경
export async function hrApplicationStage(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "권한이 없습니다");
  const stage = String((req.body ?? {}).stage ?? "").trim();
  if (!stage) throw new ApiError("VALIDATION_ERROR", "stage 는 필수입니다");
  const result = await pgQuery(
    `UPDATE hr.applicants a SET stage = $3
       FROM hr.job_postings jp
      WHERE a.id = $1 AND a.posting_id = jp.id AND jp.company_id = $2`,
    [req.params.id, companyId, stage],
  );
  if (result.rowCount === 0) throw new ApiError("NOT_FOUND", "지원자를 찾을 수 없습니다");
  res.json({ ok: true });
}

// 온보딩 — perp_db 테이블 미구현 → 빈/준비중
export async function hrOnboarding(_req, res) {
  res.json({ items: [], progress: { total: 0, done: 0 } });
}
export async function hrOnboardingComplete(_req, res) {
  throw new ApiError("VALIDATION_ERROR", "온보딩 기능은 준비 중입니다");
}
// 채용 확정 후 멤버 초대 — perp_db 이관 전 준비중
export async function membersInvite(_req, res) {
  throw new ApiError("VALIDATION_ERROR", "구성원 초대 기능은 준비 중입니다");
}
