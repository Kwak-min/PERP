import { pgQuery } from "../config/pg.js";
import { ApiError } from "../utils/errors.js";

// perp_db(PostgreSQL) 세션 브리지.
// 라우트 앞단에서 Bearer 토큰이 perp_db 세션(UUID)이면 미리 해석해
// req.appUser / req.principal 을 심어둔다. 레거시 미들웨어(currentUser/
// resolvePrincipal)는 이 값이 있으면 그대로 통과하므로, 기존 SQLite 라우트도
// pg 로그인 세션을 인정하게 된다. (strangler-fig: 인증부터 perp_db 로 일원화)
//
// 토큰이 UUID 가 아니거나(레거시 base64url 토큰) perp_db 세션이 아니면
// 아무것도 하지 않고 통과시켜 기존 SQLite 인증 경로가 처리하게 둔다.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function pgAuthBridge(req, _res, next) {
  try {
    const header = req.get("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    const token = match ? match[1].trim() : null;
    // pg 토큰(UUID) 아니면 레거시 경로로.
    if (!token || !UUID_RE.test(token)) return next();

    const { rows } = await pgQuery(
      `SELECT s.id AS session_id,
              u.id, u.email, u.name, u.is_admin,
              u.company_id, u.department_id, u.position_id,
              u.account_status, u.approval_status
         FROM auth.sessions s
         JOIN auth.users u ON u.id = s.user_id
        WHERE s.session_token = $1 AND s.is_active = true`,
      [token],
    );
    const row = rows[0];
    // 알 수 없는/비활성 pg 토큰이면 손대지 않고 통과 → 레거시가 거절.
    if (!row) return next();
    if (row.approval_status !== "approved" || row.account_status !== "active") {
      return next();
    }

    // 레거시 currentUser 가 읽는 최소 필드 형태로 사용자 부착.
    req.appUser = {
      id: String(row.id),
      email: row.email,
      name: row.name,
      auth_status: "active",
      must_change_password: 0,
      is_admin: Boolean(row.is_admin),
    };
    req.sessionId = String(row.session_id);

    // 모듈 게이팅: perp_db org.company_modules 에 켜진 모듈을 레거시
    // requireModule 이 읽는 req.organization.modules 형태로 부착한다.
    // (회사가 없으면 코어 모듈만 통과)
    let modules = "";
    if (row.company_id != null) {
      const mod = await pgQuery(
        "SELECT module_key FROM org.company_modules WHERE company_id = $1",
        [row.company_id],
      );
      modules = mod.rows.map((r) => r.module_key).join(",");
    }
    req.organization = { id: row.company_id != null ? String(row.company_id) : null, modules };

    // 브리지 단계: pg 인증 사용자에게 전권(*) 부여.
    // (모듈별 데이터가 perp_db 로 이관되면 실제 RBAC 로 대체 예정)
    const permissions = new Set(["*"]);
    req.principal = {
      userId: String(row.id),
      tenantId: `pg:${row.company_id ?? "none"}`,
      orgId: row.company_id ? String(row.company_id) : null,
      membershipId: null,
      sessionId: String(row.session_id),
      roles: row.is_admin ? ["admin"] : ["member"],
      permissions,
      departmentIds: row.department_id ? [String(row.department_id)] : [],
      scope: "company",
      source: "perp_db",
      has(permission) {
        return permissions.has("*") || permissions.has(permission);
      },
      require(permission) {
        if (!this.has(permission)) {
          throw new ApiError("PERMISSION_DENIED", `permission denied: ${permission}`);
        }
      },
    };
    return next();
  } catch (error) {
    return next(error);
  }
}
