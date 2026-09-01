import { db } from "../config/db.js";
import { permissionsFor, widestScope } from "../config/rbac.js";
import { ApiError } from "../utils/errors.js";
import { tokenFingerprint } from "../utils/crypto.js";

function bearer(req) {
  const header = req.get("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    throw new ApiError("UNAUTHENTICATED", "missing bearer token");
  }
  return header.slice(7).trim();
}

export function currentUser(req) {
  if (req.appUser) return req.appUser;
  const token = bearer(req);
  const session = db()
    .prepare("SELECT * FROM session_token WHERE fingerprint = ?")
    .get(tokenFingerprint(token));
  if (!session || session.revoked_at || session.expires_at < new Date().toISOString()) {
    throw new ApiError("UNAUTHENTICATED", "invalid or expired session");
  }
  const user = db().prepare("SELECT * FROM app_user WHERE id = ?").get(session.user_id);
  if (!user || user.auth_status !== "active") {
    throw new ApiError("UNAUTHENTICATED", "inactive user");
  }
  req.appUser = user;
  req.sessionId = session.id;
  return user;
}

export function requireUser(req, _res, next) {
  currentUser(req);
  next();
}

export function resolvePrincipal(req) {
  if (req.principal) return req.principal;
  const user = currentUser(req);

  if (user.must_change_password) {
    throw new ApiError("PASSWORD_CHANGE_REQUIRED", "임시 비밀번호입니다. 먼저 비밀번호를 변경하세요.");
  }

  const memberships = db()
    .prepare("SELECT * FROM membership WHERE user_id = ? AND status = 'active' AND deleted_at IS NULL")
    .all(user.id);
  if (memberships.length === 0) {
    throw new ApiError(
      "NO_ORGANIZATION",
      "소속된 조직이 없습니다. 조직을 만들거나 관리자에게 등록을 요청하세요.",
    );
  }

  const requestedOrg = req.get("x-org-id");
  const membership = requestedOrg
    ? memberships.find((m) => m.org_id === requestedOrg)
    : memberships[0];
  if (!membership) {
    throw new ApiError("PERMISSION_DENIED", "not a member of the requested organization");
  }

  const org = db().prepare("SELECT * FROM organization WHERE id = ?").get(membership.org_id);
  if (!org) throw new ApiError("NOT_FOUND", "organization not found");

  const roles = (membership.roles ?? "").split(",").filter(Boolean);
  const permissions = permissionsFor(roles);

  req.organization = org;
  req.principal = {
    userId: user.id,
    tenantId: org.tenant_id,
    orgId: org.id,
    membershipId: membership.id,
    sessionId: req.sessionId ?? null,
    roles,
    permissions,
    departmentIds: membership.department_id ? [membership.department_id] : [],
    scope: widestScope(roles),
    has(permission) {
      return permissions.has("*") || permissions.has(permission);
    },
    require(permission) {
      if (!this.has(permission)) {
        throw new ApiError("PERMISSION_DENIED", `permission denied: ${permission}`);
      }
    },
  };
  return req.principal;
}

export function requirePrincipal(req, _res, next) {
  resolvePrincipal(req);
  next();
}

export function requirePermission(permission) {
  return (req, _res, next) => {
    resolvePrincipal(req).require(permission);
    next();
  };
}
