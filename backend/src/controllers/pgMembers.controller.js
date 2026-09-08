import { z } from "zod";
import { pgIdentity } from "../middleware/pgAccess.js";
import { pgQuery, pgTransaction } from "../config/pg.js";
import { ApiError } from "../utils/errors.js";
import { orgIdSchema, orgMutation, recordOrgChange, withOrgAuditSchema } from "../services/pg-org-audit.service.js";

// perp_db(PostgreSQL) 구성원 슬라이스.
// strangler-fig: 레거시 SQLite /members 를 대체하는 /api/v1/pg/members/*.
// 모든 조회는 로그인 사용자의 회사(company_id)로 스코프한다.

const resolveAuthUser = pgIdentity;

async function companyMembers(companyId, query = pgQuery) {
  return (await query(`SELECT u.id, u.email, u.name, m.department_id, m.position_id,
      CASE WHEN u.account_status = 'active' THEN m.status ELSE u.account_status::text END AS account_status,
      p.name AS position_name,
      ARRAY(SELECT DISTINCT r.name FROM org.user_roles ur JOIN org.roles r ON r.id = ur.role_id
        WHERE ur.user_id = u.id AND r.company_id = m.company_id AND ur.workspace_id IS NULL) AS roles
    FROM org.company_memberships m JOIN auth.users u ON u.id = m.user_id
    LEFT JOIN org.positions p ON p.id = m.position_id AND p.company_id = m.company_id
    WHERE m.company_id = $1 ORDER BY u.id`, [companyId])).rows;
}

// GET /api/v1/pg/members
// 로그인 사용자 회사의 구성원 목록. (회사 미배정 사용자는 빈 목록)
export async function listMembers(req, res) {
  const { companyId } = await resolveAuthUser(req);
  if (!companyId) {
    return res.json({ items: [] });
  }
  const rows = await companyMembers(companyId);
  const items = rows.map((r) => ({
    membership_id: String(r.id),
    user_id: String(r.id),
    email: r.email,
    name: r.name,
    roles: r.roles,
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
  const { depts, users, revision } = await withOrgAuditSchema(() => pgTransaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const company = (await client.query('SELECT org_revision FROM org.companies WHERE id = $1', [companyId])).rows[0];
    const depts = (await client.query('SELECT id, name, parent_id, manager_id FROM org.departments WHERE company_id = $1 ORDER BY id', [companyId])).rows;
    return { depts, users: await companyMembers(companyId, client.query.bind(client)), revision: String(company.org_revision) };
  }));
  const toMember = (u) => ({
    membership_id: String(u.id),
    user_id: String(u.id),
    email: u.email,
    name: u.name,
    roles: u.roles,
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
  res.json({ roots, unassigned, revision });
}

const assignmentSchema = z.object({ department_id: orgIdSchema.nullable().optional(), title: z.string().trim().min(1).max(200).optional() }).strict()
  .refine(body => Object.keys(body).length > 0);
const departmentSchema = z.object({ leader_id: orgIdSchema.nullable().optional(), name: z.string().trim().min(1).max(200).optional() }).strict()
  .refine(body => Object.keys(body).length > 0);
const seatSchema = z.object({ expected_revision: orgIdSchema, leader_id: orgIdSchema.nullable(), assigned: z.array(orgIdSchema).max(1000) }).strict()
  .refine(body => new Set(body.assigned).size === body.assigned.length);
const nullableId = value => value == null ? null : String(value);
const departmentData = row => ({ name: row.name, parent_id: nullableId(row.parent_id), leader_id: nullableId(row.manager_id) });
const assignmentData = row => ({ department_id: nullableId(row.department_id), title: row.position_name ?? null });

async function departmentForUpdate(client, companyId, id) {
  const row = (await client.query('SELECT id, name, parent_id, manager_id FROM org.departments WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, companyId])).rows[0];
  if (!row) throw new ApiError('NOT_FOUND', '부서를 찾을 수 없습니다');
  return row;
}
async function activeMembers(client, companyId) {
  return (await client.query(`SELECT m.user_id, m.department_id, m.position_id, u.name, p.name AS position_name
    FROM org.company_memberships m JOIN auth.users u ON u.id = m.user_id
    LEFT JOIN org.positions p ON p.id = m.position_id AND p.company_id = m.company_id
    WHERE m.company_id = $1 AND m.status = 'active' AND u.account_status = 'active' AND u.approval_status = 'approved'
    ORDER BY m.user_id FOR UPDATE OF m`, [companyId])).rows;
}
async function writeDepartment(client, req, companyId, row, after) {
  const before = departmentData(row);
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await client.query('UPDATE org.departments SET manager_id = $3, name = $4 WHERE id = $1 AND company_id = $2', [row.id, companyId, after.leader_id, after.name]);
  await recordOrgChange(client, req, { action: 'department.updated', resourceType: 'department', resourceId: String(row.id), target: after.name, before, after });
}
async function writeAssignment(client, req, companyId, row, departmentId, positionId, title) {
  const before = assignmentData(row), after = { department_id: departmentId, title };
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await client.query('UPDATE org.company_memberships SET department_id = $3, position_id = $4 WHERE user_id = $1 AND company_id = $2', [row.user_id, companyId, departmentId, positionId]);
  await recordOrgChange(client, req, { action: 'member.assignment.updated', resourceType: 'member', resourceId: String(row.user_id), target: row.name, before, after });
}

// PATCH /api/v1/pg/members/departments/:id/seat — 책임자와 배치 전체를 한 트랜잭션으로 저장한다.
export async function saveSeat(req, res) {
  const id = orgIdSchema.parse(req.params.id), body = seatSchema.parse(req.body);
  const result = await orgMutation(req, body.expected_revision, async (client, { companyId }) => {
    const department = await departmentForUpdate(client, companyId, id);
    const members = await activeMembers(client, companyId);
    const allowed = new Set(members.map(row => String(row.user_id)));
    if ((body.leader_id && !allowed.has(body.leader_id)) || body.assigned.some(uid => !allowed.has(uid))) {
      throw new ApiError('VALIDATION_ERROR', '활성 회사 구성원만 책임자 또는 배치 인원으로 지정할 수 있습니다');
    }
    // 모든 외부 ID 검증을 끝낸 뒤 첫 쓰기를 시작한다.
    await writeDepartment(client, req, companyId, department, { ...departmentData(department), leader_id: body.leader_id });
    const assigned = new Set(body.assigned);
    for (const row of members) {
      if (assigned.has(String(row.user_id))) await writeAssignment(client, req, companyId, row, id, nullableId(row.position_id), row.position_name ?? null);
      else if (String(row.department_id) === id) await writeAssignment(client, req, companyId, row, null, nullableId(row.position_id), row.position_name ?? null);
    }
    return { ok: true };
  });
  res.json(result);
}

// 기존 단건 배정도 변경과 감사를 함께 커밋한다. 알 수 없는 직책은 일부 적용하지 않는다.
export async function assignMember(req, res) {
  const uid = orgIdSchema.parse(req.params.membershipId), body = assignmentSchema.parse(req.body);
  const result = await orgMutation(req, undefined, async (client, { companyId }) => {
    const row = (await activeMembers(client, companyId)).find(member => String(member.user_id) === uid);
    if (!row) throw new ApiError('NOT_FOUND', '구성원을 찾을 수 없습니다');
    const departmentId = body.department_id === undefined ? nullableId(row.department_id) : body.department_id;
    if (departmentId) await departmentForUpdate(client, companyId, departmentId);
    let positionId = nullableId(row.position_id), title = row.position_name ?? null;
    if (body.title !== undefined) {
      const position = (await client.query('SELECT id FROM org.positions WHERE company_id = $1 AND name = $2', [companyId, body.title])).rows[0];
      if (!position) throw new ApiError('VALIDATION_ERROR', '회사에 등록되지 않은 직책입니다');
      positionId = String(position.id); title = body.title;
    }
    await writeAssignment(client, req, companyId, row, departmentId, positionId, title);
    return { ok: true };
  });
  res.json(result);
}

export async function updateDepartment(req, res) {
  const id = orgIdSchema.parse(req.params.id), body = departmentSchema.parse(req.body);
  const result = await orgMutation(req, undefined, async (client, { companyId }) => {
    const row = await departmentForUpdate(client, companyId, id);
    if (body.leader_id && !(await activeMembers(client, companyId)).some(member => String(member.user_id) === body.leader_id)) {
      throw new ApiError('VALIDATION_ERROR', '유효하지 않은 책임자입니다');
    }
    await writeDepartment(client, req, companyId, row, { ...departmentData(row), ...body });
    return { ok: true };
  });
  res.json(result);
}

export async function createDepartment(req, res) {
  const body = z.object({ name: z.string().trim().min(1).max(200), parent_id: orgIdSchema.nullable().optional() }).strict().parse(req.body);
  const result = await orgMutation(req, undefined, async (client, { companyId }) => {
    if (body.parent_id) await departmentForUpdate(client, companyId, body.parent_id);
    const row = (await client.query('INSERT INTO org.departments (company_id, name, parent_id) VALUES ($1, $2, $3) RETURNING id', [companyId, body.name, body.parent_id ?? null])).rows[0];
    await recordOrgChange(client, req, { action: 'department.created', resourceType: 'department', resourceId: String(row.id), target: body.name,
      before: null, after: { name: body.name, parent_id: body.parent_id ?? null, leader_id: null } });
    return { id: String(row.id) };
  });
  res.status(201).json(result);
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
