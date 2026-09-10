import path from "node:path";

import { z } from "zod";
import { pgIdentity, resolvePgCompanyPrincipal } from "../middleware/pgAccess.js";
import { money, idempotentMutation, MONEY_TABLES, mutateFinancialRecord } from '../services/pg-finance.service.js';
import { pgExpenseMutation, postPgTransaction } from '../services/pg-expenses.service.js';
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
import { graphEdge, graphIdentity, graphNode } from "../services/graph-identity.service.js";
import { canReadPgApproval } from '../services/pg-approval-read-policy.service.js';
import { listPgDocuments, getPgDocument, createPgDocument, patchPgDocument, deletePgDocument, pgDocumentVersions, pgDocumentCreateInput, pgDocumentPatchInput, canReadPgDocumentRestrictions } from '../services/pg-documents.service.js';
import { pgApprovalPeople, personDisplay } from '../services/approval-person-display.service.js';

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
       0 AS documents`,
    [companyId],
  );
  const r = rows[0];
  res.json({
    members: Number(r.members),
    projects: Number(r.projects),
    tasks: Number(r.tasks),
    documents: (await listPgDocuments(documentClient, await resolvePgCompanyPrincipal(req))).length,
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
      WHERE e.company_id = $1 AND e.posted=true`,
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
    account_type: r.account_type,
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
  // Keep old value normalization, but never silently discard strict expense fields.
  if (Object.keys(body).some(field => !['account_id', 'amount', 'entry_date', 'memo', 'project_id', 'budget_id'].includes(field))) {
    throw new ApiError('VALIDATION_ERROR', 'Use /pg/finance/expenses for expense fields.');
  }
  const accountId = body.account_id;
  const amount = money(body.amount);
  const entryDate = body.entry_date || null;
  if (entryDate) z.string().date().parse(entryDate);
  const memo = String(body.memo ?? "").trim() || null;
  if (!accountId) throw new ApiError("VALIDATION_ERROR", "계정을 선택하세요");
  const payload = { account_id: String(accountId), amount, entry_date: entryDate, memo,
    ...(body.project_id != null ? { project_id: z.string().regex(/^[1-9]\d*$/).parse(body.project_id) } : {}),
    ...(body.budget_id != null ? { budget_id: z.string().regex(/^[1-9]\d*$/).parse(body.budget_id) } : {}) };
  const result = await pgExpenseMutation(req, 'transaction.create', payload, client => postPgTransaction(client, req, payload));
  res.status(201).json(result);
}

// GET /api/v1/pg/finance/transactions
export async function financeTransactions(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT e.id AS __id, to_char(e.entry_date, 'YYYY-MM-DD') AS 일자, e.memo AS 내용,
            e.counterparty,e.occurred_at,e.input_currency,e.no_receipt_reason,e.budget_id,
            COALESCE(SUM(l.debit), 0) AS 차변,
            COALESCE(SUM(l.credit), 0) AS 대변,
            COALESCE(SUM(CASE WHEN a.account_type='revenue' THEN l.credit-l.debit ELSE 0 END),0)::text AS income_amount,
            COALESCE(SUM(CASE WHEN a.account_type='expense' THEN l.debit-l.credit ELSE 0 END),0)::text AS expense_amount,
            CASE WHEN BOOL_OR(a.account_type='revenue') AND NOT BOOL_OR(a.account_type='expense') THEN 'income'
                 WHEN BOOL_OR(a.account_type='expense') AND NOT BOOL_OR(a.account_type='revenue') THEN 'expense'
                 ELSE 'journal' END AS kind,
            CASE WHEN e.posted THEN 'confirmed' ELSE 'pending' END AS status, e.version AS __version
       FROM accounting.journal_entries e
       LEFT JOIN accounting.journal_lines l ON l.entry_id = e.id
       LEFT JOIN accounting.accounts a ON a.id=l.account_id AND a.company_id=e.company_id
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
  const { companyId } = principal;
  if (!principal.has('approval.decide')) principal.require('approval.request');
  const canDecide = principal.has('approval.decide');
  const { rows } = await pgQuery(
    `SELECT ar.id AS __id, ar.requester_id, ar.target_user_id, to_jsonb(ar)->>'title' AS title, ar.request_type AS 유형,
            ar.status AS status, ar.created_at AS 신청일, ar.payload, ar.decision_note, ar.decided_at
       FROM org.approval_requests ar
      WHERE ar.company_id = $1
      ORDER BY ar.created_at DESC, ar.id DESC`,
    [companyId],
  );
  // 같은 읽기 predicate를 통과한 행에만 인증 ID 기반 내 요청 분류용 ID를 투영한다.
  const readable = rows.filter(row => canReadPgApproval(principal, row));
  const people = await pgApprovalPeople(pgQuery, companyId, readable.flatMap(row => [row.requester_id, row.target_user_id]));
  const items = readable.map(({ target_user_id, ...row }) => ({ ...row, requester_display: personDisplay(people, row.requester_id),
    신청자: personDisplay(people, row.requester_id).name, 대상: personDisplay(people, target_user_id).name }));
  res.json({ items, can_decide: canDecide, can_request: principal.has('approval.request') });
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
const pgDocumentUploadInput = z.object({
  filename: z.string().min(1).max(255), mime: z.string().min(1).max(100),
  content_base64: z.string().min(1).max(1_400_000),
  project_id: z.string().regex(/^[1-9]\d*$/).nullable().optional(),
  title: z.string().trim().min(1).max(300).optional(),
  sensitivity: pgDocumentCreateInput.shape.sensitivity,
  visibility: pgDocumentCreateInput.shape.visibility,
}).strict();
const documentClient = { query: pgQuery };
const pgDocumentsFor = (principal, bounded = false) => listPgDocuments(documentClient, principal,
  bounded ? { limit: DOCUMENT_CANDIDATE_LIMIT + 1 } : {});
async function pgDocumentFor(principal, id) {
  const document = await getPgDocument(documentClient, principal, id);
  if (!document) throw new ApiError("NOT_FOUND", "문서를 찾을 수 없습니다");
  return document;
}

function analyzePgDocument(identity, document) {
  if (!canReadPgDocumentRestrictions(identity, document)) return null;
  return documentSemantic.schedule(
    pgDocumentSemanticScope(identity),
    document,
    () => pgDocumentsFor(identity, true),
  );
}

// GET /api/v1/pg/documents — 문서 목록
export async function documents(req, res) {
  const identity = await resolvePgCompanyPrincipal(req);
  const rows = await pgDocumentsFor(identity);
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
  const identity = await resolvePgCompanyPrincipal(req);
  const scope = pgDocumentSemanticScope(identity);
  if (req.query.wait === "1") await documentSemantic.wait(scope);
  const [{ rows: projectRows }, documents] = await Promise.all([
    pgQuery(`SELECT id, name, updated_at FROM project.projects WHERE company_id = $1 ORDER BY name`, [identity.companyId]),
    pgDocumentsFor(identity),
  ]);
  const projectName = new Map(projectRows.map((project) => [String(project.id), project.name]));
  const projectIdentities = new Map(projectRows.map((project) => [String(project.id), graphIdentity({
    store: "pg", company: identity.companyId, kind: "space", opaqueId: project.id,
  })]));
  const documentIdentities = new Map(documents.map((document) => [document.id, graphIdentity({
    store: "pg", company: identity.companyId, kind: "document", opaqueId: document.id,
  })]));
  const titleIds = new Map();
  for (const document of documents) {
    const ids = titleIds.get(document.title) ?? [];
    ids.push(document.id);
    titleIds.set(document.title, ids);
  }
  const chunks = new Map(documents.map((document) => [document.id,
    Math.max(1, document.content.split("\n\n").map((part) => part.trim()).filter(Boolean).length)]));
  const nodes = [
    ...projectRows.map((project) => graphNode({
      id: `project:${project.id}`, kind: "space", title: project.name, folder: project.name,
      sensitivity: "org", chunks: 0, tags: [], updated_at: project.updated_at instanceof Date ? project.updated_at.toISOString() : String(project.updated_at ?? ""),
    }, projectIdentities.get(String(project.id)))),
    ...documents.map((document) => graphNode({
      id: document.id, kind: "document", title: document.title, folder: document.project_name,
      sensitivity: document.sensitivity, chunks: chunks.get(document.id), tags: [], updated_at: document.updated_at,
    }, documentIdentities.get(document.id))),
  ];
  const edges = [];
  for (const document of documents) {
    const sourceIdentity = documentIdentities.get(document.id);
    if (projectName.has(document.project_id)) {
      edges.push(graphEdge(
        { source: document.id, target_id: `project:${document.project_id}`, target_title: document.project_name, kind: "space" },
        sourceIdentity,
        projectIdentities.get(document.project_id),
        { binding: "membership", resolution: "resolved" },
      ));
    }
    const seen = new Set();
    for (const match of document.content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
      const title = match[1].trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      const ids = titleIds.get(title) ?? [];
      const targetId = ids.length === 1 ? ids[0] : null;
      if (targetId === document.id) continue;
      const targetIdentity = targetId ? documentIdentities.get(targetId) : null;
      edges.push(graphEdge(
        { source: document.id, target_id: targetId, target_title: targetId ? title : "", kind: "link" },
        sourceIdentity,
        targetIdentity,
        targetIdentity
          ? { binding: "title", resolution: "resolved" }
          : { binding: "title", resolution: "unresolved", reason: ids.length > 1 ? "duplicate_title" : "title_not_found" },
      ));
    }
  }
  const semantic = documentSemantic.graph(scope, documents);
  for (const edge of semantic.edges) {
    const sourceIdentity = documentIdentities.get(edge.source);
    const targetIdentity = documentIdentities.get(edge.target_id);
    if (sourceIdentity && targetIdentity) edges.push(graphEdge(edge, sourceIdentity, targetIdentity, { binding: "inference", resolution: "resolved" }));
  }
  const linked = new Set(edges.filter((edge) => edge.resolution === "resolved")
    .flatMap((edge) => [edge.source, edge.target_id]).filter(Boolean));
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
  const identity = await resolvePgCompanyPrincipal(req);
  const document = await pgDocumentFor(identity, req.params.id);
  res.json({
    ...document,
    tags: [],
    versions: await pgDocumentVersions(documentClient, identity, document.id),
    analysis: documentSemantic.status(pgDocumentSemanticScope(identity), document),
  });
}

export async function pgDocumentAnalysis(req, res) {
  const identity = await resolvePgCompanyPrincipal(req);
  let document = await pgDocumentFor(identity, req.params.id);
  const scope = pgDocumentSemanticScope(identity);
  if (req.method === "POST") analyzePgDocument(identity, document);
  if (req.query.wait === "1") await documentSemantic.wait(scope, document.id);
  document = await pgDocumentFor(identity, document.id);
  res.json(documentSemantic.status(scope, document));
}

export async function pgUploadDocument(req, res) {
  const identity = await resolvePgCompanyPrincipal(req);
  const payload = pgDocumentUploadInput.parse(req.body);
  const extracted = extractSupportedTextUpload(payload);
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
      return createPgDocument(client, identity, {
        project_id: payload.project_id, title: payload.title ?? path.basename(payload.filename, extracted.extension),
        content_md: extracted.text, file_id: String(files[0].id), sensitivity: payload.sensitivity, visibility: payload.visibility,
      });
    });
  } catch (error) {
    await stored.discard();
    throw error;
  }
  const document = row;
  res.status(201).json({
    ...document,
    filename: payload.filename,
    extraction: { format: extracted.format, bytes: stored.size, encoding: "utf-8" },
    analysis: analyzePgDocument(identity, document),
  });
}

export async function pgPatchDocument(req, res) {
  const identity = await resolvePgCompanyPrincipal(req);
  const payload = pgDocumentPatchInput.parse(req.body);
  const document = await pgTransaction(client => patchPgDocument(client, identity, req.params.id, payload));
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
  const identity = await resolvePgCompanyPrincipal(req);
  const payload = pgDocumentCreateInput.omit({ ai_generated: true, review_status: true }).parse(req.body);
  const document = await pgTransaction(client => createPgDocument(client, identity, payload));
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
  tasks: `DELETE FROM project.tasks t USING project.projects p
          WHERE t.id = $1 AND t.project_id = p.id AND p.company_id = $2`,
};

export async function deleteRecord(req, res) {
  const identity = resolveUser(req);
  const { companyId } = identity;
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 삭제할 수 있습니다");
  const { resource, id } = req.params;
  if (resource === 'documents') {
    const principal = await resolvePgCompanyPrincipal(req);
    await pgTransaction(client => deletePgDocument(client, principal, id));
    documentSemantic.invalidate(pgDocumentSemanticScope(principal), String(id));
    return res.json({ ok: true });
  }
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
  if (resource === 'documents') return res.json(await pgDocumentFor(await resolvePgCompanyPrincipal(req), id));
  const def = EDITABLE[resource];
  if (!def) throw new ApiError("VALIDATION_ERROR", "수정할 수 없는 항목입니다");
  if (!/^\d+$/.test(String(id))) throw new ApiError("VALIDATION_ERROR", "잘못된 id");
  const selects = def.fields.map(([col, type]) =>
    type === "date" ? `to_char(t.${col}, 'YYYY-MM-DD') AS ${col}`
    : type === "ts" ? `to_char(t.${col}, 'YYYY-MM-DD"T"HH24:MI') AS ${col}`
    : `t.${col} AS ${col}`,
  ).join(", ");
  const { rows } = await pgQuery(
    `SELECT t.id::text AS id, ${selects}${Object.hasOwn(MONEY_TABLES, resource) ? ', t.version' : ''} FROM ${def.table} t WHERE t.id = $1 AND ${ownershipClause(def.scope, "t")}`,
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
  if (resource === 'documents') {
    const principal = await resolvePgCompanyPrincipal(req);
    await pgDocumentFor(principal, id);
    const { content_md, ...rest } = req.body ?? {};
    const payload = pgDocumentPatchInput.parse({ ...rest, ...(content_md === undefined ? {} : { content: content_md }) });
    const document = await pgTransaction(client => patchPgDocument(client, principal, id, payload));
    documentSemantic.invalidate(pgDocumentSemanticScope(principal), document.id, document.version);
    return res.json({ id: document.id, version: document.version });
  }
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
  const result = await pgQuery(
    `UPDATE ${def.table} t SET ${sets.join(", ")} WHERE t.id = $1 AND ${ownershipClause(def.scope, "t")}`,
    params,
  );
  if (result.rowCount === 0) throw new ApiError("NOT_FOUND", "대상을 찾을 수 없습니다");
  res.json({ ok: true });
}

// ── 조직 변경 로그 / 브랜치 접근 (간이) ──────────────────────────
// GET /api/v1/pg/members/activity — 선택 회사의 실제 조직 감사 기록
export async function membersActivity(req, res) {
  return readOrgActivity(req, res);
}
// 숫자 ID(자유 입력 포함)를 정수 문자열로 정규화한다. 비숫자/빈값은 NULL.
function normNumericId(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return /^[1-9]\d*$/.test(s) ? s : null;
}

// PUT /api/v1/pg/members/departments/:id/access — 부서 접근 역할 집합을 통째로 교체한다.
// body: { access_roles: string[] }. 빈 집합 = 조직 전체 공개.
export async function departmentAccess(req, res) {
  const { companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 접근 권한을 바꿀 수 있습니다");
  const id = String(req.params.id ?? "");
  if (!/^[1-9]\d*$/.test(id)) throw new ApiError("VALIDATION_ERROR", "잘못된 부서 id");
  const body = req.body ?? {};
  const roles = Array.isArray(body.access_roles)
    ? [...new Set(body.access_roles.map((r) => String(r).trim()).filter(Boolean))]
    : [];
  await pgTransaction(async (client) => {
    const dept = await client.query(
      `SELECT 1 FROM org.departments WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId],
    );
    if (!dept.rows[0]) throw new ApiError("NOT_FOUND", "부서를 찾을 수 없습니다");
    await client.query(
      `DELETE FROM org.department_access_roles WHERE department_id = $1 AND company_id = $2`,
      [id, companyId],
    );
    if (roles.length > 0) {
      await client.query(
        `INSERT INTO org.department_access_roles (company_id, department_id, role_key)
         SELECT $1, $2, k FROM unnest($3::text[]) AS k`,
        [companyId, id, roles],
      );
    }
  });
  res.json({ ok: true });
}

// GET /api/v1/pg/members/home-layout?department_id=&project_id= — 스코프별 홈 블록 조회
export async function homeLayoutGet(req, res) {
  const { companyId } = await resolveUser(req);
  if (!companyId) return res.json({ blocks: [] });
  const departmentId = normNumericId(req.query.department_id);
  const projectId = normNumericId(req.query.project_id);
  const { rows } = await pgQuery(
    `SELECT blocks FROM org.home_layouts
      WHERE company_id = $1
        AND department_id IS NOT DISTINCT FROM $2
        AND project_id IS NOT DISTINCT FROM $3`,
    [companyId, departmentId, projectId],
  );
  res.json({ blocks: rows[0]?.blocks ?? [] });
}

// PUT /api/v1/pg/members/home-layout — 스코프(회사+부서+프로젝트)별 홈 블록 upsert
export async function homeLayoutSave(req, res) {
  const { companyId, userId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 홈 구성을 저장할 수 있습니다");
  const body = req.body ?? {};
  const departmentId = normNumericId(body.department_id);
  const projectId = normNumericId(body.project_id);
  const blocks = Array.isArray(body.blocks) ? body.blocks.map((b) => String(b)) : [];
  if (departmentId) {
    const { rows } = await pgQuery(`SELECT 1 FROM org.departments WHERE id = $1 AND company_id = $2`, [departmentId, companyId]);
    if (!rows[0]) throw new ApiError("VALIDATION_ERROR", "유효하지 않은 부서입니다");
  }
  if (projectId) {
    const { rows } = await pgQuery(`SELECT 1 FROM project.projects WHERE id = $1 AND company_id = $2`, [projectId, companyId]);
    if (!rows[0]) throw new ApiError("VALIDATION_ERROR", "유효하지 않은 프로젝트입니다");
  }
  await pgQuery(
    `INSERT INTO org.home_layouts (company_id, department_id, project_id, blocks, updated_by)
     VALUES ($1, $2, $3, $4::text[], $5)
     ON CONFLICT (company_id, department_id, project_id)
     DO UPDATE SET blocks = EXCLUDED.blocks, updated_by = EXCLUDED.updated_by`,
    [companyId, departmentId, projectId, blocks, userId],
  );
  res.json({ ok: true });
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
  // PostgreSQL xmin is an opaque concurrency token, not an application sequence.
  version: z.string().regex(/^\d+$/).parse(r.version),
});
const noteFields = "n.id, n.title, n.content_md, n.folder_path, n.xmin::text AS version";
const noteInput = z.object({
  title: z.string().trim().min(1), content: z.string().default(""), folder: z.string().min(1).default("/"),
}).strict();
const notePatch = noteInput.partial().extend({ version: z.string().regex(/^\d+$/) }).strict();
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
  const identities = new Map(items.map((note) => [note.id, graphIdentity({
    store: "pg", owner: identity.userId, kind: "note", opaqueId: note.id,
  })]));
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
      const targetIdentity = target ? identities.get(target) : null;
      edges.push(graphEdge(
        { source: note.id, target_id: target, target_title: title },
        identities.get(note.id),
        targetIdentity,
        targetIdentity
          ? { binding: "title", resolution: "resolved" }
          : { binding: "title", resolution: "unresolved", reason: byTitle.has(key) ? "duplicate_title" : "title_not_found" },
      ));
      if (target) { connected.add(note.id); connected.add(target); }
    }
  }
  const semantic = vaultSemantic.graph(scope, items);
  for (const edge of semantic.edges) {
    const sourceIdentity = identities.get(edge.source);
    const targetIdentity = identities.get(edge.target_id);
    if (sourceIdentity && targetIdentity) {
      edges.push(graphEdge(edge, sourceIdentity, targetIdentity, { binding: "inference", resolution: "resolved" }));
      connected.add(edge.source); connected.add(edge.target_id);
    }
  }
  res.json({
    nodes: items.map(({ id, title, folder }) => graphNode({ id, title, folder }, identities.get(id))),
    edges,
    analysis: semantic.analysis,
    orphans: items.filter(note => !connected.has(note.id)).map(note => note.id),
  });
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
    [id, userId, body.title ?? null, body.content ?? null, body.folder ?? null, body.version],
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

// 근태 수정요청(corrections) — hr.attendance_corrections.
const toIso = (v) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

// GET /api/v1/pg/hr/attendance/corrections(/pending)
// 기본(본인) = 내 신청, /pending = 회사 전체 대기 건.
export async function hrCorrections(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) return res.json({ items: [] });
  const pendingScope = req.path.endsWith("/pending");
  const params = [companyId];
  let where = "company_id = $1";
  if (pendingScope) {
    where += " AND status = 'pending'";
  } else {
    params.push(userId);
    where += " AND user_id = $2";
  }
  const { rows } = await pgQuery(
    `SELECT id, user_id, to_char(work_date, 'YYYY-MM-DD') AS on_date, kind, hours, note,
            status, comment, created_at, decided_at
       FROM hr.attendance_corrections
      WHERE ${where}
      ORDER BY created_at DESC, id DESC`,
    params,
  );
  const items = rows.map((r) => ({
    id: String(r.id),
    member_id: String(r.user_id),
    on_date: r.on_date,
    kind: r.kind,
    hours: Number(r.hours),
    note: r.note ?? "",
    status: r.status,
    comment: r.comment ?? "",
    created_at: toIso(r.created_at) ?? "",
    decided_at: toIso(r.decided_at),
  }));
  res.json({ items });
}

// POST /api/v1/pg/hr/attendance/corrections — 본인 수정요청 신청
export async function hrCorrectionSubmit(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 수정요청할 수 있습니다");
  const b = req.body ?? {};
  const onDate = String(b.on_date ?? "");
  z.string().date().parse(onDate);
  const kind = String(b.kind ?? "").trim();
  if (!kind) throw new ApiError("VALIDATION_ERROR", "종류는 필수입니다");
  const hours = Number(b.hours);
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) throw new ApiError("VALIDATION_ERROR", "근무시간은 0~24 사이여야 합니다");
  const note = String(b.note ?? "").trim() || null;
  const { rows } = await pgQuery(
    `INSERT INTO hr.attendance_corrections (company_id, user_id, attendance_id, work_date, kind, hours, note)
     VALUES ($1, $2,
             (SELECT id FROM hr.attendances WHERE user_id = $2 AND work_date = $3),
             $3, $4, $5, $6)
     RETURNING id`,
    [companyId, userId, onDate, kind, hours, note],
  );
  res.status(201).json({ id: String(rows[0].id) });
}

// POST /api/v1/pg/hr/attendance/corrections/:id/decide — 승인/반려
export async function hrCorrectionDecide(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "권한이 없습니다");
  const decision = (req.body ?? {}).decision;
  const status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : null;
  if (!status) throw new ApiError("VALIDATION_ERROR", "decision 은 approve/reject 여야 합니다");
  const comment = String((req.body ?? {}).comment ?? "").trim() || null;
  const result = await pgQuery(
    `UPDATE hr.attendance_corrections
        SET status = $3, decided_by = $4, decided_at = now(), comment = $5
      WHERE id = $1 AND company_id = $2 AND status = 'pending'`,
    [req.params.id, companyId, status, userId, comment],
  );
  if (result.rowCount === 0) throw new ApiError("NOT_FOUND", "대기 중인 수정요청을 찾을 수 없습니다");
  res.json({ ok: true });
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

// GET /api/v1/pg/hr/leave-policies — 회사 휴가 정책 목록
export async function hrLeavePolicies(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT id, kind, default_days, carryover_enabled, carryover_max_days, expiry_note
       FROM hr.leave_policies WHERE company_id = $1 ORDER BY kind`,
    [companyId],
  );
  const items = rows.map((r) => ({
    id: String(r.id),
    kind: r.kind,
    default_days: Number(r.default_days),
    carryover_enabled: r.carryover_enabled,
    carryover_max_days: Number(r.carryover_max_days),
    expiry_note: r.expiry_note ?? "",
  }));
  res.json({ items });
}

// POST /api/v1/pg/hr/leave-policies — 회사 휴가 정책 upsert (company_id, kind)
export async function hrLeavePolicySave(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 휴가 정책을 저장할 수 있습니다");
  const b = req.body ?? {};
  const kind = String(b.kind ?? "").trim();
  if (!kind) throw new ApiError("VALIDATION_ERROR", "휴가 종류는 필수입니다");
  const nonNeg = (value, label) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new ApiError("VALIDATION_ERROR", `${label}는 0 이상이어야 합니다`);
    return n;
  };
  const defaultDays = nonNeg(b.default_days, "기본 부여일수");
  const carryoverEnabled = Boolean(b.carryover_enabled);
  const carryoverMax = nonNeg(b.carryover_max_days, "이월 한도");
  const expiryNote = String(b.expiry_note ?? "");
  const { rows } = await pgQuery(
    `INSERT INTO hr.leave_policies
       (company_id, kind, default_days, carryover_enabled, carryover_max_days, expiry_note, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (company_id, kind) DO UPDATE
        SET default_days       = EXCLUDED.default_days,
            carryover_enabled  = EXCLUDED.carryover_enabled,
            carryover_max_days = EXCLUDED.carryover_max_days,
            expiry_note        = EXCLUDED.expiry_note,
            updated_by         = EXCLUDED.updated_by
     RETURNING id, kind, default_days, carryover_enabled, carryover_max_days, expiry_note`,
    [companyId, kind, defaultDays, carryoverEnabled, carryoverMax, expiryNote, userId],
  );
  const r = rows[0];
  res.status(201).json({
    id: String(r.id),
    kind: r.kind,
    default_days: Number(r.default_days),
    carryover_enabled: r.carryover_enabled,
    carryover_max_days: Number(r.carryover_max_days),
    expiry_note: r.expiry_note ?? "",
  });
}

// POST /api/v1/pg/hr/leave-balances — 관리자 휴가 부여 (연도별 total_days 설정)
// hr.leave_balances 는 종류(kind) 구분이 없어 연차(연도 단위) 잔여만 관리한다.
export async function hrLeaveGrant(req, res) {
  const { companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 휴가를 부여할 수 있습니다");
  const b = req.body ?? {};
  const memberId = String(b.member_id ?? "");
  await requireCompanyMemberId(companyId, memberId);
  const granted = Number(b.granted_days);
  if (!Number.isFinite(granted) || granted < 0) throw new ApiError("VALIDATION_ERROR", "부여일수는 0 이상이어야 합니다");
  const year = new Date().getFullYear();
  const { rows } = await pgQuery(
    `INSERT INTO hr.leave_balances (company_id, user_id, year, total_days, used_days)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (user_id, year) DO UPDATE
        SET total_days = EXCLUDED.total_days, company_id = EXCLUDED.company_id
     RETURNING total_days, used_days`,
    [companyId, memberId, year, granted],
  );
  const total = Number(rows[0].total_days);
  const used = Number(rows[0].used_days);
  res.status(201).json({
    granted_days: total,
    used_days: used,
    remaining_days: Math.round((total - used) * 10) / 10,
  });
}

// GET /api/v1/pg/hr/leave-stats — 조직 휴가 소진율(정책 테이블 없이 집계)
// 연차 부여/사용은 hr.leave_balances(연도별), 그 밖 종류는 승인된 hr.leave_requests 합계.
export async function hrLeaveStats(req, res) {
  const companyId = await resolveCompanyId(req);
  const generatedAt = new Date().toISOString();
  const formula = "소진율 = 사용 ÷ 부여 × 100";
  if (!companyId) {
    return res.json({ items: [], totals: { granted_days: 0, used_days: 0, usage_rate: 0 }, formula, generated_at: generatedAt });
  }
  const year = new Date().getFullYear();
  const [{ rows: balances }, { rows: usage }] = await Promise.all([
    pgQuery(
      `SELECT user_id, total_days, used_days FROM hr.leave_balances
        WHERE company_id = $1 AND year = $2`,
      [companyId, year],
    ),
    pgQuery(
      `SELECT user_id, leave_type, SUM(days) AS used
         FROM hr.leave_requests
        WHERE company_id = $1 AND status = 'approved'
        GROUP BY user_id, leave_type`,
      [companyId],
    ),
  ]);
  const rate = (used, granted) => (granted > 0 ? Math.round((used / granted) * 1000) / 10 : 0);
  const items = [];
  // 연차: 잔여 테이블 기준(부여·사용의 권위 소스)
  for (const b of balances) {
    const granted = Number(b.total_days);
    const used = Number(b.used_days);
    items.push({
      member_id: String(b.user_id),
      kind: "annual",
      granted_days: granted,
      used_days: used,
      remaining_days: Math.round((granted - used) * 10) / 10,
      usage_rate: rate(used, granted),
    });
  }
  // 그 밖 종류: 승인된 신청 합계(부여 소스 없음 → 0)
  for (const u of usage) {
    if (u.leave_type === "annual") continue;
    const used = Number(u.used);
    items.push({
      member_id: String(u.user_id),
      kind: u.leave_type,
      granted_days: 0,
      used_days: used,
      remaining_days: 0,
      usage_rate: 0,
    });
  }
  const grantedTotal = items.reduce((s, i) => s + i.granted_days, 0);
  const usedTotal = items.reduce((s, i) => s + i.used_days, 0);
  res.json({
    items,
    totals: {
      granted_days: Math.round(grantedTotal * 10) / 10,
      used_days: Math.round(usedTotal * 10) / 10,
      usage_rate: rate(usedTotal, grantedTotal),
    },
    formula,
    generated_at: generatedAt,
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

// 온보딩/오프보딩 체크리스트 — hr.onboarding_tasks.
async function requireCompanyMemberId(companyId, memberId) {
  if (!/^[1-9]\d*$/.test(String(memberId ?? ""))) throw new ApiError("VALIDATION_ERROR", "구성원을 선택하세요");
  const { rows } = await pgQuery(
    `SELECT 1 FROM org.company_memberships WHERE user_id = $1 AND company_id = $2 AND status = 'active'`,
    [memberId, companyId],
  );
  if (!rows[0]) throw new ApiError("VALIDATION_ERROR", "유효하지 않은 구성원입니다");
}

// GET /api/v1/pg/hr/onboarding?member_id= — 구성원별 체크리스트
export async function hrOnboarding(req, res) {
  const companyId = await resolveCompanyId(req);
  const empty = { items: [], progress: { total: 0, done: 0 } };
  if (!companyId) return res.json(empty);
  const memberId = normNumericId(req.query.member_id);
  if (!memberId) return res.json(empty);
  const { rows } = await pgQuery(
    `SELECT id, user_id, flow, label, done
       FROM hr.onboarding_tasks
      WHERE company_id = $1 AND user_id = $2
      ORDER BY seq, id`,
    [companyId, memberId],
  );
  const items = rows.map((r) => ({
    id: String(r.id),
    member_id: String(r.user_id),
    flow: r.flow,
    label: r.label,
    done: r.done,
  }));
  const done = items.filter((i) => i.done).length;
  res.json({ items, progress: { total: items.length, done } });
}

// POST /api/v1/pg/hr/onboarding — 체크리스트 생성 { member_id, flow, labels[] }
export async function hrOnboardingCreate(req, res) {
  const { companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 체크리스트를 만들 수 있습니다");
  const b = req.body ?? {};
  const memberId = String(b.member_id ?? "");
  await requireCompanyMemberId(companyId, memberId);
  const flow = b.flow === "offboarding" ? "offboarding" : "onboarding";
  const labels = Array.isArray(b.labels)
    ? b.labels.map((l) => String(l).trim()).filter(Boolean)
    : [];
  if (labels.length === 0) throw new ApiError("VALIDATION_ERROR", "체크리스트 항목을 입력하세요");
  await pgTransaction(async (client) => {
    for (let i = 0; i < labels.length; i += 1) {
      await client.query(
        `INSERT INTO hr.onboarding_tasks (company_id, user_id, flow, label, seq)
         VALUES ($1, $2, $3, $4, $5)`,
        [companyId, memberId, flow, labels[i], i + 1],
      );
    }
  });
  res.status(201).json({ ok: true, created: labels.length });
}

// POST /api/v1/pg/hr/onboarding/:id/complete — 항목 완료 처리
export async function hrOnboardingComplete(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "권한이 없습니다");
  const result = await pgQuery(
    `UPDATE hr.onboarding_tasks
        SET done = true, done_at = now(), done_by = $3
      WHERE id = $1 AND company_id = $2 AND done = false`,
    [req.params.id, companyId, userId],
  );
  if (result.rowCount === 0) throw new ApiError("NOT_FOUND", "미완료 항목을 찾을 수 없습니다");
  res.json({ ok: true });
}

export { create as membersInvite, revoke as membersInviteRevoke } from './pgInvitations.controller.js';

// GET /api/v1/pg/members/invites — 회사가 보낸 초대 목록(회사 스코프). 생성 응답과 같은 item 형태.
export async function membersInvitesList(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT mi.id, mi.email, mi.roles, mi.status,
            to_char(mi.expires_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS expires_at,
            c.name AS company_name
       FROM org.member_invites mi
       JOIN org.companies c ON c.id = mi.company_id
      WHERE mi.company_id = $1
      ORDER BY mi.created_at DESC, mi.id DESC`,
    [companyId],
  );
  const items = rows.map((r) => ({
    invitation_id: String(r.id),
    email: r.email,
    org_id: `pg:${companyId}`,
    org_name: r.company_name ?? "",
    org_type: "perp_db",
    roles: r.roles ?? [],
    status: r.status,
    expires_at: r.expires_at,
  }));
  res.json({ items });
}
