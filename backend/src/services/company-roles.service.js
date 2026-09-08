import { db, transaction } from '../config/db.js';
import { COMPANY_PERMISSIONS, ROLE_TEMPLATES, SCOPE_ORDER, permissionsFor } from '../config/rbac.js';
import { MENU_CATALOG } from '../config/menu-permissions.js';
import { bumpVersion, insert, newId, softDelete } from '../models/base.js';
import * as audit from './audit.service.js';
import { ApiError } from '../utils/errors.js';

export const permissionCatalog = COMPANY_PERMISSIONS.map(code => ({ code,
  label: MENU_CATALOG.find(menu => menu.code === code)?.label ?? ({ 'approval.decide': '결재 승인/반려', 'role.assign': '역할 생성/배정', 'reservation.manage': '예약 공간 관리' }[code] ?? code),
  kind: code.startsWith('menu.') ? 'menu' : 'action' }));
export const isAdministrator = permissions => permissions.has('*') ||
  ['role.assign', 'organization.settings', 'menu.roles'].every(code => permissions.has(code));
export const isCompanyAdministrator = (permissions, scope, allowLegacyWildcard = false) => scope === 'all' &&
  ((allowLegacyWildcard && permissions.has('*')) || COMPANY_PERMISSIONS.every(code => permissions.has(code)));

export function roleGrants(definitions, keys) {
  const selected = definitions.filter(role => keys.includes(role.key));
  return { permissions: new Set(selected.flatMap(role => role.permissions)), scope: selected.reduce((scope, role) =>
    SCOPE_ORDER.indexOf(role.scope) > SCOPE_ORDER.indexOf(scope) ? role.scope : scope, 'self') };
}

export function isCompanyAdministratorForRoles(definitions, keys, allowLegacyWildcard = false) {
  const grants = roleGrants(definitions.filter(role => role.scope === 'all'), keys);
  return isCompanyAdministrator(grants.permissions, grants.scope, allowLegacyWildcard);
}

export function assertDelegation(principal, roles) {
  principal.require('role.assign');
  for (const role of roles) {
    if (role.permissions.some(code => code.startsWith('platform.') || !principal.has(code)) ||
      SCOPE_ORDER.indexOf(role.scope) > SCOPE_ORDER.indexOf(principal.scope ?? 'all')) {
      throw new ApiError('PERMISSION_DENIED', '본인의 권한 또는 범위를 넘는 역할은 생성·변경·배정할 수 없습니다');
    }
  }
}

export function legacyRoleDefinitions(principal) {
  const builtins = Object.entries(ROLE_TEMPLATES).filter(([key]) => key !== 'platform_admin')
    .map(([key, role]) => ({ key, name: role.label, label: role.label, scope: role.scope, permissions: [...permissionsFor([key])], system: true }));
  const custom = db().prepare('SELECT * FROM company_role WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL ORDER BY name')
    .all(principal.tenantId, principal.orgId).map(row => ({ key: row.id, name: row.name, label: row.name, scope: row.scope, permissions: JSON.parse(row.permissions_json), system: false }));
  return [...builtins, ...custom];
}

export function legacyRoleGrants(principal, roles) {
  return roleGrants([...legacyRoleDefinitions(principal), { key: 'platform_admin', ...ROLE_TEMPLATES.platform_admin }], roles);
}

export function resolveRoleKeys(definitions, keys) {
  return [...new Set(keys)].map(key => {
    if (key === 'platform_admin') throw new ApiError('PERMISSION_DENIED', '회사에서 플랫폼 역할을 위임할 수 없습니다');
    const role = definitions.find(item => item.key === key);
    if (!role) throw new ApiError('VALIDATION_ERROR', '선택한 조직에 없는 역할입니다');
    return role;
  });
}

export function assertLegacyLastAdmin(principal, membershipId, nextRoles, active = true) {
  const memberships = db().prepare(`SELECT m.* FROM membership m JOIN app_user u ON u.id = m.user_id
    WHERE m.tenant_id = ? AND m.org_id = ? AND m.status = 'active' AND m.deleted_at IS NULL AND u.auth_status = 'active'`)
    .all(principal.tenantId, principal.orgId);
  const wasAdmin = memberships.some(m => isAdministrator(legacyRoleGrants(principal, m.roles.split(',').filter(Boolean)).permissions));
  const remains = memberships.some(m => {
    if (m.id === membershipId && !active) return false;
    return isAdministrator(legacyRoleGrants(principal, m.id === membershipId ? nextRoles : m.roles.split(',').filter(Boolean)).permissions);
  });
  if (wasAdmin && !remains) throw new ApiError('CONFLICT', '마지막 활성 관리자의 권한은 제거할 수 없습니다');
}

function record(principal, action, resourceId, before, after, requestId) {
  audit.record({ tenantId: principal.tenantId, actorId: principal.userId, action,
    resourceType: 'company_role', resourceId, before, after, requestId });
}

export const saveLegacyRole = transaction((principal, key, payload, requestId) => {
  const definitions = legacyRoleDefinitions(principal);
  const before = key ? definitions.find(role => role.key === key) : null;
  if (key && !before) throw new ApiError('NOT_FOUND', '역할을 찾을 수 없습니다');
  if (before?.system) throw new ApiError('CONFLICT', '기본 역할은 수정할 수 없습니다. 사용자 정의 역할을 만드세요');
  assertDelegation(principal, [...(before ? [before] : []), payload]);
  if (definitions.some(role => role.key !== key && role.name === payload.name)) throw new ApiError('CONFLICT', '같은 이름의 역할이 있습니다');
  const memberships = db().prepare(`SELECT m.* FROM membership m JOIN app_user u ON u.id = m.user_id
    WHERE m.tenant_id = ? AND m.org_id = ? AND m.status = 'active' AND m.deleted_at IS NULL AND u.auth_status = 'active'`)
    .all(principal.tenantId, principal.orgId);
  const hadAdmin = memberships.some(m => isAdministrator(legacyRoleGrants(principal, m.roles.split(',').filter(Boolean)).permissions));
  let row;
  const patch = { name: payload.name, scope: payload.scope, permissions_json: JSON.stringify(payload.permissions) };
  if (key) {
    const previous = db().prepare('SELECT * FROM company_role WHERE id = ? AND tenant_id = ? AND org_id = ?').get(key, principal.tenantId, principal.orgId);
    row = bumpVersion('company_role', previous, patch, principal.userId);
  } else row = insert('company_role', { id: newId(), tenant_id: principal.tenantId, org_id: principal.orgId, ...patch, created_by: principal.userId });
  if (hadAdmin && !memberships.some(m => isAdministrator(legacyRoleGrants(principal, m.roles.split(',').filter(Boolean)).permissions))) throw new ApiError('CONFLICT', '마지막 활성 관리자의 역할은 축소할 수 없습니다');
  record(principal, key ? 'role.updated' : 'role.created', row.id, before, payload, requestId);
  return legacyRoleDefinitions(principal).find(role => role.key === row.id);
});

export const assignLegacyRoles = transaction((principal, membershipId, keys, requestId) => {
  const membership = db().prepare("SELECT * FROM membership WHERE id = ? AND tenant_id = ? AND org_id = ? AND status = 'active' AND deleted_at IS NULL")
    .get(membershipId, principal.tenantId, principal.orgId);
  if (!membership) throw new ApiError('NOT_FOUND', '활성 구성원을 찾을 수 없습니다');
  const definitions = legacyRoleDefinitions(principal);
  const before = membership.roles.split(',').filter(Boolean);
  assertDelegation(principal, [...resolveRoleKeys(definitions, before), ...resolveRoleKeys(definitions, keys)]);
  assertLegacyLastAdmin(principal, membership.id, keys);
  bumpVersion('membership', membership, { roles: [...new Set(keys)].join(',') }, principal.userId);
  record(principal, 'member.roles.changed', membership.id, { roles: before }, { roles: keys }, requestId);
  return { membership_id: membership.id, roles: keys };
});

export const deleteLegacyRole = transaction((principal, key, requestId) => {
  const role = legacyRoleDefinitions(principal).find(item => item.key === key);
  if (!role) throw new ApiError('NOT_FOUND', '역할을 찾을 수 없습니다');
  if (role.system) throw new ApiError('CONFLICT', '기본 역할은 삭제할 수 없습니다');
  assertDelegation(principal, [role]);
  const memberships = db().prepare('SELECT * FROM membership WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL').all(principal.tenantId, principal.orgId);
  for (const membership of memberships) {
    const before = membership.roles.split(',').filter(Boolean);
    if (!before.includes(key)) continue;
    const roles = before.filter(value => value !== key);
    assertLegacyLastAdmin(principal, membership.id, roles);
    bumpVersion('membership', membership, { roles: roles.join(',') }, principal.userId);
  }
  softDelete('company_role', key, principal.userId);
  record(principal, 'role.deleted', key, role, null, requestId);
});
