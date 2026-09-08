import assert from 'node:assert/strict';

export async function definitionCases({ page, openPage, api, fixture, armDom, result, capture }) {
  async function settled(p) { const wait = await armDom(p, '.role-settings[aria-busy="false"]'); await wait(); }
  const editor = page.getByTestId('role-definition-editor');
  await editor.getByRole('button', { name: '새 역할', exact: true }).click();
  await editor.getByLabel('역할 이름', { exact: true }).fill('명시적 생성 검증');
  await editor.locator('[data-permission="task.read"]').check();
  const created = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/settings/roles' && r.request().method() === 'POST');
  await editor.getByRole('button', { name: '역할 생성', exact: true }).click();
  const response = await created; assert.equal(response.status(), 201);
  assert.equal(Object.hasOwn(response.request().postDataJSON(), 'expected_version'), false);
  const role = await response.json(); await settled(page);
  await editor.getByRole('button', { name: '새 역할', exact: true }).click();
  await editor.getByLabel('역할 이름', { exact: true }).fill(role.name);
  await editor.locator('[data-permission="task.write"]').check();
  const duplicate = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/settings/roles' && r.request().method() === 'POST');
  await editor.getByRole('button', { name: '역할 생성', exact: true }).click();
  assert.equal((await duplicate).status(), 409); await settled(page);
  const compare = await armDom(page, '[data-testid="role-comparison"]');
  await page.getByRole('button', { name: '최신값 비교', exact: true }).click(); await compare(); await settled(page);
  assert.equal(await page.getByRole('button', { name: '비교 확인 · 초안 유지', exact: true }).isEnabled(), true, 'create conflict must allow keeping and correcting the unsaved draft after comparison');
  await page.getByRole('button', { name: '비교 확인 · 초안 유지', exact: true }).click();
  assert.equal(await editor.getAttribute('data-version'), 'new');
  assert.equal(await editor.locator('[data-permission="task.write"]').isChecked(), true);
  await editor.getByLabel('역할 이름', { exact: true }).fill('중복 이름 해결 초안');
  const retry = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/settings/roles' && r.request().method() === 'POST');
  await editor.getByRole('button', { name: '역할 생성', exact: true }).click(); assert.equal((await retry).status(), 201); await settled(page);
  const row = page.getByTestId(`role-${role.key}`);
  await row.getByRole('button', { name: '삭제', exact: true }).click();
  const changed = await api.request(fixture.actorAdmin, `/settings/roles/${role.id}`, 'PATCH', { name: role.name + ' 변경', permissions: role.permissions, scope: role.scope, expected_version: role.version });
  const deleted = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/settings/roles/${role.id}` && r.request().method() === 'DELETE');
  await row.getByRole('button', { name: '삭제 확정', exact: true }).click();
  const staleDelete = await deleted; assert.equal(staleDelete.status(), 409); assert.equal(staleDelete.request().postDataJSON().expected_version, role.version); await settled(page);
  const deleteCompare = await armDom(page, '[data-testid="role-comparison"]');
  await page.getByRole('button', { name: '최신값 비교', exact: true }).click(); await deleteCompare(); await settled(page);
  await capture(page, 'delete-compare');
  await page.getByRole('button', { name: '비교 확인 · 초안 유지', exact: true }).click();
  const confirmed = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/settings/roles/${role.id}` && r.request().method() === 'DELETE');
  await row.getByRole('button', { name: '삭제 확정', exact: true }).click();
  const confirmedResponse = await confirmed; assert.equal(confirmedResponse.status(), 204); assert.equal(confirmedResponse.request().postDataJSON().expected_version, changed.version); await settled(page);
  result.checks.push('create-without-token-duplicate-draft-recovery-delete-CAS');
  if (!fixture.actorAdmin.orgId.startsWith('pg:')) {
    const owner = fixture.B.actor;
    const ownerPage = await openPage(owner);
    const own = (await api.request(owner, '/settings/members')).items.find(item => item.user_id === owner.userId);
    const memberEditor = ownerPage.getByTestId('role-membership-editor');
    await memberEditor.locator('select').selectOption(own.membership_id);
    const oldOwner = memberEditor.locator('[data-role-key="owner"]');
    assert.equal(await oldOwner.isEnabled(), true, 'existing owner can be removed, not newly assigned');
    await oldOwner.uncheck(); assert.equal(await oldOwner.isDisabled(), true);
    await memberEditor.locator('[data-role-key="company_admin"]').check();
    const converted = ownerPage.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/settings/members/${own.membership_id}/roles` && r.request().method() === 'PUT');
    await memberEditor.getByRole('button', { name: '역할 배정 저장', exact: true }).click();
    assert.equal((await converted).status(), 200); await settled(ownerPage); await ownerPage.close();
    result.checks.push('legacy-owner-explicit-finite-admin-conversion');
  }
}
