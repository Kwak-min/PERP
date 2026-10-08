import { pgQuery } from "../config/pg.js";
import { db, transaction } from "../config/db.js";
import { env } from "../config/env.js";
import { insert, newId, nowIso } from "../models/base.js";
import { hashPassword, newToken } from "../utils/crypto.js";

// perp_db(PostgreSQL) 세션 브리지.
// 라우트 앞단에서 Bearer 토큰이 perp_db 세션(UUID)이면 미리 해석해
// req.appUser 를 심어둔다. resolvePrincipal 은 이 운영 사용자에게 연결된 실제
// SQLite 소속을 다시 조회하므로 외부 회사/관리자 값이 권한으로 승격되지 않는다.
//
// 토큰이 UUID 가 아니거나(레거시 base64url 토큰) perp_db 세션이 아니면
// 아무것도 하지 않고 통과시켜 기존 SQLite 인증 경로가 처리하게 둔다.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const operationalUserFor = transaction((row) => {
  const existing = db()
    .prepare("SELECT user_id FROM auth_identity WHERE provider = ? AND subject = ?")
    .get("perp_db", String(row.id));
  if (existing) return db().prepare("SELECT * FROM app_user WHERE id = ?").get(existing.user_id);

  // 외부 이메일은 소유 확인 수단이 아니므로 기존 계정과 합치지 않는다.
  const user = insert("app_user", {
    id: newId(),
    email: `perp-db-${row.id}@identity.invalid`,
    name: row.name,
    password_hash: hashPassword(newToken()),
    created_at: nowIso(),
  });
  db()
    .prepare("INSERT INTO auth_identity (id, provider, subject, user_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(newId(), "perp_db", String(row.id), user.id, nowIso());
  return user;
});

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
              u.account_status, u.approval_status, s.login_at
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
    const loginAt = new Date(row.login_at).getTime();
    if (!Number.isFinite(loginAt) || loginAt + env.sessionTtlSeconds * 1000 <= Date.now()) {
      return next();
    }

    const operationalUser = operationalUserFor(row);
    if (!operationalUser || operationalUser.auth_status !== "active") return next();
    req.appUser = {
      ...operationalUser,
      email: row.email,
      name: row.name,
    };
    req.sessionId = String(row.session_id);
    req.authSource = "perp_db";
    req.externalIdentity = { provider: "perp_db", subject: String(row.id), companyId: row.company_id == null ? null : String(row.company_id) };
    return next();
  } catch (error) {
    return next(error);
  }
}
