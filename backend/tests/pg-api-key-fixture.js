import { randomUUID } from "node:crypto";

// HTTP/인증/권한/암호화는 실제 코드로 실행하고 PG SQL 경계만 통제한다.
export async function installPgKeyFixture() {
  const { pgPool } = await import("../src/config/pg.js");
  const originalQuery = pgPool.query;
  const sessions = new Map();
  const users = new Map();
  const modules = new Map();
  const companies = new Map();
  const memberships = new Map();
  const grants = new Map();
  const scopeKey = (userId, companyId) => JSON.stringify([userId, companyId]);
  const queries = [];
  pgPool.query = async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.includes("FROM auth.sessions s")) {
      const session = sessions.get(values[0]);
      return { rows: session?.active ? [{ ...users.get(session.subject), ...session }] : [] };
    }
    if (sql.includes("FROM org.company_memberships m JOIN org.companies c")) {
      return { rows: [...memberships.values()]
        .filter(row => row.user_id === values[0] && (!values[1] || row.company_id === values[1])
          && row.status === "active" && companies.has(row.company_id))
        .map(row => ({ ...row, name: companies.get(row.company_id) })) };
    }
    if (sql.includes("FROM org.user_roles")) {
      return { rows: (grants.get(scopeKey(values[0], values[1])) ?? []).map(code => ({ role: "configured", code })) };
    }
    if (sql.includes("FROM org.company_modules")) return { rows: (modules.get(values[0]) ?? []).map(module_key => ({ module_key })) };
    if (sql === "SELECT enabled_features FROM org.company_feature_settings WHERE company_id = $1") return { rows: [] };
    if (sql.includes("SELECT name FROM org.companies")) return { rows: companies.has(values[0]) ? [{ name: companies.get(values[0]) }] : [] };
    if (sql.includes("FROM org.departments") || sql.includes("SELECT name FROM org.positions")) return { rows: [] };
    throw new Error(`Unexpected PG key fixture SQL: ${sql}`);
  };
  return {
    sessions, users, modules, companies, memberships, grants, scopeKey, queries,
    join(actor, companyId, permissions = ["agent.chat", "member.read"]) {
      memberships.set(scopeKey(actor.externalId, companyId), { user_id: actor.externalId, company_id: companyId, status: "active", department_id: null, position_id: null });
      grants.set(scopeKey(actor.externalId, companyId), permissions);
      modules.set(companyId, ["agent"]);
      companies.set(companyId, `PG 회사 ${companyId}`);
      return { ...actor, orgId: `pg:${companyId}` };
    },
    actor(id, companyId = "77", permissions = ["agent.chat", "member.read"]) {
      users.set(id, { id, company_id: companyId, name: "PG Key Fixture", email: `pg-key-${id}@example.invalid`, is_admin: true,
        account_status: "active", approval_status: "approved", permissions });
      modules.set(companyId, ["agent"]);
      companies.set(companyId, `PG 회사 ${companyId}`);
      const token = randomUUID();
      sessions.set(token, { subject: id, session_id: randomUUID(), login_at: new Date().toISOString(), active: true });
      return this.join({ token, externalId: id }, companyId, permissions);
    },
    async close() { pgPool.query = originalQuery; await pgPool.end(); },
  };
}
