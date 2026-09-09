import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';

async function waitForDom(page, selector, options = {}) {
  const { count = 1, attribute = null, value = null } = options;
  await page.evaluate(({ selector, count, attribute, value }) => new Promise((resolve, reject) => {
    const matches = () => {
      const nodes = [...document.querySelectorAll(selector)];
      return nodes.length === count && (!attribute || nodes.every(node => node.getAttribute(attribute) === value));
    };
    const observer = new MutationObserver(() => { if (matches()) { clearTimeout(timeout); observer.disconnect(); resolve(true); } });
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`DOM deadline: ${selector}`)); }, 15000);
    observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
    if (matches()) { clearTimeout(timeout); observer.disconnect(); resolve(true); }
  }), { selector, count, attribute, value });
}

async function armDom(page, selector, options = {}) {
  const { count = 1, attribute = null, value = null } = options;
  await page.evaluate(({ selector, count, attribute, value }) => {
    window.__deadlineSidebarSignal = new Promise((resolve, reject) => {
      const matches = () => {
        const nodes = [...document.querySelectorAll(selector)];
        return nodes.length === count && (!attribute || nodes.every(node => node.getAttribute(attribute) === value));
      };
      const observer = new MutationObserver(() => { if (matches()) { clearTimeout(timeout); observer.disconnect(); resolve(true); } });
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`DOM deadline: ${selector}`)); }, 15000);
      observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
      if (matches()) { clearTimeout(timeout); observer.disconnect(); resolve(true); }
    });
  }, { selector, count, attribute, value });
}

const sidebarSignal = page => page.evaluate(() => window.__deadlineSidebarSignal);
const favoriteIds = page => page.locator('[data-testid="nav-favorites"] a').evaluateAll(links => links.map(link => link.dataset.screenId));

async function pressAndWait(page, buttonName, selector, options) {
  await armDom(page, selector, options);
  await page.getByRole('button', { name: buttonName, exact: true }).focus();
  await page.keyboard.press('Enter');
  await sidebarSignal(page);
}

async function resizeSidebar(page, width) {
  // setViewportSize's protocol acknowledgement is not the browser resize event.
  await page.evaluate(({ width, height }) => {
    window.__deadlineSidebarResize = new Promise((resolve, reject) => {
      if (innerWidth === width && innerHeight === height) { resolve(); return; }
      const onResize = () => {
        if (innerWidth !== width || innerHeight !== height) return;
        clearTimeout(timeout); window.removeEventListener('resize', onResize); resolve();
      };
      const timeout = setTimeout(() => {
        window.removeEventListener('resize', onResize); reject(new Error(`Resize deadline: ${width}`));
      }, 15000);
      window.addEventListener('resize', onResize);
    });
  }, { width, height: 900 });
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(() => window.__deadlineSidebarResize);
  await sidebarAnimations(page);
}

async function sidebarAnimations(page) {
  await page.locator('.sidebar').evaluate(node => new Promise((resolve, reject) => {
    // Flush the style change before subscribing to the actual transition promises.
    node.getBoundingClientRect();
    const timeout = setTimeout(() => reject(new Error('Sidebar animation deadline')), 15000);
    Promise.all(node.getAnimations().map(animation => animation.finished)).then(() => {
      clearTimeout(timeout); resolve();
    }, error => { clearTimeout(timeout); reject(error); });
  }));
}

async function assertCollapsedWork(page, result, phase) {
  const toggle = page.locator('[aria-controls="nav-section-work"]');
  const nextToggle = page.locator('.nav-group[data-section="work"] + .nav-group > .nav-section-toggle');
  const expectedNext = await nextToggle.getAttribute('aria-controls');
  await toggle.focus();
  await page.keyboard.press('Tab');
  const forward = await page.evaluate(() => ({ controls: document.activeElement.getAttribute('aria-controls'),
    inCollapsedGroup: Boolean(document.activeElement.closest('#nav-section-work')) }));
  await nextToggle.focus();
  await page.keyboard.press('Shift+Tab');
  const backward = await page.evaluate(() => ({ controls: document.activeElement.getAttribute('aria-controls'),
    inCollapsedGroup: Boolean(document.activeElement.closest('#nav-section-work')) }));
  await toggle.focus();
  const layout = await page.locator('#nav-section-work').evaluate(node => {
    const controls = [...node.querySelectorAll('a, button')];
    const focusable = controls.filter(control => { control.focus(); return document.activeElement === control; }).length;
    return { hidden: node.hidden, display: getComputedStyle(node).display, rects: node.getClientRects().length,
      controls: controls.length, renderedControls: controls.filter(control => control.getClientRects().length > 0).length, focusable };
  });
  const observation = { phase, width: page.viewportSize().width, forward, backward, layout };
  (result.sidebarCollapse ??= []).push(observation);
  assert.equal(forward.controls, expectedNext, 'Tab must skip every collapsed Work link and pin control');
  assert.equal(backward.controls, 'nav-section-work', 'Shift+Tab must skip every collapsed Work link and pin control');
  assert.equal(forward.inCollapsedGroup || backward.inCollapsedGroup, false);
  assert.ok(layout.controls > 0, 'collapse retains the original links and pin controls');
  assert.deepEqual({ ...layout, controls: undefined }, { hidden: true, display: 'none', rects: 0, controls: undefined, renderedControls: 0, focusable: 0 });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('[data-testid="nav-favorites"] a[href="/projects"]').isVisible(), true, 'favorite remains visible outside its collapsed group');
  assert.equal(await page.locator('#nav-section-home a[href="/"]').isVisible(), true, 'Home remains a direct visible link');
}

export async function sidebar({ surface, api, fixture, result, attempt, evidence }) {
  const invitation = await api.request(fixture.B.actor, '/members/invites', 'POST', {
    email: fixture.actorAdmin.email,
    roles: ['member'],
  }, 201);
  await api.request({ ...fixture.actorAdmin, orgId: null }, '/auth/invitations/accept', 'POST', { token: invitation.token }, 201);
  const adminMe = await api.request({ ...fixture.actorAdmin, orgId: null }, '/auth/me');
  fixture.actorAdmin.session = { ...fixture.actorAdmin.session, organizations: adminMe.organizations };

  await surface('sidebar-admin', fixture.actorAdmin, '/members', '.org-directory__table tbody tr', '/api/v1/members', async page => {
    assert.ok(await page.locator('.nav-section-toggle[aria-expanded="true"]').count() > 0, 'group headings must be collapse buttons');
    assert.equal(await page.locator('.sidebar a[href="/hr/recruitment"]').count(), 0);
    assert.equal(await page.locator('a button, button a, a a, button button').count(), 0, 'interactive elements must not nest');
    assert.equal(await page.locator('[data-testid="nav-favorites"]').count(), 0);
    assert.ok((await page.locator('.sidebar nav > *').evaluateAll(nodes => nodes.map(node => node.className))).includes('nav-group nav-group--home'));

    await pressAndWait(page, '프로젝트/업무 즐겨찾기에 추가', '[data-testid="nav-favorites"]', { attribute: 'data-order', value: 'PRJ-001' });
    await pressAndWait(page, '캘린더 즐겨찾기에 추가', '[data-testid="nav-favorites"]', { attribute: 'data-order', value: 'PRJ-001,CAL-001' });
    await pressAndWait(page, '자산 즐겨찾기에 추가', '[data-testid="nav-favorites"]', { attribute: 'data-order', value: 'PRJ-001,CAL-001,AST-001' });
    assert.deepEqual(await favoriteIds(page), ['PRJ-001', 'CAL-001', 'AST-001']);
    assert.equal(await page.locator('.nav-group a[href="/projects"]').count(), 1, 'favorite keeps original group link');

    await pressAndWait(page, '자산 위로 이동', '[data-testid="nav-favorites"]', { attribute: 'data-order', value: 'PRJ-001,AST-001,CAL-001' });
    assert.deepEqual(await favoriteIds(page), ['PRJ-001', 'AST-001', 'CAL-001']);
    await pressAndWait(page, '자산 위로 이동', '[data-testid="nav-favorites"]', { attribute: 'data-order', value: 'AST-001,PRJ-001,CAL-001' });
    assert.deepEqual(await favoriteIds(page), ['AST-001', 'PRJ-001', 'CAL-001']);

    await pressAndWait(page, '업무 메뉴 접기', '#nav-section-work', { count: 1, attribute: 'hidden', value: '' });
    await assertCollapsedWork(page, result, 'keyboard-collapse');
    await pressAndWait(page, '사람 메뉴 접기', '.nav-group[data-section="people"]', { attribute: 'data-stored-collapsed', value: 'true' });
    assert.equal(await page.locator('#nav-section-people a[href="/members"]').isVisible(), true, 'active group stays visible');

    const reloadAccess = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/settings/access');
    const reloadIdentity = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/me');
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal((await reloadAccess).status(), 200); assert.equal((await reloadIdentity).status(), 200);
    await waitForDom(page, '[data-testid="nav-favorites"] a', { count: 3 });
    assert.deepEqual(await favoriteIds(page), ['AST-001', 'PRJ-001', 'CAL-001']);
    assert.equal(await page.getByRole('button', { name: '업무 메뉴 펼치기', exact: true }).getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByRole('button', { name: '사람 메뉴 접기', exact: true }).getAttribute('aria-expanded'), 'true');
    await assertCollapsedWork(page, result, 'reload');

    const other = await page.context().newPage();
    await other.goto(new URL('/favicon.svg', page.url()).href);
    const scope = await page.evaluate(async () => {
      const [{ navPrefKey }, { isPgWorkspace }, { sessionStore }, { apiRequest }] = await Promise.all([
        import('/src/store/navPref.ts'), import('/src/services/workspace.ts'), import('/src/store/session.ts'), import('/src/services/api.ts'),
      ]);
      const session = sessionStore.getSnapshot();
      const me = await apiRequest('/auth/me', { session: { token: session.token, orgId: null } });
      const value = { userId: me.id, source: isPgWorkspace(session.orgId) ? 'pg' : 'legacy', orgId: session.orgId };
      return { ...value, key: navPrefKey(value) };
    });
    await armDom(page, '[data-testid="nav-favorites"]', { attribute: 'data-order', value: 'CAL-001,AST-001,PRJ-001' });
    await other.evaluate(({ key }) => localStorage.setItem(key, JSON.stringify({ version: 1, favoriteScreenIds: ['CAL-001', 'AST-001', 'PRJ-001'], collapsedSectionIds: ['work', 'people'] })), scope);
    await sidebarSignal(page);
    assert.deepEqual(await favoriteIds(page), ['CAL-001', 'AST-001', 'PRJ-001']);

    await page.evaluate(() => { const original = Storage.prototype.setItem; window.__restoreSetItem = () => { Storage.prototype.setItem = original; }; Storage.prototype.setItem = function (key, value) { if (String(key).startsWith('orbitflow.nav.v1:')) throw new DOMException('full', 'QuotaExceededError'); return original.call(this, key, value); }; });
    await pressAndWait(page, '문서 즐겨찾기에 추가', '[data-testid="nav-pref-error"]');
    assert.equal(await page.locator('[data-testid="nav-favorites"] a[href="/documents"]').count(), 0);
    const writeErrorScreen = path.join(attempt, 'sidebar-storage-write-error-1280.png');
    await page.screenshot({ path: writeErrorScreen, animations: 'disabled' });
    result.surfaces.push({ name: 'sidebar-storage-write-error', width: 1280, screenshot: path.relative(evidence, writeErrorScreen) });
    await page.evaluate(() => window.__restoreSetItem());

    await armDom(page, '[data-testid="nav-pref-error"]', { count: 0 });
    await other.evaluate(({ key }) => localStorage.setItem(key, JSON.stringify({ version: 1, favoriteScreenIds: ['CAL-001', 'PRJ-001', 'AST-001'], collapsedSectionIds: ['work', 'people'] })), scope);
    await sidebarSignal(page);
    await page.evaluate(() => { const original = Storage.prototype.getItem; window.__restoreGetItem = () => { Storage.prototype.getItem = original; }; Storage.prototype.getItem = function (key) { if (String(key).startsWith('orbitflow.nav.v1:')) throw new DOMException('denied', 'SecurityError'); return original.call(this, key); }; });
    await armDom(page, '[data-testid="nav-personalization"]', { attribute: 'data-pref-status', value: 'unavailable' });
    await other.evaluate(({ key }) => localStorage.setItem(key, JSON.stringify({ version: 1, favoriteScreenIds: ['PRJ-001'], collapsedSectionIds: [] })), scope);
    await sidebarSignal(page);
    assert.ok(await page.locator('.nav-pref-control:disabled').count() > 0);
    const readErrorScreen = path.join(attempt, 'sidebar-storage-read-error-1280.png');
    await page.screenshot({ path: readErrorScreen, animations: 'disabled' });
    result.surfaces.push({ name: 'sidebar-storage-read-error', width: 1280, screenshot: path.relative(evidence, readErrorScreen) });
    await page.evaluate(() => window.__restoreGetItem());
    await armDom(page, '[data-testid="nav-personalization"]', { attribute: 'data-pref-status', value: 'ready' });
    await other.evaluate(({ key }) => localStorage.setItem(key, JSON.stringify({ version: 1, favoriteScreenIds: ['AST-001', 'PRJ-001', 'CAL-001'], collapsedSectionIds: ['work', 'people'] })), scope);
    await sidebarSignal(page);
    await armDom(page, '[data-testid="nav-favorites"]', { count: 0 });
    await other.evaluate(() => localStorage.clear());
    await sidebarSignal(page);
    await armDom(page, '[data-testid="nav-favorites"]', { attribute: 'data-order', value: 'AST-001,PRJ-001,CAL-001' });
    await other.evaluate(({ key }) => localStorage.setItem(key, JSON.stringify({ version: 1, favoriteScreenIds: ['AST-001', 'PRJ-001', 'CAL-001'], collapsedSectionIds: ['work', 'people'] })), scope);
    await sidebarSignal(page);
    await other.close();

    const switcher = page.locator('.workspace-picker__button');
    await switcher.focus(); await page.keyboard.press('Enter');
    const bAccess = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/settings/access');
    await page.getByRole('menuitemradio', { name: /DEADLINE_B/ }).focus(); await page.keyboard.press('Enter');
    assert.equal((await bAccess).status(), 200);
    await waitForDom(page, '[data-testid="nav-favorites"]', { count: 0 });
    const scopeBScreen = path.join(attempt, 'sidebar-scope-b-1280.png');
    await page.screenshot({ path: scopeBScreen, animations: 'disabled' });
    result.surfaces.push({ name: 'sidebar-scope-b', width: 1280, screenshot: path.relative(evidence, scopeBScreen) });
    await page.locator('.workspace-picker__button').press('Enter');
    const aAccess = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/settings/access');
    await page.getByRole('menuitemradio', { name: /DEADLINE_A/ }).press('Enter');
    assert.equal((await aAccess).status(), 200);
    await waitForDom(page, '[data-testid="nav-favorites"] a', { count: 3 });

    for (const width of [1280, 768, 375]) {
      await resizeSidebar(page, width);
      if (width < 1100) {
        await pressAndWait(page, '메뉴 열기', '.sidebar.sidebar--open');
        await sidebarAnimations(page);
      }
      await pressAndWait(page, '업무 메뉴 펼치기', '#nav-section-work', { attribute: 'hidden', value: null });
      assert.equal(await page.locator('#nav-section-work a[href="/projects"]').isVisible(), true);
      await page.locator('[aria-controls="nav-section-work"]').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.matches('#nav-section-work a[href="/projects"]')), true, 'expanded links are keyboard reachable');
      await pressAndWait(page, '업무 메뉴 접기', '#nav-section-work', { attribute: 'hidden', value: '' });
      await assertCollapsedWork(page, result, 'responsive-collapse');
      assert.equal(await page.locator('.nav-group[data-section="people"]').getAttribute('data-stored-collapsed'), 'true');
      assert.equal(await page.locator('#nav-section-people a[href="/members"][aria-current="page"]').isVisible(), true, 'stored-collapsed active group remains rendered and highlighted');
      const geometry = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewport: innerWidth,
        controls: [...document.querySelectorAll('.nav-pref-control')].filter(node => node.getClientRects().length > 0).map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })) }));
      assert.equal(geometry.documentWidth, geometry.viewport);
      if (width === 375) assert.ok(geometry.controls.every(control => control.width >= 44 && control.height >= 44));
      const screenshot = path.join(attempt, `sidebar-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
      result.surfaces.push({ name: 'sidebar-open', width, screenshot: path.relative(evidence, screenshot), geometry });
      if (width < 1100) {
        await armDom(page, '.sidebar:not(.sidebar--open)');
        await page.locator('.sidebar-scrim').click({ position: { x: 370, y: 20 } });
        await sidebarSignal(page);
        await sidebarAnimations(page);
      }
    }
    await resizeSidebar(page, 375);
    await pressAndWait(page, '메뉴 열기', '.sidebar.sidebar--open');
    await sidebarAnimations(page);
    await armDom(page, '.sidebar:not(.sidebar--open)');
    await page.locator('[data-testid="nav-favorites"] a[href="/calendar"]').focus(); await page.keyboard.press('Enter');
    await sidebarSignal(page);
    assert.equal(new URL(page.url()).pathname, '/calendar');

    const stored = await page.evaluate(({ key }) => localStorage.getItem(key), scope);
    result.sidebarAdmin = { identityEndpoint: '/auth/me', scope: { source: scope.source, orgId: scope.orgId }, favoriteOrder: JSON.parse(stored).favoriteScreenIds,
      storedHash: createHash('sha256').update(stored).digest('hex'), nestedInteractive: 0, mobileClosed: true };
    return result.sidebarAdmin;
  }, [1280]);

  const assignments = await api.request(fixture.actorAdmin, '/settings/members');
  const manager = assignments.items.find(member => member.membership_id === fixture.actorManager.membershipId);
  const originalRoles = manager.roles;
  await surface('sidebar-access-revoke', fixture.actorManager, '/projects', '[data-screen-id="PRJ-001"]', '/api/v1/projects', async page => {
    await pressAndWait(page, '프로젝트/업무 즐겨찾기에 추가', '[data-testid="nav-favorites"] a[href="/projects"]');
    const before = await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('orbitflow.nav.v1:'))?.[1]);
    await armDom(page, '.sidebar a[href="/projects"]', { count: 0 });
    const revokedAccess = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/settings/access');
    const revoked = await api.request(fixture.actorAdmin, `/settings/members/${fixture.actorManager.membershipId}/roles`, 'PUT', { roles: [], expected_roles_version: manager.roles_version });
    await page.evaluate(() => window.dispatchEvent(new Event('orbitflow:access-changed')));
    assert.equal((await revokedAccess).status(), 200); await sidebarSignal(page);
    assert.equal(await page.locator('[data-testid="nav-favorites"] a[href="/projects"]').count(), 0);
    assert.equal(await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('orbitflow.nav.v1:'))?.[1]), before);
    const revokedScreen = path.join(attempt, 'sidebar-access-revoked-1280.png');
    await page.screenshot({ path: revokedScreen, animations: 'disabled' });
    result.surfaces.push({ name: 'sidebar-access-revoked', width: 1280, screenshot: path.relative(evidence, revokedScreen) });
    await armDom(page, '.sidebar a[href="/projects"]', { count: 2 });
    const restoredAccess = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/settings/access');
    await api.request(fixture.actorAdmin, `/settings/members/${fixture.actorManager.membershipId}/roles`, 'PUT', { roles: originalRoles, expected_roles_version: revoked.roles_version });
    await page.evaluate(() => window.dispatchEvent(new Event('orbitflow:access-changed')));
    assert.equal((await restoredAccess).status(), 200); await sidebarSignal(page);
    assert.equal(await page.locator('[data-testid="nav-favorites"] a[href="/projects"]').count(), 1);
    result.sidebarRevoke = { originalAndFavoriteHidden: true, storedBytesUnchanged: true, restored: true };
    return result.sidebarRevoke;
  }, [1280]);
  result.limitations = ['Legacy SQLite auth/access exercised through actual HTTP; PG identity endpoint is compiler-covered but native PG was not started', 'External font stylesheet blocked; system font fallback'];
}
