import assert from 'node:assert/strict';
import test from 'node:test';
import { roleSchema, membersSchema, assignmentSchema, canDelegateRole, effectiveRoleSources } from '../src/screens/role-settings-model.ts';

const role = { id: 'role-id', key: 'role-key', name: '역할', label: '역할', scope: 'all', permissions: ['task.read'], system: false, version: 7 };
const data = { items: [role], catalog: [{ code: 'task.read', label: '읽기', kind: 'action' }, { code: 'menu.roles', label: '설정', kind: 'menu' }, { code: 'role.assign', label: '위임', kind: 'action' }], grantable: ['task.read'], scope: 'all', recovery_required: false };
test('definition boundary keeps independent IDs, exact version and system marker', () => {
  assert.deepEqual(roleSchema.parse(role), role);
  for (const version of [undefined, null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(roleSchema.safeParse({ ...role, version }).success, false);
  for (const field of ['id', 'key', 'system']) { const dto = { ...role }; delete dto[field]; assert.equal(roleSchema.safeParse(dto).success, false); }
});
test('membership and saved assignment boundaries require roles_version, never generic version', () => {
  const member = { membership_id: 'membership', user_id: 'user', name: '회원', email: 'member@example.invalid', roles: [], roles_version: 13 };
  assert.equal(membersSchema.parse({ items: [member] }).items[0].roles_version, 13);
  assert.equal(assignmentSchema.parse(member).roles_version, 13);
  for (const roles_version of [undefined, null, '13', 0, 1.5]) assert.equal(membersSchema.safeParse({ items: [{ ...member, roles_version, version: 1 }] }).success, false);
});
test('delegation denies out-of-scope, unknown, platform and new owner grants', () => {
  assert.equal(canDelegateRole(role, data), true);
  assert.equal(canDelegateRole(role, { ...data, scope: 'self' }), false);
  assert.equal(canDelegateRole({ ...role, permissions: ['role.assign'] }, data), false);
  assert.equal(canDelegateRole({ ...role, delegable: false }, data), false);
  assert.equal(canDelegateRole({ ...role, permissions: ['*'] }, data), false);
  const owner = { ...role, key: 'owner', system: true, permissions: ['*'] };
  const full = { ...data, grantable: data.catalog.map(item => item.code) };
  assert.equal(canDelegateRole(owner, full), false);
  assert.equal(canDelegateRole(owner, full, true), true);
});
test('effective union keeps every contributing source without inventing a grant or feature activation', () => {
  const second = { ...role, id: 'second', key: 'second', name: '두번째', permissions: ['task.read', 'menu.roles'] };
  const current = { ...data, items: [role, second] };
  const union = effectiveRoleSources(current, [role.key, second.key]);
  assert.deepEqual(union.map(item => [item.code, item.sources]), [['task.read', [role.name, second.name]], ['menu.roles', [second.name]]]);
  assert.deepEqual(effectiveRoleSources(current, [role.key]).map(item => item.code), ['task.read']);
  assert.deepEqual(effectiveRoleSources(current, []), []);
});
