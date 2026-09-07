import { z } from "zod";

import { db, transaction } from "../config/db.js";
import { env } from "../config/env.js";
import { pgQuery } from "../config/pg.js";
import { currentUser, resolvePrincipal } from "../middleware/auth.js";
import { enabledSet } from "../middleware/modules.js";
import { insert, newId, nowIso, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { hashPassword, newToken, tokenFingerprint, verifyPassword } from "../utils/crypto.js";
import { ApiError } from "../utils/errors.js";

const signupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  password: z.string().min(8).max(200),
  invitation_token: z.string().optional().nullable(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const passwordSchema = z.object({
  current_password: z.string(),
  new_password: z.string().min(8).max(200),
});

function issueSession(user, req) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + env.sessionTtlSeconds * 1000).toISOString();
  db()
    .prepare(
      `INSERT INTO session_token (id, user_id, fingerprint, expires_at, revoked_at, ip, device, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(newId(), user.id, tokenFingerprint(token), expiresAt, req.ip ?? null, req.get("user-agent") ?? null, nowIso());
  return token;
}

function revokeAllSessions(userId) {
  db()
    .prepare("UPDATE session_token SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .run(nowIso(), userId);
}

const createSignup = transaction((payload, email, req) => {
  let invite = null;
  if (payload.invitation_token) {
    invite = db().prepare("SELECT * FROM invitation WHERE token = ?").get(payload.invitation_token);
    if (!invite || invite.status !== "pending") {
      throw new ApiError("VALIDATION_ERROR", "invitation is invalid or already used");
    }
    if (invite.expires_at < nowIso()) throw new ApiError("VALIDATION_ERROR", "invitation expired");
    if (invite.email.toLowerCase() !== email) {
      throw new ApiError("VALIDATION_ERROR", "invitation email mismatch");
    }
  }
  const user = insert("app_user", {
    id: newId(),
    email,
    name: payload.name,
    password_hash: hashPassword(payload.password),
    created_at: nowIso(),
  });

  if (invite) {
    insert("membership", {
      tenant_id: invite.tenant_id,
      user_id: user.id,
      org_id: invite.org_id,
      roles: invite.roles,
      status: "active",
      joined_at: nowIso(),
      created_by: user.id,
    });
    update("invitation", invite.id, { status: "accepted" });
    audit.record({
      tenantId: invite.tenant_id,
      action: "member.invitation.accepted",
      resourceType: "membership",
      resourceId: user.id,
      actorId: user.id,
      requestId: req.requestId,
    });
  }

  return { user, joinedOrg: invite?.org_id ?? null, token: issueSession(user, req) };
});

export function signup(req, res) {
  const payload = signupSchema.parse(req.body);
  const email = payload.email.trim().toLowerCase();

  if (db().prepare("SELECT id FROM app_user WHERE email = ?").get(email)) {
    throw new ApiError("CONFLICT", "email already registered");
  }

  const { user, joinedOrg, token } = createSignup(payload, email, req);

  res.status(201).json({
    user: { id: user.id, email: user.email, name: user.name },
    access_token: token,
    org_id: joinedOrg,
  });
}

export function login(req, res) {
  const payload = loginSchema.parse(req.body);
  const email = payload.email.trim().toLowerCase();
  const user = db().prepare("SELECT * FROM app_user WHERE email = ?").get(email);
  if (!user) throw new ApiError("UNAUTHENTICATED", "invalid credentials");

  if (user.locked_until && user.locked_until > nowIso()) {
    throw new ApiError("RATE_LIMITED", "account temporarily locked after repeated failures");
  }

  if (!verifyPassword(payload.password, user.password_hash)) {
    const failures = (user.failed_logins ?? 0) + 1;
    if (failures >= env.maxLoginFailures) {
      update("app_user", user.id, {
        failed_logins: 0,
        locked_until: new Date(Date.now() + env.loginLockSeconds * 1000).toISOString(),
      });
    } else {
      update("app_user", user.id, { failed_logins: failures });
    }
    throw new ApiError("UNAUTHENTICATED", "invalid credentials");
  }

  update("app_user", user.id, { failed_logins: 0, locked_until: null });
  res.json({
    access_token: issueSession(user, req),
    token_type: "bearer",
    must_change_password: Boolean(user.must_change_password),
    user: { id: user.id, email: user.email, name: user.name },
  });
}

export async function logout(req, res) {
  currentUser(req);
  if (req.authSource === "perp_db") {
    await pgQuery(
      "UPDATE auth.sessions SET is_active = false, logout_at = now() WHERE id = $1 AND is_active = true",
      [req.sessionId],
    );
  } else {
    db().prepare("UPDATE session_token SET revoked_at = ? WHERE id = ?").run(nowIso(), req.sessionId);
  }
  res.json({ revoked: true });
}

export async function revokeAll(req, res) {
  const user = currentUser(req);
  if (req.authSource === "perp_db") {
    await pgQuery(
      "UPDATE auth.sessions SET is_active = false, logout_at = now() WHERE user_id = $1 AND is_active = true",
      [req.externalIdentity.subject],
    );
  } else {
    revokeAllSessions(user.id);
  }
  res.json({ revoked_all: true });
}

export function changePassword(req, res) {
  const payload = passwordSchema.parse(req.body);
  const user = currentUser(req);

  if (!verifyPassword(payload.current_password, user.password_hash)) {
    throw new ApiError("UNAUTHENTICATED", "current password mismatch");
  }
  if (payload.new_password === payload.current_password) {
    throw new ApiError("VALIDATION_ERROR", "새 비밀번호는 기존(임시) 비밀번호와 달라야 합니다");
  }

  update("app_user", user.id, {
    password_hash: hashPassword(payload.new_password),
    must_change_password: 0,
  });
  revokeAllSessions(user.id);
  res.json({ changed: true, sessions_revoked: true, must_change_password: false });
}

const invitationTokenSchema = z.object({ token: z.string().min(1).max(500) });
const acceptInvitationSchema = z
  .object({
    token: z.string().min(1).max(500).optional(),
    invitation_id: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.token || value.invitation_id), {
    message: "token 또는 invitation_id가 필요합니다",
  });

// 초대 링크 전체를 붙여넣어도 되도록 URL에서 토큰만 뽑아낸다.
function extractInvitationToken(raw) {
  const value = raw.trim();
  const match = /[?&](?:invite|token|invitation_token)=([^&#\s]+)/.exec(value);
  if (match?.[1]) return decodeURIComponent(match[1]);
  const tail = /([^/?&#\s]+)\s*$/.exec(value);
  return tail?.[1] ? decodeURIComponent(tail[1]) : value;
}

function invitationView(invite) {
  const org = db().prepare("SELECT * FROM organization WHERE id = ?").get(invite.org_id);
  return {
    invitation_id: invite.id,
    email: invite.email,
    org_id: invite.org_id,
    org_name: org?.name ?? invite.org_id,
    org_type: org?.type ?? null,
    roles: (invite.roles ?? "").split(",").filter(Boolean),
    status: invite.status,
    expires_at: invite.expires_at,
  };
}

// 확인 전용: 비밀 토큰이 살아있는지와 대상 조직을 알려준다.
function inspectInvitation(token, email) {
  const invite = db().prepare("SELECT * FROM invitation WHERE token = ?").get(token);
  if (!invite) return { valid: false, reason: "not_found", message: "초대를 찾을 수 없습니다. 링크를 다시 확인하세요." };
  if (invite.status !== "pending") {
    return { valid: false, reason: invite.status, message: `이미 처리된 초대입니다: ${invite.status}`, invitation: invitationView(invite) };
  }
  if (invite.expires_at < nowIso()) {
    return { valid: false, reason: "expired", message: "초대 유효기간이 지났습니다.", invitation: invitationView(invite) };
  }
  if (email && invite.email.toLowerCase() !== email.toLowerCase()) {
    return {
      valid: false,
      reason: "email_mismatch",
      message: `이 초대는 ${invite.email} 주소로 발송되었습니다.`,
      invitation: invitationView(invite),
    };
  }
  return { valid: true, reason: "ok", message: "사용할 수 있는 초대입니다.", invitation: invitationView(invite) };
}

export function listMyInvitations(req, res) {
  const user = currentUser(req);
  // 계정 이메일은 아직 검증되지 않았으므로 이메일 주소만으로 초대를 공개하지 않는다.
  res.json({ email: user.email, items: [] });
}

export function verifyInvitation(req, res) {
  const payload = invitationTokenSchema.parse(req.body);
  currentUser(req);
  res.json(inspectInvitation(extractInvitationToken(payload.token)));
}

const joinByInvitation = transaction((invite, user, requestId) => {
  const check = inspectInvitation(invite.token, user.email);
  if (!check.valid) throw new ApiError("VALIDATION_ERROR", check.message, { reason: check.reason });

  const already = db()
    .prepare("SELECT id FROM membership WHERE user_id = ? AND org_id = ? AND deleted_at IS NULL")
    .get(user.id, invite.org_id);
  if (already) throw new ApiError("CONFLICT", "이미 이 조직의 구성원입니다");

  insert("membership", {
    tenant_id: invite.tenant_id,
    user_id: user.id,
    org_id: invite.org_id,
    roles: invite.roles,
    status: "active",
    joined_at: nowIso(),
    created_by: user.id,
  });
  update("invitation", invite.id, { status: "accepted" });
  audit.record({
    tenantId: invite.tenant_id,
    action: "member.invitation.accepted",
    resourceType: "membership",
    resourceId: user.id,
    actorId: user.id,
    requestId,
  });
});

export function acceptInvitation(req, res) {
  const payload = acceptInvitationSchema.parse(req.body);
  const user = currentUser(req);

  if (payload.invitation_id) throw new ApiError("VALIDATION_ERROR", "초대 토큰이 필요합니다");
  const invite = db()
    .prepare("SELECT * FROM invitation WHERE token = ?")
    .get(extractInvitationToken(payload.token ?? ""));
  if (!invite) throw new ApiError("NOT_FOUND", "초대를 찾을 수 없습니다");

  joinByInvitation(invite, user, req.requestId);

  res.status(201).json({ joined: true, ...invitationView({ ...invite, status: "accepted" }) });
}

export function me(req, res) {
  const user = currentUser(req);
  const memberships = db()
    .prepare(
      `SELECT m.* FROM membership m
       JOIN organization o ON o.id = m.org_id AND o.tenant_id = m.tenant_id
       JOIN tenant t ON t.id = o.tenant_id
       WHERE m.user_id = ? AND m.status = 'active' AND m.deleted_at IS NULL
         AND o.deleted_at IS NULL AND t.status = 'active'`,
    )
    .all(user.id);

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    locale: user.locale,
    timezone: user.timezone,
    must_change_password: Boolean(user.must_change_password),
    organizations: memberships.map((m) => {
      const org = db().prepare("SELECT * FROM organization WHERE id = ?").get(m.org_id);
      return {
        org_id: m.org_id,
        org_name: org?.name ?? m.org_id,
        org_type: org?.type ?? null,
        roles: (m.roles ?? "").split(",").filter(Boolean),
        department_id: m.department_id,
      };
    }),
  });
}

export function principal(req, res) {
  if (!req.get("x-org-id")) {
    throw new ApiError("VALIDATION_ERROR", "X-Org-Id 헤더가 필요합니다");
  }
  const resolved = resolvePrincipal(req);
  res.json({
    userId: resolved.userId,
    tenantId: resolved.tenantId,
    orgId: resolved.orgId,
    membershipId: resolved.membershipId,
    roles: resolved.roles,
    permissions: [...resolved.permissions].sort(),
    modules: [...enabledSet(req.organization.modules)].sort(),
  });
}
