import assert from 'node:assert/strict';

export async function roleBoundaries({ api, fixture, result, openPage, capture }) {
  const admin = fixture.actorAdmin, actor = fixture.actorMember, native = admin.orgId.startsWith('pg:');
  const create = (name, permissions) => api.request(admin, '/settings/roles', 'POST', { name, scope: 'all', permissions }, 201);
  async function assign(keys) {
    const current = (await api.request(admin, '/settings/members')).items.find(item => item.user_id === actor.userId);
    return api.request(admin, `/settings/members/${current.membership_id}/roles`, 'PUT', { roles: keys, expected_roles_version: current.roles_version });
  }
  const limited = await create('제한 위임자', ['role.assign', 'menu.roles', 'menu.members', 'member.write', 'menu.imports', 'task.read']);
  await assign([limited.key]);
  const limitedPage = await openPage(actor);
  assert.equal(await limitedPage.getByRole('button', { name: /관리자 프리셋/ }).isDisabled(), true);
  assert.equal(await limitedPage.locator('[data-permission="task.write"]').isDisabled(), true);
  assert.equal(await limitedPage.locator('[data-permission="task.read"]').isEnabled(), true);
  const own = (await api.request(admin, '/settings/members')).items.find(item => item.user_id === admin.userId);
  await limitedPage.getByTestId('role-membership-editor').locator('select').selectOption(own.membership_id);
  assert.equal(await limitedPage.getByRole('button', { name: '역할 배정 저장', exact: true }).isDisabled(), true);
  await capture(limitedPage, 'limited-delegation'); await limitedPage.close();
  const before = await api.request(admin, '/settings/roles');
  await api.request(actor, '/settings/roles', 'POST', { name: '범위 밖 금지', scope: 'all', permissions: ['task.write'] }, 403);
  assert.deepEqual(await api.request(admin, '/settings/roles'), before);
  const noDelegation = await create('위임 없는 사용자', ['menu.roles', 'menu.members', 'member.write', 'menu.imports']);
  const preview = native ? null : await api.request(admin, '/imports', 'POST', { kind: 'members', csv: 'email,name,roles\nnot-created@example.invalid,금지,member' }, 201);
  await assign([noDelegation.key]);
  const paths = native ? [
    ['/pg/members', 'POST', { email: 'denied@example.invalid', name: '금지', password: 'password-1234' }],
    ['/pg/members/invites', 'POST', { email: 'denied@example.invalid' }],
  ] : [
    [`/members/${actor.membershipId}/roles`, 'PATCH', { roles: [], expected_roles_version: 1 }],
    [`/members/${actor.membershipId}/status`, 'PATCH', { status: 'inactive', expected_roles_version: 1 }],
    ['/members/invites', 'POST', { email: 'denied@example.invalid', roles: ['member'] }],
    ['/members/provision', 'POST', { email: 'denied@example.invalid', name: '금지', roles: ['member'] }],
    ['/imports', 'POST', { kind: 'members', csv: 'email,name,roles\nnot-created@example.invalid,금지,member', dry_run: false }],
    [`/imports/${preview.id}/commit`, 'POST', { csv: 'email,name,roles\nnot-created@example.invalid,금지,member' }],
  ];
  const membersBefore = await api.request(admin, '/settings/members');
  for (const [route, method, body] of [...paths, ['/settings/roles', 'POST', { name: '권한 없음', permissions: [] }], [`/settings/members/${actor.membershipId}/roles`, 'PUT', { roles: [], expected_roles_version: 1 }]]) await api.request(actor, route, method, body, 403);
  assert.deepEqual(await api.request(admin, '/settings/members'), membersBefore);
  await api.request({ ...admin, orgId: fixture.B.id }, '/settings/roles', 'GET', undefined, 403);
  result.checks.push(native ? 'limited-delegation-UI-native-member-invite-boundaries' : 'limited-delegation-UI-member-status-invite-provision-CSV-immediate-commit-boundaries');
}
