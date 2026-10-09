import { z } from "zod";

import { pgQuery, pgTransaction } from "../config/pg.js";
import { permissionsFor, widestScope, ROLE_TEMPLATES } from "../config/rbac.js";
import { resolvePrincipal } from "../middleware/auth.js";
import { hashPassword, temporaryPassword } from "../utils/crypto.js";
import { ApiError, notFound } from "../utils/errors.js";

// perp_db(org.*) 전용 구성원 컨트롤러.
// SQLite(config/db, models/base, node:sqlite)를 전혀 쓰지 않는다.
// 모든 조회/쓰기는 company_id = principal.orgId 로 스코프.
//
// 핵심 매핑(프론트 수정 금지):
//   membership_id <- user_id        (perp_db 는 별도 membership PK 가 없어 user_id 로 대체)
//   title         <- positions.name (company_memberships.position_id)
//   leader_id     <- departments.manager_id
//   roles         <- org.user_roles ∞ org.roles.name
//   status 매핑    : DB active/suspended/left  ↔  프론트 active/inactive/left
//   access_roles  <- org.department_access_roles.role_key
// perp_db 에 없는 프론트 필드(address, birth_date)는 null 상수.
//
// 변경 이력은 org.organization_change_events 에 기록/조회(레거시 SQLite audit 미사용).
//   단 이 테이블 CHECK: action ∈ {department.created, department.updated, member.assignment.updated},
//   resource_type ∈ {department, member} 이므로 허용된 행위만 로깅한다.

// ── status 매핑 ─────────────────────────────────────────────
// company_memberships.status CHECK: {active, suspended, left}
const STATUS_TO_FRONT = { active: "active", suspended: "inactive", left: "left" };
const STATUS_TO_DB = { active: "active", inactive: "suspended", left: "left" };

// ── zod 스키마 ──────────────────────────────────────────────
const inviteSchema = z.object({
  email: z.string().email(),
  roles: z.array(z.string()).default(["member"]),
  expires_in_days: z.number().int().min(1).max(90).default(14),
});

const provisionSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  roles: z.array(z.string()).default(["member"]),
  department_id: z.union([z.string(), z.number()]).nullable().optional(),
  title: z.string().nullable().optional(),
});

const rolesSchema = z.object({ roles: z.array(z.string()) });
const statusSchema = z.object({ status: z.enum(["active", "inactive", "left"]) });
const simulationSchema = z.object({
  roles: z.array(z.string()).min(1),
  permissions: z.array(z.string()).default([]),
});
const departmentSchema = z.object({
  name: z.string().min(1).max(120),
  parent_id: z.union([z.string(), z.number()]).nullable().optional(),
  leader_id: z.union([z.string(), z.number()]).nullable().optional(),
  access_roles: z.array(z.string()).optional(),
});
const accessSchema = z.object({ access_roles: z.array(z.string()) });
const departmentPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  parent_id: z.union([z.string(), z.number()]).nullable().optional(),
  leader_id: z.union([z.string(), z.number()]).nullable().optional(),
});
const assignmentSchema = z.object({
  department_id: z.union([z.string(), z.number()]).nullable().optional(),
  title: z.string().max(120).nullable().optional(),
});

const ORG_ACTION_LABELS = {
  "member.assignment.changed": "부서·직책 변경",
  "member.assignment.updated": "부서·직책 변경",
  "member.roles.changed": "역할 변경",
  "member.status.changed": "상태 변경",
  "member.provisioned": "구성원 등록",
  "member.invited": "초대 발송",
  "department.created": "브랜치 생성",
  "department.updated": "브랜치 수정",
  "department.access.changed": "브랜치 접근 그룹 변경",
};

const toText = (v) => (v == null ? null : String(v));

// 변경 이력 기록(허용된 action 만). 실패해도 본 요청은 계속 진행.
async function logOrgEvent(entry) {
  try {
    await pgQuery(
      `INSERT INTO org.organization_change_events
         (company_id, actor_id, actor_name, action, resource_type, resource_id, target,
          before_data, after_data, request_id)
       VALUES ($1::bigint, $2::bigint,
               COALESCE((SELECT name FROM auth.users WHERE id = $2::bigint), '시스템'),
               $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
      [
        entry.orgId,
        entry.actorId,
        entry.action,
        entry.resourceType,
        String(entry.resourceId),
        entry.target ?? "",
        entry.before == null ? null : JSON.stringify(entry.before),
        JSON.stringify(entry.after ?? {}),
        entry.requestId ?? null,
      ],
    );
  } catch {
    // 이력 기록 실패는 무시한다.
  }
}

// ── 구성원 뷰 ───────────────────────────────────────────────
// company_memberships + auth.users + positions(title) + user_roles(roles) 조인.
const MEMBER_SELECT = `
  SELECT u.id AS user_id, u.email, u.name, u.phone,
         cm.status, cm.department_id, p.name AS title,
         COALESCE(
           array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL),
           '{}'
         ) AS roles
    FROM org.company_memberships cm
    JOIN auth.users u ON u.id = cm.user_id
    LEFT JOIN org.positions p ON p.id = cm.position_id
    LEFT JOIN org.user_roles ur ON ur.user_id = u.id
    LEFT JOIN org.roles r ON r.id = ur.role_id AND r.deleted_at IS NULL`;

const memberView = (row) => ({
  membership_id: toText(row.user_id),
  user_id: toText(row.user_id),
  email: row.email,
  name: row.name,
  roles: row.roles ?? [],
  status: STATUS_TO_FRONT[row.status] ?? row.status,
  department_id: toText(row.department_id),
  title: row.title ?? null,
  phone: row.phone ?? null,
  // perp_db 에 없는 필드 → null 상수(보고에 명시)
  address: null,
  birth_date: null,
});

async function loadMembers(orgId, { activeOnly = false, limit = 500 } = {}) {
  const clauses = ["cm.company_id::text = $1"];
  const params = [orgId];
  if (activeOnly) clauses.push("cm.status = 'active'");
  params.push(limit);
  const { rows } = await pgQuery(
    `${MEMBER_SELECT}
      WHERE ${clauses.join(" AND ")}
      GROUP BY u.id, u.email, u.name, u.phone, cm.status, cm.department_id, p.name, cm.created_at
      ORDER BY cm.created_at ASC NULLS LAST, u.id ASC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(memberView);
}

async function loadMembership(orgId, userId) {
  const { rows } = await pgQuery(
    `SELECT company_id, user_id, status, department_id, position_id
       FROM org.company_memberships
      WHERE company_id::text = $1 AND user_id::text = $2`,
    [orgId, String(userId)],
  );
  if (rows.length === 0) throw notFound("membership");
  return rows[0];
}

// 직책 문자열 → 해당 회사 positions.id (이름 일치 시). 없으면 null.
async function resolvePositionId(orgId, title) {
  if (!title) return null;
  const { rows } = await pgQuery(
    `SELECT id FROM org.positions WHERE company_id::text = $1 AND name = $2 LIMIT 1`,
    [orgId, title],
  );
  return rows[0]?.id ?? null;
}

export async function listMembers(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const limit = Number(req.query.limit ?? 200);
  const items = await loadMembers(principal.orgId, { limit });
  res.json({ items, next_cursor: null });
}

export async function listRoles(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const { rows } = await pgQuery(
    `SELECT name AS key, COALESCE(NULLIF(description, ''), name) AS label,
            COALESCE(scope, 'self') AS scope
       FROM org.roles
      WHERE (company_id::text = $1 OR company_id IS NULL) AND deleted_at IS NULL
      ORDER BY name ASC`,
    [principal.orgId],
  );
  res.json({ items: rows.map((r) => ({ key: r.key, label: r.label, scope: r.scope })) });
}

// ── 브랜치(부서) ────────────────────────────────────────────
// perp_db org principal 은 전권(*)이라 can_enter 는 항상 true.
// 접근 그룹과 겹침 여부는 참고용으로만 계산한다.
function canEnterBranch(principal, accessRoles) {
  if (principal.has("*") || principal.has("department.write")) return true;
  if (!accessRoles || accessRoles.length === 0) return true;
  return principal.roles.some((role) => accessRoles.includes(role));
}

async function loadDepartments(orgId) {
  const { rows } = await pgQuery(
    `SELECT d.id, d.parent_id, d.name, d.manager_id,
            COALESCE(
              array_agg(ar.role_key) FILTER (WHERE ar.role_key IS NOT NULL),
              '{}'
            ) AS access_roles
       FROM org.departments d
       LEFT JOIN org.department_access_roles ar ON ar.department_id = d.id
      WHERE d.company_id::text = $1
      GROUP BY d.id, d.parent_id, d.name, d.manager_id
      ORDER BY d.id ASC`,
    [orgId],
  );
  return rows;
}

export async function listDepartments(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const rows = await loadDepartments(principal.orgId);
  const items = rows.map((d) => ({
    id: toText(d.id),
    name: d.name,
    parent_id: toText(d.parent_id),
    leader_id: toText(d.manager_id),
    access_roles: d.access_roles ?? [],
    can_enter: canEnterBranch(principal, d.access_roles ?? []),
  }));
  res.json({
    items: principal.has("department.write") ? items : items.filter((i) => i.can_enter),
  });
}

async function replaceAccessRoles(client, orgId, departmentId, roles) {
  await client.query(`DELETE FROM org.department_access_roles WHERE department_id = $1`, [
    departmentId,
  ]);
  for (const role of [...new Set(roles)]) {
    await client.query(
      `INSERT INTO org.department_access_roles (company_id, department_id, role_key)
       VALUES ($1::bigint, $2, $3)
       ON CONFLICT (department_id, role_key) DO NOTHING`,
      [orgId, departmentId, role],
    );
  }
}

export async function createDepartment(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("department.write");
  const payload = departmentSchema.parse(req.body);

  const department = await pgTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO org.departments (company_id, parent_id, name, manager_id)
       VALUES ($1::bigint, $2, $3, $4)
       RETURNING id, parent_id, name, manager_id`,
      [
        principal.orgId,
        payload.parent_id ?? null,
        payload.name,
        payload.leader_id ?? null,
      ],
    );
    const created = rows[0];
    if (payload.access_roles?.length) {
      await replaceAccessRoles(client, principal.orgId, created.id, payload.access_roles);
    }
    return created;
  });

  await logOrgEvent({
    orgId: principal.orgId,
    actorId: principal.userId,
    action: "department.created",
    resourceType: "department",
    resourceId: department.id,
    target: department.name,
    after: { name: department.name, parent_id: toText(department.parent_id) },
    requestId: req.requestId,
  });

  res.status(201).json({
    id: toText(department.id),
    name: department.name,
    parent_id: toText(department.parent_id),
    leader_id: toText(department.manager_id),
    access_roles: payload.access_roles ?? [],
  });
}

export async function updateDepartment(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("department.write");
  const payload = departmentPatchSchema.parse(req.body);

  const { rows: current } = await pgQuery(
    `SELECT id, parent_id, name, manager_id FROM org.departments
      WHERE id::text = $1 AND company_id::text = $2`,
    [req.params.departmentId, principal.orgId],
  );
  if (current.length === 0) throw notFound("department");
  const before = current[0];

  if (payload.parent_id != null && String(payload.parent_id) === String(before.id)) {
    throw new ApiError("VALIDATION_ERROR", "자기 자신을 상위 부서로 지정할 수 없습니다");
  }

  const sets = [];
  const params = [];
  if (payload.name !== undefined) {
    params.push(payload.name);
    sets.push(`name = $${params.length}`);
  }
  if (payload.parent_id !== undefined) {
    params.push(payload.parent_id ?? null);
    sets.push(`parent_id = $${params.length}`);
  }
  if (payload.leader_id !== undefined) {
    params.push(payload.leader_id ?? null);
    sets.push(`manager_id = $${params.length}`);
  }

  if (sets.length === 0) {
    res.json({
      id: toText(before.id),
      name: before.name,
      parent_id: toText(before.parent_id),
      leader_id: toText(before.manager_id),
    });
    return;
  }

  params.push(before.id);
  const { rows } = await pgQuery(
    `UPDATE org.departments SET ${sets.join(", ")}, updated_at = now()
      WHERE id = $${params.length}
      RETURNING id, parent_id, name, manager_id`,
    params,
  );
  const updated = rows[0];

  await logOrgEvent({
    orgId: principal.orgId,
    actorId: principal.userId,
    action: "department.updated",
    resourceType: "department",
    resourceId: updated.id,
    target: updated.name,
    before: {
      name: before.name,
      parent_id: toText(before.parent_id),
      leader_id: toText(before.manager_id),
    },
    after: {
      name: updated.name,
      parent_id: toText(updated.parent_id),
      leader_id: toText(updated.manager_id),
    },
    requestId: req.requestId,
  });

  res.json({
    id: toText(updated.id),
    name: updated.name,
    parent_id: toText(updated.parent_id),
    leader_id: toText(updated.manager_id),
  });
}

export async function setDepartmentAccess(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("department.write");
  const payload = accessSchema.parse(req.body);

  const { rows } = await pgQuery(
    `SELECT id, name FROM org.departments WHERE id::text = $1 AND company_id::text = $2`,
    [req.params.departmentId, principal.orgId],
  );
  if (rows.length === 0) throw notFound("department");
  const department = rows[0];

  await pgTransaction(async (client) => {
    await replaceAccessRoles(client, principal.orgId, department.id, payload.access_roles);
  });

  res.json({ id: toText(department.id), access_roles: payload.access_roles });
}

// assertBranchAccess: 기존 export 유지(현재 다른 컨트롤러에서 import 하지 않음).
// perp_db principal 은 전권이라 사실상 통과. 접근 그룹이 지정된 브랜치만 검사.
export async function assertBranchAccess(principal, departmentId) {
  if (!departmentId) return;
  if (principal.has("*") || principal.has("department.write")) return;
  const { rows } = await pgQuery(
    `SELECT role_key FROM org.department_access_roles WHERE department_id::text = $1`,
    [String(departmentId)],
  );
  const roles = rows.map((r) => r.role_key);
  if (roles.length === 0) return;
  if (!principal.roles.some((role) => roles.includes(role))) {
    throw new ApiError("PERMISSION_DENIED", "이 브랜치에 들어갈 권한이 없습니다", {
      department_id: departmentId,
    });
  }
}

// ── 조직도 ──────────────────────────────────────────────────
export async function orgChart(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");

  const [departments, members] = await Promise.all([
    loadDepartments(principal.orgId),
    loadMembers(principal.orgId, { activeOnly: true, limit: 1000 }),
  ]);

  const node = (department) => {
    const deptId = toText(department.id);
    const leaderId = toText(department.manager_id);
    const assigned = members.filter((m) => m.department_id === deptId);
    const leader = members.find((m) => m.user_id === leaderId) ?? null;
    return {
      id: deptId,
      name: department.name,
      parent_id: toText(department.parent_id),
      leader_id: leaderId,
      configured: Boolean(leaderId),
      leader,
      member_count: assigned.length,
      members: assigned,
      children: departments
        .filter((d) => toText(d.parent_id) === deptId)
        .map(node),
    };
  };

  res.json({
    roots: departments.filter((d) => d.parent_id == null).map(node),
    unassigned: members.filter((m) => !m.department_id),
  });
}

// ── 변경 이력 ───────────────────────────────────────────────
export async function activity(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const limit = Math.min(Number(req.query.limit ?? 100), 500);

  const { rows } = await pgQuery(
    `SELECT id, actor_id, actor_name, action, resource_type, resource_id, target,
            before_data, after_data, created_at
       FROM org.organization_change_events
      WHERE company_id::text = $1
      ORDER BY id DESC
      LIMIT $2`,
    [principal.orgId, limit],
  );

  res.json({
    items: rows.map((row) => ({
      id: String(row.id),
      seq: Number(row.id),
      action: row.action,
      action_label: ORG_ACTION_LABELS[row.action] ?? row.action,
      resource_type: row.resource_type,
      resource_id: toText(row.resource_id),
      target: row.target ?? null,
      actor_name: row.actor_name ?? "알 수 없음",
      actor_kind: "user",
      before: row.before_data ?? null,
      after: row.after_data ?? null,
      created_at:
        row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    })),
  });
}

// ── 인원 변화 통계 ──────────────────────────────────────────
const growthSchema = z.object({
  days: z.coerce.number().int().min(7).max(1095).default(90),
});

function bucketPlan(days) {
  if (days <= 31) return { count: days, stepDays: 1, label: (d) => `${d.getMonth() + 1}/${d.getDate()}` };
  if (days <= 120) return { count: Math.ceil(days / 7), stepDays: 7, label: (d) => `${d.getMonth() + 1}/${d.getDate()}` };
  return { count: Math.ceil(days / 30), stepDays: 30, label: (d) => `${d.getFullYear() % 100}.${d.getMonth() + 1}` };
}

// perp_db 에는 가입/탈퇴 이력 타임스탬프가 없어 created_at + 현재 status 로 근사한다.
export async function growth(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const { days } = growthSchema.parse(req.query);

  const [{ rows: memberships }, { rows: invites }] = await Promise.all([
    pgQuery(
      `SELECT status, created_at FROM org.company_memberships WHERE company_id::text = $1`,
      [principal.orgId],
    ),
    pgQuery(
      `SELECT status, created_at, expires_at FROM org.member_invites WHERE company_id::text = $1`,
      [principal.orgId],
    ),
  ]);

  const plan = bucketPlan(days);
  const dayMs = 86_400_000;
  const now = Date.now();
  const joinedAt = (row) => (row.created_at ? new Date(row.created_at).getTime() : 0);

  const buckets = [];
  for (let index = plan.count - 1; index >= 0; index -= 1) {
    const edgeDate = new Date(now - index * plan.stepDays * dayMs);
    const edge = edgeDate.getTime();
    const windowStart = edge - plan.stepDays * dayMs;

    const present = memberships.filter((row) => joinedAt(row) > 0 && joinedAt(row) <= edge);

    buckets.push({
      date: edgeDate.toISOString().slice(0, 10),
      label: plan.label(edgeDate),
      total: present.length,
      active: present.filter((row) => row.status === "active").length,
      dormant: present.filter((row) => row.status !== "active").length,
      pending: invites.filter((invite) => {
        const created = invite.created_at ? new Date(invite.created_at).getTime() : 0;
        if (created > edge) return false;
        if (invite.status !== "pending") return false;
        return invite.expires_at ? new Date(invite.expires_at).getTime() > edge : true;
      }).length,
      joined: present.filter((row) => joinedAt(row) > windowStart && joinedAt(row) <= edge)
        .length,
    });
  }

  res.json({ period_days: days, step_days: plan.stepDays, buckets });
}

// ── 구성원 배정(부서·직책) ──────────────────────────────────
export async function setAssignment(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.write");
  const payload = assignmentSchema.parse(req.body);
  const membership = await loadMembership(principal.orgId, req.params.membershipId);

  if (payload.department_id) {
    const { rows } = await pgQuery(
      `SELECT id FROM org.departments WHERE id::text = $1 AND company_id::text = $2`,
      [String(payload.department_id), principal.orgId],
    );
    if (rows.length === 0) throw notFound("department");
  }

  const sets = [];
  const params = [];
  if (payload.department_id !== undefined) {
    params.push(payload.department_id ?? null);
    sets.push(`department_id = $${params.length}`);
  }
  // title 은 positions.name 과 일치할 때만 position_id 로 반영(없으면 무시).
  let newTitle;
  if (payload.title !== undefined) {
    const positionId = await resolvePositionId(principal.orgId, payload.title);
    if (positionId != null) {
      params.push(positionId);
      sets.push(`position_id = $${params.length}`);
      newTitle = payload.title;
    }
  }

  if (sets.length > 0) {
    params.push(membership.company_id, membership.user_id);
    await pgQuery(
      `UPDATE org.company_memberships SET ${sets.join(", ")}, updated_at = now()
        WHERE company_id = $${params.length - 1} AND user_id = $${params.length}`,
      params,
    );
  }

  const { rows: after } = await pgQuery(
    `SELECT cm.department_id, p.name AS title
       FROM org.company_memberships cm
       LEFT JOIN org.positions p ON p.id = cm.position_id
      WHERE cm.company_id = $1 AND cm.user_id = $2`,
    [membership.company_id, membership.user_id],
  );
  const result = after[0] ?? {};

  await logOrgEvent({
    orgId: principal.orgId,
    actorId: principal.userId,
    action: "member.assignment.updated",
    resourceType: "member",
    resourceId: membership.user_id,
    target: await memberName(membership.user_id),
    before: { department_id: toText(membership.department_id) },
    after: { department_id: toText(result.department_id), title: result.title ?? null },
    requestId: req.requestId,
  });

  res.json({
    membership_id: toText(membership.user_id),
    user_id: toText(membership.user_id),
    department_id: toText(result.department_id),
    title: result.title ?? newTitle ?? null,
  });
}

async function memberName(userId) {
  const { rows } = await pgQuery(`SELECT name FROM auth.users WHERE id::text = $1`, [
    String(userId),
  ]);
  return rows[0]?.name ?? null;
}

// ── 역할 변경 ───────────────────────────────────────────────
export async function setRoles(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("role.assign");
  const payload = rolesSchema.parse(req.body);
  const membership = await loadMembership(principal.orgId, req.params.membershipId);

  const updated = await pgTransaction(async (client) => {
    const { rows: roleRows } = await client.query(
      `SELECT id, name FROM org.roles
        WHERE name = ANY($1::text[])
          AND (company_id::text = $2 OR company_id IS NULL)
          AND deleted_at IS NULL`,
      [payload.roles, principal.orgId],
    );
    const roleIds = roleRows.map((r) => r.id);

    // 이 회사(+시스템) 역할 범위 안에서만 교체한다.
    await client.query(
      `DELETE FROM org.user_roles ur
         USING org.roles r
        WHERE ur.role_id = r.id AND ur.user_id = $1
          AND (r.company_id::text = $2 OR r.company_id IS NULL)`,
      [membership.user_id, principal.orgId],
    );
    for (const roleId of roleIds) {
      await client.query(
        `INSERT INTO org.user_roles (user_id, role_id, granted_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, role_id, workspace_id) DO NOTHING`,
        [membership.user_id, roleId, principal.userId],
      );
    }
    return roleRows.map((r) => r.name);
  });

  res.json({ membership_id: toText(membership.user_id), roles: updated });
}

// ── 상태 변경 ───────────────────────────────────────────────
export async function setStatus(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.write");
  const payload = statusSchema.parse(req.body);
  const membership = await loadMembership(principal.orgId, req.params.membershipId);
  const dbStatus = STATUS_TO_DB[payload.status];

  await pgTransaction(async (client) => {
    await client.query(
      `UPDATE org.company_memberships SET status = $1, updated_at = now()
        WHERE company_id = $2 AND user_id = $3`,
      [dbStatus, membership.company_id, membership.user_id],
    );
    if (payload.status === "left") {
      await client.query(
        `UPDATE auth.sessions SET is_active = false WHERE user_id = $1 AND is_active = true`,
        [membership.user_id],
      );
    }
  });

  res.json({ membership_id: toText(membership.user_id), status: payload.status });
}

// ── 초대 ────────────────────────────────────────────────────
export async function createInvite(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.write");
  const payload = inviteSchema.parse(req.body);
  const email = payload.email.trim().toLowerCase();

  const { rows: existing } = await pgQuery(
    `SELECT id FROM org.member_invites
      WHERE company_id::text = $1 AND email = $2 AND status = 'pending'`,
    [principal.orgId, email],
  );
  if (existing.length > 0) {
    throw new ApiError("CONFLICT", "a pending invitation already exists for this email");
  }

  const expiresAt = new Date(Date.now() + payload.expires_in_days * 86_400_000).toISOString();
  const { rows } = await pgQuery(
    `INSERT INTO org.member_invites (company_id, email, roles, status, invited_by, expires_at)
     VALUES ($1::bigint, $2, $3::text[], 'pending', $4::bigint, $5)
     RETURNING id, email, token, expires_at`,
    [principal.orgId, email, payload.roles, principal.userId, expiresAt],
  );
  const invite = rows[0];

  res.status(201).json({
    id: String(invite.id),
    email: invite.email,
    token: invite.token,
    expires_at:
      invite.expires_at instanceof Date ? invite.expires_at.toISOString() : invite.expires_at,
  });
}

export async function revokeInvite(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.write");
  const { rows } = await pgQuery(
    `UPDATE org.member_invites SET status = 'revoked', updated_at = now()
      WHERE id::text = $1 AND company_id::text = $2 AND status = 'pending'
      RETURNING id, status`,
    [req.params.invitationId, principal.orgId],
  );
  if (rows.length === 0) throw notFound("invitation");
  res.json({ id: String(rows[0].id), status: rows[0].status });
}

// ── 구성원 프로비저닝(임시 비밀번호 발급) ───────────────────
export async function provision(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.write");
  const payload = provisionSchema.parse(req.body);
  const email = payload.email.trim().toLowerCase();
  const temporary = temporaryPassword();
  const passwordHash = hashPassword(temporary);
  const positionId = await resolvePositionId(principal.orgId, payload.title ?? null);

  const result = await pgTransaction(async (client) => {
    const { rows: existingUser } = await client.query(
      `SELECT id FROM auth.users WHERE email = $1`,
      [email],
    );

    let userId;
    if (existingUser.length === 0) {
      const { rows } = await client.query(
        `INSERT INTO auth.users
           (email, name, phone, password_hash, company_id, department_id, position_id,
            account_status, approval_status, approved_by, approved_at)
         VALUES ($1, $2, NULL, $3, $4::bigint, $5, $6, 'active', 'approved', $7::bigint, now())
         RETURNING id`,
        [
          email,
          payload.name,
          passwordHash,
          principal.orgId,
          payload.department_id ?? null,
          positionId,
          principal.userId,
        ],
      );
      userId = rows[0].id;
    } else {
      userId = existingUser[0].id;
      const { rows: active } = await client.query(
        `SELECT status FROM org.company_memberships
          WHERE company_id::text = $1 AND user_id = $2`,
        [principal.orgId, userId],
      );
      if (active[0]?.status === "active") {
        throw new ApiError("CONFLICT", "이미 이 조직에 등록된 이메일입니다");
      }
      await client.query(
        `UPDATE auth.users SET password_hash = $1, account_status = 'active',
                approval_status = 'approved', updated_at = now()
          WHERE id = $2`,
        [passwordHash, userId],
      );
    }

    await client.query(
      `INSERT INTO org.company_memberships
         (company_id, user_id, status, department_id, position_id, created_by)
       VALUES ($1::bigint, $2, 'active', $3, $4, $5::bigint)
       ON CONFLICT (company_id, user_id)
       DO UPDATE SET status = 'active', department_id = EXCLUDED.department_id,
                     position_id = EXCLUDED.position_id, updated_at = now()`,
      [principal.orgId, userId, payload.department_id ?? null, positionId, principal.userId],
    );
    return userId;
  });

  res.status(201).json({
    user_id: String(result),
    membership_id: String(result),
    email,
    name: payload.name,
    roles: payload.roles,
    temporary_password: temporary,
    must_change_password: true,
    note: "이 임시 비밀번호는 지금 한 번만 표시됩니다. 사용자에게 직접 전달하세요.",
  });
}

export async function resetPassword(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.write");
  const membership = await loadMembership(principal.orgId, req.params.membershipId);

  const temporary = temporaryPassword();
  const passwordHash = hashPassword(temporary);

  const { rows } = await pgTransaction(async (client) => {
    const r = await client.query(
      `UPDATE auth.users SET password_hash = $1, updated_at = now()
        WHERE id = $2 RETURNING email`,
      [passwordHash, membership.user_id],
    );
    await client.query(
      `UPDATE auth.sessions SET is_active = false WHERE user_id = $1 AND is_active = true`,
      [membership.user_id],
    );
    return r;
  });
  if (rows.length === 0) throw notFound("user");

  res.json({
    membership_id: toText(membership.user_id),
    email: rows[0].email,
    temporary_password: temporary,
    must_change_password: true,
    sessions_revoked: true,
  });
}

// ── 권한 시뮬레이션(정적 RBAC 템플릿 기반, DB 미접근) ───────
export function simulatePermissions(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("role.assign");
  const payload = simulationSchema.parse(req.body);
  for (const role of payload.roles) {
    if (!(role in ROLE_TEMPLATES)) {
      throw new ApiError("VALIDATION_ERROR", `unknown role: ${role}`);
    }
  }
  const effective = permissionsFor(payload.roles);
  const requested =
    payload.permissions.length > 0
      ? [...new Set(payload.permissions)]
      : [...effective].filter((permission) => permission !== "*").sort();
  const granted = requested.filter(
    (permission) => effective.has("*") || effective.has(permission),
  );
  const denied = requested.filter((permission) => !granted.includes(permission));
  res.json({
    roles: payload.roles,
    scope: widestScope(payload.roles),
    granted,
    denied,
    matrix: requested.map((permission) => ({
      permission,
      allowed: effective.has("*") || effective.has(permission),
    })),
  });
}
