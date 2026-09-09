import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { startDeadlineServer, createDeadlineFixture } from '../../backend/tests/deadline-fixture.js';

// 실제 권한 API + 격리된 합성 회사만 사용한다. 운영 서버/저장소에 연결하지 않는다.
const root = fileURLToPath(new URL('../../', import.meta.url));
const production = process.argv.includes('--production');
const evidence = path.join(root, '.omo/evidence/navigation-ux', production ? 'production' : 'source');
let api, fixture, vite, browser, origin;
const observations = [];
before(async () => {
  await mkdir(evidence, { recursive: true });
  api = await startDeadlineServer();
  fixture = await createDeadlineFixture(api);
  const config = { configFile: false, root: path.join(root, 'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT };
  const server = { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(api.baseUrl).origin } };
  if (production) {
    const built = await preview({ ...config, preview: server });
    vite = { httpServer: built.httpServer, close: () => new Promise((resolve, reject) => built.httpServer.close(error => error ? reject(error) : resolve())) };
  } else {
    vite = await createServer({ ...config, cacheDir: path.join(process.env.DEADLINE_TEMP_ROOT, 'vite-cache'), plugins: [react()],
      server: { ...server, watch: { ignored: ['**/.omo/**'] } } });
    await vite.listen();
  }
  origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => {
  await browser?.close(); await vite?.close(); await api?.close();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ observations, apiCleanup: api?.resource }, null, 2));
});

async function arm(page, selector, count = 1, attribute, value) {
  await page.evaluate(({ selector, count, attribute, value }) => {
    window.__navigationSignal = new Promise((resolve, reject) => {
      const check = () => {
        const nodes = [...document.querySelectorAll(selector)];
        if (nodes.length === count && (!attribute || nodes.every(node => node.getAttribute(attribute) === value))) {
          clearTimeout(timeout); observer.disconnect(); resolve();
        }
      };
      const observer = new MutationObserver(check);
      const timeout = setTimeout(() => { observer.disconnect(); reject(Error(`DOM deadline: ${selector}`)); }, 10000);
      observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true }); check();
    });
  }, { selector, count, attribute, value });
}
const signal = page => page.evaluate(() => window.__navigationSignal);
async function change(page, selector, action, count = 1, attribute, value) {
  await arm(page, selector, count, attribute, value); await action(); await signal(page);
}
async function surface(width, route = '/members', actor = fixture.actorAdmin) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await context.addInitScript(session => sessionStorage.setItem('orbitflow.session.v1', JSON.stringify(session)), actor.session);
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + route);
  await arm(page, '[data-pref-status="ready"]'); await signal(page);
  if (route.startsWith('/members') && actor === fixture.actorAdmin) { await arm(page, '[data-org-state="ready"]'); await signal(page); }
  return { page, context, errors };
}
async function openSidebar(page, width) {
  if (width <= 1100) await change(page, '.sidebar[aria-modal="true"]', () => page.getByRole('button', { name: '메뉴 열기', exact: true }).click());
}
const ids = page => page.locator('.nav-favorites a').evaluateAll(nodes => nodes.map(node => node.dataset.screenId));

for (const width of [375, 768, 1280]) test(`explicit authorized search and exact member selection at ${width}`, async () => {
  const { page, context, errors } = await surface(width);
  try {
    const category = page.getByRole('combobox', { name: '검색 범위', exact: true });
    assert.equal(await category.isVisible(), true);
    await category.selectOption('/members');
    const query = '검증 구성원 01';
    const search = page.getByRole('searchbox', { name: '전역 검색', exact: true });
    await search.fill(query);
    const navigation = page.waitForURL(url => url.pathname === '/members' && url.searchParams.get('q') === query);
    await change(page, '.org-directory__table tbody tr', () => search.press('Enter'));
    await navigation;
    await arm(page, '.org-directory__table tbody tr', 1); await signal(page);
    assert.equal(await page.getByRole('searchbox', { name: '구성원 검색', exact: true }).inputValue(), query);
    assert.equal(await page.locator('.org-directory__table tbody tr').count(), 1);
    await page.screenshot({ path: path.join(evidence, `member-results-${width}.png`), animations: 'disabled' });
    const member = fixture.members.find(member => member.name === query);
    await change(page, '.member-detail', () => page.locator('.org-directory__table').getByRole('button', { name: query, exact: true }).click());
    assert.equal(new URL(page.url()).searchParams.get('member'), member.membership_id);
    assert.ok((await page.locator('.member-detail').innerText()).includes(member.email));
    assert.equal(await page.locator('.org-directory__table tr[data-selected="true"]').count(), 1);
    assert.equal(await page.locator('.orgchart-aside').evaluate(node => document.activeElement === node), true);
    const detail = await page.locator('.member-detail').boundingBox();
    assert.ok(detail.y >= 0 && detail.y + detail.height <= 900, `selected detail is in viewport: ${JSON.stringify(detail)}`);
    await page.screenshot({ path: path.join(evidence, `member-${width}.png`), animations: 'disabled' });
    await page.reload(); await arm(page, '.member-detail'); await signal(page);
    assert.ok((await page.locator('.member-detail').innerText()).includes(member.email));
    const local = page.getByRole('searchbox', { name: '구성원 검색', exact: true });
    await change(page, '.member-detail', () => local.fill('not-a-member'), 0);
    assert.equal(new URL(page.url()).searchParams.get('q'), 'not-a-member');
    assert.equal(await page.locator('.org-directory__table tbody tr').count(), 0);
    // 동일 pathname에서 새 검색: 오래된 선택/페이지/필터가 검색 결과를 가리지 않는다.
    await page.getByRole('combobox', { name: '부서', exact: true }).selectOption('unassigned');
    assert.equal(new URL(page.url()).searchParams.get('department'), 'unassigned');
    await category.selectOption('/members');
    await search.fill('검증 구성원 02');
    await change(page, '.org-directory__table tbody tr', () => search.press('Enter'));
    assert.equal(await local.inputValue(), '검증 구성원 02');
    assert.equal(await page.getByRole('combobox', { name: '부서', exact: true }).inputValue(), '');
    assert.equal(new URL(page.url()).searchParams.has('member'), false);
    await page.goto(origin + '/members?q=' + encodeURIComponent(query) + '&member=not-authorized');
    await arm(page, '[data-org-state="ready"]'); await signal(page);
    assert.equal(await page.locator('.member-detail').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const width of [375, 768, 1280]) test(`compact favorites, keyboard management and persistence at ${width}`, async () => {
  const { page, context, errors } = await surface(width);
  try {
    await openSidebar(page, width);
    for (const [label, count] of [['프로젝트/업무', 1], ['캘린더', 2], ['자산', 3]]) {
      await change(page, '.nav-favorites a', () => page.locator('.nav-group').getByRole('button', { name: `${label} 즐겨찾기에 추가`, exact: true }).press('Enter'), count);
    }
    const box = await page.locator('.nav-favorites').boundingBox();
    assert.ok(box.height <= (width <= 1100 ? 200 : 160), `three favorites height ${box.height}`);
    const edit = page.getByRole('button', { name: '즐겨찾기 편집', exact: true });
    assert.equal(await page.getByRole('button', { name: '자산 위로 이동', exact: true }).isVisible(), false);
    await page.screenshot({ path: path.join(evidence, `favorites-${width}.png`), animations: 'disabled' });
    await change(page, '.nav-favorite-actions:not([hidden])', () => edit.press('Space'), 3);
    if (width <= 1100) {
      const sizes = await page.locator('.nav-pref-control:not(:disabled)').evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => {
        const { width, height } = node.getBoundingClientRect(); return { width, height };
      }));
      assert.ok(sizes.every(size => size.width >= 44 && size.height >= 44));
      observations.push({ width, height: box.height, minTarget: Math.min(...sizes.map(size => Math.min(size.width, size.height))) });
    } else observations.push({ width, height: box.height });
    await change(page, '.nav-favorites', () => page.getByRole('button', { name: '자산 위로 이동', exact: true }).press('Enter'), 1, 'data-order', 'PRJ-001,AST-001,CAL-001');
    await change(page, '.nav-favorites', () => page.getByRole('button', { name: '자산 위로 이동', exact: true }).press('Enter'), 1, 'data-order', 'AST-001,PRJ-001,CAL-001');
    await change(page, '.nav-favorites a', () => page.locator('.nav-favorites').getByRole('button', { name: '캘린더 즐겨찾기에서 제거', exact: true }).press('Enter'), 2);
    await edit.focus();
    await change(page, '.nav-favorite-actions:not([hidden])', () => page.keyboard.press('Escape'), 0);
    assert.equal(await edit.evaluate(node => document.activeElement === node), true);
    if (width <= 1100) {
      assert.equal(await page.locator('.app-main').evaluate(node => node.inert), true);
      await change(page, '.sidebar[hidden]', () => page.keyboard.press('Escape'));
      assert.equal(await page.getByRole('button', { name: '메뉴 열기', exact: true }).evaluate(node => document.activeElement === node), true);
    }
    await page.reload(); await arm(page, '[data-pref-status="ready"]'); await signal(page);
    await openSidebar(page, width);
    assert.deepEqual(await ids(page), ['AST-001', 'PRJ-001']);
    assert.equal(await page.locator('.nav-group a[href="/projects"]').count(), 1);
    assert.equal(await page.locator('a button, button a, button button, a a').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('1100/1101 drawer boundary, Tab/inert and permission refresh keep focus', async () => {
  const { page, context } = await surface(1100);
  try {
    await openSidebar(page, 1100);
    const first = page.locator('.workspace-picker__button');
    const last = page.getByRole('button', { name: '메뉴 닫기', exact: true });
    await last.focus(); await page.keyboard.press('Tab');
    assert.equal(await first.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await last.evaluate(node => node === document.activeElement), true);
    const pin = page.locator('.nav-group').getByRole('button', { name: '프로젝트/업무 즐겨찾기에 추가', exact: true });
    await pin.focus();
    // 실제 응답의 관련 없는 메뉴만 숨겨 React 권한 재렌더 완료를 DOM에서 관측한다.
    await page.route('**/api/v1/settings/access', async route => {
      const response = await route.fetch(); const payload = await response.json();
      await route.fulfill({ response, json: { ...payload, menus: payload.menus.filter(menu => menu !== 'menu.analytics') } });
    });
    assert.equal(await page.locator('.nav-group a[href="/analytics"]').count(), 1);
    await change(page, '.nav-group a[href="/analytics"]', () => page.evaluate(() => window.dispatchEvent(new Event('orbitflow:access-changed'))), 0);
    assert.equal(await pin.evaluate(node => node === document.activeElement), true);
    assert.ok((await pin.boundingBox()).height >= 44);
    await change(page, '.sidebar[role="complementary"]', () => page.setViewportSize({ width: 1101, height: 900 }));
    assert.equal(await page.locator('.app-main').evaluate(node => node.inert), false);
    assert.equal(await page.locator('.sidebar').evaluate(node => node.inert), false);
    await change(page, '.sidebar[hidden]', () => page.setViewportSize({ width: 1100, height: 900 }));
    assert.equal(await page.locator('.sidebar').evaluate(node => node.inert), true);
  } finally { await context.close(); }
});

test('search choices honor menu permissions; project/task q is consumed without broad member reads', async () => {
  const { page, context } = await surface(1280, '/projects?q=not-a-project', fixture.actorManager);
  try {
    const reads = []; page.on('request', request => reads.push(new URL(request.url()).pathname));
    const category = page.getByRole('combobox', { name: '검색 범위', exact: true });
    assert.equal(await category.locator('option[value="/members"]').count(), 0);
    assert.equal(await category.locator('option[value="/documents"]').count(), 0);
    await arm(page, '.project-tasks__search input'); await signal(page);
    assert.equal(await page.locator('.project-tasks__search input').inputValue(), 'not-a-project');
    assert.equal(await page.locator('[data-project-id]').count(), 0);
    await page.goto(origin + '/members?q=검증&member=' + fixture.actorAdmin.membershipId);
    await arm(page, '[data-testid="screen-access-denied"]'); await signal(page);
    assert.equal(reads.some(route => route === '/api/v1/members' || route === '/api/v1/pg/members/org-chart'), false);
  } finally { await context.close(); }
  const admin = await surface(1280, '/tasks?q=not-a-task');
  try {
    await arm(admin.page, '.project-tasks__search input'); await signal(admin.page);
    assert.equal(await admin.page.locator('.project-tasks__search input').inputValue(), 'not-a-task');
    assert.equal(await admin.page.locator('[data-task-id]').count(), 0);
    await admin.page.getByRole('combobox', { name: '검색 범위', exact: true }).selectOption('/tasks');
    await admin.page.getByRole('searchbox', { name: '전역 검색', exact: true }).fill(fixture.task.title);
    await change(admin.page, '[data-task-id]', () => admin.page.locator('.global-search__submit').click());
    assert.equal(await admin.page.locator('[data-task-id]').getAttribute('data-task-id'), fixture.task.id);
  } finally { await admin.context.close(); }
});

test('document category consumes the exact query and excludes unrelated authorized rows', async () => {
  const target = await api.request(fixture.actorAdmin, '/documents', 'POST', { title: '찾을 문서', content: '합성 문서' }, 201);
  await api.request(fixture.actorAdmin, '/documents', 'POST', { title: '다른 문서', content: '합성 문서' }, 201);
  const { page, context, errors } = await surface(1280);
  try {
    await page.getByRole('combobox', { name: '검색 범위', exact: true }).selectOption('/documents');
    await page.getByRole('searchbox', { name: '전역 검색', exact: true }).fill(target.title);
    const navigation = page.waitForURL(url => url.pathname === '/documents' && url.searchParams.get('q') === target.title);
    await change(page, '[data-screen-id="DOC-001"] .table-wrap tbody tr', () => page.locator('.global-search__submit').click()); await navigation;
    assert.equal(await page.locator('[data-screen-id="DOC-001"] .table-wrap tbody tr').count(), 1);
    assert.ok((await page.locator('[data-screen-id="DOC-001"] .table-wrap tbody tr').innerText()).includes(target.title));
    assert.equal(await page.getByRole('searchbox', { name: '이 화면에서 검색', exact: true }).inputValue(), target.title);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
