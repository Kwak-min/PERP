import { db, transaction } from '../config/db.js';
import { COMPANY_PERMISSIONS, ROLE_TEMPLATES, SCOPE_ORDER, permissionsFor } from '../config/rbac.js';
import { MENU_CATALOG } from '../config/menu-permissions.js';
import { bumpVersion, insert, newId, nowIso, softDelete } from '../models/base.js';
import * as audit from './audit.service.js';
import { ApiError } from '../utils/errors.js';

export const permissionCatalog = COMPANY_PERMISSIONS.map(code => ({ code,
  label: MENU_CATALOG.find(menu => menu.code === code)?.label ?? ({ 'approval.decide': '결재 승인/반려', 'role.assign': '역할 생성/배정', 'reservation.manage': '예약 공간 관리' }[code] ?? code),
  kind: code.startsWith('menu.') ? 'menu' : 'action' }));
export const isAdministrator = (permissions, scope) => scope === 'all' &&
  (permissions.has('*') || COMPANY_PERMISSIONS.every(code => permissions.has(code)));
export const isCompanyAdministrator = (permissions, scope, allowLegacyWildcard = false) => scope === 'all' &&
  ((allowLegacyWildcard && permissions.has('*')) || COMPANY_PERMISSIONS.every(code => permissions.has(code)));

export function isCompanyAdministratorForRoles(definitions, keys, allowLegacyWildcard = false) {
  const grants = roleGrants(definitions.filter(role => role.scope === 'all'), keys);
  return isCompanyAdministrator(grants.permissions, grants.scope, allowLegacyWildcard);
}

export const sameKeys = (a, b) => a.length === b.length && a.every(key => b.includes(key));
export function assertRoleVersion(expected, current) {
  if (!Number.isSafeInteger(expected) || expected < 1) throw new ApiError('VALIDATION_ERROR', '현재 역할 버전이 필요합니다');
  if (expected !== current) throw new ApiError('CONFLICT', '역할이 변경되었습니다. 다시 조회하세요');
}

export function assertDelegation(principal, roles) {
  principal.require('role.assign');
  for (const role of roles) {
    // 기존 owner만 유한 회사 권한으로 해석한다. 새 wildcard 역할은 허용하지 않는다.
    const codes = role.key === 'owner' && role.system ? COMPANY_PERMISSIONS : role.permissions;
    if (role.delegable === false || codes.some(code => !COMPANY_PERMISSIONS.includes(code) || !principal.has(code)) ||
      SCOPE_ORDER.indexOf(role.scope) > SCOPE_ORDER.indexOf(principal.scope ?? 'all')) {
      throw new ApiError('PERMISSION_DENIED', '본인의 권한 또는 범위를 넘는 역할은 생성·변경·배정할 수 없습니다');
    }
  }
}

export function legacyRoleDefinitions(principal) {
  const builtins = Object.entries(ROLE_TEMPLATES).filter(([key]) => key !== 'platform_admin')
    .map(([key, role]) => ({ id: key, key, name: role.label, label: role.label, scope: role.scope, permissions: [...permissionsFor([key])], version: 1, system: true }));
  const custom = db().prepare('SELECT * FROM company_role WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL ORDER BY name')
    .all(principal.tenantId, principal.orgId).map(row => ({ id: row.id, key: row.id, name: row.name, label: row.name, scope: row.scope, permissions: JSON.parse(row.permissions_json), version: row.version, system: false }));
  return [...builtins, ...custom];
}

export function roleGrants(definitions, keys) {
  const selected = definitions.filter(role => keys.includes(role.key));
  return { permissions: new Set(selected.flatMap(role => role.permissions)), scope: selected.reduce((scope, role) =>
    SCOPE_ORDER.indexOf(role.scope) > SCOPE_ORDER.indexOf(scope) ? role.scope : scope, 'self') };
}
export function legacyRoleGrants(principal, roles) {
  const definitions = legacyRoleDefinitions(principal);
  // 기존 플랫폼 역할의 신원은 보존하되 회사에서 배정할 수는 없다.
  return roleGrants([...definitions, { key: 'platform_admin', ...ROLE_TEMPLATES.platform_admin }], roles);
}

export function resolveRoleKeys(definitions, keys, existing = false) {
  return [...new Set(keys)].map(key => {
    if (key === 'platform_admin' || (key === 'owner' && !existing)) throw new ApiError('PERMISSION_DENIED', '회사에서 플랫폼 또는 wildcard 역할을 위임할 수 없습니다');
    const role = definitions.find(item => item.key === key);
    if (!role) throw new ApiError('VALIDATION_ERROR', '선택한 조직에 없는 역할입니다');
    return role;
  });
}

// SQLite 동기 트랜잭션 안에서 현재 소속과 권한을 재해석한다. 요청 캐시를 신뢰하지 않는다.
export function freshLegacyAuthority(principal, surface) {
  const member = db().prepare(`SELECT m.* FROM membership m JOIN app_user u ON u.id = m.user_id
    JOIN organization o ON o.id = m.org_id AND o.tenant_id = m.tenant_id JOIN tenant t ON t.id = m.tenant_id
    WHERE m.user_id = ? AND m.tenant_id = ? AND m.org_id = ? AND m.status = 'active' AND m.deleted_at IS NULL
      AND u.auth_status = 'active' AND o.deleted_at IS NULL AND t.status = 'active'`).get(principal.userId, principal.tenantId, principal.orgId);
  if (!member) throw new ApiError('PERMISSION_DENIED', '활성 회사 소속이 없습니다');
  const grants = legacyRoleGrants(principal, member.roles.split(',').filter(Boolean));
  const authority = { ...principal, ...grants,
    has(code) { return this.permissions.has('*') || this.permissions.has(code); },
    require(code) { if (!this.has(code)) throw new ApiError('PERMISSION_DENIED', '이 작업의 권한이 없습니다'); } };
  authority.require('role.assign');
  if (surface) authority.require(surface);
  return authority;
}
export function assertInvitationDelegation(invite) {
  const authority = freshLegacyAuthority({ tenantId: invite.tenant_id, orgId: invite.org_id, userId: invite.created_by }, 'menu.members');
  authority.require('member.write');
  assertDelegation(authority, resolveRoleKeys(legacyRoleDefinitions(authority), invite.roles.split(',').filter(Boolean)));
}
function activeMembers(principal) {
  return db().prepare(`SELECT m.* FROM membership m JOIN app_user u ON u.id = m.user_id
    WHERE m.tenant_id = ? AND m.org_id = ? AND m.status = 'active' AND m.deleted_at IS NULL AND u.auth_status = 'active'`)
    .all(principal.tenantId, principal.orgId);
}
function fullAdmin(principal, keys) {
  const grants = legacyRoleGrants(principal, keys);
  return isAdministrator(grants.permissions, grants.scope);
}
export const legacyRecoveryRequired = principal => !activeMembers(principal).some(m => fullAdmin(principal, m.roles.split(',').filter(Boolean)));
export function assertLegacyLastAdmin(principal, membershipId, nextRoles, active = true) {
  const memberships = activeMembers(principal);
  const wasAdmin = memberships.some(m => fullAdmin(principal, m.roles.split(',').filter(Boolean)));
  const remains = memberships.some(m => {
    if (m.id === membershipId && !active) return false;
    return fullAdmin(principal, m.id === membershipId ? nextRoles : m.roles.split(',').filter(Boolean));
  });
  if (wasAdmin && !remains) throw new ApiError('CONFLICT', '마지막 활성 관리자의 권한은 제거할 수 없습니다');
}
function record(principal, action, resourceId, before, after, requestId, resourceType = 'company_role') {
  audit.record({ tenantId: principal.tenantId, actorId: principal.userId, action,
    resourceType, resourceId, before, after, requestId });
}

export const saveLegacyRole = transaction((principal, key, payload, requestId) => {
  principal = freshLegacyAuthority(principal, 'menu.roles');
  const definitions = legacyRoleDefinitions(principal);
  const before = key ? definitions.find(role => role.key === key) : null;
  if (key && !before) throw new ApiError('NOT_FOUND', '역할을 찾을 수 없습니다');
  if (before?.system) throw new ApiError('CONFLICT', '기본 역할은 수정할 수 없습니다. 사용자 정의 역할을 만드세요');
  assertDelegation(principal, [...(before ? [before] : []), payload]);
  if (key) assertRoleVersion(payload.expected_version, before.version);
  if (before && before.name === payload.name && before.scope === payload.scope && sameKeys(before.permissions, payload.permissions)) return before;
  if (definitions.some(role => role.key !== key && role.name === payload.name)) throw new ApiError('CONFLICT', '같은 이름의 역할이 있습니다');
  const hadAdmin = !legacyRecoveryRequired(principal);
  let row;
  const patch = { name: payload.name, scope: payload.scope, permissions_json: JSON.stringify(payload.permissions) };
  if (key) {
    const previous = db().prepare('SELECT * FROM company_role WHERE id = ? AND tenant_id = ? AND org_id = ?').get(key, principal.tenantId, principal.orgId);
    row = bumpVersion('company_role', previous, patch, principal.userId);
  } else row = insert('company_role', { id: newId(), tenant_id: principal.tenantId, org_id: principal.orgId, ...patch, created_by: principal.userId });
  if (hadAdmin && legacyRecoveryRequired(principal)) throw new ApiError('CONFLICT', '마지막 활성 관리자의 역할은 축소할 수 없습니다');
  record(principal, key ? 'role.updated' : 'role.created', row.id, before, payload, requestId);
  return legacyRoleDefinitions(principal).find(role => role.key === row.id);
});

export const assignLegacyRoles = transaction((principal, membershipId, keys, requestId, expectedVersion, surface = 'menu.roles') => {
  principal = freshLegacyAuthority(principal, surface);
  const membership = db().prepare("SELECT * FROM membership WHERE id = ? AND tenant_id = ? AND org_id = ? AND status = 'active' AND deleted_at IS NULL")
    .get(membershipId, principal.tenantId, principal.orgId);
  if (!membership) throw new ApiError('NOT_FOUND', '활성 구성원을 찾을 수 없습니다');
  const definitions = legacyRoleDefinitions(principal), before = membership.roles.split(',').filter(Boolean);
  assertDelegation(principal, [...resolveRoleKeys(definitions, before, true), ...resolveRoleKeys(definitions, keys)]);
  assertRoleVersion(expectedVersion, membership.roles_version);
  keys = [...new Set(keys)];
  if (sameKeys(before, keys)) return { membership_id: membership.id, roles: before, roles_version: membership.roles_version };
  assertLegacyLastAdmin(principal, membership.id, keys);
  bumpVersion('membership', membership, { roles: keys.join(','), roles_version: membership.roles_version + 1 }, principal.userId);
  record(principal, 'member.roles.changed', membership.id, { roles: before }, { roles: keys }, requestId, 'membership');
  return { membership_id: membership.id, roles: keys, roles_version: membership.roles_version + 1 };
});

export const setLegacyMemberStatus = transaction((principal, membershipId, status, requestId, expectedVersion, surface = 'menu.members') => {
  principal = freshLegacyAuthority(principal, surface);
  principal.require('member.write');
  const membership = db().prepare('SELECT * FROM membership WHERE id = ? AND tenant_id = ? AND org_id = ? AND deleted_at IS NULL')
    .get(membershipId, principal.tenantId, principal.orgId);
  if (!membership) throw new ApiError('NOT_FOUND', '구성원을 찾을 수 없습니다');
  const definitions = legacyRoleDefinitions(principal);
  const roles = membership.roles.split(',').filter(Boolean);
  assertDelegation(principal, resolveRoleKeys(definitions, roles, true));
  assertRoleVersion(expectedVersion, membership.roles_version);
  if (membership.status === status) {
    return { membership_id: membership.id, status, roles_version: membership.roles_version };
  }
  assertLegacyLastAdmin(principal, membership.id, roles, status === 'active');
  const patch = { status, roles_version: membership.roles_version + 1 };
  if (status === 'left') {
    patch.left_at = nowIso();
    db().prepare('UPDATE session_token SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(nowIso(), membership.user_id);
  }
  const updated = bumpVersion('membership', membership, patch, principal.userId);
  record(principal, 'member.status.changed', membership.id, { status: membership.status }, { status: updated.status }, requestId, 'membership');
  return { membership_id: updated.id, status: updated.status, roles_version: updated.roles_version };
});

export const deleteLegacyRole = transaction((principal, key, requestId, expectedVersion) => {
  principal = freshLegacyAuthority(principal, 'menu.roles');
  const definitions = legacyRoleDefinitions(principal), role = definitions.find(item => item.key === key);
  if (!role) throw new ApiError('NOT_FOUND', '역할을 찾을 수 없습니다');
  if (role.system) throw new ApiError('CONFLICT', '기본 역할은 삭제할 수 없습니다');
  assertDelegation(principal, [role]);
  assertRoleVersion(expectedVersion, role.version);
  const memberships = db().prepare('SELECT * FROM membership WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL').all(principal.tenantId, principal.orgId);
  for (const membership of memberships) {
    const before = membership.roles.split(',').filter(Boolean);
    if (!before.includes(key)) continue;
    assertDelegation(principal, resolveRoleKeys(definitions, before, true));
    const roles = before.filter(value => value !== key);
    assertLegacyLastAdmin(principal, membership.id, roles);
    bumpVersion('membership', membership, { roles: roles.join(','), roles_version: membership.roles_version + 1 }, principal.userId);
  }
  softDelete('company_role', key, principal.userId);
  record(principal, 'role.deleted', key, role, null, requestId);
});
