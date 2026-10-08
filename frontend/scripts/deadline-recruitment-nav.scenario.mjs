import assert from 'node:assert/strict';

export async function recruitmentNav({ surface, api, fixture, rendered, result }) {
  const { actorAdmin } = fixture;

  // Retired UI must not mutate or delete records still owned by the backend.
  const posting = await api.request(actorAdmin, '/hr/postings', 'POST', { title: '보존 확인 공고' }, 201);
  const application = await api.request(actorAdmin, `/hr/postings/${posting.id}/applications`, 'POST', {
    applicant_name: '보존 확인 지원자', applicant_email: 'retired-recruitment@example.invalid',
  }, 201);
  const postingsBefore = await api.request(actorAdmin, '/hr/postings');
  const applicationsBefore = await api.request(actorAdmin, '/hr/applications');

  await surface('feature-catalog-labels', actorAdmin, '/onboarding/organization', '.onboarding-card', '/api/v1/tenants/modules/catalog', async page => {
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await page.getByLabel('조직 이름').fill('표시 검증 조직');
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await rendered(page, '.module-list');
    assert.equal(await page.getByRole('checkbox', { name: /^캘린더/ }).count(), 1);
    assert.equal(await page.getByRole('checkbox', { name: /^인사(?:\s|$)/ }).count(), 1);
    assert.equal(await page.getByText(/일정·행사|인사·채용|모집|지원자/).count(), 0);
    return { calendarLabel: '캘린더', hrLabel: '인사', recruitmentCopy: 0 };
  });

  await surface('organization-feature-labels', actorAdmin, '/settings/organization', '[data-screen-id="ORG-001"]', '/api/v1/tenants/modules', async page => {
    assert.equal(await page.getByRole('checkbox', { name: /^캘린더/ }).count(), 1);
    assert.equal(await page.getByRole('checkbox', { name: /^인사(?:\s|$)/ }).count(), 1);
    assert.equal(await page.getByText(/일정·행사|인사·채용|모집|지원자/).count(), 0);
    return { calendarLabel: '캘린더', hrLabel: '인사', recruitmentCopy: 0 };
  });

  await surface('recruitment-permissions-retired', actorAdmin, '/settings/roles', '[data-testid="role-definition-editor"]', '/api/v1/settings/roles', async page => {
    assert.equal(await page.locator('[data-permission="menu.recruitment"]').count(), 0);
    assert.equal(await page.locator('[data-permission="recruitment.manage"]').count(), 0);
    assert.equal(await page.getByText('채용 관리', { exact: true }).count(), 0);
    assert.equal(await page.getByText('모집', { exact: true }).count(), 0);
    return { recruitmentMenuPermission: 0, recruitmentActionPermission: 0 };
  });

  await surface('recruitment-route-retired', actorAdmin, '/hr/recruitment', '.not-found', null, async page => {
    assert.equal(await page.getByRole('heading', { name: '요청한 화면을 찾을 수 없습니다' }).count(), 1);
    assert.equal(await page.locator('[data-screen-id="HR-004"]').count(), 0);
    assert.equal(await page.locator('.sidebar a[href="/hr/recruitment"]').count(), 0);
    return { notFound: true, recruitmentScreen: 0 };
  });

  assert.deepEqual(await api.request(actorAdmin, '/hr/postings'), postingsBefore);
  assert.deepEqual(await api.request(actorAdmin, '/hr/applications'), applicationsBefore);
  result.recruitment = {
    postingId: posting.id,
    applicationId: application.id,
    dataPreserved: true,
    productRoute: 'retired',
    configurablePermissions: 'retired',
  };
}
