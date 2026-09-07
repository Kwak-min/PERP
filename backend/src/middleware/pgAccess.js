import { pgQuery } from "../config/pg.js";
import { CORE_MODULES } from "../config/modules.js";
import { ApiError } from "../utils/errors.js";

// PG 신원/회사는 운영 SQLite membership과 별개의 권한 경계다.
export function pgIdentity(req) {
  if (req.authSource !== "perp_db" || !req.externalIdentity) {
    throw new ApiError("UNAUTHENTICATED", "유효한 perp_db 세션이 필요합니다");
  }
  const identity = req.externalIdentity;
  return { userId: identity.subject, companyId: identity.companyId };
}

export async function pgWorkspace(req) {
  const { userId, companyId } = pgIdentity(req);
  if (!companyId) throw new ApiError("NO_ORGANIZATION", "PG 회사 소속이 없습니다");
  const [grants, modules, company] = await Promise.all([
    pgQuery(`SELECT DISTINCT p.code, r.name AS role
      FROM org.user_roles ur
      JOIN org.roles r ON r.id = ur.role_id AND r.company_id = $2
      JOIN org.role_permissions rp ON rp.role_id = r.id
      JOIN org.permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = $1 AND ur.workspace_id IS NULL`, [userId, companyId]),
    pgQuery("SELECT module_key FROM org.company_modules WHERE company_id = $1", [companyId]),
    pgQuery("SELECT name FROM org.companies WHERE id = $1", [companyId]),
  ]);
  if (!company.rows[0]) throw new ApiError("NO_ORGANIZATION", "PG 회사를 찾을 수 없습니다");
  return { org_id: `pg:${companyId}`, org_name: company.rows[0].name, org_type: "perp_db",
    roles: [...new Set(grants.rows.map(row => row.role))],
    permissions: [...new Set(grants.rows.map(row => row.code).filter(code => code !== "*" && !code.startsWith("platform.")))],
    modules: [...new Set([...CORE_MODULES, ...modules.rows.map(row => row.module_key)])] };
}

// 회사 생성 트랜잭션에서만 부여하는 유한 권한 집합. 기존 is_admin을 이 목록으로 승격하지 않는다.
export const PG_CREATOR_PERMISSIONS = [
  "member.read", "member.write", "role.assign", "department.write", "audit.read", "organization.settings",
  "project.read", "project.write", "task.read", "task.write", "document.read", "document.write",
  "event.read", "event.write", "approval.decide", "approval.request", "transaction.read", "transaction.write",
  "budget.read", "budget.write", "dues.read", "dues.write", "settlement.create", "asset.read", "asset.write",
  "notification.read", "agent.chat", "agent.policy.manage", "automation.manage", "attendance.read", "attendance.write",
  "leave.approve", "recruitment.manage",
];

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
    const { companyId } = pgIdentity(req);
    const selected = req.get("x-org-id");
    if (selected && selected !== `pg:${companyId}`) {
      throw new ApiError("PERMISSION_DENIED", "선택한 조직은 이 PG 회사가 아닙니다");
    }
    if (permission) {
      if (!selected) throw new ApiError("VALIDATION_ERROR", "X-Org-Id 헤더가 필요합니다");
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
