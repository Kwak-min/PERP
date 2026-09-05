import { pgQuery } from "../config/pg.js";
import { ApiError } from "../utils/errors.js";

// perp_db(PostgreSQL) 구성원 슬라이스.
// strangler-fig: 레거시 SQLite /members 를 대체하는 /api/v1/pg/members/*.
// 모든 조회는 로그인 사용자의 회사(company_id)로 스코프한다.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bearerToken(req) {
  const header = req.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Bearer(UUID 세션) → 로그인 사용자의 { userId, companyId, isAdmin } 해석.
async function resolveAuthUser(req) {
  const token = bearerToken(req);
  if (!token || !UUID_RE.test(token)) {
    throw new ApiError("UNAUTHENTICATED", "인증 토큰이 필요합니다");
  }
  const { rows } = await pgQuery(
    `SELECT u.id, u.company_id, u.is_admin
       FROM auth.sessions s
       JOIN auth.users u ON u.id = s.user_id
      WHERE s.session_token = $1 AND s.is_active = true`,
    [token],
  );
  const row = rows[0];
  if (!row) {
    throw new ApiError("UNAUTHENTICATED", "세션이 만료되었거나 유효하지 않습니다");
  }
  return { userId: row.id, companyId: row.company_id, isAdmin: row.is_admin };
}

// GET /api/v1/pg/members
// 로그인 사용자 회사의 구성원 목록. (회사 미배정 사용자는 빈 목록)
export async function listMembers(req, res) {
  const { companyId } = await resolveAuthUser(req);
  if (!companyId) {
    return res.json({ items: [] });
  }
  const { rows } = await pgQuery(
    `SELECT u.id, u.email, u.name,
            u.department_id, u.position_id,
            u.account_status, u.is_admin,
            p.name AS position_name
       FROM auth.users u
       LEFT JOIN org.positions p ON p.id = u.position_id
      WHERE u.company_id = $1
      ORDER BY u.id`,
    [companyId],
  );
  const items = rows.map((r) => ({
    membership_id: String(r.id),
    user_id: String(r.id),
    email: r.email,
    name: r.name,
    roles: r.is_admin ? ["admin"] : r.position_name ? [r.position_name] : [],
    status: r.account_status,
    department_id: r.department_id ? String(r.department_id) : null,
    title: r.position_name ?? null,
  }));
  res.json({ items });
}

// GET /api/v1/pg/members/departments
export async function listDepartments(req, res) {
  const { companyId } = await resolveAuthUser(req);
  if (!companyId) {
    return res.json({ items: [] });
  }
  const { rows } = await pgQuery(
    `SELECT id, name, parent_id, manager_id
       FROM org.departments
      WHERE company_id = $1
      ORDER BY id`,
    [companyId],
  );
  const items = rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    parent_id: r.parent_id ? String(r.parent_id) : null,
    leader_id: r.manager_id ? String(r.manager_id) : null,
    access_roles: [],
    can_enter: true,
  }));
  res.json({ items });
}

// GET /api/v1/pg/members/roles
// 회사 직급을 역할 선택지로 노출한다. (구성원 roles 라벨 매핑에 사용)
export async function listRoles(req, res) {
  const { companyId } = await resolveAuthUser(req);
  const items = [{ key: "admin", label: "관리자", scope: "org" }];
  if (companyId) {
    const { rows } = await pgQuery(
      `SELECT name FROM org.positions WHERE company_id = $1 ORDER BY rank_level DESC`,
      [companyId],
    );
    for (const r of rows) {
      items.push({ key: r.name, label: r.name, scope: "self" });
    }
  }
  res.json({ items });
}
