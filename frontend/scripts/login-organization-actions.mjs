import assert from 'node:assert/strict';
import path from 'node:path';
import { api } from '../../backend/tests/http.js';

export async function creationAndNavigationScenarios(qa) {
  const { scenario, signIn, sessionOf, server, origin, storageKey, evidence, member, first, empty, pgUser, fixture } = qa;
  async function seedSession(page) {
    const authenticated = await api(server.baseUrl, '/auth/login', { method: 'POST', body: { email: member.email, password: 'password-1234' } });
    assert.equal(authenticated.status, 200);
    const prior = await sessionOf({ ...member, token: authenticated.body.access_token }, first);
    await page.goto(origin + '/login');
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: prior });
    await page.goto(origin + '/');
    return prior;
  }

  await scenario('demo-toggle-removed', async page => {
    // Given: 로그인된 앱 셸. When: 렌더링. Then: 데모 전환 버튼이 없다.
    await seedSession(page);
    await page.locator('.workspace-picker__button').waitFor();
    assert.equal(await page.getByRole('button', { name: /^데모 (ON|OFF)$/ }).count(), 0);
  });

  for (const [route, expected] of [
    ['/vault/graph', '/vault/graph'], ['/vault', '/vault'],
    ['/documents/graph', '/documents/graph'], ['/documents', '/documents'],
    ['/documents/qa-detail', '/documents'], ['/projects/qa-detail', '/projects'],
  ]) await scenario('navigation-' + route.slice(1).replaceAll('/', '-'), async page => {
    // Given: 로그인 세션. When: 목록/그래프/상세 경로 진입. Then: 가장 구체적인 메뉴만 활성화한다.
    await seedSession(page);
    await page.goto(origin + route);
    await page.locator('.workspace-picker__button').waitFor();
    const active = await page.getByRole('navigation', { name: '주 메뉴', exact: true }).locator('a[aria-current="page"]').evaluateAll(links => links.map(link => link.getAttribute('href')));
    assert.deepEqual(active, [expected]);
  });

  for (const mode of ['legacy', 'pg-native-fixture']) await scenario(mode + '-add-company-create-relogin', async page => {
    // Given: 기존 회사 로그인. When: 회사 추가/생성. Then: 서버 소속과 새 선택이 재로그인 후에도 남는다.
    let prior;
    if (mode === 'legacy') prior = await seedSession(page);
    else {
      await signIn(page, pgUser.email);
      prior = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
      assert.equal(prior.orgId, 'pg:77');
    }
    await page.locator('.workspace-picker__button').click();
    const add = page.getByRole('menuitem', { name: '조직 추가', exact: true });
    await add.waitFor();
    if (mode === 'legacy') {
      for (const width of [375, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const sidebar = page.locator('.sidebar');
        if (width < 1280 && !(await sidebar.evaluate(element => element.classList.contains('sidebar--open')))) {
          await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
        }
        if (!(await add.isVisible())) await page.locator('.workspace-picker__button').click();
        assert.ok((await add.boundingBox()).height >= 44, 'add organization has a mobile-sized touch target');
        await page.screenshot({ path: path.join(evidence, 'add-organization-' + width + '.png') });
      }
    }
    await page.locator('.workspace-picker__button').focus();
    for (let index = 0; index <= prior.organizations.length; index++) await page.keyboard.press('Tab');
    assert.equal(await add.evaluate(element => element === document.activeElement), true);
    const entered = page.waitForURL(origin + '/onboarding/organization');
    await page.keyboard.press('Enter');
    await entered;
    const retained = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    assert.equal(retained.token, prior.token);
    assert.equal(retained.orgId, prior.orgId);
    await page.getByRole('radio', { name: /소규모 기업/ }).click();
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await page.getByLabel('조직 이름', { exact: true }).fill('QA_ADDED_' + mode);
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await page.getByRole('button', { name: '다음', exact: true }).click();
    const saved = page.waitForResponse(response => /\/api\/v1\/(tenants|pg\/companies)$/.test(response.url()) && response.request().method() === 'POST');
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/me'));
    const home = page.waitForURL(origin + '/');
    await page.getByRole('button', { name: '조직 만들기', exact: true }).click();
    const response = await saved;
    assert.equal(response.status(), 201);
    assert.ok(response.url().endsWith(mode === 'legacy' ? '/api/v1/tenants' : '/api/v1/pg/companies'), 'PG company creation cannot submit to SQLite');
    assert.equal(response.request().headers()['x-org-id'], undefined);
    const created = await response.json();
    assert.equal((await refreshed).status(), 200);
    await home;
    const current = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    assert.equal(current.token, prior.token);
    assert.equal(current.orgId, created.org_id);
    const memberships = await api(server.baseUrl, mode === 'legacy' ? '/auth/me' : '/pg/auth/workspace', { token: prior.token });
    assert.equal(memberships.status, 200);
    const owned = memberships.body.organizations.find(org => org.org_id === created.org_id);
    assert.deepEqual(owned.roles, mode === 'legacy' ? ['owner'] : ['company_creator']);
    const principal = await api(server.baseUrl, mode === 'legacy' ? '/auth/principal' : '/pg/members', { token: prior.token, orgId: created.org_id });
    assert.equal(principal.status, 200);
    assert.deepEqual(mode === 'legacy' ? principal.body.roles : principal.body.items[0].roles, mode === 'legacy' ? ['owner'] : ['company_creator']);
    assert.ok(current.organizations.some(org => org.org_id === created.org_id));
    if (mode !== 'legacy') {
      assert.ok(current.organizations.some(org => org.org_id === 'pg:77'));
      assert.match(created.org_id, /^pg:\d+$/);
      assert.equal(fixture.users[0].company_id, '77');
      assert.deepEqual((await api(server.baseUrl, '/auth/me', { token: prior.token })).body.organizations, []);
      assert.equal(fixture.queries.some(query => /INSERT INTO org\.companies/.test(query.sql)), true);
      const pgPermission = await api(server.baseUrl, '/pg/members', { token: prior.token, orgId: 'pg:77' });
      assert.equal(pgPermission.status, 403, 'new company ownership cannot elevate original company grants');
    }
    await page.locator('.workspace-picker__button').click();
    await page.getByRole('menuitemradio', { name: new RegExp('QA_ADDED_' + mode) }).waitFor();
    await page.screenshot({ path: path.join(evidence, mode + '-created.png') });
    await page.locator('.workspace-picker__button').click();
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    await page.waitForURL(origin + '/login');
    await signIn(page, mode === 'legacy' ? member.email : pgUser.email);
    const relogged = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    assert.equal(relogged.orgId, mode === 'legacy' ? first : 'pg:77');
    assert.ok(relogged.organizations.some(org => org.org_id === created.org_id));
    const denied = await api(server.baseUrl, '/tenants/current', { token: empty.token, orgId: created.org_id });
    assert.equal(denied.status, 403);
    if (mode !== 'legacy') {
      await page.locator('.workspace-picker__button').click();
      await page.getByRole('menuitemradio', { name: new RegExp('QA_ADDED_' + mode) }).click();
      await signIn(page, pgUser.email);
      const selected = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
      assert.equal(selected.orgId, created.org_id, 'selected secondary PG membership survives reauthentication');
    }
  });

  await scenario('creation-refresh-retry-does-not-duplicate', async page => {
    // Given: 생성 성공 후 소속 조회만 실패. When: 재확인. Then: 생성 POST 없이 기존 조직에 진입한다.
    const prior = await seedSession(page);
    await page.goto(origin + '/onboarding/organization');
    await page.getByRole('radio', { name: /소규모 기업/ }).click();
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await page.getByLabel('조직 이름', { exact: true }).fill('QA_REFRESH_RETRY');
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await page.getByRole('button', { name: '다음', exact: true }).click();
    let posts = 0;
    page.on('request', request => { if (request.url().endsWith('/api/v1/tenants') && request.method() === 'POST') posts++; });
    await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'QA lookup unavailable' } } }), { times: 1 });
    const saved = page.waitForResponse(response => response.url().endsWith('/api/v1/tenants') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '조직 만들기', exact: true }).click();
    const created = await (await saved).json();
    await page.getByRole('alert').waitFor();
    const retained = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    assert.equal(retained.orgId, prior.orgId);
    const home = page.waitForURL(origin + '/');
    await page.locator('.onboarding-actions button').last().click();
    await home;
    assert.equal(posts, 1);
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    assert.equal(stored.orgId, created.org_id);
  });
}
