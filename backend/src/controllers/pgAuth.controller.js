import { z } from "zod";

import { pgQuery, pgTransaction } from "../config/pg.js";
import { currentUser } from "../middleware/auth.js";
import { pgIdentity, pgWorkspace, PG_CREATOR_PERMISSIONS } from "../middleware/pgAccess.js";
import { OPTIONAL_MODULES } from "../config/modules.js";
import { hashPassword, verifyPassword } from "../utils/crypto.js";
import { ApiError } from "../utils/errors.js";

// perp_db (PostgreSQL) 인증 슬라이스.
// strangler-fig: 기존 SQLite auth 라우트와 분리된 /api/v1/pg/auth/* 아래 배치.

const loginSchema = z.object({
  email: z.string().trim().min(1).email(),
  password: z.string().min(1),
});

// 클라이언트 IP 추출 (INET 컬럼용). 없으면 NULL.
function clientIp(req) {
  const xff = req.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const ip = req.socket?.remoteAddress ?? req.ip ?? null;
  if (!ip) return null;
  // Express 는 IPv4-mapped IPv6(::ffff:127.0.0.1)로 줄 수 있음 → 정리
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

// 조직명 조인 포함한 사용자 요약 조회.
async function loadUserSummary(userId) {
  const { rows } = await pgQuery(
    `SELECT u.id, u.email, u.name, u.is_admin,
            u.company_id, u.department_id, u.position_id,
            c.name AS company_name,
            d.name AS department_name,
            p.name AS position_name
       FROM auth.users u
       LEFT JOIN org.companies   c ON c.id = u.company_id
       LEFT JOIN org.departments d ON d.id = u.department_id
       LEFT JOIN org.positions   p ON p.id = u.position_id
      WHERE u.id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

function serializeUser(row) {
  return {
    id: String(row.id),
    email: row.email,
    name: row.name,
    is_admin: row.is_admin,
    company: row.company_id
      ? { id: String(row.company_id), name: row.company_name }
      : null,
    department: row.department_id
      ? { id: String(row.department_id), name: row.department_name }
      : null,
    position: row.position_id
      ? { id: String(row.position_id), name: row.position_name }
      : null,
  };
}

const signupSchema = z.object({
  email: z.string().trim().min(1).email(),
  name: z.string().trim().min(1),
  password: z.string().min(8, "비밀번호는 8자 이상이어야 합니다"),
  phone: z.string().trim().optional(),
  invitation_token: z.string().min(1).optional(),
  company_name: z.string().trim().min(1, "회사명을 입력하세요"),
});

// POST /api/v1/pg/auth/signup
// 신규 계정을 auth.users 에 저장한다. (즉시 승인 정책: approval_status='approved')
// 가입 시 그 사람의 회사(작업공간) + 기본 부서·직급을 함께 만들고 관리자(대표)로 지정한다.
// 로그인과 동일하게 세션을 생성해 토큰을 반환 → 가입 직후 자동 로그인.
export async function signup(req, res) {
  const parsed = signupSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", "입력값을 확인하세요", {
      issues: parsed.error.issues,
    });
  }
  const { email, name, password, phone, company_name } = parsed.data;
  const ip = clientIp(req);
  const userAgent = req.get("user-agent") ?? null;

  // 이메일 중복 확인 (lower(email) unique index 와 일치)
  const { rows: existing } = await pgQuery(
    `SELECT 1 FROM auth.users WHERE lower(email) = lower($1)`,
    [email],
  );
  if (existing.length > 0) {
    throw new ApiError("CONFLICT", "이미 가입된 이메일입니다");
  }

  const passwordHash = hashPassword(password);

  // 회사·기본 설정·사용자·세션·가입 기록을 같은 PG 트랜잭션으로 생성한다.
  const { userId, session } = await pgTransaction(async (client) => {
    const { rows: comp } = await client.query(
      `INSERT INTO org.companies (name, ceo_name) VALUES ($1, $2) RETURNING id`,
      [company_name, name],
    );
    const companyId = comp[0].id;

    const { rows: pos } = await client.query(
      `INSERT INTO org.positions (company_id, name, rank_level) VALUES
         ($1, '대표', 50), ($1, '이사', 40), ($1, '팀장', 20), ($1, '사원', 10)
       RETURNING id, name`,
      [companyId],
    );
    const ceoPositionId = pos.find((p) => p.name === "대표")?.id ?? pos[0].id;

    const { rows: dep } = await client.query(
      `INSERT INTO org.departments (company_id, name, code) VALUES ($1, '경영지원팀', 'MGMT')
       RETURNING id`,
      [companyId],
    );
    const deptId = dep[0].id;

    // 기본 활성 모듈(전체 옵션) 세팅
    await client.query(
      `INSERT INTO org.company_modules (company_id, module_key)
       SELECT $1, k FROM unnest($2::text[]) AS k
       ON CONFLICT DO NOTHING`,
      [companyId, OPTIONAL_MODULES],
    );

    // 즉시 승인 + 관리자(대표)
    const { rows: u } = await client.query(
      `INSERT INTO auth.users
         (company_id, department_id, position_id, email, name, phone,
          password_hash, approval_status, is_admin, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', true, now())
       RETURNING id`,
      [companyId, deptId, ceoPositionId, email, name, phone ?? null, passwordHash],
    );
    const createdUserId = u[0].id;
    // 새 회사 생성자에게만 명시적 PG 역할을 기록한다. 기존 관리자 플래그는 사용하지 않는다.
    await client.query(`INSERT INTO org.permissions (code, module)
      SELECT code, split_part(code, '.', 1) FROM unnest($1::text[]) AS code
      ON CONFLICT (code) DO NOTHING`, [PG_CREATOR_PERMISSIONS]);
    const { rows: roles } = await client.query(
      "INSERT INTO org.roles (company_id, name, is_system) VALUES ($1, 'company_creator', true) RETURNING id", [companyId]);
    await client.query(`INSERT INTO org.role_permissions (role_id, permission_id)
      SELECT $1, id FROM org.permissions WHERE code = ANY($2::text[])`, [roles[0].id, PG_CREATOR_PERMISSIONS]);
    await client.query("INSERT INTO org.user_roles (user_id, role_id, granted_by) VALUES ($1, $2, $1)", [createdUserId, roles[0].id]);
    const { rows: sessionRows } = await client.query(
      `INSERT INTO auth.sessions (user_id, ip_address, user_agent)
       VALUES ($1, $2, $3)
       RETURNING session_token, login_at`,
      [createdUserId, ip, userAgent],
    );
    await client.query(
      `INSERT INTO auth.login_logs (user_id, email_tried, success, reason, ip_address)
       VALUES ($1, $2, true, 'signup', $3)`,
      [createdUserId, email, ip],
    );
    return { userId: createdUserId, session: sessionRows[0] };
  });

  const summary = await loadUserSummary(userId);

  res.status(201).json({
    token: session.session_token,
    token_type: "Bearer",
    login_at: session.login_at,
    user: serializeUser(summary),
  });
}

// PG 회사만 반환한다. SQLite 소속과 숫자 ID/이메일로 합치지 않는다.
export async function workspace(req, res) {
  const { companyId } = pgIdentity(req);
  res.json({ organizations: companyId ? [await pgWorkspace(req)] : [] });
}

// POST /api/v1/pg/auth/login
export async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", "이메일/비밀번호를 확인하세요", {
      issues: parsed.error.issues,
    });
  }
  const { email, password } = parsed.data;
  const ip = clientIp(req);
  const userAgent = req.get("user-agent") ?? null;

  // 이메일 대소문자 무시(lower(email) unique index 와 일치)
  const { rows } = await pgQuery(
    `SELECT id, email, name, password_hash, is_admin,
            account_status, approval_status
       FROM auth.users
      WHERE lower(email) = lower($1)`,
    [email],
  );
  const user = rows[0];

  const logFail = async (userId, reason) => {
    await pgQuery(
      `INSERT INTO auth.login_logs (user_id, email_tried, success, reason, ip_address)
       VALUES ($1, $2, false, $3, $4)`,
      [userId, email, reason, ip],
    );
  };

  if (!user) {
    await logFail(null, "user_not_found");
    throw new ApiError("UNAUTHENTICATED", "이메일 또는 비밀번호가 올바르지 않습니다");
  }

  if (!verifyPassword(password, user.password_hash)) {
    await logFail(user.id, "bad_password");
    throw new ApiError("UNAUTHENTICATED", "이메일 또는 비밀번호가 올바르지 않습니다");
  }

  if (user.approval_status !== "approved") {
    await logFail(user.id, `approval_status:${user.approval_status}`);
    throw new ApiError("PERMISSION_DENIED", "승인 대기 중인 계정입니다");
  }

  if (user.account_status !== "active") {
    await logFail(user.id, `account_status:${user.account_status}`);
    throw new ApiError("PERMISSION_DENIED", "비활성화된 계정입니다");
  }

  // 세션 생성 → session_token(UUID) 을 액세스 토큰으로 반환
  const { rows: sessionRows } = await pgQuery(
    `INSERT INTO auth.sessions (user_id, ip_address, user_agent)
     VALUES ($1, $2, $3)
     RETURNING session_token, login_at`,
    [user.id, ip, userAgent],
  );
  const session = sessionRows[0];

  await pgQuery(
    `INSERT INTO auth.login_logs (user_id, email_tried, success, reason, ip_address)
     VALUES ($1, $2, true, 'ok', $3)`,
    [user.id, email, ip],
  );

  const summary = await loadUserSummary(user.id);

  res.json({
    token: session.session_token,
    token_type: "Bearer",
    login_at: session.login_at,
    user: serializeUser(summary),
  });
}

// GET /api/v1/pg/auth/me
export async function me(req, res) {
  currentUser(req);
  if (req.authSource !== "perp_db" || !req.externalIdentity) {
    throw new ApiError("UNAUTHENTICATED", "유효한 perp_db 세션이 필요합니다");
  }
  const summary = await loadUserSummary(req.externalIdentity.subject);
  if (!summary) {
    throw new ApiError("UNAUTHENTICATED", "사용자를 찾을 수 없습니다");
  }

  res.json({ user: serializeUser(summary) });
}

// POST /api/v1/pg/auth/logout
export async function logout(req, res) {
  currentUser(req);
  if (req.authSource !== "perp_db") throw new ApiError("UNAUTHENTICATED", "유효한 perp_db 세션이 필요합니다");
  await pgQuery(
    `UPDATE auth.sessions
        SET is_active = false, logout_at = now()
      WHERE id = $1 AND is_active = true`,
    [req.sessionId],
  );
  res.json({ ok: true });
}

// GET /api/v1/pg/health
export async function health(_req, res) {
  const { rows } = await pgQuery(
    `SELECT 1 AS ok, (SELECT count(*) FROM auth.users) AS user_count`,
  );
  res.json({
    status: "ok",
    database: "perp_db",
    user_count: Number(rows[0].user_count),
  });
}
