import { z } from "zod";

import { db } from "../config/db.js";
import {
  MASKED_FIELDS,
  ROLE_TEMPLATES,
  permissionsFor,
  widestScope,
} from "../config/rbac.js";
import { resolvePrincipal } from "../middleware/auth.js";
import { bumpVersion, insert, listScoped, newId, nowIso, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
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
});

function assertKnownRoles(roles) {
  for (const role of roles) {
    if (!(role in ROLE_TEMPLATES)) {
      throw new ApiError("VALIDATION_ERROR", `unknown role: ${role}`);
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
  assertKnownRoles(payload.roles);

  const existing = db()
    .prepare(
      `SELECT id FROM invitation
       WHERE tenant_id = ? AND org_id = ? AND email = ? AND status = 'pending' AND deleted_at IS NULL`,
    )
    .get(principal.tenantId, principal.orgId, payload.email);
  if (existing) throw new ApiError("CONFLICT", "a pending invitation already exists for this email");

  const invitation = insert("invitation", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    email: payload.email,
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
    after: { email: payload.email, roles: payload.roles },
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
  assertKnownRoles(payload.roles);

  const email = payload.email.trim().toLowerCase();
  const temporary = temporaryPassword();
  let user = db().prepare("SELECT * FROM app_user WHERE email = ?").get(email);

  if (!user) {
    user = insert("app_user", {
      id: newId(),
      email,
      name: payload.name,
      password_hash: hashPassword(temporary),
      must_change_password: 1,
      created_at: nowIso(),
    });
  } else {
    const active = db()
      .prepare(
        `SELECT * FROM membership
         WHERE tenant_id = ? AND org_id = ? AND user_id = ? AND deleted_at IS NULL`,
      )
      .get(principal.tenantId, principal.orgId, user.id);
    if (active && active.status === "active") {
      throw new ApiError("CONFLICT", "이미 이 조직에 등록된 이메일입니다");
    }
    user = update("app_user", user.id, {
      password_hash: hashPassword(temporary),
      must_change_password: 1,
      failed_logins: 0,
      locked_until: null,
    });
  }

  let membership = db()
    .prepare("SELECT * FROM membership WHERE tenant_id = ? AND org_id = ? AND user_id = ?")
    .get(principal.tenantId, principal.orgId, user.id);
  if (!membership) {
    membership = insert("membership", {
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
  } else {
    membership = update(
      "membership",
      membership.id,
      {
        roles: payload.roles.join(","),
        status: "active",
        department_id: payload.department_id ?? null,
        title: payload.title ?? null,
      },
      principal.userId,
    );
  }

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
  const membership = db()
    .prepare("SELECT * FROM membership WHERE id = ? AND tenant_id = ? AND org_id = ?")
    .get(req.params.membershipId, principal.tenantId, principal.orgId);
  if (!membership) throw notFound("membership");
  const user = db().prepare("SELECT * FROM app_user WHERE id = ?").get(membership.user_id);
  if (!user) throw notFound("user");

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
  principal.require("role.assign");
  const payload = rolesSchema.parse(req.body);
  assertKnownRoles(payload.roles);

  const membership = db()
    .prepare("SELECT * FROM membership WHERE id = ? AND tenant_id = ? AND org_id = ?")
    .get(req.params.membershipId, principal.tenantId, principal.orgId);
  if (!membership) throw notFound("membership");

  const before = (membership.roles ?? "").split(",").filter(Boolean);
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

export function createDepartment(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("department.write");
  const payload = departmentSchema.parse(req.body);
  const department = insert("department", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    name: payload.name,
    parent_id: payload.parent_id ?? null,
    leader_id: payload.leader_id ?? null,
    created_by: principal.userId,
  });
  res.status(201).json({ id: department.id, name: department.name, parent_id: department.parent_id });
}

export function listDepartments(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const rows = listScoped("department", principal, [], { limit: 500, orderBy: "created_at ASC" });
  res.json({
    items: rows.map((d) => ({
      id: d.id,
      name: d.name,
      parent_id: d.parent_id,
      leader_id: d.leader_id,
    })),
  });
}

export function orgChart(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");
  const departments = listScoped("department", principal, [], { limit: 500, orderBy: "created_at ASC" });
  const members = listScoped("membership", principal, [{ sql: "status = ?", params: ["active"] }], {
    limit: 1000,
  });

  const node = (department) => ({
    id: department.id,
    name: department.name,
    leader_id: department.leader_id,
    member_count: members.filter((m) => m.department_id === department.id).length,
    children: departments.filter((d) => d.parent_id === department.id).map(node),
  });

  res.json({ roots: departments.filter((d) => !d.parent_id).map(node) });
}
