import assert from 'node:assert/strict';

export async function recruitmentNav({ surface, api, fixture, rendered, result }) {
  // Given: real API-owned recruitment data and both allowed/denied actors.
  const { actorAdmin, actorManager, B } = fixture;
  const posting = await api.request(actorAdmin, '/hr/postings', 'POST', { title: '검증 모집 공고' }, 201);
  const application = await api.request(actorAdmin, `/hr/postings/${posting.id}/applications`, 'POST', {
    applicant_name: '검증 지원자', applicant_email: 'recruitment@example.invalid',
  }, 201);
  await api.request(actorAdmin, '/hr/postings', 'POST', { title: '' }, 400);
  await api.request(actorManager, '/hr/postings', 'GET', undefined, 403);
  await api.request(actorManager, `/hr/postings/${posting.id}/close`, 'POST', {}, 403);
  const before = await api.request(actorAdmin, '/hr/postings');
  const applicationsBefore = await api.request(actorAdmin, '/hr/applications');
  assert.deepEqual(before.items.map(item => item.id), [posting.id]);
  assert.deepEqual(applicationsBefore.items.map(item => item.id), [application.id]);
  const access = await api.request(actorAdmin, '/settings/access');
  assert.ok(access.menus.includes('menu.recruitment'));
  assert.ok(access.permissions.includes('recruitment.manage'));
  assert.ok(access.modules.includes('hr'));

  // 회사 선택기는 실제로 승인된 두 소속만 사용한다. B에서는 모집 권한이 없다.
  const role = await api.request(B.actor, '/settings/roles', 'POST', {
    name: '모집 접근 없음', scope: 'all', permissions: ['menu.home'],
  }, 201);
  const invitation = await api.request(B.actor, '/members/invites', 'POST', {
    email: actorAdmin.email, roles: [role.key],
  }, 201);
  await api.request(actorAdmin, '/auth/invitations/accept', 'POST', { token: invitation.token }, 201);
  const me = await api.request(actorAdmin, '/auth/me');
  const switchingActor = { ...actorAdmin, session: { ...actorAdmin.session, organizations: me.organizations } };
  const navCounts = [];
  const inspectNavigation = async page => {
    const count = await page.locator('.sidebar a[href="/hr/recruitment"]').count();
    navCounts.push(count);
    assert.ok(await page.locator('.sidebar a[href="/members"]').count() > 0);
    return count;
  };

  // When: opening the existing URL, reloading it, and switching company through the real UI.
  await surface('recruitment-authorized', switchingActor, '/hr/recruitment', '.recruitment-card', '/api/v1/hr/applications', async page => {
    assert.equal(await page.locator('[data-screen-id="HR-004"]').count(), 1);
    assert.ok((await page.locator('.recruitment-card').innerText()).includes(application.applicant_name));
    assert.equal(await page.locator(`.posting-list option[value="${posting.id}"]`).count(), 1);
    const recruitmentLinks = await inspectNavigation(page);
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/hr/applications');
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal((await response).status(), 200);
    await rendered(page, '.recruitment-card');
    await inspectNavigation(page);

    await page.locator('.workspace-picker__button').click();
    const deniedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/settings/access'
      && response.request().headers()['x-org-id'] === B.id);
    await page.getByRole('menuitemradio').filter({ hasText: 'DEADLINE_B' }).click();
    assert.equal((await deniedResponse).status(), 200);
    await rendered(page, '[data-testid="screen-access-denied"]');
    assert.equal(await page.locator('[data-screen-id="HR-004"]').count(), 0);
    assert.equal(await page.locator('.sidebar a[href="/hr/recruitment"]').count(), 0);
    assert.equal(new URL(page.url()).pathname, '/hr/recruitment');

    await page.locator('.workspace-picker__button').click();
    const restoredResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/hr/applications'
      && response.request().headers()['x-org-id'] === actorAdmin.orgId);
    await page.getByRole('menuitemradio').filter({ hasText: 'DEADLINE_A' }).click();
    assert.equal((await restoredResponse).status(), 200);
    await rendered(page, '.recruitment-card');
    await inspectNavigation(page);
    return { recruitmentLinks, postingId: posting.id, applicationId: application.id, reload: 'preserved', scopeSwitch: 'A allowed / B denied / A restored' };
  });
  await surface('recruitment-sidebar-members', actorAdmin, '/members', '.org-directory__table tbody tr', '/api/v1/members', async page => ({ recruitmentLinks: await inspectNavigation(page) }));
  await surface('recruitment-denied', actorManager, '/hr/recruitment', '[data-testid="screen-access-denied"]', '/api/v1/settings/access', async page => {
    assert.equal(await page.locator('[data-screen-id="HR-004"]').count(), 0);
    assert.equal(await page.locator('.sidebar a[href="/hr/recruitment"]').count(), 0);
    return { directApiStatus: 403, screenMounted: false };
  });
  await surface('recruitment-empty-company-b', B.actor, '/hr/recruitment', '.recruitment-pipeline', '/api/v1/hr/applications', async page => {
    assert.equal(await page.locator('.recruitment-card').count(), 0);
    assert.equal(await page.locator('.posting-list option').count(), 1);
    navCounts.push(await page.locator('.sidebar a[href="/hr/recruitment"]').count());
    return { postingCount: 0, applicationCount: 0 };
  });

  // Then: no read/navigation operation or denied/malformed write changed existing records.
  assert.deepEqual(await api.request(actorAdmin, '/hr/postings'), before);
  assert.deepEqual(await api.request(actorAdmin, '/hr/applications'), applicationsBefore);
  assert.deepEqual((await api.request(B.actor, '/hr/postings')).items, []);
  result.recruitment = { navCounts, postingId: posting.id, applicationId: application.id, dataPreserved: true,
    favorites: 'No favorites surface exists in this base; non-nav is excluded at the shared navigation catalog. Tasks 4/5 own persistence/rendering.' };
  // 끝에서 검사하여 RED도 실제 직접 경로/권한/회사 전환과 화면 캡처를 보존한다.
  assert.deepEqual(navCounts, navCounts.map(() => 0), 'authorized sidebar must contain zero recruitment links');
}
