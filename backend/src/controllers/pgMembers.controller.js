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

// GET /api/v1/pg/members/org-chart — 조직도 트리
export async function orgChart(req, res) {
  const { companyId } = await resolveAuthUser(req);
  if (!companyId) return res.json({ roots: [], unassigned: [] });
  const { rows: depts } = await pgQuery(
    `SELECT id, name, parent_id, manager_id FROM org.departments WHERE company_id = $1 ORDER BY id`,
    [companyId],
  );
  const { rows: users } = await pgQuery(
    `SELECT u.id, u.email, u.name, u.department_id, u.is_admin, u.account_status, p.name AS position_name
       FROM auth.users u LEFT JOIN org.positions p ON p.id = u.position_id
      WHERE u.company_id = $1 ORDER BY u.id`,
    [companyId],
  );
  const toMember = (u) => ({
    membership_id: String(u.id),
    user_id: String(u.id),
    email: u.email,
    name: u.name,
    roles: u.is_admin ? ["admin"] : u.position_name ? [u.position_name] : [],
    status: u.account_status,
    department_id: u.department_id ? String(u.department_id) : null,
    title: u.position_name ?? null,
    phone: null,
    address: null,
    birth_date: null,
  });
  const byDept = new Map();
  const unassigned = [];
  const byId = new Map();
  for (const u of users) {
    const m = toMember(u);
    byId.set(String(u.id), m);
    if (u.department_id) {
      const k = String(u.department_id);
      if (!byDept.has(k)) byDept.set(k, []);
      byDept.get(k).push(m);
    } else {
      unassigned.push(m);
    }
  }
  const buildSeat = (d) => {
    const members = byDept.get(String(d.id)) ?? [];
    return {
      id: String(d.id),
      name: d.name,
      parent_id: d.parent_id ? String(d.parent_id) : null,
      leader_id: d.manager_id ? String(d.manager_id) : null,
      configured: true,
      leader: d.manager_id ? byId.get(String(d.manager_id)) ?? null : null,
      member_count: members.length,
      members,
      children: depts.filter((x) => String(x.parent_id) === String(d.id)).map(buildSeat),
    };
  };
  const roots = depts.filter((d) => !d.parent_id).map(buildSeat);
  res.json({ roots, unassigned });
}

// PATCH /api/v1/pg/members/:membershipId/assignment — 부서/직책 배정
export async function assignMember(req, res) {
  const { companyId } = await resolveAuthUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "권한이 없습니다");
  const uid = req.params.membershipId; // 본 스킴에서 membership_id = user id
  const body = req.body ?? {};
  const sets = [];
  const params = [uid, companyId];
  if ("department_id" in body) {
    const dep = body.department_id || null;
    if (dep) {
      const { rows } = await pgQuery(`SELECT 1 FROM org.departments WHERE id=$1 AND company_id=$2`, [dep, companyId]);
      if (!rows[0]) throw new ApiError("VALIDATION_ERROR", "유효하지 않은 부서입니다");
    }
    params.push(dep);
    sets.push(`department_id = $${params.length}`);
  }
  if ("title" in body && body.title) {
    const { rows } = await pgQuery(
      `SELECT id FROM org.positions WHERE company_id=$1 AND name=$2`, [companyId, String(body.title).trim()]);
    if (rows[0]) {
      params.push(rows[0].id);
      sets.push(`position_id = $${params.length}`);
    }
  }
  if (sets.length === 0) throw new ApiError("VALIDATION_ERROR", "변경할 내용이 없습니다");
  const result = await pgQuery(
    `UPDATE auth.users SET ${sets.join(", ")} WHERE id = $1 AND company_id = $2`, params);
  if (result.rowCount === 0) throw new ApiError("NOT_FOUND", "구성원을 찾을 수 없습니다");
  res.json({ ok: true });
}

// PATCH /api/v1/pg/members/departments/:id — 부서 설정(책임자 등)
export async function updateDepartment(req, res) {
  const { companyId } = await resolveAuthUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "권한이 없습니다");
  const body = req.body ?? {};
  const sets = [];
  const params = [req.params.id, companyId];
  if ("leader_id" in body) {
    params.push(body.leader_id || null);
    sets.push(`manager_id = $${params.length}`);
  }
  if ("name" in body && body.name) {
    params.push(String(body.name).trim());
    sets.push(`name = $${params.length}`);
  }
  if (sets.length === 0) throw new ApiError("VALIDATION_ERROR", "변경할 내용이 없습니다");
  const result = await pgQuery(
    `UPDATE org.departments SET ${sets.join(", ")} WHERE id = $1 AND company_id = $2`, params);
  if (result.rowCount === 0) throw new ApiError("NOT_FOUND", "부서를 찾을 수 없습니다");
  res.json({ ok: true });
}

// POST /api/v1/pg/members/departments — 부서 생성
export async function createDepartment(req, res) {
  const { companyId } = await resolveAuthUser(req);
  if (!companyId) throw new ApiError("PERMISSION_DENIED", "권한이 없습니다");
  const body = req.body ?? {};
  const name = String(body.name ?? "").trim();
  const parentId = body.parent_id || null;
  if (!name) throw new ApiError("VALIDATION_ERROR", "부서명은 필수입니다");
  const { rows } = await pgQuery(
    `INSERT INTO org.departments (company_id, name, parent_id) VALUES ($1, $2, $3) RETURNING id`,
    [companyId, name, parentId],
  );
  res.status(201).json({ id: String(rows[0].id) });
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
