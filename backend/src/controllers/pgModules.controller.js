import { pgQuery, pgTransaction } from "../config/pg.js";
import { MODULE_CATALOG, OPTIONAL_MODULES } from "../config/modules.js";
import { hashPassword } from "../utils/crypto.js";
import { ApiError } from "../utils/errors.js";

// perp_db(PostgreSQL) 모듈 read 슬라이스.
// strangler-fig 1단계: 홈/프로젝트/캘린더/재무/HR 화면을 실데이터로 전환.
// 모든 조회는 로그인 사용자의 회사(company_id)로 스코프한다.
// 응답은 프론트 ScreenPage 의 제네릭 매퍼(liveTable/liveStats)가 렌더한다.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bearerToken(req) {
  const header = req.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function resolveUser(req) {
  const token = bearerToken(req);
  if (!token || !UUID_RE.test(token)) {
    throw new ApiError("UNAUTHENTICATED", "인증 토큰이 필요합니다");
  }
  const { rows } = await pgQuery(
    `SELECT u.id, u.company_id
       FROM auth.sessions s
       JOIN auth.users u ON u.id = s.user_id
      WHERE s.session_token = $1 AND s.is_active = true`,
    [token],
  );
  if (!rows[0]) {
    throw new ApiError("UNAUTHENTICATED", "세션이 만료되었거나 유효하지 않습니다");
  }
  return { userId: rows[0].id, companyId: rows[0].company_id };
}

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
export async function usage(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) {
    return res.json({ members: 0, projects: 0, tasks: 0, documents: 0 });
  }
  const { rows } = await pgQuery(
    `SELECT
       (SELECT count(*) FROM auth.users        WHERE company_id = $1) AS members,
       (SELECT count(*) FROM project.projects  WHERE company_id = $1) AS projects,
       (SELECT count(*) FROM project.assignments a
          JOIN project.projects p ON p.id = a.project_id
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
            u.name AS 책임자, p.starts_on AS 시작, p.ends_on AS 종료
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
  const { rows } = await pgQuery(
    `SELECT id AS __id, title AS 일정, starts_at AS 시작, ends_at AS 종료,
            location AS 장소, scope AS status
       FROM calendar.events
      WHERE company_id = $1
      ORDER BY starts_at DESC
      LIMIT 100`,
    [companyId],
  );
  res.json({ items: rows });
}

// GET /api/v1/pg/finance/summary — 재무 홈 지표
export async function financeSummary(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ 수입: 0, 지출: 0, 잔액: 0 });
  const { rows } = await pgQuery(
    `SELECT
       COALESCE(SUM(CASE WHEN a.account_type = 'revenue' THEN l.credit - l.debit END), 0) AS revenue,
       COALESCE(SUM(CASE WHEN a.account_type = 'expense' THEN l.debit - l.credit END), 0) AS expense
       FROM accounting.journal_lines l
       JOIN accounting.journal_entries e ON e.id = l.entry_id
       JOIN accounting.accounts a ON a.id = l.account_id
      WHERE e.company_id = $1`,
    [companyId],
  );
  const revenue = Number(rows[0].revenue);
  const expense = Number(rows[0].expense);
  res.json({ 수입: revenue, 지출: expense, 잔액: revenue - expense });
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
  const amount = Number(body.amount);
  const entryDate = body.entry_date || new Date().toISOString().slice(0, 10);
  const memo = String(body.memo ?? "").trim() || null;
  if (!accountId) throw new ApiError("VALIDATION_ERROR", "계정을 선택하세요");
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError("VALIDATION_ERROR", "금액은 0보다 큰 숫자여야 합니다");
  }

  // 선택 계정(회사 소유·수입/지출) 확인
  const { rows: accRows } = await pgQuery(
    `SELECT id, account_type FROM accounting.accounts
      WHERE id = $1 AND company_id = $2 AND account_type IN ('revenue','expense')`,
    [accountId, companyId],
  );
  const account = accRows[0];
  if (!account) throw new ApiError("VALIDATION_ERROR", "유효하지 않은 계정입니다");

  // 상대 계정 = 회사의 자산(현금) 계정 중 코드 최소값
  const { rows: cashRows } = await pgQuery(
    `SELECT id FROM accounting.accounts
      WHERE company_id = $1 AND account_type = 'asset' AND is_active = true
      ORDER BY code LIMIT 1`,
    [companyId],
  );
  const cash = cashRows[0];
  if (!cash) throw new ApiError("VALIDATION_ERROR", "현금(자산) 계정이 없어 거래를 만들 수 없습니다");

  const { rows: entryRows } = await pgQuery(
    `INSERT INTO accounting.journal_entries (company_id, entry_date, memo, created_by, posted)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
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
    await pgQuery(
      `INSERT INTO accounting.journal_lines (entry_id, account_id, debit, credit)
       VALUES ($1, $2, $3, $4)`,
      [entryId, l.accountId, l.debit, l.credit],
    );
  }
  res.status(201).json({ id: String(entryId) });
}

// GET /api/v1/pg/finance/transactions
export async function financeTransactions(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT e.id AS __id, e.entry_date AS 일자, e.memo AS 내용,
            COALESCE(SUM(l.debit), 0) AS 차변,
            COALESCE(SUM(l.credit), 0) AS 대변,
            CASE WHEN e.posted THEN 'confirmed' ELSE 'pending' END AS status
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
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT ar.id AS __id, ar.request_type AS 유형, r.name AS 신청자, t.name AS 대상,
            ar.status AS status, ar.created_at AS 신청일
       FROM org.approval_requests ar
       LEFT JOIN auth.users r ON r.id = ar.requester_id
       LEFT JOIN auth.users t ON t.id = ar.target_user_id
      WHERE ar.company_id = $1
      ORDER BY ar.created_at DESC`,
    [companyId],
  );
  res.json({ items: rows });
}

// GET /api/v1/pg/tasks — 업무 (project.tasks)
export async function tasks(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT t.id AS __id, t.title AS 업무, p.name AS 프로젝트, u.name AS 담당,
            t.status AS status, t.due_on AS 기한
       FROM project.tasks t
       JOIN project.projects p ON p.id = t.project_id
       LEFT JOIN auth.users u ON u.id = t.assignee_id
      WHERE p.company_id = $1
      ORDER BY t.sort_order, t.id DESC`,
    [companyId],
  );
  res.json({ items: rows });
}

// GET /api/v1/pg/documents — 문서
export async function documents(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT d.id AS __id, d.title AS 제목, p.name AS 프로젝트, u.name AS 작성자,
            d.version AS 버전, d.updated_at AS 수정일
       FROM project.documents d
       JOIN project.projects p ON p.id = d.project_id
       LEFT JOIN auth.users u ON u.id = d.author_id
      WHERE p.company_id = $1
      ORDER BY d.updated_at DESC`,
    [companyId],
  );
  res.json({ items: rows });
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
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) {
    throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 문서를 만들 수 있습니다");
  }
  const body = req.body ?? {};
  const projectId = body.project_id;
  const title = String(body.title ?? "").trim();
  const contentMd = String(body.content_md ?? "").trim() || null;
  if (!projectId) throw new ApiError("VALIDATION_ERROR", "프로젝트를 선택하세요");
  if (!title) throw new ApiError("VALIDATION_ERROR", "제목은 필수입니다");
  const { rows: ok } = await pgQuery(
    `SELECT 1 FROM project.projects WHERE id = $1 AND company_id = $2`,
    [projectId, companyId],
  );
  if (!ok[0]) throw new ApiError("VALIDATION_ERROR", "유효하지 않은 프로젝트입니다");
  const { rows } = await pgQuery(
    `INSERT INTO project.documents (project_id, title, content_md, author_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [projectId, title, contentMd, userId],
  );
  res.status(201).json({ id: String(rows[0].id) });
}

// GET /api/v1/pg/members/options — 구성원 선택지 { value, label }
export async function memberOptions(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT id, name FROM auth.users WHERE company_id = $1 ORDER BY name`,
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
  const { companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 삭제할 수 있습니다");
  const { resource, id } = req.params;
  const sql = DELETABLE[resource];
  if (!sql) throw new ApiError("VALIDATION_ERROR", "삭제할 수 없는 항목입니다");
  if (!/^\d+$/.test(String(id))) throw new ApiError("VALIDATION_ERROR", "잘못된 id");
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
    fields: [["title", "text"], ["due_on", "date"]] },
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
    `SELECT ${selects} FROM ${def.table} t WHERE t.id = $1 AND ${ownershipClause(def.scope, "t")}`,
    [id, companyId],
  );
  if (!rows[0]) throw new ApiError("NOT_FOUND", "대상을 찾을 수 없습니다");
  res.json(rows[0]);
}

// PATCH /api/v1/pg/records/:resource/:id — 수정
export async function updateRecord(req, res) {
  const { companyId } = await resolveUser(req);
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
    if (type === "num") {
      value = value === "" || value === null ? null : Number(value);
      if (value !== null && !Number.isFinite(value)) throw new ApiError("VALIDATION_ERROR", `${col} 숫자 오류`);
    } else {
      value = value === "" ? null : value;
    }
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length === 0) throw new ApiError("VALIDATION_ERROR", "변경할 내용이 없습니다");
  const result = await pgQuery(
    `UPDATE ${def.table} t SET ${sets.join(", ")} WHERE t.id = $1 AND ${ownershipClause(def.scope, "t")}`,
    params,
  );
  if (result.rowCount === 0) throw new ApiError("NOT_FOUND", "대상을 찾을 수 없습니다");
  res.json({ ok: true });
}

// ── 조직 모듈 활성 ───────────────────────────────────────────────
// GET /api/v1/pg/org/modules — 카탈로그 + 회사 활성 여부
export async function getOrgModules(req, res) {
  const { companyId } = await resolveUser(req);
  if (!companyId) return res.json({ items: [] });
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
  res.json({ items });
}

// PATCH /api/v1/pg/org/modules — 활성 모듈 교체 (옵션 모듈만)
export async function updateOrgModules(req, res) {
  const { companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 모듈을 변경할 수 있습니다");
  const body = req.body ?? {};
  const requested = Array.isArray(body.enabled) ? body.enabled : [];
  const valid = requested.filter((k) => OPTIONAL_MODULES.includes(k));
  await pgTransaction(async (client) => {
    await client.query(`DELETE FROM org.company_modules WHERE company_id = $1`, [companyId]);
    if (valid.length > 0) {
      await client.query(
        `INSERT INTO org.company_modules (company_id, module_key)
         SELECT $1, k FROM unnest($2::text[]) AS k`,
        [companyId, valid],
      );
    }
  });
  res.json({ ok: true, enabled: valid });
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
  const { companyId } = await resolveUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "회사에 배정된 계정만 구성원을 추가할 수 있습니다");
  const body = req.body ?? {};
  const email = String(body.email ?? "").trim();
  const name = String(body.name ?? "").trim();
  const password = String(body.password ?? "");
  const departmentId = body.department_id || null;
  const positionId = body.position_id || null;
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
  const { rows } = await pgQuery(
    `INSERT INTO auth.users (company_id, department_id, position_id, email, name, password_hash, approval_status, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'approved', now()) RETURNING id`,
    [companyId, departmentId, positionId, email, name, hashPassword(password)],
  );
  res.status(201).json({ id: String(rows[0].id) });
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
            u.name AS 담당, a.location AS 위치, a.acquired_on AS 취득일
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
  const { rows } = await pgQuery(
    `INSERT INTO asset.assets (company_id, name, category, location) VALUES ($1, $2, $3, $4) RETURNING id`,
    [companyId, name, category, location],
  );
  await pgQuery(
    `INSERT INTO asset.history (asset_id, event_type, actor_id, note) VALUES ($1, 'created', $2, '생성')`,
    [rows[0].id, userId],
  );
  res.status(201).json({ id: String(rows[0].id) });
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
    `SELECT b.id AS __id, b.name AS 이름, b.amount AS 편성액, b.spent AS 집행액, b.status AS status
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
  const amount = Number(body.amount);
  if (!name) throw new ApiError("VALIDATION_ERROR", "이름은 필수입니다");
  if (!Number.isFinite(amount) || amount < 0) throw new ApiError("VALIDATION_ERROR", "편성액은 0 이상 숫자여야 합니다");
  const { rows } = await pgQuery(
    `INSERT INTO accounting.budgets (company_id, name, amount, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
    [companyId, name, amount],
  );
  res.status(201).json({ id: String(rows[0].id) });
}

// ── 회비 ─────────────────────────────────────────────────────────
// GET /api/v1/pg/finance/dues
export async function dues(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT c.id AS __id, u.name AS 대상, c.amount AS 금액, c.due_date AS 기한, c.status AS status
       FROM accounting.dues_charges c
       LEFT JOIN auth.users u ON u.id = c.target_user_id
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
  const amount = Number(body.amount);
  const dueDate = body.due_date || null;
  if (!target) throw new ApiError("VALIDATION_ERROR", "대상자를 선택하세요");
  if (!Number.isFinite(amount) || amount <= 0) throw new ApiError("VALIDATION_ERROR", "금액은 0보다 큰 숫자여야 합니다");
  const { rows: ok } = await pgQuery(`SELECT 1 FROM auth.users WHERE id = $1 AND company_id = $2`, [target, companyId]);
  if (!ok[0]) throw new ApiError("VALIDATION_ERROR", "유효하지 않은 대상자입니다");
  const { rows } = await pgQuery(
    `INSERT INTO accounting.dues_charges (company_id, target_user_id, amount, due_date) VALUES ($1, $2, $3, $4) RETURNING id`,
    [companyId, target, amount, dueDate],
  );
  res.status(201).json({ id: String(rows[0].id) });
}

// ── 정산 ─────────────────────────────────────────────────────────
// GET /api/v1/pg/finance/settlements
export async function settlements(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT s.id AS __id, s.title AS 제목, u.name AS 신청자, s.amount AS 금액, s.status AS status, s.created_at AS 신청일
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
  const amount = Number(body.amount);
  if (!title) throw new ApiError("VALIDATION_ERROR", "제목은 필수입니다");
  if (!Number.isFinite(amount) || amount <= 0) throw new ApiError("VALIDATION_ERROR", "금액은 0보다 큰 숫자여야 합니다");
  const { rows } = await pgQuery(
    `INSERT INTO accounting.settlements (company_id, requester_id, title, amount) VALUES ($1, $2, $3, $4) RETURNING id`,
    [companyId, userId, title, amount],
  );
  res.status(201).json({ id: String(rows[0].id) });
}

// ── 알림 ─────────────────────────────────────────────────────────
// GET /api/v1/pg/notifications — 내 알림
export async function notifications(req, res) {
  const { userId, companyId } = await resolveUser(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT kind AS 유형, title AS 제목, body AS 내용,
            CASE WHEN is_read THEN 'done' ELSE 'pending' END AS status, created_at AS 시각
       FROM notice.notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [userId],
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

// GET /api/v1/pg/hr/leaves
export async function hrLeaves(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT u.name AS 이름, lr.leave_type AS 종류,
            lr.starts_on AS 시작, lr.ends_on AS 종료,
            lr.days AS 일수, lr.status AS status
       FROM hr.leave_requests lr
       JOIN auth.users u ON u.id = lr.user_id
      WHERE lr.company_id = $1
      ORDER BY lr.created_at DESC
      LIMIT 200`,
    [companyId],
  );
  res.json({ items: rows });
}

// GET /api/v1/pg/hr/postings
export async function hrPostings(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT jp.title AS 공고, d.name AS 부서,
            jp.headcount AS 모집인원, jp.status AS status, jp.opened_at AS 게시일
       FROM hr.job_postings jp
       LEFT JOIN org.departments d ON d.id = jp.department_id
      WHERE jp.company_id = $1
      ORDER BY jp.opened_at DESC`,
    [companyId],
  );
  res.json({ items: rows });
}
