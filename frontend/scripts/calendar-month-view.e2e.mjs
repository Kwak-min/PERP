import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { api, createOwnerOrg, startTestServer } from '../../backend/tests/http.js';
import { installCalendarFixture } from './calendar-pg-fixture.mjs';

// 실제 Chrome/SPA/HTTP/권한/SQLite. PG만 SQL 경계 픽스처이며 원격 DB는 접속하지 않는다.
process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
const frontend = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(frontend, '.artifacts/calendar-selected-day');
await mkdir(evidence, { recursive: true });
const server = await startTestServer();
const fixture = await installCalendarFixture();
const results = [];
let browser, vite;
const longTitle = '밀집 일정 5 ' + '전체제목'.repeat(35);
const samples = [
  { title: '월경계 행사', start_at: '2026-08-31T23:00:00+09:00', end_at: '2026-09-03T00:00:00+09:00', location: 'QA 회의실' },
  { title: '여러 날 워크숍', start_at: '2026-09-10T09:00:00+09:00', end_at: '2026-09-12T12:00:00+09:00' },
  { title: 'UTC 날짜 경계', start_at: '2026-09-30T15:30:00Z', end_at: '2026-09-30T16:30:00Z' },
  ...Array.from({ length: 5 }, (_, i) => ({ title: i === 4 ? longTitle : `밀집 일정 ${i + 1}`, start_at: `2026-09-07T0${i}:00:00Z`, end_at: `2026-09-07T0${i}:30:00Z` })),
];
try {
  vite = await createServer({ configFile: false, root: frontend, plugins: [react()], server: {
    host: '127.0.0.1', port: 0, watch: { ignored: ['**/.artifacts/**', '**/dist/**'] }, proxy: { '/api': new URL(server.baseUrl).origin },
  } });
  await vite.listen(); const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
  browser = await chromium.launch({ channel: 'chrome' });
  console.log('CHROME_VERSION ' + browser.version());
  // 선택 기능을 사용하지 않는 휴가 달력의 기존 표시/펼치기 계약도 보존한다.
  const { MonthCalendar } = await vite.ssrLoadModule('/src/components/data/MonthCalendar.tsx');
  const shared = await browser.newPage();
  try {
    await shared.setContent(renderToStaticMarkup(createElement(MemoryRouter, null, createElement(MonthCalendar, {
      year: 2026, month: 8, today: 7,
      events: Array.from({ length: 5 }, (_, index) => ({ id: String(index), day: 7, title: `SHARED_${index}`, href: `/calendar/${index}` })),
    }))));
    assert.equal(await shared.locator('.calendar__cell[data-date]').count(), 30);
    assert.equal(await shared.locator('button.calendar__cell').count(), 0);
    assert.equal(await shared.locator('.calendar__event').count(), 5);
    await shared.locator('summary').click(); await expect(shared.getByRole('link').last()).toBeVisible();
    results.push('shared MonthCalendar: non-selectable caller retains event links and overflow disclosure');
  } finally { await shared.close(); }
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.identity.users[0].email, password: 'password-1234' } });
  assert.equal(login.status, 200);
  const legacy = await createOwnerOrg(server.baseUrl, ['calendar']);
  const other = await createOwnerOrg(server.baseUrl, ['calendar']);
  const sessions = [
    { name: 'pg-sql-fixture', pg: true, token: login.body.token, orgId: 'pg:77' },
    { name: 'legacy-real-http', pg: false, ...legacy },
  ];
  for (const session of sessions) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Seoul' });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const calendarPath = `/api/v1/${session.pg ? 'pg/' : ''}calendar`;
    const responseFor = (method = 'GET') => page.waitForResponse(r => new URL(r.url()).pathname === calendarPath && r.request().method() === method);
    const shot = name => page.screenshot({ path: path.join(evidence, `${session.name}-${name}.png`), fullPage: true });
    const cell = date => page.locator(`.calendar__cell[data-date="${date}"]`);
    const preview = (date, title) => cell(date).locator('.calendar__event').filter({ hasText: title });
    const dayList = page.locator('.calendar-selected-day');
    const select = async date => {
      await cell(date).click();
      await expect(cell(date)).toHaveAttribute('aria-pressed', 'true');
      await expect(dayList).toHaveAttribute('data-date', date);
      assert.equal(await page.locator('.calendar__cell[aria-pressed="true"]').count(), 1);
    };
    await context.addInitScript(stored => localStorage.setItem('orbitflow.session.v1', JSON.stringify(stored)), {
      token: session.token, orgId: session.orgId, name: 'Calendar QA', email: 'calendar@example.invalid', mustChangePassword: false,
      organizations: [{ org_id: session.orgId, org_name: 'CALENDAR_QA', org_type: session.pg ? 'perp_db' : 'custom', roles: ['member'] }],
    });
    await page.clock.setFixedTime(new Date('2026-09-07T03:00:00Z'));
    try {
      // Given: selected workspace has no events. When: opening the route. Then: empty month remains a grid.
      const loaded = responseFor(); await page.goto(origin + '/calendar'); assert.equal((await loaded).status(), 200);
      await cell('2026-09-01').waitFor();
      assert.equal(await page.locator('.calendar__grid').count(), 1);
      assert.equal(await page.locator('.calendar__cell[data-date]').count(), 30);
      assert.equal(await page.locator('.calendar__cell[aria-current="date"]').getAttribute('data-date'), '2026-09-07');
      assert.equal(await page.locator('button.calendar__cell[data-date]').count(), 30, 'every date is a native selection button');
      await expect(cell('2026-09-07')).toHaveAttribute('aria-pressed', 'true');
      for (const [date, key] of [['2026-09-01', 'Enter'], ['2026-09-30', 'Space']]) {
        await cell(date).focus(); await page.keyboard.press(key);
        await expect(cell(date)).toHaveAttribute('aria-pressed', 'true');
        await expect(dayList).toHaveAttribute('data-date', date);
        await expect(cell(date)).toBeFocused();
      }
      await cell('2026-09-01').focus(); await page.keyboard.press('Tab'); await expect(cell('2026-09-02')).toBeFocused();
      await select('2026-09-03');
      assert.equal(await dayList.getByRole('link').count(), 0);
      assert.equal(await dayList.locator('[role="status"]').count(), 1);
      assert.equal(await page.locator('button.calendar__cell :is(a, button, details, summary, input, select)').count(), 0);
      await shot('empty');
      results.push(`${session.name}: empty month/day, native date buttons, Enter/Space, selected state, valid interactive markup`);

      // Given: real persisted HTTP events or explicitly labelled SQL fixture rows, including other organizations.
      const ids = [];
      for (const event of samples) {
        if (session.pg) ids.push(String(fixture.seed(event)));
        else {
          const created = await api(server.baseUrl, '/calendar', { ...session, method: 'POST', body: { ...event, start_at: new Date(event.start_at).toISOString(), end_at: new Date(event.end_at).toISOString() } });
          assert.equal(created.status, 201); ids.push(created.body.id);
        }
      }
      if (session.pg) {
        fixture.seed({ ...samples[0], title: 'OTHER_ORG_SECRET' }, '88');
        // 105 future rows must not push the current month out of a global LIMIT 100.
        for (let index = 0; index < 105; index++) fixture.seed({ title: `FUTURE_${index}`, start_at: '2027-01-01T00:00:00Z', end_at: '2027-01-01T01:00:00Z' });
      } else assert.equal((await api(server.baseUrl, '/calendar', { ...other, method: 'POST', body: { ...samples[0], title: 'OTHER_ORG_SECRET' } })).status, 201);
      const refreshed = responseFor(); await page.reload(); assert.equal((await refreshed).status(), 200);
      await preview('2026-09-01', samples[0].title).waitFor();
      await expect(dayList).toHaveAttribute('data-date', '2026-09-03');
      assert.equal(await preview('2026-09-02', samples[0].title).count(), 1);
      assert.equal(await preview('2026-09-03', samples[0].title).count(), 0);
      assert.equal(await dayList.getByRole('link').count(), 0);
      for (const day of [10, 11, 12]) {
        assert.equal(await preview(`2026-09-${day}`, samples[1].title).count(), 1);
        await select(`2026-09-${day}`);
        assert.deepEqual(await dayList.locator('strong').allTextContents(), [samples[1].title]);
        assert.deepEqual(await dayList.locator('time').evaluateAll(elements => elements.map(element => element.dateTime)), [new Date(samples[1].start_at).toISOString(), new Date(samples[1].end_at).toISOString()]);
      }
      await select('2026-09-13'); assert.equal(await dayList.getByRole('link').count(), 0);
      assert.equal(await page.locator('.calendar-screen').getByText(/OTHER_ORG_SECRET|FUTURE_/).count(), 0);
      await select('2026-09-07');
      assert.equal(await cell('2026-09-07').locator('.calendar__event').count(), 3);
      assert.deepEqual(await dayList.locator('strong').allTextContents(), samples.slice(3).map(event => event.title));
      assert.equal(await dayList.getByRole('link').count(), 5);
      assert.equal(await page.locator('button.calendar__cell :is(a, button, details, summary)').count(), 0);
      await expect(page.locator('.calendar-summary')).toBeVisible();
      assert.equal(parseInt(await page.locator('.calendar-summary__stats dd').first().textContent(), 10), 7);
      assert.equal(parseInt(await page.locator('.calendar-summary__stats dd').last().textContent(), 10), 5);
      assert.deepEqual(await page.locator('.calendar-upcoming strong').allTextContents(), [...samples.slice(3), samples[1]].map(event => event.title));
      assert.deepEqual(await page.locator('.calendar-summary').evaluate(element => ({
        occupiedDays: parseInt(element.querySelectorAll('.calendar-summary__stats dd')[1].textContent, 10),
        titlesFit: [...element.querySelectorAll('.calendar-upcoming strong')].every(title => title.scrollWidth <= title.clientWidth && title.getBoundingClientRect().right <= element.getBoundingClientRect().right),
      })), { occupiedDays: 6, titlesFit: true });
      const summaryLink = page.locator('.calendar-upcoming__item').first();
      await expect(summaryLink).toHaveAttribute('href', `/calendar/${ids[3]}?month=2026-09&day=2026-09-07`);
      const summaryDetail = page.waitForResponse(r => session.pg ? new URL(r.url()).searchParams.get('event_id') === ids[3] : new URL(r.url()).pathname === `${calendarPath}/${ids[3]}`);
      await summaryLink.click(); assert.equal((await summaryDetail).status(), 200);
      await page.locator('.kv-list').waitFor();
      assert.equal(await page.locator('.calendar-summary').count(), 0);
      await page.getByRole('link', { name: '캘린더로', exact: true }).click();
      await expect(cell('2026-09-07')).toHaveAttribute('aria-pressed', 'true');
      await shot('populated-complete-list');
      results.push(`${session.name}: summary total/today counts, sorted six upcoming links, detail hides summary, return preserves selected date`);
      results.push(`${session.name}: selected local dates, multi-day, exclusive midnight, company scope, all five events below three previews, full title/time`);

      // When: following the actual event link and reloading its detail URL. Then: server detail survives direct navigation.
      await select('2026-09-02');
      const detailResponse = page.waitForResponse(r => session.pg ? new URL(r.url()).searchParams.get('event_id') === ids[0] : new URL(r.url()).pathname === `${calendarPath}/${ids[0]}`);
      await dayList.getByRole('link').click(); assert.equal((await detailResponse).status(), 200);
      await page.locator('.kv-list').waitFor(); assert.match(await page.locator('.kv-list').innerText(), /QA 회의실/);
      await page.reload(); await page.locator('.kv-list').waitFor(); await shot('detail');
      await page.getByRole('link', { name: '캘린더로', exact: true }).click(); await cell('2026-09-01').waitFor();
      await expect(cell('2026-09-02')).toHaveAttribute('aria-pressed', 'true');
      assert.deepEqual(await dayList.locator('strong').allTextContents(), [samples[0].title]);
      results.push(`${session.name}: list click opens server detail, direct reload and return preserve selected date`);

      // When: navigating month boundaries. Then: fresh scoped HTTP queries and correct dates, not repeated event lists.
      let next = responseFor(); await page.getByRole('button', { name: '다음 달', exact: true }).click(); assert.equal((await next).status(), 200);
      await preview('2026-10-01', samples[2].title).waitFor();
      await expect(dayList).toHaveAttribute('data-date', '2026-10-01');
      assert.deepEqual(await dayList.locator('strong').allTextContents(), [samples[2].title]);
      assert.equal(await page.locator('[aria-current="date"]').count(), 0); await shot('october');
      next = responseFor(); await page.getByRole('button', { name: '다음 달', exact: true }).click(); await next; await cell('2026-11-01').waitFor();
      assert.equal(await page.locator('.calendar__event').count(), 0); await shot('empty-november');
      next = responseFor(); await page.getByRole('button', { name: '오늘', exact: true }).click(); await next; await cell('2026-09-01').waitFor();
      next = responseFor(); await page.getByRole('button', { name: '이전 달', exact: true }).click(); await next;
      await preview('2026-08-31', samples[0].title).waitFor();
      await select('2026-08-31'); assert.deepEqual(await dayList.locator('strong').allTextContents(), [samples[0].title]); await shot('august');
      next = responseFor(); await page.getByRole('button', { name: '오늘', exact: true }).click(); await next; await cell('2026-09-01').waitFor();
      results.push(`${session.name}: previous, next, today, cross-month, empty month navigation`);
      next = responseFor(); await page.goto(origin + '/calendar?month=2024-02'); await next; await cell('2024-02-29').waitFor();
      assert.equal(await page.locator('.calendar__cell[data-date]').count(), 29);
      assert.equal(await page.locator('.calendar__cell').nth(3).getAttribute('data-date'), '2024-02-01'); await shot('leap-february');
      next = responseFor(); await page.goto(origin + '/calendar?month=2026-12'); await next; await cell('2026-12-01').waitFor();
      next = responseFor(); await page.getByRole('button', { name: '다음 달', exact: true }).click(); await next; await cell('2027-01-01').waitFor();
      assert.equal(await page.locator('.calendar__event').count(), session.pg ? 3 : 0);
      assert.equal(await dayList.getByRole('link').count(), session.pg ? 105 : 0); await shot('year-boundary');
      next = responseFor(); await page.getByRole('button', { name: '오늘', exact: true }).click(); await next; await cell('2026-09-01').waitFor();
      results.push(`${session.name}: leap-year weekday alignment, year rollover, complete bounded query`);
      for (const query of ['month=2026-09&day=2026-09-31', 'month=2026-09&day=2026-08-31', 'month=2026-09&day=invalid']) {
        next = responseFor(); await page.goto(`${origin}/calendar?${query}`); await next; await cell('2026-09-07').waitFor();
        await expect(cell('2026-09-07')).toHaveAttribute('aria-pressed', 'true');
        await expect(dayList).toHaveAttribute('data-date', '2026-09-07');
      }
      results.push(`${session.name}: invalid or out-of-month selected-date URLs fall back to today`);

      // When: entering local times and submitting. Then: UTC instants persist and refreshed/reloaded month shows the event.
      await expect(page.getByRole('button', { name: '새로 만들기', exact: true })).toBeEnabled();
      await select('2026-09-15');
      await page.getByRole('button', { name: '새로 만들기', exact: true }).click();
      assert.equal(await page.getByLabel('시작', { exact: true }).inputValue(), '2026-09-15T09:00');
      await page.getByLabel('제목', { exact: true }).fill('브라우저 저장 일정');
      await page.getByLabel('시작', { exact: true }).fill('2026-09-15T09:30');
      await page.getByLabel('종료', { exact: true }).fill('2026-09-17T10:30');
      await page.getByLabel('장소', { exact: true }).fill('QA 입력 장소');
      await shot('create-modal');
      const saved = responseFor('POST'); const listAfterSave = responseFor();
      await page.getByRole('button', { name: '만들기', exact: true }).click(); const savedResponse = await saved;
      assert.equal(savedResponse.status(), 201); await listAfterSave;
      const body = savedResponse.request().postDataJSON();
      assert.equal(body[session.pg ? 'starts_at' : 'start_at'], '2026-09-15T00:30:00.000Z');
      await preview('2026-09-16', '브라우저 저장 일정').waitFor();
      await expect(dayList).toHaveAttribute('data-date', '2026-09-15');
      assert.deepEqual(await dayList.locator('strong').allTextContents(), ['브라우저 저장 일정']);
      next = responseFor(); await page.reload(); await next; await preview('2026-09-17', '브라우저 저장 일정').waitFor();
      results.push(`${session.name}: real create HTTP, UTC persistence, refresh and reload`);
      for (const width of [375, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        // 리사이즈로 시작한 사이드바 전환의 완료 신호를 기다려 중간 프레임을 증거로 쓰지 않는다.
        await page.evaluate(async () => {
          document.querySelector('.sidebar').getBoundingClientRect();
          let timer;
          try { await Promise.race([Promise.all(document.getAnimations().map(animation => animation.finished)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('resize animation did not finish')), 5000); })]); }
          finally { clearTimeout(timer); }
        });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no page overflow at ${width}`);
        assert.equal(await page.locator('.calendar-body').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), width <= 1024 ? 1 : 2);
        await expect(page.locator('.calendar-summary')).toBeVisible();
        assert.equal(await page.locator('.calendar-summary').evaluate(element => [...element.querySelectorAll('.calendar-upcoming strong')].every(title => title.scrollWidth <= title.clientWidth && title.getBoundingClientRect().right <= element.getBoundingClientRect().right)), true, 'upcoming titles wrap inside summary');
        await select('2026-09-07');
        assert.equal(await dayList.getByRole('link').count(), 5);
        assert.equal(await dayList.locator('strong').last().textContent(), longTitle);
        assert.equal(await dayList.locator('strong').last().evaluate(element => element.scrollWidth <= element.clientWidth && getComputedStyle(element).whiteSpace !== 'nowrap'), true, 'full title wraps without truncation');
        await shot(`month-${width}`);
        if (width === 375) {
          // 모바일에서 실제 링크·상세 복귀·생성 폼·맨 아래 날짜 접근까지 확인한다.
          await dayList.getByRole('link').last().click();
          await page.locator('.kv-list').waitFor();
          assert.equal(await page.locator('.kv-list dd').first().textContent(), longTitle);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'full detail title wraps on mobile');
          await shot('mobile-detail');
          await page.getByRole('link', { name: '캘린더로', exact: true }).click(); await cell('2026-09-01').waitFor();
          await page.getByRole('button', { name: '새로 만들기', exact: true }).click();
          await page.getByRole('dialog').waitFor(); await shot('mobile-create');
          await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click();
          await select('2026-09-30'); await shot('mobile-month-bottom');
          assert.equal(await cell('2026-09-30').evaluate(element => {
            const date = element.querySelector('.calendar__date'), bounds = date.getBoundingClientRect();
            return document.elementFromPoint(bounds.left + 2, bounds.top + 2) === date;
          }), true, 'bottom month dates remain reachable above the mobile navigation');
          await page.locator('.calendar-nav').scrollIntoViewIfNeeded();
        }
      }
      results.push(`${session.name}: 375/768/1280 responsive grid`);
      if (session.pg) {
        // Permissions are read from the selected workspace; server rejection still protects a stale open form.
        await page.getByRole('button', { name: '새로 만들기', exact: true }).click();
        await page.getByLabel('제목', { exact: true }).fill('DENIED_WRITE');
        fixture.identity.state.permissions = fixture.identity.state.permissions.filter(p => p.code !== 'event.write');
        const denied = responseFor('POST'); await page.getByRole('button', { name: '만들기', exact: true }).click();
        assert.equal((await denied).status(), 403); await page.getByRole('dialog').getByRole('alert').waitFor(); await shot('create-denied');
        await page.reload(); await cell('2026-09-01').waitFor();
        await expect(page.getByRole('button', { name: '새로 만들기', exact: true })).toBeDisabled();
        fixture.identity.state.permissions = fixture.identity.state.permissions.filter(p => p.code !== 'event.read');
        next = responseFor(); await page.reload(); assert.equal((await next).status(), 403); await page.locator('.calendar-screen [role="alert"]').waitFor();
        assert.equal(await page.locator('.calendar__grid').count(), 0);
        assert.equal(await dayList.count(), 0); await shot('read-denied');
        results.push(`${session.name}: explicit write/read permissions and server-denied save`);
      }
      assert.deepEqual(errors, []);
    } catch (error) { await shot('failure'); throw error; }
    finally { await context.close(); }
  }
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ chrome: browser.version(), results, pgEvidence: 'SQL boundary fixture using isolated SQLite; not real PostgreSQL', legacyEvidence: 'real Express HTTP + temporary SQLite', remoteCalls: false }, null, 2));
  for (const result of results) console.log('PASS ' + result);
  console.log('CALENDAR_MONTH_VIEW_PASS');
  console.log('CALENDAR_SELECTED_DAY_PASS');
} finally {
  await browser?.close(); await vite?.close(); await fixture.close(); await server.close();
}
