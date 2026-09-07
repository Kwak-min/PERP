import { pgQuery, pgTransaction } from '../config/pg.js';
import { PG_CREATOR_PERMISSIONS, pgMembershipError } from '../middleware/pgAccess.js';

export async function isCompanyMember(userId, companyId) {
  if (!/^[1-9]\d*$/.test(String(userId))) return false;
  const { rows } = await pgQuery(`SELECT 1 FROM org.company_memberships m JOIN auth.users u ON u.id = m.user_id
    WHERE m.user_id = $1 AND m.company_id = $2 AND m.status = 'active'
      AND u.account_status = 'active' AND u.approval_status = 'approved'`, [userId, companyId]);
  return rows.length > 0;
}

// 회사 생성자에게만 회사 범위의 유한한 권한을 기록한다. membership과 grants는 별개다.
export async function grantCompanyCreator(client, companyId, userId) {
  await client.query(`INSERT INTO org.permissions (code, module)
    SELECT code, split_part(code, '.', 1) FROM unnest($1::text[]) AS code
    ON CONFLICT (code) DO NOTHING`, [PG_CREATOR_PERMISSIONS]);
  const { rows: roles } = await client.query(
    "INSERT INTO org.roles (company_id, name, is_system) VALUES ($1, 'company_creator', true) RETURNING id", [companyId]);
  await client.query(`INSERT INTO org.role_permissions (role_id, permission_id)
    SELECT $1, id FROM org.permissions WHERE code = ANY($2::text[])`, [roles[0].id, PG_CREATOR_PERMISSIONS]);
  await client.query('INSERT INTO org.user_roles (user_id, role_id, granted_by) VALUES ($1, $2, $1)', [userId, roles[0].id]);
}

export async function createPgCompany(userId, payload) {
  try {
    return await pgTransaction(async client => {
      const { rows: companies } = await client.query('INSERT INTO org.companies (name) VALUES ($1) RETURNING id, name', [payload.name]);
      const company = companies[0];
      await client.query(`INSERT INTO org.company_modules (company_id, module_key)
        SELECT $1, k FROM unnest($2::text[]) AS k`, [company.id, payload.modules]);
      for (const name of payload.departments) {
        await client.query('INSERT INTO org.departments (company_id, name) VALUES ($1, $2)', [company.id, name]);
      }
      await client.query(`INSERT INTO org.company_memberships (company_id, user_id, department_id, position_id, created_by)
        VALUES ($1, $2, $3, $4, $2)`, [company.id, userId, null, null]);
      await grantCompanyCreator(client, company.id, userId);
      await client.query("INSERT INTO org.company_events (company_id, actor_id, action) VALUES ($1, $2, 'company.created')", [company.id, userId]);
      return { org_id: `pg:${company.id}`, name: company.name, type: 'perp_db' };
    });
  } catch (error) { throw pgMembershipError(error); }
}
