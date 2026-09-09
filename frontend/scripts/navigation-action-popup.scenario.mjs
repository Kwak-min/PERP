import assert from 'node:assert/strict';
import path from 'node:path';

// 실행 환경과 합성 API는 기존 탐색 회귀와 공유한다. 모든 비동기 변경은 동작 전에 구독한다.
export function actionPopupTests({ test, surface, openSidebar, openActions, chooseAction, change, arm, signal, ids, evidence, resources }) {
  for (const width of [375, 768, 1280]) test(`personal hide/restore, unified rows and popup input at ${width}`, async () => {
    const { page, context, errors } = await surface(width);
    const writes = [];
    page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(new URL(request.url()).pathname); });
    try {
      await openSidebar(page, width);
      const pin = page.locator('.nav-group [data-favorite-screen-id="PRJ-001"]');
      const row = pin.locator('..');
      const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
      await page.locator('.workspace-picker__button').focus(); await page.mouse.move(width - 1, 899);
      assert.equal(await pin.evaluate(node => getComputedStyle(node).opacity), coarse ? '1' : '0');
      await page.screenshot({ path: path.join(evidence, `popup-rest-${width}.png`), animations: 'disabled' });
      await row.hover();
      await page.screenshot({ path: path.join(evidence, `popup-hover-${width}.png`), animations: 'disabled' });
      assert.equal(await pin.evaluate(node => getComputedStyle(node).opacity), '1', JSON.stringify(await row.evaluate(node => ({ hover: node.matches(':hover'), box: node.getBoundingClientRect().toJSON() }))));
      await row.locator('a').focus(); await page.mouse.move(width - 1, 899);
      assert.equal(await pin.evaluate(node => getComputedStyle(node).opacity), '1');
      await page.screenshot({ path: path.join(evidence, `popup-focus-${width}.png`), animations: 'disabled' });
      const before = await page.evaluate(() => ({ url: location.href, history: history.length, storage: JSON.stringify(localStorage) }));
      await openActions(page, 'PRJ-001', '.nav-group', 'click');
      assert.deepEqual(await page.evaluate(() => ({ url: location.href, history: history.length, storage: JSON.stringify(localStorage) })), before);
      assert.equal(await pin.getAttribute('aria-haspopup'), 'menu');
      assert.equal(await pin.getAttribute('aria-controls'), await page.locator('.nav-action-popup').getAttribute('id'));
      assert.equal(await page.locator('[data-nav-action="favorite"]').evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('End');
      assert.equal(await page.locator('[data-nav-action="hide"]').evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.locator('[data-nav-action="favorite"]').evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('ArrowUp'); await page.keyboard.press('Home');
      assert.equal(await page.locator('[data-nav-action="favorite"]').evaluate(node => node === document.activeElement), true);
      const menuBox = await page.locator('.nav-action-popup').boundingBox();
      const navBox = await page.locator('.sidebar > nav').boundingBox();
      assert.ok(menuBox.x >= navBox.x && menuBox.x + menuBox.width <= navBox.x + navBox.width);
      assert.ok(menuBox.y >= navBox.y && menuBox.y + menuBox.height <= navBox.y + navBox.height);
      if (coarse) {
        const sizes = await page.locator('.nav-action-popup button, .nav-entry > button').evaluateAll(nodes => nodes.map(node => {
          const rect = node.getBoundingClientRect(); return [rect.width, rect.height];
        }));
        assert.ok(sizes.every(([w, h]) => w >= 44 && h >= 44));
      }
      await page.screenshot({ path: path.join(evidence, `popup-open-${width}.png`), animations: 'disabled' });
      await change(page, '.nav-action-popup', () => page.keyboard.press('Escape'), 0);
      assert.equal(await pin.evaluate(node => node === document.activeElement), true);
      if (width <= 1100) assert.equal(await page.locator('.sidebar[aria-modal="true"]').count(), 1);
      await openActions(page, 'PRJ-001');
      await change(page, '.nav-action-popup', () => page.keyboard.press('Tab'), 0);
      assert.equal(await page.locator('.sidebar').evaluate(node => node.contains(document.activeElement)), true);
      await openActions(page, 'PRJ-001');
      await change(page, '.nav-action-popup', () => page.locator('.sidebar__brand').click({ position: { x: 2, y: 2 } }), 0);
      assert.equal(await pin.evaluate(node => node === document.activeElement), true);
      assert.deepEqual(await ids(page), []);
      await chooseAction(page, 'PRJ-001', 'favorite', '.nav-group');
      assert.deepEqual(await ids(page), ['PRJ-001']);
      const favoriteRow = page.locator('.nav-favorites .nav-entry');
      assert.equal((await favoriteRow.boundingBox()).height, (await row.boundingBox()).height);
      // 동일한 선택 상태일 때 두 행 전체가 같은 표면을 갖는다.
      const navigation = page.waitForURL(url => url.pathname === '/projects');
      await change(page, '#main-content [data-screen-id="PRJ-001"]', () => row.locator('a').click()); await navigation;
      await arm(page, '[data-pref-status="ready"]'); await signal(page);
      await openSidebar(page, width);
      await page.locator('.workspace-picker__button').focus(); await page.mouse.move(width - 1, 899);
      assert.equal(await favoriteRow.evaluate(node => getComputedStyle(node).backgroundColor), await row.evaluate(node => getComputedStyle(node).backgroundColor));
      assert.equal(await row.locator('a').getAttribute('aria-current'), 'page');
      const url = page.url();
      await chooseAction(page, 'PRJ-001', 'hide');
      assert.equal(page.url(), url);
      assert.equal(await page.locator('.nav-entry a[href="/projects"], .mobile-nav a[href="/projects"]').count(), 0);
      assert.equal(await page.locator('[data-testid="screen-access-denied"]').count(), 0);
      assert.equal(await page.locator('.nav-hidden-manager').evaluate(node => node === document.activeElement), true);
      const stored = await page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([key]) => key.startsWith('orbitflow.nav.v1:'))[1]));
      assert.deepEqual(stored.favoriteScreenIds, ['PRJ-001']); assert.deepEqual(stored.hiddenScreenIds, ['PRJ-001']);
      await page.reload(); await arm(page, '[data-pref-status="ready"]'); await signal(page);
      await openSidebar(page, width);
      assert.equal(await page.locator('.nav-entry a[href="/projects"], .mobile-nav a[href="/projects"]').count(), 0);
      assert.equal(await page.locator('[data-testid="screen-access-denied"]').count(), 0);
      await change(page, '#nav-hidden-items:not([hidden])', () => page.locator('.nav-hidden-manager').click());
      assert.equal(await page.locator('[data-hidden-screen-id="PRJ-001"]').count(), 1);
      await page.screenshot({ path: path.join(evidence, `popup-restore-${width}.png`), animations: 'disabled' });
      await change(page, '.nav-favorites a', () => page.locator('[data-hidden-screen-id="PRJ-001"] button').click());
      assert.deepEqual(await ids(page), ['PRJ-001']);
      assert.equal(await page.locator('.nav-group a[href="/projects"]').count(), 1);
      await page.locator('.nav-hidden-manager').click();
      const homeId = await page.locator('.nav-group a[href="/"]').getAttribute('data-screen-id');
      await openActions(page, homeId);
      assert.equal(await page.locator('[data-nav-action="hide"]').count(), 0);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('a button, button a, button button, a a').count(), 0);
      assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  for (const width of [375, 768, 1280]) test(`footer settings gear is the authorized persistent settings entry at ${width}`, async () => {
    const { page, context, errors } = await surface(width);
    try {
      await openSidebar(page, width);
      await chooseAction(page, 'CAL-001', 'favorite', '.nav-group');
      const gear = page.locator('.user-block').getByRole('link', { name: '설정', exact: true });
      assert.equal(await gear.count(), 1);
      assert.equal(await page.locator('.nav-group a[href="/settings"]').count(), 0);
      const box = await gear.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
      const email = await page.locator('.user-block small').boundingBox();
      assert.ok(box.x >= email.x + email.width && box.y <= email.y && box.y + box.height >= email.y + email.height);
      await gear.focus();
      assert.equal(await gear.evaluate(node => node.matches(':focus-visible')), true);
      await page.screenshot({ path: path.join(evidence, `settings-gear-${width}.png`), animations: 'disabled' });
      const navigation = page.waitForURL(url => url.pathname === '/settings');
      await gear.click(); await navigation;
      await arm(page, '.settings-links a[href="/settings/ai-key"]'); await signal(page);
      if (width <= 1100) assert.equal(await page.locator('.sidebar[hidden]').count(), 1);
      const keyNavigation = page.waitForURL(url => url.pathname === '/settings/ai-key');
      await change(page, '.api-key-settings[data-screen-id="SET-002"]', () => page.locator('.settings-links a[href="/settings/ai-key"]').click()); await keyNavigation;
      await arm(page, '[data-pref-status="ready"]'); await signal(page);
      assert.equal(await page.locator('[data-testid="screen-access-denied"]').count(), 0);
      await openSidebar(page, width);
      // 이전 브라우저 값이 설정을 숨겨도 필수 gear는 권한만 따른다.
      await change(page, '.nav-group a[href="/calendar"]', () => page.evaluate(() => {
        const key = Object.keys(localStorage).find(key => key.startsWith('orbitflow.nav.v1:'));
        const pref = JSON.parse(localStorage.getItem(key));
        localStorage.setItem(key, JSON.stringify({ ...pref, hiddenScreenIds: ['CAL-001', 'SET-003'] }));
        window.dispatchEvent(new StorageEvent('storage', { key }));
      }), 0);
      assert.equal(await gear.count(), 1);
      await page.route('**/api/v1/settings/access', async route => {
        const response = await route.fetch(); const payload = await response.json();
        await route.fulfill({ response, json: { ...payload, permissions: [], menus: payload.menus.filter(menu => menu !== 'menu.settings') } });
      });
      await change(page, '.user-block a[href="/settings"]', () => page.evaluate(() => window.dispatchEvent(new Event('orbitflow:access-changed'))), 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  test('coarse pointer remains discoverable at desktop width; token and query changes dismiss actions', async () => {
    const { fixture } = resources();
    const { page, context } = await surface(1280, '/members', undefined, true);
    try {
      const pin = page.locator('.nav-group [data-favorite-screen-id="PRJ-001"]');
      await page.locator('.workspace-picker__button').focus(); await page.mouse.move(1279, 899);
      assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
      assert.equal(await pin.evaluate(node => getComputedStyle(node).opacity), '1');
      const box = await pin.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
      await openActions(page, 'PRJ-001');
      await change(page, '.nav-action-popup', () => page.evaluate(session => {
        sessionStorage.setItem('orbitflow.session.v1', JSON.stringify(session));
        window.dispatchEvent(new StorageEvent('storage', { key: 'orbitflow.session.v1' }));
      }, fixture.actorManager.session), 0);
      await arm(page, '[data-pref-status="ready"]'); await signal(page);
      assert.equal(await pin.count(), 1);
      const navigation = page.waitForURL(url => url.pathname === '/projects');
      await change(page, '#main-content [data-screen-id="PRJ-001"]', () => pin.locator('..').locator('a').click()); await navigation;
      await arm(page, '[data-pref-status="ready"]'); await signal(page);
      // 실제 검색 제출로 history를 만든 뒤 팝업이 열린 채 브라우저 뒤로 가기를 실행한다.
      await page.getByRole('combobox', { name: '검색 범위', exact: true }).selectOption('/projects');
      await page.getByRole('searchbox', { name: '전역 검색', exact: true }).fill('popup-query');
      const queryNavigation = page.waitForURL(url => url.searchParams.get('q') === 'popup-query');
      await change(page, '.project-tasks__search input', () => page.locator('.global-search__submit').click(), 1, 'value', 'popup-query');
      await queryNavigation;
      await openActions(page, 'PRJ-001');
      const back = page.waitForURL(url => url.pathname === '/projects' && !url.searchParams.has('q'));
      await change(page, '.nav-action-popup', () => page.goBack(), 0); await back;
      assert.equal(await page.locator('.nav-action-popup').count(), 0);
    } finally { await context.close(); }
  });

  test('hidden names are permission-filtered; scope switch and revocation clear open actions without erasing preferences', async () => {
    const { api, fixture } = resources();
    const invitation = await api.request(fixture.B.actor, '/members/invites', 'POST', { email: fixture.actorAdmin.email, roles: ['member'] }, 201);
    await api.request({ ...fixture.actorAdmin, orgId: null }, '/auth/invitations/accept', 'POST', { token: invitation.token }, 201);
    const me = await api.request({ ...fixture.actorAdmin, orgId: null }, '/auth/me');
    const actor = { ...fixture.actorAdmin, session: { ...fixture.actorAdmin.session, organizations: me.organizations } };
    const { page, context } = await surface(1280, '/members', actor);
    try {
      await chooseAction(page, 'AST-001', 'favorite', '.nav-group');
      await chooseAction(page, 'AST-001', 'hide');
      const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).filter(([key]) => key.startsWith('orbitflow.nav.v1:'))));
      await change(page, '#nav-hidden-items:not([hidden])', () => page.locator('.nav-hidden-manager').click());
      assert.equal(await page.locator('[data-hidden-screen-id="AST-001"]').count(), 1);
      const hiddenLabel = await page.locator('[data-hidden-screen-id="AST-001"] > span').innerText();
      await openActions(page, 'PRJ-001');
      await page.route('**/api/v1/settings/access', async route => {
        const response = await route.fetch(); const payload = await response.json();
        await route.fulfill({ response, json: { ...payload, modules: payload.modules.filter(module => !['assets', 'projects', 'tasks'].includes(module)) } });
      });
      await change(page, '.nav-group a[href="/projects"]', () => page.evaluate(() => window.dispatchEvent(new Event('orbitflow:access-changed'))), 0);
      assert.equal(await page.locator('.nav-action-popup').count(), 0);
      assert.equal(await page.locator('[data-hidden-screen-id="AST-001"]').count(), 0);
      assert.equal((await page.locator('#nav-hidden-items').innerText()).includes(hiddenLabel), false);
      assert.equal(await page.locator('.sidebar').evaluate(node => node.contains(document.activeElement)), true);
      assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage).filter(([key]) => key.startsWith('orbitflow.nav.v1:')))), stored);
      await page.unroute('**/api/v1/settings/access');
      await change(page, '.nav-group a[href="/projects"]', () => page.evaluate(() => window.dispatchEvent(new Event('orbitflow:access-changed'))));
      assert.equal(await page.locator('.nav-action-popup').count(), 0);
      await openActions(page, 'PRJ-001');
      await page.locator('.workspace-picker__button').click();
      const b = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/settings/access');
      await page.getByRole('menuitemradio', { name: /DEADLINE_B/ }).click(); await b;
      await arm(page, '[data-pref-status="ready"]'); await signal(page);
      assert.equal(await page.locator('.nav-action-popup').count(), 0);
      await change(page, '#nav-hidden-items:not([hidden])', () => page.locator('.nav-hidden-manager').click());
      assert.equal(await page.locator('[data-hidden-screen-id]').count(), 0);
      await page.locator('.workspace-picker__button').click();
      const a = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/settings/access');
      await page.getByRole('menuitemradio', { name: /DEADLINE_A/ }).click(); await a;
      await arm(page, '[data-pref-status="ready"]'); await signal(page);
      await change(page, '#nav-hidden-items:not([hidden])', () => page.locator('.nav-hidden-manager').click());
      assert.equal(await page.locator('[data-hidden-screen-id="AST-001"]').count(), 1);
      assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage).filter(([key]) => key.startsWith('orbitflow.nav.v1:')))), stored);
    } finally { await context.close(); }
  });
}
