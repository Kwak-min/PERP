import assert from 'node:assert/strict';
import path from 'node:path';
import { COMPANY_PERMISSIONS } from '../../backend/src/config/rbac.js';

export async function roleCases({ page, openPage, api, fixture, role, result, attempt, armDom }) {
  const admin = fixture.actorAdmin, target = fixture.actorMember, backup = fixture.actorManager;
  const native = admin.orgId.startsWith('pg:');
  const endpoint = `/api/v1/settings/roles/${role.id}`;
  const definition = p => p.getByTestId('role-definition-editor');
  const membership = p => p.getByTestId('role-membership-editor');
  async function settled(p, selector = '.role-settings[aria-busy="false"]') { const wait = await armDom(p, selector); await wait(); }
  async function capture(p, name) {
    await p.bringToFront();
    for (const width of [375, 768, 1280]) {
      await p.setViewportSize({ width, height: 900 }); await p.evaluate(() => { window.scrollTo({ top: 0, behavior: 'instant' }); return document.fonts.ready; });
      const file = path.join(attempt, `${name}-${width}.png`);
      await p.screenshot({ path: file, fullPage: true, animations: 'disabled' });
      const geometry = await p.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
      result.screens.push({ name, width, file, geometry }); assert.ok(geometry.width <= width, `${name}: horizontal overflow ${geometry.width}/${width}`);
    }
  }
  async function assign(actor, who, keys) {
    const rows = await api.request(actor, '/settings/members');
    const member = rows.items.find(item => item.user_id === who.userId);
    who.membershipId = member.membership_id;
    return api.request(actor, `/settings/members/${member.membership_id}/roles`, 'PUT', { roles: keys, expected_roles_version: member.roles_version });
  }
  async function saveDefinition(p, expected = 200) {
    const response = p.waitForResponse(r => new URL(r.url()).pathname === endpoint && r.request().method() === 'PATCH');
    await definition(p).getByRole('button', { name: '역할 저장', exact: true }).click();
    const saved = await response; assert.equal(saved.status(), expected); await settled(p); return saved;
  }
  await settled(page);
  // Given: 실제 정의 DTO. When: 독립 토글을 키보드로 조작. Then: 저장 전 HTTP 쓰기 없음.
  assert.equal(await page.locator('[data-permission-kind="delegation"] [data-permission="role.assign"]').count(), 1);
  assert.equal(await page.locator('[data-permission-kind="action"] [data-permission="role.assign"]').count(), 0);
  const beforeRequests = result.responses.filter(item => item.method !== 'GET').length;
  const menu = page.locator('[data-permission="menu.roles"]'), delegation = page.locator('[data-permission="role.assign"]');
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await menu.focus(); await page.keyboard.press('Space'); assert.equal(await menu.isChecked(), true); assert.equal(await delegation.isChecked(), false);
    assert.equal(await menu.evaluate(input => getComputedStyle(input).outlineWidth), '2px');
    await page.keyboard.press('Space'); assert.equal(await menu.isChecked(), false);
    await page.keyboard.press('Tab'); assert.equal(await menu.evaluate(input => document.activeElement === input), false);
  }
  assert.equal(result.responses.filter(item => item.method !== 'GET').length, beforeRequests);
  result.checks.push('keyboard-independent-menu-action-delegation-no-auto-write');
  await (await import('./deadline-role-definition.cases.mjs')).definitionCases({ page, openPage, api, fixture, armDom, result, capture });
  await definition(page).getByRole('button', { name: /관리자 프리셋/ }).click();
  assert.deepEqual(new Set(await page.locator('[data-permission]:checked').evaluateAll(inputs => inputs.map(input => input.dataset.permission))), new Set(COMPANY_PERMISSIONS));
  assert.equal(await definition(page).locator('select').inputValue(), 'all');
  await capture(page, 'administrator-preset');
  // 선택만 했으므로 저장된 정의는 그대로다.
  assert.deepEqual(new Set((await api.request(admin, '/settings/roles')).items.find(item => item.id === role.id).permissions), new Set(['task.read', 'menu.projects']));
  await page.locator(`[data-testid="role-${role.key}"]`).getByRole('button', { name: '수정', exact: true }).click();
  const other = await openPage();
  await other.locator(`[data-testid="role-${role.key}"]`).getByRole('button', { name: '수정', exact: true }).click();
  await page.getByLabel('역할 이름', { exact: true }).fill('탭 A 저장');
  await other.getByLabel('역할 이름', { exact: true }).fill('탭 B 보존 초안');
  await other.locator('[data-permission="task.write"]').check();
  // 실제 서버 응답 전달을 잡고 pending을 관찰한다. 응답 자체는 mock하지 않는다.
  let release, arrived, arrivalTimer;
  const arrival = new Promise((resolve, reject) => {
    arrivalTimer = setTimeout(() => reject(new Error('real PATCH response barrier missing')), 15000);
    arrived = () => { clearTimeout(arrivalTimer); resolve(); };
  });
  const gate = new Promise(resolve => { release = resolve; });
  const handler = async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response });
  };
  await page.route('**/api/v1/settings/roles/' + role.id, handler);
  const saving = Promise.allSettled([saveDefinition(page)]);
  try {
    await arrival;
    assert.equal(await page.locator('.role-settings input:enabled, .role-settings select:enabled, .role-settings button:enabled').count(), 0);
    await capture(page, 'pending');
  } finally { clearTimeout(arrivalTimer); release(); }
  const [outcome] = await saving;
  if (outcome.status === 'rejected') throw outcome.reason;
  await page.unroute('**/api/v1/settings/roles/' + role.id, handler);
  result.checks.push('pending-lock-real-response-barrier');
  const stale = await saveDefinition(other, 409); assert.equal(stale.request().postDataJSON().expected_version, 2);
  assert.equal(await other.getByLabel('역할 이름', { exact: true }).inputValue(), '탭 B 보존 초안');
  assert.equal(await other.locator('[data-permission="task.write"]').isChecked(), true);
  assert.equal(await definition(other).getByRole('button', { name: '역할 저장', exact: true }).isDisabled(), true);
  const compare = await armDom(other, '[data-testid="role-comparison"]');
  await other.getByRole('button', { name: '최신값 비교', exact: true }).click(); await compare(); await settled(other);
  await capture(other, 'stale-compare');
  await other.getByRole('button', { name: '비교 확인 · 초안 유지', exact: true }).click();
  assert.equal(await other.getByLabel('역할 이름', { exact: true }).inputValue(), '탭 B 보존 초안');
  const newSave = await saveDefinition(other); assert.equal(newSave.request().postDataJSON().expected_version, 3);
  assert.equal((await newSave.json()).version, 4);
  result.checks.push('two-tab-409-draft-preserved-explicit-compare-new-CAS-save');
  const overlap = await api.request(admin, '/settings/roles', 'POST', { name: '겹치는 읽기 출처', scope: 'all', permissions: ['task.read'] }, 201);
  await assign(admin, backup, ['company_admin']);
  await assign(admin, target, [role.key, overlap.key]);
  await other.close();
  const membersPage = await openPage();
  await membership(membersPage).locator('select').selectOption(target.membershipId);
  await membersPage.locator('.role-settings__sources summary').click();
  const source = membersPage.locator('[data-effective-permission="task.read"]');
  assert.ok((await source.innerText()).includes(overlap.name)); assert.ok((await source.innerText()).includes('탭 B 보존 초안'));
  await membership(membersPage).locator(`[data-role-key="${overlap.key}"]`).uncheck();
  const memberEndpoint = `/api/v1/settings/members/${target.membershipId}/roles`;
  const oldVersion = Number(await membership(membersPage).getAttribute('data-version'));
  // Legacy의 상태 변경도 동일한 독립 역할 버전을 변경한다. PG에는 상태 UI/API가 없어 배정 경합을 검증한다.
  if (!native) {
    const inactive = await api.request(admin, `/members/${target.membershipId}/status`, 'PATCH', { status: 'inactive', expected_roles_version: oldVersion });
    await api.request(admin, `/members/${target.membershipId}/status`, 'PATCH', { status: 'active', expected_roles_version: inactive.roles_version });
    result.checks.push('legacy-active-status-change-invalidates-membership-token');
  } else await assign(admin, target, [overlap.key]);
  const staleMember = membersPage.waitForResponse(r => new URL(r.url()).pathname === memberEndpoint && r.request().method() === 'PUT');
  await membership(membersPage).getByRole('button', { name: '역할 배정 저장', exact: true }).click();
  assert.equal((await staleMember).status(), 409); await settled(membersPage);
  assert.equal(await membership(membersPage).locator(`[data-role-key="${overlap.key}"]`).isChecked(), false);
  const memberCompare = await armDom(membersPage, '[data-testid="role-comparison"]');
  await membersPage.getByRole('button', { name: '최신값 비교', exact: true }).click(); await memberCompare(); await settled(membersPage);
  await membersPage.getByRole('button', { name: '비교 확인 · 초안 유지', exact: true }).click();
  const expected = Number(await membership(membersPage).getAttribute('data-version'));
  const memberSaved = membersPage.waitForResponse(r => new URL(r.url()).pathname === memberEndpoint && r.request().method() === 'PUT');
  await membership(membersPage).getByRole('button', { name: '역할 배정 저장', exact: true }).click();
  const memberResponse = await memberSaved; assert.equal(memberResponse.status(), 200); assert.equal(memberResponse.request().postDataJSON().expected_roles_version, expected); await settled(membersPage);
  assert.ok(!(await membersPage.locator('[data-effective-permission="task.read"]').innerText()).includes(overlap.name));
  await capture(membersPage, 'membership-union');
  result.checks.push('membership-CAS-conflict-preserves-draft-union-sources-update');
  // 동일 최신 버전의 no-op은 토큰을 증가시키지 않는다.
  const stableVersion = Number(await membership(membersPage).getAttribute('data-version'));
  const noop = membersPage.waitForResponse(r => new URL(r.url()).pathname === memberEndpoint && r.request().method() === 'PUT');
  await membership(membersPage).getByRole('button', { name: '역할 배정 저장', exact: true }).click();
  assert.equal((await (await noop).json()).roles_version, stableVersion); await settled(membersPage);
  result.checks.push('membership-noop-exact-version');
  await (await import('./deadline-role-boundaries.cases.mjs')).roleBoundaries({ api, fixture, result, openPage, capture });
  // 다른 실제 전체 관리자가 있는 상태에서 자기 위임만 회수한다. menu.roles는 남아 편집 종료 상태를 볼 수 있다.
  const selfRole = await api.request(admin, '/settings/roles', 'POST', { name: '위임 없는 회사 역할', scope: 'all', permissions: COMPANY_PERMISSIONS.filter(code => code !== 'role.assign') }, 201);
  await membersPage.close();
  const selfPage = await openPage();
  const own = (await api.request(admin, '/settings/members')).items.find(item => item.user_id === admin.userId);
  await membership(selfPage).locator('select').selectOption(own.membership_id);
  for (const input of await membership(selfPage).locator('[data-role-key]:checked').all()) await input.uncheck();
  await membership(selfPage).locator(`[data-role-key="${selfRole.key}"]`).check();
  await selfPage.evaluate(() => {
    window.roleTimeline = [];
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-testid="role-save-receipt"]') && !window.roleTimeline.includes('receipt')) window.roleTimeline.push('receipt');
      if (document.querySelector('[data-testid="role-editor-closed"]') && !window.roleTimeline.includes('closed')) window.roleTimeline.push('closed');
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const original = window.fetch;
    window.fetch = (...args) => { if (String(args[0]).endsWith('/settings/access')) window.roleTimeline.push(document.querySelector('[data-testid="role-save-receipt"]') ? 'access-after-receipt' : 'access-before-receipt'); return original(...args); };
  });
  const closed = await armDom(selfPage, '[data-testid="role-editor-closed"]');
  const revoked = selfPage.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/settings/members/${own.membership_id}/roles` && r.request().method() === 'PUT');
  await membership(selfPage).getByRole('button', { name: '역할 배정 저장', exact: true }).click();
  assert.equal((await revoked).status(), 200); await closed();
  const timeline = await selfPage.evaluate(() => window.roleTimeline);
  assert.ok(timeline.includes('access-after-receipt')); assert.ok(!timeline.includes('access-before-receipt'));
  assert.equal(await selfPage.getByTestId('role-definition-editor').count(), 0);
  await api.request(admin, '/settings/roles', 'GET', undefined, 403);
  await capture(selfPage, 'self-revoked');
  result.timeline = timeline; result.checks.push('self-revoke-200-receipt-before-access-refresh-editor-closed');
  // 백업 관리자의 명시적 재배정 후 메뉴까지 전부 회수해 AppShell의 실제 접근 경계를 검증한다.
  await assign(backup, admin, ['company_admin']);
  const fullPage = await openPage();
  await membership(fullPage).locator('select').selectOption(own.membership_id);
  for (const input of await membership(fullPage).locator('[data-role-key]:checked').all()) await input.uncheck();
  await fullPage.evaluate(() => {
    window.receiptsAtAccess = [];
    const original = window.fetch;
    window.fetch = (...args) => { if (String(args[0]).endsWith('/settings/access')) window.receiptsAtAccess.push(Boolean(document.querySelector('[data-testid="role-save-receipt"]'))); return original(...args); };
  });
  const denied = await armDom(fullPage, '[data-testid="screen-access-denied"]');
  const removed = fullPage.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/settings/members/${own.membership_id}/roles` && r.request().method() === 'PUT');
  await membership(fullPage).getByRole('button', { name: '역할 배정 저장', exact: true }).click();
  assert.equal((await removed).status(), 200); await denied();
  assert.equal((await fullPage.evaluate(() => window.receiptsAtAccess))[0], true);
  assert.equal(await fullPage.getByTestId('role-membership-editor').count(), 0);
  await capture(fullPage, 'self-revoked-all-menus');
  result.checks.push('self-revoke-all-menus-200-receipt-before-real-shell-denial');
  await page.close(); await selfPage.close(); await fullPage.close();
}
