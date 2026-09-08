import { z } from 'zod';
import { db } from '../config/db.js';
import { COMPANY_PERMISSIONS } from '../config/rbac.js';
import { resolvePrincipal } from '../middleware/auth.js';
import { resolvePgCompanyPrincipal } from '../middleware/pgAccess.js';
import { enabledSet } from '../middleware/modules.js';
import { enabledFeatures } from '../config/features.js';
import { pgEnabledFeatures } from '../middleware/features.js';
import { ApiError } from '../utils/errors.js';
import { legacyRoleDefinitions, permissionCatalog, saveLegacyRole, assignLegacyRoles, deleteLegacyRole, legacyRecoveryRequired } from '../services/company-roles.service.js';
import { pgRoleDefinitions, pgRoleMembers, savePgRole, assignPgRoles, deletePgRole, pgRecoveryRequired } from '../services/pg-company-roles.service.js';

const roleSchema = z.object({ name: z.string().trim().min(1).max(80).refine(name => !name.startsWith('_perp_'), '시스템 예약 이름은 사용할 수 없습니다'),
  scope: z.enum(['self', 'project', 'department', 'all']).default('all'),
  permissions: z.array(z.string()).max(200).transform(values => [...new Set(values)]) }).strict();
const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const patchSchema = roleSchema.extend({ expected_version: versionSchema });
const deleteSchema = z.object({ expected_version: versionSchema }).strict();
const assignSchema = z.object({ roles: z.array(z.string().min(1).max(100)).max(50), expected_roles_version: versionSchema }).strict();

async function principalOf(req) {
  const orgId = req.get('x-org-id');
  if (!orgId) throw new ApiError('VALIDATION_ERROR', '조직을 선택하세요');
  return orgId.startsWith('pg:') ? resolvePgCompanyPrincipal(req) : resolvePrincipal(req);
}
async function managementPrincipal(req) {
  const principal = await principalOf(req);
  principal.require('role.assign'); principal.require('menu.roles');
  return principal;
}

export async function access(req, res) {
  const principal = await principalOf(req);
  const permissions = [...new Set([...principal.permissions, ...(principal.menus ?? [])])].sort();
  const modules = principal.source === 'perp_db' ? principal.modules : [...enabledSet(req.organization.modules)];
  const features = principal.source === 'perp_db' ? await pgEnabledFeatures(principal.companyId, modules)
    : enabledFeatures(req.organization.enabled_features, req.organization.modules);
  res.json({ org_id: principal.orgId, permissions, modules, features,
    menus: permissions.filter(code => code.startsWith('menu.')), scope: principal.scope });
}

export async function roles(req, res) {
  const principal = await managementPrincipal(req);
  const items = principal.source === 'perp_db' ? await pgRoleDefinitions(principal.companyId) : legacyRoleDefinitions(principal);
  const recovery_required = principal.source === 'perp_db' ? await pgRecoveryRequired(principal.companyId) : legacyRecoveryRequired(principal);
  res.json({ items, recovery_required, catalog: permissionCatalog, grantable: COMPANY_PERMISSIONS.filter(code => principal.has(code)), scope: principal.scope });
}

export async function members(req, res) {
  const principal = await managementPrincipal(req);
  if (principal.source === 'perp_db') return res.json({ items: await pgRoleMembers(principal.companyId) });
  const rows = db().prepare(`SELECT m.id AS membership_id, m.user_id, m.roles, m.roles_version, u.name, u.email
    FROM membership m JOIN app_user u ON u.id = m.user_id
    WHERE m.tenant_id = ? AND m.org_id = ? AND m.status = 'active' AND m.deleted_at IS NULL AND u.auth_status = 'active'
    ORDER BY u.name`).all(principal.tenantId, principal.orgId);
  res.json({ items: rows.map(row => ({ ...row, roles: row.roles.split(',').filter(Boolean) })) });
}

export async function save(req, res) {
  const principal = await managementPrincipal(req);
  const payload = (req.params.roleId ? patchSchema : roleSchema).parse(req.body);
  if (payload.permissions.some(code => !COMPANY_PERMISSIONS.includes(code))) throw new ApiError('VALIDATION_ERROR', '등록되지 않은 회사 권한입니다');
  const fn = principal.source === 'perp_db' ? savePgRole : saveLegacyRole;
  const result = await fn(principal, req.params.roleId ?? null, payload, req.requestId);
  res.status(req.params.roleId ? 200 : 201).json(result);
}

export async function assign(req, res) {
  const principal = await managementPrincipal(req);
  const payload = assignSchema.parse(req.body);
  const fn = principal.source === 'perp_db' ? assignPgRoles : assignLegacyRoles;
  res.json(await fn(principal, req.params.membershipId, payload.roles, req.requestId, payload.expected_roles_version));
}

export async function remove(req, res) {
  const principal = await managementPrincipal(req);
  const fn = principal.source === 'perp_db' ? deletePgRole : deleteLegacyRole;
  const payload = deleteSchema.parse(req.body);
  await fn(principal, req.params.roleId, req.requestId, payload.expected_version);
  res.status(204).send();
}
