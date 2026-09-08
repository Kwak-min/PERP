import assert from 'node:assert/strict';
import test, { before, after, beforeEach, afterEach } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { api, startTestServer } from '../../backend/tests/http.js';
import { installDailyListFixture } from '../../backend/tests/daily-list-fixture.js';

process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = `${root}/.artifacts/daily-list`;
let server, fixture, vite, browser, context, page, session, origin;
const requests = [];
const pageErrors = [];
before(async () => {
  await mkdir(evidence, { recursive: true });
  server = await startTestServer(); fixture = await installDailyListFixture();
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.identity.users[0].email, password: 'password-1234' } });
  assert.equal(login.status, 200);
  session = { token: login.body.token, orgId: 'pg:77', name: '격리 QA', email: 'qa@example.invalid', mustChangePassword: false,
    organizations: [{ org_id: 'pg:77', org_name: '목록 검증', org_type: 'company', roles: [] }] };
  const proxy = { '/api': new URL(server.baseUrl).origin };
  if (process.env.DAILY_LIST_BUILT === '1') {
    vite = await preview({ configFile: false, root, preview: { host: '127.0.0.1', port: 0, proxy } });
  } else {
    vite = await createServer({ configFile: false, root, plugins: [react()], server: { host: '127.0.0.1', port: 0, proxy, watch: { ignored: ['**/.artifacts/**', '**/dist/**'] } } });
    await vite.listen();
  }
  origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome' });
});
beforeEach(async () => {
  fixture.seed();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
  page = await context.newPage(); page.setDefaultTimeout(4000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(value => localStorage.setItem('orbitflow.session.v1', JSON.stringify(value)), session);
  page.on('request', request => {
    if (request.url().includes('/pg/records/')) requests.push({ method: request.method(), path: new URL(request.url()).pathname });
  });
  const response = page.waitForResponse(r => r.url().includes('/pg/finance/budgets'));
  await page.goto(`${origin}/finance/budgets`);
  assert.equal((await response).status(), 200);
  await page.locator('tbody tr').first().waitFor();
});
afterEach(async () => { await context?.close(); assert.deepEqual(pageErrors, []); });
after(async () => {
  await writeFile(`${evidence}/mutation-requests.json`, JSON.stringify(requests, null, 2));
  await browser?.close();
  if (vite?.close) await vite.close();
  else if (vite) await new Promise((resolve, reject) => vite.httpServer.close(error => error ? reject(error) : resolve()));
  await fixture?.close(); await server?.close();
  console.log('DAILY_LIST_CLEANUP_COMPLETE');
});

async function csvRows() {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /내보내기/ }).click();
  const file = await download;
  // 쉼표가 없는 fixture 이름과 별개로 숫자 천단위 쉼표는 인용 CSV 값이다.
  return (await readFile(await file.path(), 'utf8')).replace(/^\uFEFF/, '').trimEnd().split('\n');
}

test('all 25 company rows are reachable across pages; foreign rows never enter list or CSV', async () => {
  const result = await api(server.baseUrl, '/pg/finance/budgets', session);
  assert.equal(result.body.items.length, 25);
  const names = [];
  for (const count of [10, 10, 5]) {
    await expect(page.locator('tbody tr')).toHaveCount(count);
    names.push(...await page.locator('tbody tr td:first-child').allTextContents());
    if (count === 10) await page.getByRole('button', { name: '다음 페이지' }).click();
  }
  assert.equal(new Set(names).size, 25);
  assert.equal(names.includes('외부-비공개'), false);
  assert.equal((await csvRows()).length - 1, 25);
  await page.screenshot({ path: `${evidence}/last-page.png`, fullPage: true });
});

test('search and typed status intersect over the full list and reset pagination; CSV exports all matches', async () => {
  await page.getByRole('button', { name: '다음 페이지' }).click();
  await page.getByRole('searchbox', { name: '이 화면에서 검색' }).fill('대상');
  await page.getByRole('button', { name: '활성', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(10);
  assert.equal((await csvRows()).length - 1, 12);
  await page.getByRole('button', { name: '다음 페이지' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByRole('searchbox', { name: '이 화면에서 검색' }).fill('대상-01');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  assert.equal((await csvRows()).length - 1, 1);
  await page.getByRole('searchbox', { name: '이 화면에서 검색' }).fill('없는항목');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  assert.equal((await csvRows()).length - 1, 0);
});

for (const [position, id] of [[2, 23], [9, 16], [24, 1]]) {
  test(`filtered row ${position} edits and deletes only ID ${id}, preserving every other row`, async () => {
    const before = fixture.snapshot();
    await page.getByRole('searchbox', { name: '이 화면에서 검색' }).fill('대상');
    const pageIndex = Math.floor((position - 1) / 10);
    for (let i = 0; i < pageIndex; i++) await page.getByRole('button', { name: '다음 페이지' }).click();
    const name = `대상-${String(id).padStart(2, '0')}`;
    const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
    const editRead = page.waitForResponse(r => r.url().includes('/pg/records/budgets/') && r.request().method() === 'GET');
    await row.getByRole('button', { name: '수정', exact: true }).click();
    assert.equal(new URL((await editRead).url()).pathname, `/api/v1/pg/records/budgets/${id}`);
    await page.getByRole('dialog').locator('input[type="text"]').fill(`${name}-수정`);
    const patch = page.waitForResponse(r => r.url().endsWith(`/pg/records/budgets/${id}`) && r.request().method() === 'PATCH');
    const reload = page.waitForResponse(r => r.url().includes('/pg/finance/budgets'));
    await page.getByRole('button', { name: '저장', exact: true }).click();
    assert.equal((await patch).status(), 200); await reload;
    const edited = page.getByRole('row').filter({ has: page.getByRole('cell', { name: `${name}-수정`, exact: true }) });
    await edited.waitFor();
    assert.deepEqual(fixture.snapshot(), before.map(record => record.id === id ? { ...record, name: `${name}-수정` } : record));
    const deletion = page.waitForResponse(r => r.url().includes('/pg/records/budgets/') && r.request().method() === 'DELETE');
    const deleteReload = page.waitForResponse(r => r.url().includes('/pg/finance/budgets'));
    page.once('dialog', dialog => dialog.accept());
    await edited.getByRole('button', { name: '삭제', exact: true }).click();
    const deleted = await deletion;
    assert.equal(new URL(deleted.url()).pathname, `/api/v1/pg/records/budgets/${id}`);
    assert.equal(deleted.status(), 200); await deleteReload;
    await expect(page.getByRole('cell', { name: `${name}-수정`, exact: true })).toHaveCount(0);
    assert.deepEqual(fixture.snapshot(), before.filter(record => record.id !== id));
  });
}

test('home displays eight company tasks with two assignments, including cancelled work', async () => {
  const usage = page.waitForResponse(response => response.url().includes('/pg/usage'));
  await page.goto(`${origin}/`);
  const response = await usage;
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).tasks, 8);
  const card = page.locator('.stat-card').filter({ has: page.locator('.stat-card__label', { hasText: /^업무$/ }) });
  await expect(card.locator('.stat-card__value')).toHaveText('8');
  await page.screenshot({ path: `${evidence}/home-tasks.png`, fullPage: true });
});

for (const width of [375, 768]) {
  test(`pagination remains reachable at viewport ${width}`, async () => {
    await page.setViewportSize({ width, height: 900 });
    const next = page.getByRole('button', { name: '다음 페이지' });
    await next.click(); await next.click();
    await expect(page.locator('tbody tr')).toHaveCount(5);
    assert.equal(await next.isDisabled(), true);
    await page.screenshot({ path: `${evidence}/last-page-${width}.png`, fullPage: true });
  });
}

test('record endpoints reject another company for GET, PATCH and DELETE without changes', async () => {
  const before = fixture.snapshot();
  for (const method of ['GET', 'PATCH', 'DELETE']) {
    const result = await api(server.baseUrl, '/pg/records/budgets/99', { ...session, method, ...(method === 'PATCH' ? { body: { name: 'LEAK' } } : {}) });
    assert.equal(result.status, 404);
  }
  assert.deepEqual(fixture.snapshot(), before);
});
