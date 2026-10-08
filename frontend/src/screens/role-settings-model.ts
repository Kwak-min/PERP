import { z } from 'zod';

const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const roleScopeSchema = z.enum(['self', 'project', 'department', 'all']);
export const roleSchema = z.object({ id: z.string().min(1), key: z.string().min(1), name: z.string(), label: z.string(),
  scope: roleScopeSchema, permissions: z.array(z.string()), version: versionSchema, system: z.boolean(), delegable: z.boolean().optional() });
export const rolesSchema = z.object({ items: z.array(roleSchema), recovery_required: z.boolean(),
  catalog: z.array(z.object({ code: z.string(), label: z.string(), kind: z.enum(['action', 'menu']) })),
  grantable: z.array(z.string()), scope: roleScopeSchema });
export const memberSchema = z.object({ membership_id: z.string(), user_id: z.string(), name: z.string(), email: z.string(),
  roles: z.array(z.string()), roles_version: versionSchema });
export const membersSchema = z.object({ items: z.array(memberSchema) });
export const assignmentSchema = memberSchema.pick({ membership_id: true, roles: true, roles_version: true });
export const roleAccessSchema = z.object({ permissions: z.array(z.string()), menus: z.array(z.string()) });
export type Role = z.infer<typeof roleSchema>;
export type Roles = z.infer<typeof rolesSchema>;
export type Member = z.infer<typeof memberSchema>;
export const scopes = ['self', 'project', 'department', 'all'] as const;
export const scopeLabels = { self: '본인', project: '참여 프로젝트', department: '부서', all: '회사 전체' } as const;
export const toggleRoleValue = (values: readonly string[], key: string) => values.includes(key) ? values.filter(value => value !== key) : [...values, key];
export function canDelegateRole(role: Role, data: Roles, existing = false): boolean {
  if (role.delegable === false || (role.key === 'owner' && !existing)) return false;
  const codes = role.key === 'owner' && role.system ? data.catalog.map(item => item.code) : role.permissions;
  return codes.every(code => data.grantable.includes(code)) && scopes.indexOf(role.scope) <= scopes.indexOf(data.scope);
}
export function effectiveRoleSources(data: Roles, keys: readonly string[]) {
  const roles = data.items.filter(role => keys.includes(role.key));
  return data.catalog.map(item => ({ ...item, sources: roles.filter(role => role.permissions.includes(item.code) ||
    (role.key === 'owner' && role.system && role.permissions.includes('*'))).map(role => role.name) })).filter(item => item.sources.length > 0);
}
