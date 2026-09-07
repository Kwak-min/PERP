import { z } from "zod";

import { db } from "../config/db.js";
import {
  MASKED_FIELDS,
  ROLE_TEMPLATES,
  SCOPE_ORDER,
  permissionsFor,
  widestScope,
} from "../config/rbac.js";
import { resolvePrincipal } from "../middleware/auth.js";
import { bumpVersion, getScoped, hardDelete, insert, listScoped, newId, nowIso, softDelete, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { notify } from "../services/notification.service.js";
import { hashPassword, newToken, temporaryPassword } from "../utils/crypto.js";
import { ApiError, notFound } from "../utils/errors.js";

const inviteSchema = z.object({
  email: z.string().email(),
  roles: z.array(z.string()).default(["member"]),
  expires_in_days: z.number().int().min(1).max(90).default(14),
});

const provisionSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  roles: z.array(z.string()).default(["member"]),
  department_id: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  employee_number: z.string().max(80).nullable().optional(),
  employment_type: z.enum(["full_time", "part_time", "contractor", "intern", "other"]).nullable().optional(),
  hire_date: z.string().date().nullable().optional(),
  workplace: z.string().max(160).nullable().optional(),
  birth_date: z.string().date().nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  emergency_contact: z.string().max(240).nullable().optional(),
});

const rolesSchema = z.object({ roles: z.array(z.string()) });
const statusSchema = z.object({ status: z.enum(["active", "inactive", "left"]) });
const simulationSchema = z.object({
  roles: z.array(z.string()).min(1),
  permissions: z.array(z.string()).default([]),
});
const departmentSchema = z.object({
  name: z.string().min(1).max(120),
  parent_id: z.string().nullable().optional(),
  leader_id: z.string().nullable().optional(),
  access_roles: z.array(z.string()).optional(),
});
const accessSchema = z.object({ access_roles: z.array(z.string()) });
const departmentPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  parent_id: z.string().nullable().optional(),
  leader_id: z.string().nullable().optional(),
});
const assignmentSchema = z.object({
  department_id: z.string().nullable().optional(),
  title: z.string().max(120).nullable().optional(),
});
const homeLayoutSchema = z.object({
  department_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  blocks: z.array(z.enum(["welcome", "tasks", "projects", "calendar", "members", "documents"])).min(1),
});

const competencySchema = z.object({
  label: z.string().min(1).max(120),
  level: z.enum(["beginner", "intermediate", "advanced"]).default("intermediate"),
  note: z.string().default(""),
});

const FIELD_REQUEST_FIELDS = ["phone", "address", "birth_date", "emergency_contact"];
const APP_USER_FIELDS = new Set(["phone", "address", "birth_date"]);
const fieldRequestSchema = z.object({
  field: z.enum(FIELD_REQUEST_FIELDS),
  new_value: z.string().min(1).max(300),
});
const fieldDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  comment: z.string().default(""),
});

function assertKnownRoles(roles) {
  for (const role of roles) {
    if (!Object.hasOwn(ROLE_TEMPLATES, role)) {
      throw new ApiError("VALIDATION_ERROR", `unknown role: ${role}`);
    }
  }
}

function assertCanDelegateRoles(principal, roles) {
  principal.require("role.assign");
  assertKnownRoles(roles);

  const actorPermissions = permissionsFor(principal.roles);
  const actorScope = SCOPE_ORDER.indexOf(principal.scope);
  for (const role of roles) {
    const template = ROLE_TEMPLATES[role];
    const delegatesPlatformAccess = template.permissions.some((permission) => permission.startsWith("platform."));
    const exceedsPermissions = template.permissions.some(
      (permission) => !actorPermissions.has("*") && !actorPermissions.has(permission),
    );
    if (delegatesPlatformAccess || exceedsPermissions || SCOPE_ORDER.indexOf(template.scope) > actorScope) {
      throw new ApiError("PERMISSION_DENIED", `role delegation denied: ${role}`);
    }
  }
}

function maskRecord(principal, data, ownerId) {
  if (ownerId && ownerId === principal.userId) return data;
  const out = { ...data };
  for (const [field, required] of Object.entries(MASKED_FIELDS)) {
    if (out[field] && !principal.has(required)) out[field] = "***";
  }
  return out;
}

function memberView(principal, membership, user) {
  return maskRecord(
    principal,
    {
      membership_id: membership.id,
      user_id: user.id,
      email: user.email,
      name: user.name,
      roles: (membership.roles ?? "").split(",").filter(Boolean),
      status: membership.status,
      department_id: membership.department_id,
      title: membership.title,
      phone: user.phone,
      address: user.address,
      birth_date: user.birth_date,
      emergency_contact: membership.emergency_contact,
    },
    user.id,
  );
}

export function listMembers(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const limit = Number(req.query.limit ?? 50);
  const rows = listScoped("membership", principal, [], { limit });
  const items = [];
  for (const membership of rows) {
    const user = db().prepare("SELECT * FROM app_user WHERE id = ?").get(membership.user_id);
    if (user) items.push(memberView(principal, membership, user));
  }
  res.json({ items, next_cursor: null });
}

function findMembershipByUserId(principal, userId) {
  return db()
    .prepare(
      `SELECT * FROM membership
       WHERE tenant_id = ? AND org_id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .get(principal.tenantId, principal.orgId, userId);
}

/** memberId(=user_id) 본인이거나 member.write가 있어야 통과한다. HR-001의 역량·수정신청류 엔드포인트가 공통으로 쓰는 관용구. */
function requireSelfOrMemberWrite(principal, memberId) {
  if (memberId !== principal.userId) principal.require("member.write");
}

/** 단건 구성원 프로필. HR-001 상세 화면의 헤더 정보로 쓰인다. memberId는 membership.id가 아니라 user_id다. */
export function getMemberProfile(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const membership = findMembershipByUserId(principal, req.params.memberId);
  if (!membership) throw notFound("member");
  const user = db().prepare("SELECT * FROM app_user WHERE id = ?").get(membership.user_id);
  if (!user) throw notFound("member");

  res.json({ ...memberView(principal, membership, user), joined_at: membership.joined_at });
}

const competencyView = (c) => ({
  id: c.id,
  member_id: c.member_id,
  label: c.label,
  level: c.level,
  note: c.note,
});

export function listCompetencies(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const rows = listScoped(
    "member_competency",
    principal,
    [{ sql: "member_id = ?", params: [req.params.memberId] }],
    { limit: 200, orderBy: "created_at ASC" },
  );
  res.json({ items: rows.map(competencyView) });
}

export function addCompetency(req, res) {
  const principal = resolvePrincipal(req);
  requireSelfOrMemberWrite(principal, req.params.memberId);
  const payload = competencySchema.parse(req.body);
  const row = insert("member_competency", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    member_id: req.params.memberId,
    label: payload.label,
    level: payload.level,
    note: payload.note,
    created_by: principal.userId,
  });
  res.status(201).json(competencyView(row));
}

export function deleteCompetency(req, res) {
  const principal = resolvePrincipal(req);
  const competency = getScoped("member_competency", principal, req.params.competencyId, "competency");
  requireSelfOrMemberWrite(principal, competency.member_id);
  softDelete("member_competency", competency.id, principal.userId);
  res.status(204).send();
}

const fieldRequestView = (r) => ({
  id: r.id,
  member_id: r.member_id,
  field: r.field,
  old_value: r.old_value,
  new_value: r.new_value,
  status: r.status,
  comment: r.comment,
  created_at: r.created_at,
  decided_at: r.decided_at,
});

export function listFieldRequests(req, res) {
  const principal = resolvePrincipal(req);
  requireSelfOrMemberWrite(principal, req.params.memberId);
  const rows = listScoped(
    "member_field_request",
    principal,
    [{ sql: "member_id = ?", params: [req.params.memberId] }],
    { limit: 100 },
  );
  res.json({ items: rows.map(fieldRequestView) });
}

/** 본인 수정 승인 워크플로우 1단계: 신청. HR-001 스펙상 본인만 신청할 수 있다(HR 대리 신청 없음). */
export function createFieldRequest(req, res) {
  const principal = resolvePrincipal(req);
  if (req.params.memberId !== principal.userId) {
    throw new ApiError("PERMISSION_DENIED", "본인만 수정 신청을 할 수 있습니다");
  }
  const payload = fieldRequestSchema.parse(req.body);
  const membership = findMembershipByUserId(principal, principal.userId);
  if (!membership) throw notFound("member");
  const user = db().prepare("SELECT * FROM app_user WHERE id = ?").get(principal.userId);

  const oldValue = APP_USER_FIELDS.has(payload.field) ? user[payload.field] : membership[payload.field];

  const row = insert("member_field_request", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    member_id: principal.userId,
    field: payload.field,
    old_value: oldValue ?? null,
    new_value: payload.new_value,
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "member.field_request.created",
    resourceType: "member_field_request",
    resourceId: row.id,
    actorId: principal.userId,
    after: { field: row.field, new_value: row.new_value },
    requestId: req.requestId,
  });

  res.status(201).json(fieldRequestView(row));
}

/** 본인 수정 승인 워크플로우 2단계: 승인/반려. 승인 시 실제로 app_user/membership에 반영한다. */
export function decideFieldRequest(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.write");
  const payload = fieldDecisionSchema.parse(req.body);
  const fieldRequest = getScoped("member_field_request", principal, req.params.requestId, "member_field_request");
  if (fieldRequest.status !== "pending") {
    throw new ApiError("CONFLICT", `이미 처리된 요청입니다: ${fieldRequest.status}`);
  }

  const status = payload.decision === "approve" ? "approved" : "rejected";
  const updated = update(
    "member_field_request",
    fieldRequest.id,
    { status, comment: payload.comment, decided_by: principal.userId, decided_at: nowIso() },
    principal.userId,
  );

  if (status === "approved") {
    const membership = findMembershipByUserId(principal, fieldRequest.member_id);
    if (!membership) throw notFound("member");
    if (APP_USER_FIELDS.has(fieldRequest.field)) {
      update("app_user", membership.user_id, { [fieldRequest.field]: fieldRequest.new_value }, principal.userId);
    } else {
      update("membership", membership.id, { [fieldRequest.field]: fieldRequest.new_value }, principal.userId);
    }
  }

  audit.record({
    tenantId: principal.tenantId,
    action: `member.field_request.${status}`,
    resourceType: "member_field_request",
    resourceId: fieldRequest.id,
    actorId: principal.userId,
    before: { status: fieldRequest.status },
    after: { status },
    requestId: req.requestId,
  });

  notify({
    tenantId: principal.tenantId,
    recipientId: fieldRequest.member_id,
    type: `member.field_request.${status}`,
    title: status === "approved" ? "수정 신청이 승인되었습니다" : "수정 신청이 반려되었습니다",
    body: payload.comment,
    relatedType: "member_field_request",
    relatedId: fieldRequest.id,
    dedupeKey: `field-request-decision:${fieldRequest.id}`,
  });

  res.json(fieldRequestView(updated));
}

export function simulatePermissions(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("role.assign");
  const payload = simulationSchema.parse(req.body);
  assertKnownRoles(payload.roles);
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

export function createInvite(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.write");
  const payload = inviteSchema.parse(req.body);
  assertCanDelegateRoles(principal, payload.roles);

  const email = payload.email.trim().toLowerCase();
  const now = nowIso();
  const expired = db()
    .prepare(
      `SELECT id FROM invitation
       WHERE tenant_id = ? AND org_id = ? AND lower(email) = ? AND status = 'pending'
         AND expires_at <= ? AND deleted_at IS NULL`,
    )
    .all(principal.tenantId, principal.orgId, email, now);
  for (const invitation of expired) {
    update("invitation", invitation.id, { status: "expired" }, principal.userId);
  }

  const existing = db()
    .prepare(
      `SELECT id FROM invitation
       WHERE tenant_id = ? AND org_id = ? AND lower(email) = ? AND status = 'pending'
         AND expires_at > ? AND deleted_at IS NULL`,
    )
    .get(principal.tenantId, principal.orgId, email, now);
  if (existing) throw new ApiError("CONFLICT", "a pending invitation already exists for this email");

  const invitation = insert("invitation", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    email,
    roles: payload.roles.join(","),
    token: newToken(),
    expires_at: new Date(Date.now() + payload.expires_in_days * 86400000).toISOString(),
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "member.invited",
    resourceType: "invitation",
    resourceId: invitation.id,
    actorId: principal.userId,
    after: { email, roles: payload.roles },
    requestId: req.requestId,
  });

  res.status(201).json({
    id: invitation.id,
    email: invitation.email,
    token: invitation.token,
    expires_at: invitation.expires_at,
  });
}

export function revokeInvite(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.write");
  const invitation = db()
    .prepare("SELECT * FROM invitation WHERE id = ? AND tenant_id = ? AND org_id = ?")
    .get(req.params.invitationId, principal.tenantId, principal.orgId);
  if (!invitation) throw notFound("invitation");
  update("invitation", invitation.id, { status: "revoked" }, principal.userId);
  res.json({ id: invitation.id, status: "revoked" });
}

export function provision(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.write");
  const payload = provisionSchema.parse(req.body);
  assertCanDelegateRoles(principal, payload.roles);

  const email = payload.email.trim().toLowerCase();
  const existingUser = db().prepare("SELECT * FROM app_user WHERE lower(email) = ?").get(email);
  if (existingUser) {
    throw new ApiError(
      "CONFLICT",
      "이미 등록된 계정입니다. 사용자가 로그인한 뒤 이메일 초대를 수락해야 합니다",
    );
  }

  const temporary = temporaryPassword();
  const user = insert("app_user", {
    id: newId(),
    email,
    name: payload.name,
    password_hash: hashPassword(temporary),
    must_change_password: 1,
    created_at: nowIso(),
  });
  const membership = insert("membership", {
    tenant_id: principal.tenantId,
    user_id: user.id,
    org_id: principal.orgId,
    roles: payload.roles.join(","),
    status: "active",
    department_id: payload.department_id ?? null,
    title: payload.title ?? null,
    joined_at: nowIso(),
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "member.provisioned",
    resourceType: "membership",
    resourceId: membership.id,
    actorId: principal.userId,
    after: { email, roles: payload.roles, temporary_password_issued: true },
    requestId: req.requestId,
  });

  res.status(201).json({
    user_id: user.id,
    membership_id: membership.id,
    email: user.email,
    name: user.name,
    roles: (membership.roles ?? "").split(",").filter(Boolean),
    temporary_password: temporary,
    must_change_password: true,
    note: "이 임시 비밀번호는 지금 한 번만 표시됩니다. 사용자에게 직접 전달하세요.",
  });
}

export function resetPassword(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.write");
  principal.require("role.assign");
  const membership = db()
    .prepare(
      `SELECT * FROM membership
       WHERE id = ? AND tenant_id = ? AND org_id = ? AND status = 'active' AND deleted_at IS NULL`,
    )
    .get(req.params.membershipId, principal.tenantId, principal.orgId);
  if (!membership) throw notFound("membership");
  assertCanDelegateRoles(principal, (membership.roles ?? "").split(",").filter(Boolean));
  const user = db().prepare("SELECT * FROM app_user WHERE id = ?").get(membership.user_id);
  if (!user) throw notFound("user");

  const memberships = db()
    .prepare("SELECT org_id FROM membership WHERE user_id = ? AND deleted_at IS NULL")
    .all(user.id);
  if (!user.must_change_password || memberships.length !== 1 || memberships[0].org_id !== principal.orgId) {
    throw new ApiError("CONFLICT", "등록이 완료된 계정의 비밀번호는 관리자가 변경할 수 없습니다");
  }

  const temporary = temporaryPassword();
  update("app_user", user.id, {
    password_hash: hashPassword(temporary),
    must_change_password: 1,
    failed_logins: 0,
    locked_until: null,
  });
  db()
    .prepare("UPDATE session_token SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .run(nowIso(), user.id);

  audit.record({
    tenantId: principal.tenantId,
    action: "member.password.reset",
    resourceType: "membership",
    resourceId: membership.id,
    actorId: principal.userId,
    after: { email: user.email, sessions_revoked: true },
    requestId: req.requestId,
  });

  res.json({
    membership_id: membership.id,
    email: user.email,
    temporary_password: temporary,
    must_change_password: true,
    sessions_revoked: true,
  });
}

export function setRoles(req, res) {
  const principal = resolvePrincipal(req);
  const payload = rolesSchema.parse(req.body);
  assertCanDelegateRoles(principal, payload.roles);

  const membership = db()
    .prepare("SELECT * FROM membership WHERE id = ? AND tenant_id = ? AND org_id = ?")
    .get(req.params.membershipId, principal.tenantId, principal.orgId);
  if (!membership) throw notFound("membership");

  const before = (membership.roles ?? "").split(",").filter(Boolean);
  assertCanDelegateRoles(principal, before);
  const updated = bumpVersion("membership", membership, { roles: payload.roles.join(",") }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "member.roles.changed",
    resourceType: "membership",
    resourceId: membership.id,
    actorId: principal.userId,
    before: { roles: before },
    after: { roles: payload.roles },
    requestId: req.requestId,
  });

  res.json({
    membership_id: updated.id,
    roles: (updated.roles ?? "").split(",").filter(Boolean),
  });
}

export function setStatus(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.write");
  const payload = statusSchema.parse(req.body);

  const membership = db()
    .prepare("SELECT * FROM membership WHERE id = ? AND tenant_id = ? AND org_id = ?")
    .get(req.params.membershipId, principal.tenantId, principal.orgId);
  if (!membership) throw notFound("membership");

  const before = membership.status;
  const patch = { status: payload.status };
  if (payload.status === "left") {
    patch.left_at = nowIso();
    db()
      .prepare("UPDATE session_token SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .run(nowIso(), membership.user_id);
  }
  const updated = bumpVersion("membership", membership, patch, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "member.status.changed",
    resourceType: "membership",
    resourceId: membership.id,
    actorId: principal.userId,
    before: { status: before },
    after: { status: updated.status },
    requestId: req.requestId,
  });

  res.json({ membership_id: updated.id, status: updated.status });
}

/** 브랜치에 들어갈 수 있게 지정된 그룹(역할). 비어 있으면 조직 전체 공개다. */
function accessRolesOf(principal, departmentId) {
  return listScoped(
    "department_access",
    principal,
    [{ sql: "department_id = ?", params: [departmentId] }],
    { limit: 50, orderBy: "created_at ASC" },
  ).map((row) => row.role);
}

function canEnterBranch(principal, departmentId) {
  if (principal.has("department.write")) return true;
  const roles = accessRolesOf(principal, departmentId);
  if (roles.length === 0) return true;
  return principal.roles.some((role) => roles.includes(role));
}

function replaceAccessRoles(principal, departmentId, roles) {
  hardDelete("department_access", "tenant_id = ? AND org_id = ? AND department_id = ?", [
    principal.tenantId,
    principal.orgId,
    departmentId,
  ]);
  for (const role of [...new Set(roles)]) {
    insert("department_access", {
      tenant_id: principal.tenantId,
      org_id: principal.orgId,
      department_id: departmentId,
      role,
      created_by: principal.userId,
    });
  }
}

export function listRoles(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  res.json({
    items: Object.entries(ROLE_TEMPLATES)
      .filter(([key]) => key !== "platform_admin")
      .map(([key, value]) => ({ key, label: value.label, scope: value.scope })),
  });
}

export function createDepartment(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("department.write");
  const payload = departmentSchema.parse(req.body);
  assertKnownRoles(payload.access_roles ?? []);
  const department = insert("department", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    name: payload.name,
    parent_id: payload.parent_id ?? null,
    leader_id: payload.leader_id ?? null,
    created_by: principal.userId,
  });
  if (payload.access_roles?.length) {
    replaceAccessRoles(principal, department.id, payload.access_roles);
  }

  audit.record({
    tenantId: principal.tenantId,
    action: "department.created",
    resourceType: "department",
    resourceId: department.id,
    actorId: principal.userId,
    after: { name: department.name, parent_id: department.parent_id, access_roles: payload.access_roles ?? [] },
    requestId: req.requestId,
  });

  res.status(201).json({
    id: department.id,
    name: department.name,
    parent_id: department.parent_id,
    leader_id: department.leader_id,
    access_roles: payload.access_roles ?? [],
  });
}

export function setDepartmentAccess(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("department.write");
  const payload = accessSchema.parse(req.body);
  assertKnownRoles(payload.access_roles);
  const department = db()
    .prepare("SELECT * FROM department WHERE id = ? AND tenant_id = ? AND org_id = ?")
    .get(req.params.departmentId, principal.tenantId, principal.orgId);
  if (!department) throw notFound("department");

  const before = accessRolesOf(principal, department.id);
  replaceAccessRoles(principal, department.id, payload.access_roles);

  audit.record({
    tenantId: principal.tenantId,
    action: "department.access.changed",
    resourceType: "department",
    resourceId: department.id,
    actorId: principal.userId,
    before: { access_roles: before },
    after: { access_roles: payload.access_roles },
    requestId: req.requestId,
  });

  res.json({ id: department.id, access_roles: payload.access_roles });
}

export function listDepartments(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const rows = listScoped("department", principal, [], { limit: 500, orderBy: "created_at ASC" });
  const items = rows.map((d) => ({
    id: d.id,
    name: d.name,
    parent_id: d.parent_id,
    leader_id: d.leader_id,
    access_roles: accessRolesOf(principal, d.id),
    can_enter: canEnterBranch(principal, d.id),
  }));
  // 관리 권한이 없으면 들어갈 수 있는 브랜치만 보인다.
  res.json({ items: principal.has("department.write") ? items : items.filter((item) => item.can_enter) });
}

export function assertBranchAccess(principal, departmentId) {
  if (!departmentId) return;
  if (!canEnterBranch(principal, departmentId)) {
    throw new ApiError("PERMISSION_DENIED", "이 브랜치에 들어갈 권한이 없습니다", {
      department_id: departmentId,
    });
  }
}

const ORG_ACTION_LABELS = {
  "member.assignment.changed": "부서·직책 변경",
  "member.roles.changed": "역할 변경",
  "member.status.changed": "상태 변경",
  "member.provisioned": "구성원 등록",
  "member.invited": "초대 발송",
  "member.invitation.accepted": "초대 수락",
  "member.invitation.revoked": "초대 취소",
  "member.password.reset": "비밀번호 초기화",
  "department.created": "브랜치 생성",
  "department.updated": "브랜치 수정",
  "department.access.changed": "브랜치 접근 그룹 변경",
};

/** 조직도·구성원 변경 이력. 감사로그에서 조직 관련 행위만 뽑아 이름을 붙인다. */
export function activity(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const limit = Math.min(Number(req.query.limit ?? 100), 500);

  let memberFilter = "";
  const memberParams = [];
  if (req.query.member_id) {
    const membership = db()
      .prepare(
        `SELECT id FROM membership
         WHERE tenant_id = ? AND org_id = ? AND user_id = ? AND deleted_at IS NULL`,
      )
      .get(principal.tenantId, principal.orgId, req.query.member_id);
    memberFilter = " AND (resource_id = ? OR actor_id = ?)";
    memberParams.push(membership?.id ?? null, req.query.member_id);
  }

  const rows = db()
    .prepare(
      `SELECT * FROM audit_event
       WHERE tenant_id = ? AND resource_type IN ('membership','department','invitation')${memberFilter}
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(principal.tenantId, ...memberParams, limit);

  const nameOf = (userId) => {
    if (!userId) return "시스템";
    const user = db().prepare("SELECT name FROM app_user WHERE id = ?").get(userId);
    return user?.name ?? "알 수 없음";
  };
  const departmentName = (id) =>
    db().prepare("SELECT name FROM department WHERE id = ?").get(id)?.name ?? null;
  const memberName = (membershipId) => {
    const membership = db().prepare("SELECT user_id FROM membership WHERE id = ?").get(membershipId);
    return membership ? nameOf(membership.user_id) : null;
  };

  // 로그는 사람이 읽는 화면이므로 id 대신 이름으로 바꿔 내려준다.
  const readable = (payload) => {
    if (!payload || typeof payload !== "object") return payload;
    const out = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value && typeof value === "string") {
        if (key === "department_id" || key === "parent_id") {
          out[key] = departmentName(value) ?? value;
          continue;
        }
        if (key === "leader_id" || key === "substitute_id") {
          out[key] = nameOf(value);
          continue;
        }
      }
      out[key] = value;
    }
    return out;
  };

  res.json({
    items: rows.map((row) => {
      const before = readable(row.before_json ? JSON.parse(row.before_json) : null);
      const after = readable(row.after_json ? JSON.parse(row.after_json) : null);
      return {
        id: row.id,
        seq: row.seq,
        action: row.action,
        action_label: ORG_ACTION_LABELS[row.action] ?? row.action,
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        target:
          row.resource_type === "department"
            ? departmentName(row.resource_id)
            : memberName(row.resource_id),
        actor_name: nameOf(row.actor_id),
        actor_kind: row.actor_kind,
        before,
        after,
        created_at: row.created_at,
      };
    }),
  });
}

const growthSchema = z.object({
  days: z.coerce.number().int().min(7).max(1095).default(90),
});

function bucketPlan(days) {
  if (days <= 31) return { count: days, stepDays: 1, label: (d) => `${d.getMonth() + 1}/${d.getDate()}` };
  if (days <= 120) return { count: Math.ceil(days / 7), stepDays: 7, label: (d) => `${d.getMonth() + 1}/${d.getDate()}` };
  return { count: Math.ceil(days / 30), stepDays: 30, label: (d) => `${d.getFullYear() % 100}.${d.getMonth() + 1}` };
}

/** 기간에 따른 인원 변화. membership 가입·탈퇴일과 초대 상태에서 실제로 계산한다. */
export function growth(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const { days } = growthSchema.parse(req.query);

  const memberships = listScoped("membership", principal, [], { limit: 5000 });
  const invitations = db()
    .prepare("SELECT * FROM invitation WHERE tenant_id = ? AND org_id = ?")
    .all(principal.tenantId, principal.orgId);

  const plan = bucketPlan(days);
  const dayMs = 86_400_000;
  const now = Date.now();
  const joinedAt = (row) => Date.parse(row.joined_at ?? row.created_at ?? "") || 0;
  const leftAt = (row) => (row.left_at ? Date.parse(row.left_at) : null);

  const buckets = [];
  for (let index = plan.count - 1; index >= 0; index -= 1) {
    const edgeDate = new Date(now - index * plan.stepDays * dayMs);
    const edge = edgeDate.getTime();
    const windowStart = edge - plan.stepDays * dayMs;

    const joinedBy = memberships.filter((row) => joinedAt(row) > 0 && joinedAt(row) <= edge);
    const left = joinedBy.filter((row) => {
      const gone = leftAt(row);
      return gone !== null && gone <= edge;
    });
    const present = joinedBy.filter((row) => !left.includes(row));

    buckets.push({
      date: edgeDate.toISOString().slice(0, 10),
      label: plan.label(edgeDate),
      total: present.length,
      active: present.filter((row) => row.status === "active").length,
      dormant: present.filter((row) => row.status !== "active").length + left.length,
      pending: invitations.filter((invite) => {
        const created = Date.parse(invite.created_at ?? "") || 0;
        if (created > edge) return false;
        if (invite.status !== "pending") return false;
        return Date.parse(invite.expires_at ?? "") > edge;
      }).length,
      joined: joinedBy.filter((row) => joinedAt(row) > windowStart && joinedAt(row) <= edge).length,
    });
  }

  res.json({ period_days: days, step_days: plan.stepDays, buckets });
}

export function orgChart(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const departments = listScoped("department", principal, [], { limit: 500, orderBy: "created_at ASC" });
  const members = listScoped("membership", principal, [{ sql: "status = ?", params: ["active"] }], {
    limit: 1000,
  });

  const viewOf = (membership) => {
    const user = db().prepare("SELECT * FROM app_user WHERE id = ?").get(membership.user_id);
    return user ? memberView(principal, membership, user) : null;
  };

  const node = (department) => {
    const assigned = members.filter((m) => m.department_id === department.id);
    const leader = members.find((m) => m.user_id === department.leader_id);
    return {
      id: department.id,
      name: department.name,
      parent_id: department.parent_id,
      leader_id: department.leader_id,
      // 책임자가 한 번도 지정되지 않은 자리는 프론트에서 잠금 상태로 보여준다.
      configured: Boolean(department.leader_id),
      leader: leader ? viewOf(leader) : null,
      member_count: assigned.length,
      members: assigned.map(viewOf).filter(Boolean),
      children: departments.filter((d) => d.parent_id === department.id).map(node),
    };
  };

  res.json({
    roots: departments.filter((d) => !d.parent_id).map(node),
    unassigned: members.filter((m) => !m.department_id).map(viewOf).filter(Boolean),
  });
}

export function updateDepartment(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("department.write");
  const payload = departmentPatchSchema.parse(req.body);
  const department = db()
    .prepare("SELECT * FROM department WHERE id = ? AND tenant_id = ? AND org_id = ?")
    .get(req.params.departmentId, principal.tenantId, principal.orgId);
  if (!department) throw notFound("department");

  const changes = {};
  if (payload.name !== undefined) changes.name = payload.name;
  if (payload.parent_id !== undefined) changes.parent_id = payload.parent_id;
  if (payload.leader_id !== undefined) changes.leader_id = payload.leader_id;
  if (payload.parent_id === department.id) {
    throw new ApiError("VALIDATION_ERROR", "자기 자신을 상위 부서로 지정할 수 없습니다");
  }
  const updated = update("department", department.id, changes, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "department.updated",
    resourceType: "department",
    resourceId: department.id,
    actorId: principal.userId,
    before: { name: department.name, leader_id: department.leader_id, parent_id: department.parent_id },
    after: { name: updated.name, leader_id: updated.leader_id, parent_id: updated.parent_id },
    requestId: req.requestId,
  });

  res.json({
    id: updated.id,
    name: updated.name,
    parent_id: updated.parent_id,
    leader_id: updated.leader_id,
  });
}

export function setAssignment(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.write");
  const payload = assignmentSchema.parse(req.body);
  const membership = db()
    .prepare("SELECT * FROM membership WHERE id = ? AND tenant_id = ? AND org_id = ?")
    .get(req.params.membershipId, principal.tenantId, principal.orgId);
  if (!membership) throw notFound("membership");

  if (payload.department_id) {
    const department = db()
      .prepare("SELECT id FROM department WHERE id = ? AND tenant_id = ? AND org_id = ?")
      .get(payload.department_id, principal.tenantId, principal.orgId);
    if (!department) throw notFound("department");
  }

  const changes = {};
  if (payload.department_id !== undefined) changes.department_id = payload.department_id;
  if (payload.title !== undefined) changes.title = payload.title;
  const updated = bumpVersion("membership", membership, changes, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "member.assignment.changed",
    resourceType: "membership",
    resourceId: membership.id,
    actorId: principal.userId,
    before: { department_id: membership.department_id, title: membership.title },
    after: { department_id: updated.department_id, title: updated.title },
    requestId: req.requestId,
  });

  res.json({
    membership_id: updated.id,
    user_id: updated.user_id,
    department_id: updated.department_id,
    title: updated.title,
  });
}

export function getHomeLayout(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const departmentId = req.query.department_id ?? null;
  const projectId = req.query.project_id ?? null;
  const row = db()
    .prepare(
      `SELECT * FROM home_layout WHERE tenant_id = ? AND org_id = ?
       AND ifnull(department_id, '') = ifnull(?, '')
       AND ifnull(project_id, '') = ifnull(?, '') AND deleted_at IS NULL`,
    )
    .get(principal.tenantId, principal.orgId, departmentId, projectId);
  res.json({
    department_id: departmentId,
    project_id: projectId,
    blocks: row ? JSON.parse(row.blocks_json) : ["welcome", "tasks", "calendar"],
  });
}

export function putHomeLayout(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("organization.settings");
  const payload = homeLayoutSchema.parse(req.body);
  const existing = db()
    .prepare(
      `SELECT * FROM home_layout WHERE tenant_id = ? AND org_id = ?
       AND ifnull(department_id, '') = ifnull(?, '')
       AND ifnull(project_id, '') = ifnull(?, '') AND deleted_at IS NULL`,
    )
    .get(principal.tenantId, principal.orgId, payload.department_id ?? null, payload.project_id ?? null);
  const values = {
    department_id: payload.department_id ?? null,
    project_id: payload.project_id ?? null,
    blocks_json: JSON.stringify(payload.blocks),
  };
  const row = existing
    ? update("home_layout", existing.id, values, principal.userId)
    : insert("home_layout", {
        tenant_id: principal.tenantId,
        org_id: principal.orgId,
        ...values,
        created_by: principal.userId,
      });
  res.json({ id: row.id, ...values, blocks: payload.blocks });
}
