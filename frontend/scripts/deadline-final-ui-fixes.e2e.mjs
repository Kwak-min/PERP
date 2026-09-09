import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { startDeadlineServer, createDeadlineFixture } from '../../backend/tests/deadline-fixture.js';
import { COMPANY_PERMISSIONS } from '../../backend/src/config/rbac.js';
import { initializeDeadlineSession } from './deadline-browser-session.mjs';
import { networkAudit, protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';
import { actionPermissionLabels } from '../src/screens/action-permission-labels.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, '.omo/evidence/task29-focus-revision', process.env.DEADLINE_RUN_ID);
await mkdir(out, { recursive: true });
const result = { checks: [], errors: [], resources: [], hashes: {}, native: process.argv.includes('--native'), liveServicesUsed: false };
result.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
for (const file of ['frontend/src/components/layout/AppShell.tsx', 'frontend/src/styles.css', 'frontend/src/screens/RoleSettingsScreen.tsx', 'frontend/src/screens/action-permission-labels.ts', 'frontend/scripts/deadline-final-ui-fixes.e2e.mjs']) {
  result.hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
}
function check(name, observed, verify) {
  try { verify(); result.checks.push({ name, status: 'passed', observed }); }
  catch (error) { result.checks.push({ name, status: 'failed', observed, error: error.message }); }
}
// Subscribe before actions; timers only bound a missing state/event, never schedule progress.
async function arm(page, selector) {
  await page.evaluate(selector => {
    window.uiSignal = new Promise((resolve, reject) => {
      const observer = new MutationObserver(test);
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`DOM deadline: ${selector}`)); }, 5000);
      function test() { if (document.querySelector(selector)) { clearTimeout(timer); observer.disconnect(); resolve(); } }
      observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true }); test();
    });
  }, selector);
}
const signal = page => page.evaluate(() => window.uiSignal);
async function resize(page, width) {
  await page.evaluate(width => {
    window.resizeSignal = new Promise((resolve, reject) => {
      if (innerWidth === width) { resolve(); return; }
      const listener = () => { if (innerWidth === width) { clearTimeout(timer); removeEventListener('resize', listener); resolve(); } };
      const timer = setTimeout(() => { removeEventListener('resize', listener); reject(new Error('Resize deadline')); }, 5000);
      addEventListener('resize', listener);
    });
  }, width);
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(() => window.resizeSignal);
  await shot(page, `resize-${width}-${result.checks.length}`);
}
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), animations: 'disabled' });
const focus = page => page.evaluate(() => ({ inSidebar: !!document.activeElement.closest('.sidebar'), opener: document.activeElement.matches('.menu-button'), main: document.activeElement.id === 'main-content', tag: document.activeElement.tagName }));
async function tabTo(page, selector) {
  const bound = await page.locator('a[href],button,input,select,textarea,[tabindex],summary').count() + 5;
  for (let i = 0; i < bound; i++) {
    if (await page.evaluate(s => document.activeElement.matches(s), selector)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Keyboard target unreachable: ${selector}`);
}
async function refresh(page) {
  // Observe the real React access-provider commit, including layout effects, even if
  // identical permissions cause no DOM mutation. No fetch/render/focus substitution.
  await page.evaluate(() => {
    window.refreshSignal = new Promise((resolve, reject) => {
      const listener = () => { clearTimeout(timer); removeEventListener('qa-access-commit', listener); resolve(); };
      const timer = setTimeout(() => { removeEventListener('qa-access-commit', listener); reject(new Error('Access commit deadline')); }, 15000);
      addEventListener('qa-access-commit', listener, { once: true });
    });
    window.refreshAccess = window.qaAccessValue;
    window.refreshFocus = document.activeElement;
    window.focusTrace = []; window.inertTrace = [];
  });
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/settings/access', { timeout: 15000 });
  await page.evaluate(() => window.dispatchEvent(new Event('orbitflow:access-changed')));
  const received = await response; assert.equal(received.status(), 200);
  const access = await received.json();
  await page.evaluate(() => window.refreshSignal);
  return { access, ...await page.evaluate(() => ({ previousAccess: window.refreshAccess, same: document.activeElement === window.refreshFocus, connected: window.refreshFocus.isConnected, picker: document.activeElement.matches('.workspace-picker__button'), sidebar: !!document.activeElement.closest('.sidebar'), open: !!document.querySelector('.sidebar--open'), mainInert: document.querySelector('.app-main').inert, focusTrace: window.focusTrace, inertTrace: window.inertTrace })) };
}
async function continuousTabs(page, name, withRefresh = false) {
  const count = await page.evaluate(() => {
    window.tabControls = [...document.querySelector('.sidebar').querySelectorAll('button,a[href],input,select,textarea,[tabindex]')].filter(n => n.tabIndex >= 0 && !n.matches(':disabled') && !n.closest('[inert]') && n.checkVisibility({ visibilityProperty: true }));
    return window.tabControls.length;
  });
  const modal = await page.locator('.sidebar--open').count() === 1;
  const trace = [];
  for (const key of ['Tab', 'Shift+Tab']) for (let step = 1; step <= count; step++) {
    const expected = key === 'Tab' ? (step === count && !modal ? -1 : step % count) : (count - step) % count;
    await page.keyboard.press(key);
    trace.push({ key, expected, ...await page.evaluate(() => ({ observed: window.tabControls.indexOf(document.activeElement), name: document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent.trim().slice(0, 50) })) });
    if (withRefresh && step === 2) {
      const observed = await refresh(page);
      check(`${name} unchanged refresh ${key}`, observed, () => { assert.ok(observed.same); assert.ok(observed.sidebar); assert.equal(observed.open, modal); assert.equal(observed.mainInert, modal); for (const key of Object.keys(observed.previousAccess)) assert.deepEqual(observed.access[key], observed.previousAccess[key]); assert.deepEqual(observed.focusTrace, []); assert.deepEqual(observed.inertTrace, []); });
    }
  }
  check(name, trace, () => trace.forEach(item => assert.equal(item.observed, item.expected, `${item.key} expected ${item.expected}: ${item.name}`)));
}
async function open(page) {
  await tabTo(page, '.menu-button');
  await arm(page, '.sidebar--open');
  await page.keyboard.press('Enter');
  await signal(page);
}
async function close(page) {
  await arm(page, '.sidebar:not(.sidebar--open)');
  await page.locator('.sidebar-scrim').click({ position: { x: page.viewportSize().width - 5, y: 20 } });
  await signal(page);
}
let api, vite, server, browser, nativeFixture;
try {
  check('finite action metadata keys', Object.keys(actionPermissionLabels), () => assert.deepEqual(Object.keys(actionPermissionLabels).sort(), COMPANY_PERMISSIONS.filter(code => !code.startsWith('menu.'))));
  api = await startDeadlineServer(); result.resources.push(api.resource);
  const fixture = result.native ? await (async () => { nativeFixture = await (await import('./deadline-role-native.fixture.mjs')).nativeRoleFixture(api); return nativeFixture.fixture; })() : await createDeadlineFixture(api);
  vite = await createServer({ configFile: false, root: path.join(root, 'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT, cacheDir: path.join(process.env.DEADLINE_TEMP_ROOT, 'vite-ui-fixes'), plugins: [react()], server: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(api.baseUrl).origin }, watch: { ignored: ['**/.omo/**', '**/dist/**'] } } });
  await vite.listen(); const port = vite.httpServer.address().port; assert.ok(!protectedPorts.has(port));
  const origin = `http://127.0.0.1:${port}`; result.resources.push({ kind: 'vite', port });
  server = await chromium.launchServer({ channel: 'chrome', headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  result.resources.push({ kind: 'chrome', pid: server.process().pid, profile: server.process().spawnargs.find(arg => arg.startsWith('--user-data-dir='))?.slice(16) });
  browser = await chromium.connect(server.wsEndpoint()); result.chrome = browser.version();
  const context = await browser.newContext({ viewport: { width: 375, height: 900 }, reducedMotion: 'reduce', timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await context.routeWebSocket('**/*', socket => new URL(socket.url()).host === new URL(origin).host ? socket.connectToServer() : socket.close());
  await initializeDeadlineSession(context, { origin, session: fixture.actorAdmin.session, onPageError: error => result.errors.push(error.message) });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  // Install the render subscription in each new document before navigating.
  await page.addInitScript(() => {
    let accessValue;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(), supportsFiber: true,
      inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
      onCommitFiberUnmount() {},
      onCommitFiberRoot(_id, root) {
        function visit(fiber) {
          if (fiber.type?.name === 'AppShell') {
            const value = fiber.child?.memoizedProps?.value;
            if (value && value !== accessValue) { accessValue = value; window.qaAccessValue = value; window.dispatchEvent(new Event('qa-access-commit')); }
          }
          for (let child = fiber.child; child; child = child.sibling) visit(child);
        }
        visit(root.current);
      },
    };
    window.focusTrace = []; window.inertTrace = [];
    document.addEventListener('focusin', event => window.focusTrace.push({ name: event.target.getAttribute('aria-label'), cls: event.target.className, sidebar: !!event.target.closest('.sidebar') }));
    new MutationObserver(records => records.filter(r => r.attributeName === 'inert' && r.target.matches('.app-main')).forEach(r => window.inertTrace.push({ old: r.oldValue, current: r.target.inert }))).observe(document, { attributes: true, attributeOldValue: true, subtree: true });
    window.readySignal = new Promise((resolve, reject) => {
      const observer = new MutationObserver(test);
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Screen render deadline')); }, 15000);
      function test() { if (document.querySelector('[data-pref-status="ready"]') && document.querySelector('[data-testid="role-definition-editor"], .org-directory__table tbody tr')) { clearTimeout(timer); observer.disconnect(); resolve(); } }
      observer.observe(document, { subtree: true, childList: true, attributes: true }); test();
    });
  });
  await page.goto(origin + (result.native ? '/settings/roles' : '/members'), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.readySignal);
  for (const width of [375, 768]) {
    await resize(page, width);
    await tabTo(page, '.menu-button'); await page.keyboard.press('Shift+Tab');
    const closed = await focus(page);
    const hidden = await page.locator('.sidebar').evaluate(node => {
      return { inert: node.inert, hidden: node.hidden };
    });
    check(`closed nav ${width}`, { closed, hidden }, () => { assert.equal(closed.inSidebar, false); assert.ok(hidden.inert && hidden.hidden); });
    const closedCount = await page.locator('a[href],button,input,select,textarea,[tabindex],summary').count() + 2;
    for (let step = 0; step < closedCount; step++) { await page.keyboard.press('Tab'); assert.equal((await focus(page)).inSidebar, false); }
    await shot(page, `nav-${width}-closed`);
    for (let cycle = 0; cycle < 2; cycle++) {
      await open(page);
      const initial = await focus(page);
      const semantics = await page.locator('.sidebar').evaluate(node => ({ role: node.getAttribute('role'), modal: node.getAttribute('aria-modal'), id: node.id, name: node.getAttribute('aria-label'), controls: document.querySelector('.menu-button').getAttribute('aria-controls'), expanded: document.querySelector('.menu-button').getAttribute('aria-expanded') }));
      check(`open nav ${width}/${cycle}`, { initial, semantics }, () => { assert.equal(initial.inSidebar, true); assert.equal(semantics.role, 'dialog'); assert.equal(semantics.modal, 'true'); assert.ok(semantics.name); assert.ok(semantics.id); assert.equal(semantics.controls, semantics.id); assert.equal(semantics.expanded, 'true'); });
      // Complete successive traversal in both directions, including refresh mid-cycle.
      await continuousTabs(page, `trap nav ${width}/${cycle}`, cycle === 0);
      const background = await page.locator('.app-main').evaluate(node => node.inert);
      check(`modal background ${width}/${cycle}`, background, () => assert.equal(background, true));
      await shot(page, `nav-${width}-open-${cycle}`);
      await arm(page, '.sidebar:not(.sidebar--open)'); await page.keyboard.press('Escape');
      let escaped = true;
      try { await signal(page); } catch (error) { escaped = false; result.checks.push({ name: `Escape signal ${width}/${cycle}`, status: 'failed', error: error.message }); }
      const restored = await focus(page);
      check(`Escape restore ${width}/${cycle}`, { escaped, restored }, () => { assert.ok(escaped); assert.ok(restored.opener); });
      if (!escaped) await close(page);
    }
    await open(page); await close(page);
    const scrim = await focus(page);
    check(`scrim restores ${width}`, scrim, () => assert.ok(scrim.opener));
  }
  await open(page); await resize(page, 1280);
  const desktop = await page.locator('.sidebar').evaluate(node => ({ inert: node.inert, modal: node.getAttribute('aria-modal'), visible: node.checkVisibility(), open: node.classList.contains('sidebar--open') }));
  await tabTo(page, '.sidebar__footer button:not(.sidebar__close)'); await page.keyboard.press('Tab');
  const desktopFocus = await focus(page);
  check('open mobile to desktop releases modal', { desktop, desktopFocus }, () => { assert.equal(desktop.inert, false); assert.notEqual(desktop.modal, 'true'); assert.ok(desktop.visible); assert.equal(desktop.open, false); assert.equal(desktopFocus.inSidebar, false); });
  await tabTo(page, '.sidebar .workspace-picker__button'); await resize(page, 375);
  const resized = await focus(page);
  check('desktop focused nav to mobile closes safely', resized, () => assert.ok(resized.opener));
  if (await page.locator('.sidebar--open').count()) await close(page);
  await open(page);
  await page.evaluate(() => { window.detachedOpener = document.querySelector('.menu-button'); window.openerParent = window.detachedOpener.parentElement; window.openerNext = window.detachedOpener.nextSibling; window.detachedOpener.remove(); });
  await arm(page, '.sidebar:not(.sidebar--open)'); await page.keyboard.press('Escape');
  let lostClosed = true;
  try { await signal(page); } catch (error) { lostClosed = false; result.checks.push({ name: 'lost opener close signal', status: 'failed', error: error.message }); }
  const lost = await focus(page);
  check('lost opener uses main fallback', { lostClosed, lost }, () => { assert.ok(lostClosed); assert.ok(lost.main); });
  await page.evaluate(() => window.openerParent.insertBefore(window.detachedOpener, window.openerNext));
  if (!lostClosed) await close(page);
  await resize(page, 1100); await open(page);
  const boundaryOpen = await page.locator('.sidebar').evaluate(node => ({ modal: node.getAttribute('aria-modal'), focused: node.contains(document.activeElement) }));
  check('1100 is modal', boundaryOpen, () => assert.deepEqual(boundaryOpen, { modal: 'true', focused: true }));
  await resize(page, 1101);
  const boundary = await page.locator('.sidebar').evaluate(node => ({ hidden: node.hidden, inert: node.inert, modal: node.getAttribute('aria-modal'), open: node.classList.contains('sidebar--open') }));
  check('1101 releases modal', boundary, () => assert.deepEqual(boundary, { hidden: false, inert: false, modal: null, open: false }));
  await resize(page, 1100);
  const boundaryClosed = await page.locator('.sidebar').evaluate(node => ({ hidden: node.hidden, inert: node.inert }));
  check('1100 closes after desktop resize', boundaryClosed, () => assert.deepEqual(boundaryClosed, { hidden: true, inert: true }));
  await open(page); await arm(page, '.sidebar:not(.sidebar--open)'); await tabTo(page, '.sidebar__close'); await page.keyboard.press('Enter'); await signal(page);
  const closeButton = await focus(page);
  check('in-panel close button restores opener', closeButton, () => assert.ok(closeButton.opener));
  await resize(page, 768); await open(page);
  await arm(page, '.sidebar:not(.sidebar--open)'); await tabTo(page, '#nav-section-home a[href="/"]'); await page.keyboard.press('Enter'); await signal(page);
  check('required home link closes nav', { url: page.url(), focus: await focus(page) }, () => assert.equal(new URL(page.url()).pathname, '/'));

  if (!result.native) {
    await page.goto(origin + '/members', { waitUntil: 'domcontentloaded' }); await page.evaluate(() => window.readySignal);
    for (const scheme of ['light', 'dark']) for (const width of [375, 768, 1280]) {
      await page.emulateMedia({ colorScheme: scheme }); await resize(page, width);
      const contrast = await page.evaluate(() => {
        const rgb = value => value.match(/[\d.]+/g).map(Number);
        const luminance = color => color.slice(0, 3).map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, c, index) => sum + c * [.2126, .7152, .0722][index], 0);
        return ['.screen-header .eyebrow', '.section-card__foot'].map(selector => {
          const node = document.querySelector(selector); if (!node) throw new Error(`Missing contrast target ${selector}`);
          const style = getComputedStyle(node); let parent = node, background;
          while (parent) { const color = rgb(getComputedStyle(parent).backgroundColor); if (color.length === 3 || color[3] === 1) { background = color; break; } parent = parent.parentElement; }
          if (!background) throw new Error('No opaque background');
          const foreground = rgb(style.color), a = luminance(foreground), b = luminance(background);
          return { selector, foreground, background, fontSize: style.fontSize, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
        });
      });
      check(`small text contrast ${scheme}/${width}`, contrast, () => contrast.forEach(sample => assert.ok(sample.ratio >= 4.5, `${sample.selector}: ${sample.ratio}`)));
      await page.evaluate(() => scrollTo(0, 0)); await shot(page, `contrast-${scheme}-${width}-top`);
      await page.locator('.section-card__foot').first().scrollIntoViewIfNeeded(); await shot(page, `contrast-${scheme}-${width}-footer`);
    }
  }
  await page.goto(origin + '/settings/roles', { waitUntil: 'domcontentloaded' }); await page.evaluate(() => window.readySignal);
  for (const width of [375, 768, 1280]) {
    await resize(page, width);
    const labels = await page.locator('[data-permission-kind="action"] input, [data-permission-kind="delegation"] input').evaluateAll(inputs => inputs.map(input => {
      const primary = input.labels[0].querySelector('span').cloneNode(true); primary.querySelector('small')?.remove();
      return { code: input.dataset.permission, primary: primary.textContent.trim(), labelledBy: input.getAttribute('aria-labelledby'), describedBy: input.getAttribute('aria-describedby'), description: document.getElementById(input.getAttribute('aria-describedby'))?.textContent, name: document.getElementById(input.getAttribute('aria-labelledby'))?.textContent };
    }));
    check(`role shipped labels and semantics ${width}`, labels, () => {
      assert.deepEqual(labels.map(label => label.code).sort(), Object.keys(actionPermissionLabels).sort());
      for (const label of labels) { assert.equal(label.primary, actionPermissionLabels[label.code], label.code); assert.equal(label.name, actionPermissionLabels[label.code], label.code); assert.ok(label.description.includes(label.code)); assert.notEqual(label.labelledBy, label.describedBy); }
    });
    const cdp = await context.newCDPSession(page);
    const ax = await cdp.send('Accessibility.getFullAXTree'); await cdp.detach();
    const names = ax.nodes.filter(node => !node.ignored && node.role?.value === 'checkbox').map(node => node.name?.value);
    check(`role AX names ${width}`, names, () => Object.values(actionPermissionLabels).forEach(label => assert.ok(names.includes(label))));
    await page.locator('[data-permission-kind="action"]').evaluate(node => scrollTo(0, scrollY + node.getBoundingClientRect().top - document.querySelector('.topbar').getBoundingClientRect().height - 16));
    await shot(page, `role-labels-${width}-top`);
    await page.locator('[data-permission="transaction.write"]').scrollIntoViewIfNeeded(); await shot(page, `role-labels-${width}-bottom`);
    const geometry = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, clipped: [...document.querySelectorAll('[data-permission-kind] label')].filter(node => { const r = node.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < 0 || node.scrollWidth > node.clientWidth + 1; }).length }));
    check(`role label geometry ${width}`, geometry, () => { assert.equal(geometry.width, geometry.document); assert.equal(geometry.clipped, 0); });
  }
  async function assign(actor, target, roles) {
    const current = (await api.request(actor, '/settings/members')).items.find(member => member.user_id === target.userId);
    return api.request(actor, `/settings/members/${current.membership_id}/roles`, 'PUT', { roles, expected_roles_version: current.roles_version });
  }
  await assign(fixture.actorAdmin, fixture.actorManager, ['company_admin']);
  const own = (await api.request(fixture.actorAdmin, '/settings/members')).items.find(member => member.user_id === fixture.actorAdmin.userId);
  const limited = await api.request(fixture.actorAdmin, '/settings/roles', 'POST', { name: 'Focus removal without projects', scope: 'all', permissions: COMPANY_PERMISSIONS.filter(code => code !== 'menu.projects') }, 201);
  for (const width of [375, 768, 1280]) {
    await resize(page, width);
    if (width <= 1100) await open(page);
    await tabTo(page, '#nav-section-work a[href="/projects"]');
    const preferences = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('orbitflow.nav.v1:')));
    await assign(fixture.actorManager, fixture.actorAdmin, [limited.key]);
    const removed = await refresh(page);
    check(`revoked focused control ${width}`, removed, () => {
      assert.equal(removed.connected, false); assert.ok(removed.picker && removed.sidebar);
      assert.equal(removed.open, width <= 1100); assert.equal(removed.mainInert, width <= 1100);
      assert.deepEqual(removed.inertTrace, []); assert.equal(removed.focusTrace.length, 1); assert.ok(removed.focusTrace.every(event => event.sidebar));
    });
    assert.equal(await page.locator('.sidebar a[href="/projects"]').count(), 0);
    await shot(page, `permission-removed-${width}`);
    await assign(fixture.actorManager, fixture.actorAdmin, own.roles);
    const restored = await refresh(page);
    check(`grant returns without reopening ${width}`, restored, () => { assert.ok(restored.same); assert.deepEqual(restored.focusTrace, []); assert.deepEqual(restored.inertTrace, []); });
    assert.equal(await page.locator('#nav-section-work a[href="/projects"]').count(), 1);
    assert.deepEqual(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('orbitflow.nav.v1:'))), preferences);
    // Start at the expected fallback via real keyboard even on RED, never forced focus.
    await tabTo(page, '.workspace-picker__button');
    await continuousTabs(page, `permission change continuous Tab ${width}`, true);
    await shot(page, `permission-restored-${width}`);
    if (width <= 1100) { await arm(page, '.sidebar:not(.sidebar--open)'); await page.keyboard.press('Escape'); await signal(page); assert.ok((await focus(page)).opener); }
  }
  await context.unrouteAll({ behavior: 'wait' }); await context.close();
  assert.deepEqual(result.errors, []); assert.deepEqual(networkAudit.blocked, []);
} catch (error) { result.errors.push(error.stack); console.error(error); }
finally {
  result.cleanup = {};
  for (const [kind, closeResource] of [['browser', () => browser?.close()], ['chrome', () => server?.close()], ['vite', () => vite?.close()], ['api', () => api?.close()], ['pg', () => nativeFixture?.close()]]) {
    try { await closeResource(); result.cleanup[kind] = true; } catch (error) { result.cleanup[kind] = error.message; result.errors.push(error.stack); }
  }
  result.cleanup.profileRemoved = !result.resources.find(resource => resource.kind === 'chrome')?.profile || !existsSync(result.resources.find(resource => resource.kind === 'chrome').profile);
  result.cleanup.pg = nativeFixture?.resource ?? true; result.network = networkAudit;
  result.status = result.errors.length || result.checks.some(item => item.status === 'failed') ? 'failed' : 'passed';
  if (result.status === 'failed') process.exitCode = 1;
  await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, out, checks: result.checks.length, failures: result.checks.filter(item => item.status === 'failed').map(({ name, error }) => ({ name, error })), errors: result.errors, cleanup: result.cleanup }, null, 2));
}
