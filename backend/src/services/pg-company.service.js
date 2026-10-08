import { pgQuery, pgTransaction } from '../config/pg.js';
import { PG_CREATOR_PERMISSIONS, pgMembershipError } from '../middleware/pgAccess.js';
import { ApiError } from '../utils/errors.js';

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
      // company는 기존 스키마에서도 생성 가능하다. 새 유형은 같은 회사 저장소에 기록한다.
      const { rows: companies } = await client.query(payload.type === 'company'
        ? 'INSERT INTO org.companies (name) VALUES ($1) RETURNING id, name'
        : 'INSERT INTO org.companies (name, organization_type) VALUES ($1, $2) RETURNING id, name',
      payload.type === 'company' ? [payload.name] : [payload.name, payload.type]);
      const company = companies[0];
      await client.query(`INSERT INTO org.company_modules (company_id, module_key)
        SELECT $1, k FROM unnest($2::text[]) AS k`, [company.id, payload.modules]);
      try {
        await client.query(`INSERT INTO org.company_feature_settings (company_id, enabled_features)
          VALUES ($1, $2::text[])`, [company.id, payload.features]);
      } catch (error) {
        if (error?.code === '42P01') {
          throw new ApiError('SERVICE_UNAVAILABLE', 'PG 회사 기능 스키마가 없습니다. perp_additions_v6.sql 적용 상태를 확인하세요.');
        }
        throw error;
      }
      for (const name of payload.departments) {
        await client.query('INSERT INTO org.departments (company_id, name) VALUES ($1, $2)', [company.id, name]);
      }
      await client.query(`INSERT INTO org.company_memberships (company_id, user_id, department_id, position_id, created_by)
        VALUES ($1, $2, $3, $4, $2)`, [company.id, userId, null, null]);
      await grantCompanyCreator(client, company.id, userId);
      await client.query("INSERT INTO org.company_events (company_id, actor_id, action) VALUES ($1, $2, 'company.created')", [company.id, userId]);
      return { org_id: `pg:${company.id}`, name: company.name, type: payload.type === 'company' ? 'perp_db' : payload.type, enabled_features: payload.features };
    });
  } catch (error) {
    if ((error?.code === '42703' || (error?.code === '23514' && error.constraint === 'companies_organization_type_check')) && payload.type !== 'company') {
      throw new ApiError('SERVICE_UNAVAILABLE', '공간 유형 설정을 사용할 수 없습니다. 관리자에게 스키마 업데이트를 요청하세요.');
    }
    throw pgMembershipError(error);
  }
}
