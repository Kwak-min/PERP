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
