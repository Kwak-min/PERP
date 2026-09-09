import { pgQuery } from "../config/pg.js";
import { CORE_MODULES } from "../config/modules.js";
import { COMPANY_PERMISSIONS } from '../config/rbac.js';
import { ApiError } from "../utils/errors.js";
import { effectivePgPermissions, menuForApi } from '../config/menu-permissions.js';

// PG 신원/회사는 운영 SQLite membership과 별개의 권한 경계다.
export function pgIdentity(req) {
  if (req.authSource !== "perp_db" || !req.externalIdentity) {
    throw new ApiError("UNAUTHENTICATED", "유효한 perp_db 세션이 필요합니다");
  }
  const identity = req.externalIdentity;
  return { userId: identity.subject, companyId: req.pgCompanyPrincipal?.companyId ?? identity.companyId };
}

export function pgMembershipError(error) {
  return error?.code === "42P01"
    ? new ApiError("SERVICE_UNAVAILABLE", "PG 회사 소속 스키마가 없습니다. perp_additions_v5.sql 적용 상태를 확인하세요.")
    : error;
}

async function membershipsOf(userId, companyId = null) {
  try {
    return (await pgQuery(`SELECT m.company_id, m.user_id, m.department_id, m.position_id, c.name,
      to_jsonb(c)->>'organization_type' AS organization_type
      FROM org.company_memberships m JOIN org.companies c ON c.id = m.company_id
      WHERE m.user_id = $1 AND m.status = 'active' AND c.is_active = true
      ${companyId ? "AND m.company_id = $2" : ""}
      ORDER BY m.created_at, m.company_id`, companyId ? [userId, companyId] : [userId])).rows;
  } catch (error) { throw pgMembershipError(error); }
}

async function workspaceOf(userId, membership) {
  const companyId = String(membership.company_id);
  const [grants, modules] = await Promise.all([
    pgQuery(`SELECT DISTINCT p.code, r.name AS role
      FROM org.user_roles ur
      JOIN org.roles r ON r.id = ur.role_id AND r.company_id = $2 AND r.deleted_at IS NULL
      JOIN org.role_permissions rp ON rp.role_id = r.id
      JOIN org.permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = $1 AND ur.workspace_id IS NULL`, [userId, companyId]),
    pgQuery("SELECT module_key FROM org.company_modules WHERE company_id = $1", [companyId]),
  ]);
  return { org_id: `pg:${companyId}`, org_name: membership.name, org_type: membership.organization_type === 'personal' ? 'personal' : 'perp_db',
    roles: [...new Set(grants.rows.map(row => row.role))],
    permissions: [...new Set(grants.rows.map(row => row.code).filter(code => code && code !== '*' && code !== 'menu.configured' && !code.startsWith('platform.')))],
    menu_permissions: effectivePgPermissions(grants.rows).filter(code => code.startsWith('menu.')),
    modules: [...new Set([...CORE_MODULES, ...modules.rows.map(row => row.module_key)])] };
}

export async function pgWorkspaces(req) {
  const { userId } = pgIdentity(req);
  const memberships = await membershipsOf(userId);
  return Promise.all(memberships.map(membership => workspaceOf(userId, membership)));
}

export async function resolvePgCompanyPrincipal(req) {
  const { userId } = pgIdentity(req);
  if (req.pgCompanyPrincipal) return req.pgCompanyPrincipal;
  const selected = req.get("x-org-id");
  if (!selected) throw new ApiError("VALIDATION_ERROR", "X-Org-Id 헤더가 필요합니다");
  if (!/^pg:[1-9]\d*$/.test(selected)) throw new ApiError("PERMISSION_DENIED", "유효한 PG 회사를 선택하세요");
  const companyId = selected.slice(3);
  const membership = (await membershipsOf(userId, companyId))[0];
  if (!membership) throw new ApiError("PERMISSION_DENIED", "선택한 PG 회사의 활성 소속이 없습니다");
  const workspace = await workspaceOf(userId, membership);
  req.pgCompanyWorkspace = workspace;
  req.pgCompanyPrincipal = {
    source: "perp_db", userId, companyId, orgId: workspace.org_id,
    membership: { userId, companyId, departmentId: membership.department_id == null ? null : String(membership.department_id),
      positionId: membership.position_id == null ? null : String(membership.position_id) },
    roles: workspace.roles, permissions: workspace.permissions, menus: workspace.menu_permissions, modules: workspace.modules, scope: 'all',
    has(code) { return this.permissions.includes(code) || this.menus.includes(code); },
    require(code) { if (!this.has(code)) throw new ApiError("PERMISSION_DENIED", "이 PG 작업의 명시적 권한이 없습니다"); },
  };
  const menu = menuForApi(req);
  if (menu) req.pgCompanyPrincipal.require(menu);
  return req.pgCompanyPrincipal;
}

export async function pgWorkspace(req) {
  await resolvePgCompanyPrincipal(req);
  return req.pgCompanyWorkspace;
}

// 회사 생성 트랜잭션에서만 부여하는 유한 권한 집합. 기존 is_admin을 이 목록으로 승격하지 않는다.
export const PG_CREATOR_PERMISSIONS = COMPANY_PERMISSIONS;

const RECORD_ACCESS = {
  projects: ["project", "projects"], tasks: ["task", "tasks"], documents: ["document", "documents"],
  calendar: ["event", "calendar"], assets: ["asset", "assets"], budgets: ["budget", "finance"],
  dues: ["dues", "finance"], transactions: ["transaction", "finance"],
  settlements: ["transaction", "finance"], approvals: ["approval", "approvals"],
};
export function pgRecordRoute(handler) {
  return (req, res) => {
    const resource = req.params.resource;
    if (!Object.hasOwn(RECORD_ACCESS, resource)) throw new ApiError("VALIDATION_ERROR", "지원하지 않는 리소스입니다");
    const [domain, module] = RECORD_ACCESS[resource];
    const permission = domain === "approval" ? "approval.decide" : `${domain}.${req.method === "GET" ? "read" : "write"}`;
    return pgRoute(handler, permission, module)(req, res);
  };
}

export function pgRoute(handler, permission = null, module = null) {
  return async (req, res) => {
    pgIdentity(req);
    if (req.get("x-org-id") || permission) await resolvePgCompanyPrincipal(req);
    if (permission) {
      const workspace = await pgWorkspace(req);
      const required = Array.isArray(permission) ? permission : [permission];
      if (!required.every(code => workspace.permissions.includes(code))) {
        throw new ApiError("PERMISSION_DENIED", "이 PG 작업의 명시적 권한이 없습니다");
      }
      if (module && !workspace.modules.includes(module)) {
        throw new ApiError("MODULE_DISABLED", "이 회사에서 모듈이 비활성화되어 있습니다");
      }
    }
    return handler(req, res);
  };
}
