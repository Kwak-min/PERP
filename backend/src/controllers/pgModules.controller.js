import { pgQuery } from "../config/pg.js";
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
    `SELECT p.name AS 프로젝트, p.status AS status,
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
    `SELECT title AS 일정, starts_at AS 시작, ends_at AS 종료,
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
    `SELECT e.entry_date AS 일자, e.memo AS 내용,
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
    `SELECT ar.request_type AS 유형, r.name AS 신청자, t.name AS 대상,
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

// GET /api/v1/pg/tasks — 업무(프로젝트 배정)
export async function tasks(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT p.name AS 프로젝트, u.name AS 담당, a.role AS 역할,
            a.started_on AS 시작, a.ended_on AS 종료,
            CASE WHEN a.ended_on IS NULL THEN 'active' ELSE 'done' END AS status
       FROM project.assignments a
       JOIN project.projects p ON p.id = a.project_id
       JOIN auth.users u ON u.id = a.user_id
      WHERE p.company_id = $1
      ORDER BY a.started_on DESC`,
    [companyId],
  );
  res.json({ items: rows });
}

// GET /api/v1/pg/documents — 문서
export async function documents(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT d.title AS 제목, p.name AS 프로젝트, u.name AS 작성자,
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

// ── 자산 ─────────────────────────────────────────────────────────
// GET /api/v1/pg/assets
export async function assets(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT a.name AS 이름, a.category AS 분류, a.status AS status,
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
    `SELECT b.name AS 이름, b.amount AS 편성액, b.spent AS 집행액, b.status AS status
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
    `SELECT u.name AS 대상, c.amount AS 금액, c.due_date AS 기한, c.status AS status
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
    `SELECT s.title AS 제목, u.name AS 신청자, s.amount AS 금액, s.status AS status, s.created_at AS 신청일
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

// GET /api/v1/pg/hr/attendance
export async function hrAttendance(req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId) return res.json({ items: [] });
  const { rows } = await pgQuery(
    `SELECT u.name AS 이름, at.work_date AS 근무일,
            at.check_in_at AS 출근, at.check_out_at AS 퇴근, at.source AS status
       FROM hr.attendances at
       JOIN auth.users u ON u.id = at.user_id
      WHERE at.company_id = $1
      ORDER BY at.work_date DESC, u.name
      LIMIT 200`,
    [companyId],
  );
  res.json({ items: rows });
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
