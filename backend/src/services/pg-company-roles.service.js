import { pgQuery, pgTransaction } from '../config/pg.js';
import { COMPANY_PERMISSIONS } from '../config/rbac.js';
import { effectivePgPermissions } from '../config/menu-permissions.js';
import { assertDelegation, isAdministrator, isCompanyAdministratorForRoles, resolveRoleKeys } from './company-roles.service.js';
import { ApiError } from '../utils/errors.js';

const adminDefinition = { key: 'company_admin', name: '관리자', label: '관리자', scope: 'all', permissions: COMPANY_PERMISSIONS, system: true };

export async function pgRoleDefinitions(companyId, query = pgQuery) {
  const { rows } = await query(`SELECT r.id, r.name, r.is_system, r.scope,
    COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
    FROM org.roles r LEFT JOIN org.role_permissions rp ON rp.role_id = r.id
    LEFT JOIN org.permissions p ON p.id = rp.permission_id
    WHERE r.company_id = $1 AND r.deleted_at IS NULL GROUP BY r.id ORDER BY r.name`, [companyId]);
  return [...rows.map(row => ({ key: String(row.id), name: row.name, label: row.name,
    scope: row.scope, permissions: effectivePgPermissions(row.permissions.map(code => ({ code, role: row.name }))), system: row.is_system })), adminDefinition];
}

export async function pgRoleMembers(companyId, query = pgQuery) {
  const { rows } = await query(`SELECT m.user_id, u.name, u.email,
    COALESCE(array_agg(r.id::text) FILTER (WHERE r.id IS NOT NULL), '{}') AS roles
    FROM org.company_memberships m JOIN auth.users u ON u.id = m.user_id
    LEFT JOIN org.user_roles ur ON ur.user_id = m.user_id AND ur.workspace_id IS NULL
    LEFT JOIN org.roles r ON r.id = ur.role_id AND r.company_id = m.company_id AND r.deleted_at IS NULL
    WHERE m.company_id = $1 AND m.status = 'active' AND u.account_status = 'active' AND u.approval_status = 'approved'
    GROUP BY m.user_id, u.name, u.email ORDER BY u.name`, [companyId]);
  return rows.map(row => ({ membership_id: String(row.user_id), user_id: String(row.user_id), name: row.name, email: row.email, roles: row.roles }));
}

export async function isPgCompanyAdministrator(companyId, userId, query = pgQuery) {
  const [roles, members] = await Promise.all([pgRoleDefinitions(companyId, query), pgRoleMembers(companyId, query)]);
  const member = members.find(row => row.user_id === userId);
  return member ? isCompanyAdministratorForRoles(roles, member.roles) : false;
}

function permissionsOf(member, roles) {
  return new Set(member.roles.flatMap(key => roles.find(role => role.key === key)?.permissions ?? []));
}
function assertLastAdmin(beforeMembers, beforeRoles, afterMembers, afterRoles) {
  if (beforeMembers.some(member => isAdministrator(permissionsOf(member, beforeRoles))) &&
    !afterMembers.some(member => isAdministrator(permissionsOf(member, afterRoles)))) {
    throw new ApiError('CONFLICT', '마지막 활성 관리자의 권한은 제거할 수 없습니다');
  }
}

async function mutate(principal, requestId, fn) {
  return pgTransaction(async client => {
    const query = client.query.bind(client);
    // 같은 회사의 모든 역할 변경을 직렬화하고 잠금 이후 권한을 다시 읽는다.
    const company = await query('SELECT id FROM org.companies WHERE id = $1 AND is_active = true FOR UPDATE', [principal.companyId]);
    if (!company.rows[0]) throw new ApiError('PERMISSION_DENIED', '활성 회사가 아닙니다');
    const roles = await pgRoleDefinitions(principal.companyId, query);
    const members = await pgRoleMembers(principal.companyId, query);
    const actor = members.find(member => member.user_id === principal.userId);
    if (!actor) throw new ApiError('PERMISSION_DENIED', '활성 회사 소속이 없습니다');
    const permissions = permissionsOf(actor, roles);
    const authority = { ...principal, permissions, scope: 'all', has: code => permissions.has(code),
      require(code) { if (!this.has(code)) throw new ApiError('PERMISSION_DENIED', '이 작업의 권한이 없습니다'); } };
    authority.require('role.assign'); authority.require('menu.roles');
    const result = await fn({ query, roles, members, authority });
    const nextRoles = await pgRoleDefinitions(principal.companyId, query);
    const nextMembers = await pgRoleMembers(principal.companyId, query);
    assertLastAdmin(members, roles, nextMembers, nextRoles);
    await query(`INSERT INTO org.role_change_events (company_id, actor_id, action, resource_id, before_data, after_data, request_id)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [principal.companyId, principal.userId, result.action, result.resourceId, JSON.stringify(result.before ?? null), JSON.stringify(result.after ?? null), requestId ?? null]);
    return result.value;
  });
}

async function writePermissions(query, id, permissions) {
  const codes = [...permissions, 'menu.configured'];
  await query(`INSERT INTO org.permissions (code, module) SELECT code, split_part(code, '.', 1)
    FROM unnest($1::text[]) AS code ON CONFLICT (code) DO NOTHING`, [codes]);
  await query('DELETE FROM org.role_permissions WHERE role_id = $1', [id]);
  await query(`INSERT INTO org.role_permissions (role_id, permission_id)
    SELECT $1, id FROM org.permissions WHERE code = ANY($2::text[])`, [id, codes]);
}

export function savePgRole(principal, key, payload, requestId) {
  return mutate(principal, requestId, async ({ query, roles, authority }) => {
    const before = key ? roles.find(role => role.key === key) : null;
    if (key && !before) throw new ApiError('NOT_FOUND', '역할을 찾을 수 없습니다');
    if (before?.system) throw new ApiError('CONFLICT', '기본 역할은 수정할 수 없습니다');
    // 현재 PG 데이터 레이어는 회사 범위만 지원한다. 좁은 범위를 가장하지 않는다.
    if (payload.scope !== 'all') throw new ApiError('VALIDATION_ERROR', 'PG 회사 역할의 데이터 범위는 회사 전체입니다');
    assertDelegation(authority, [...(before ? [before] : []), payload]);
    if (roles.some(role => role.key !== key && role.name === payload.name)) throw new ApiError('CONFLICT', '같은 이름의 역할이 있습니다');
    let id = key;
    if (!key) {
      const { rows } = await query('INSERT INTO org.roles (company_id, name, is_system, scope) VALUES ($1, $2, false, $3) RETURNING id', [principal.companyId, payload.name, payload.scope]);
      id = String(rows[0].id);
    } else await query('UPDATE org.roles SET name = $3, scope = $4, version = version + 1 WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL', [id, principal.companyId, payload.name, payload.scope]);
    await writePermissions(query, id, payload.permissions);
    const value = { key: id, ...payload, label: payload.name, system: false };
    return { action: key ? 'role.updated' : 'role.created', resourceId: id, before, after: value, value };
  });
}

export function assignPgRoles(principal, memberId, keys, requestId) {
  return mutate(principal, requestId, async ({ query, roles, members, authority }) => {
    const member = members.find(row => row.membership_id === memberId);
    if (!member) throw new ApiError('NOT_FOUND', '활성 구성원을 찾을 수 없습니다');
    assertDelegation(authority, [...resolveRoleKeys(roles, member.roles), ...resolveRoleKeys(roles, keys)]);
    const ids = [];
    for (const key of [...new Set(keys)]) {
      if (key !== 'company_admin') { ids.push(key); continue; }
      const name = '_perp_company_admin_v1';
      const existing = roles.find(role => role.name === name && role.system);
      let id = existing?.key;
      if (!id) {
        const { rows } = await query('INSERT INTO org.roles (company_id, name, is_system, scope) VALUES ($1, $2, true, $3) RETURNING id', [principal.companyId, name, 'all']);
        id = String(rows[0].id);
      }
      await writePermissions(query, id, COMPANY_PERMISSIONS);
      ids.push(id);
    }
    await query(`DELETE FROM org.user_roles ur USING org.roles r
      WHERE ur.role_id = r.id AND r.company_id = $1 AND ur.user_id = $2 AND ur.workspace_id IS NULL`, [principal.companyId, memberId]);
    for (const id of ids) await query('INSERT INTO org.user_roles (user_id, role_id, granted_by) VALUES ($1, $2, $3)', [memberId, id, principal.userId]);
    const value = { membership_id: memberId, roles: ids };
    return { action: 'member.roles.changed', resourceId: memberId, before: member, after: value, value };
  });
}

export function deletePgRole(principal, key, requestId) {
  return mutate(principal, requestId, async ({ query, roles, authority }) => {
    const role = roles.find(row => row.key === key);
    if (!role) throw new ApiError('NOT_FOUND', '역할을 찾을 수 없습니다');
    if (role.system) throw new ApiError('CONFLICT', '기본 역할은 삭제할 수 없습니다');
    assertDelegation(authority, [role]);
    await query('DELETE FROM org.user_roles WHERE role_id = $1', [key]);
    await query('DELETE FROM org.role_permissions WHERE role_id = $1', [key]);
    await query("UPDATE org.roles SET name = '_perp_deleted_role_' || id::text, deleted_at = now(), version = version + 1 WHERE id = $1 AND company_id = $2", [key, principal.companyId]);
    return { action: 'role.deleted', resourceId: key, before: role, after: null, value: null };
  });
}
