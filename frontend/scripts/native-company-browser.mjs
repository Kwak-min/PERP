import assert from 'node:assert/strict';

export async function nativeCompanyScenarios({ scenario, signIn, origin, storageKey, fixture }) {
  async function fill(page, name) {
    await page.getByRole('radio', { name: /소규모 기업/ }).click();
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await page.getByLabel('조직 이름', { exact: true }).fill(name);
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await page.getByRole('button', { name: '다음', exact: true }).click();
  }

  await scenario('native-pg-error-never-falls-back-to-sqlite', async page => {
    // Given: 실제 PG 생성 트랜잭션의 membership 쓰기 실패. When: 제출. Then: SQLite 생성 없이 원래 세션을 유지한다.
    await signIn(page, fixture.users[0].email);
    const prior = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    await page.goto(origin + '/onboarding/organization');
    await fill(page, 'QA_NATIVE_ROLLBACK');
    const posts = [];
    page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
    const saved = page.waitForResponse(response => response.url().endsWith('/pg/companies') && response.request().method() === 'POST');
    const before = fixture.state.companies.length;
    fixture.failMembership = true;
    try {
      await page.getByRole('button', { name: '조직 만들기', exact: true }).click();
      assert.equal((await saved).status(), 500);
      await page.getByRole('alert').waitFor();
      assert.deepEqual(posts, [new URL('/api/v1/pg/companies', origin).href]);
      assert.equal(fixture.state.companies.length, before);
      const retained = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
      assert.equal(retained.orgId, prior.orgId);
      assert.equal(retained.token, prior.token);
    } finally { fixture.failMembership = false; }
  });

  await scenario('pg-without-primary-company-creates-first-native-membership', async page => {
    // Given: primary 회사가 없는 PG 계정. When: welcome에서 native 회사 생성. Then: primary는 null이고 재로그인에 새 소속이 나타난다.
    const user = fixture.users[1];
    await signIn(page, user.email);
    await page.getByRole('link', { name: /새 조직 만들기/ }).click();
    await fill(page, 'QA_NATIVE_FIRST');
    const created = page.waitForResponse(response => response.url().endsWith('/pg/companies') && response.request().method() === 'POST');
    const home = page.waitForURL(origin + '/');
    await page.getByRole('button', { name: '조직 만들기', exact: true }).click();
    const response = await created;
    assert.equal(response.status(), 201);
    const company = await response.json();
    await home;
    assert.equal(user.company_id, null);
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    assert.equal(stored.orgId, company.org_id);
    assert.match(stored.orgId, /^pg:\d+$/);
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    await page.waitForURL(origin + '/login');
    await signIn(page, user.email);
    const again = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    assert.equal(again.orgId, company.org_id);
    await page.locator('.workspace-picker__button').click();
    await page.getByRole('button', { name: '브랜치 만들기', exact: true }).click();
    await page.getByLabel('브랜치 이름', { exact: true }).fill('QA_NATIVE_EXPLICIT_BRANCH');
    assert.equal(await page.locator('.branch-create input[type="checkbox"]').count(), 0, 'PG must not offer unsupported branch ACL controls');
    const department = page.waitForResponse(response => response.url().endsWith('/members/departments') && response.request().method() === 'POST');
    await page.locator('.branch-create__submit').click();
    const saved = await department;
    assert.equal(saved.status(), 201);
    assert.ok(saved.url().endsWith('/pg/members/departments'));
    assert.deepEqual(saved.request().postDataJSON(), { name: 'QA_NATIVE_EXPLICIT_BRANCH' });
    const branch = await saved.json();
    assert.ok(fixture.state.departments.some(row => row.id === branch.id && row.company_id === company.org_id.slice(3) && row.name === 'QA_NATIVE_EXPLICIT_BRANCH'));
    await page.getByRole('menuitemradio', { name: /QA_NATIVE_EXPLICIT_BRANCH/ }).waitFor();
    await page.reload();
    await page.locator('.workspace-picker__button').click();
    await page.getByRole('menuitemradio', { name: /QA_NATIVE_EXPLICIT_BRANCH/ }).waitFor();
  });
}
