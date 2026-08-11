import { z } from "zod";

import { db } from "../config/db.js";
import { env } from "../config/env.js";
import { currentUser } from "../middleware/auth.js";
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

export function signup(req, res) {
  const payload = signupSchema.parse(req.body);
  const email = payload.email.trim().toLowerCase();

  if (db().prepare("SELECT id FROM app_user WHERE email = ?").get(email)) {
    throw new ApiError("CONFLICT", "email already registered");
  }

  const user = insert("app_user", {
    id: newId(),
    email,
    name: payload.name,
    password_hash: hashPassword(payload.password),
    created_at: nowIso(),
  });

  let joinedOrg = null;
  if (payload.invitation_token) {
    const invite = db()
      .prepare("SELECT * FROM invitation WHERE token = ?")
      .get(payload.invitation_token);
    if (!invite || invite.status !== "pending") {
      throw new ApiError("VALIDATION_ERROR", "invitation is invalid or already used");
    }
    if (invite.expires_at < nowIso()) {
      throw new ApiError("VALIDATION_ERROR", "invitation expired");
    }
    if (invite.email.toLowerCase() !== email) {
      throw new ApiError("VALIDATION_ERROR", "invitation email mismatch");
    }
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
    joinedOrg = invite.org_id;
    audit.record({
      tenantId: invite.tenant_id,
      action: "member.invitation.accepted",
      resourceType: "membership",
      resourceId: user.id,
      actorId: user.id,
      requestId: req.requestId,
    });
  }

  res.status(201).json({
    user: { id: user.id, email: user.email, name: user.name },
    access_token: issueSession(user, req),
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

export function logout(req, res) {
  currentUser(req);
  db().prepare("UPDATE session_token SET revoked_at = ? WHERE id = ?").run(nowIso(), req.sessionId);
  res.json({ revoked: true });
}

export function revokeAll(req, res) {
  const user = currentUser(req);
  revokeAllSessions(user.id);
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

export function me(req, res) {
  const user = currentUser(req);
  const memberships = db()
    .prepare("SELECT * FROM membership WHERE user_id = ? AND status = 'active' AND deleted_at IS NULL")
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
