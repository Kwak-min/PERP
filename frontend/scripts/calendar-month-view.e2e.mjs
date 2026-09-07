import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { api, createOwnerOrg, startTestServer } from '../../backend/tests/http.js';
import { installCalendarFixture } from './calendar-pg-fixture.mjs';

// 실제 Chrome/SPA/HTTP/권한/SQLite. PG만 SQL 경계 픽스처이며 원격 DB는 접속하지 않는다.
process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
const frontend = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(frontend, '.artifacts/calendar-month-view');
await mkdir(evidence, { recursive: true });
const server = await startTestServer();
const fixture = await installCalendarFixture();
const results = [];
let browser, vite;
const samples = [
  { title: '월경계 행사', start_at: '2026-08-31T23:00:00+09:00', end_at: '2026-09-03T00:00:00+09:00', location: 'QA 회의실' },
  { title: '여러 날 워크숍', start_at: '2026-09-10T09:00:00+09:00', end_at: '2026-09-12T12:00:00+09:00' },
  { title: 'UTC 날짜 경계', start_at: '2026-09-30T15:30:00Z', end_at: '2026-09-30T16:30:00Z' },
  ...Array.from({ length: 5 }, (_, i) => ({ title: `밀집 일정 ${i + 1}`, start_at: `2026-09-07T0${i}:00:00Z`, end_at: `2026-09-07T0${i}:30:00Z` })),
];
try {
  vite = await createServer({ configFile: false, root: frontend, plugins: [react()], server: {
    host: '127.0.0.1', port: 0, watch: { ignored: ['**/.artifacts/**', '**/dist/**'] }, proxy: { '/api': new URL(server.baseUrl).origin },
  } });
  await vite.listen(); const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
  browser = await chromium.launch({ channel: 'chrome' });
  console.log('CHROME_VERSION ' + browser.version());
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
      await shot('empty');
      results.push(`${session.name}: empty month grid`);

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
      await cell('2026-09-01').getByRole('link', { name: /월경계 행사/ }).waitFor();
      assert.equal(await cell('2026-09-02').getByRole('link', { name: /월경계 행사/ }).count(), 1);
      assert.equal(await cell('2026-09-03').getByRole('link', { name: /월경계 행사/ }).count(), 0);
      for (const day of [10, 11, 12]) assert.equal(await cell(`2026-09-${day}`).getByRole('link', { name: /여러 날 워크숍/ }).count(), 1);
      assert.equal(await page.getByRole('link', { name: /OTHER_ORG_SECRET|UTC 날짜 경계|FUTURE_/ }).count(), 0);
      assert.equal(await cell('2026-09-07').locator('details[open]').count(), 0);
      await cell('2026-09-07').locator('summary').click();
      await cell('2026-09-07').getByRole('link', { name: /밀집 일정 5/ }).waitFor();
      await shot('overflow-expanded');
      results.push(`${session.name}: local dates, multi-day, exclusive midnight, company scope, overflow`);

      // When: following the actual event link and reloading its detail URL. Then: server detail survives direct navigation.
      const detailResponse = page.waitForResponse(r => session.pg ? new URL(r.url()).searchParams.get('event_id') === ids[0] : new URL(r.url()).pathname === `${calendarPath}/${ids[0]}`);
      await cell('2026-09-01').getByRole('link', { name: /월경계 행사/ }).click(); assert.equal((await detailResponse).status(), 200);
      await page.locator('.kv-list').waitFor(); assert.match(await page.locator('.kv-list').innerText(), /QA 회의실/);
      await page.reload(); await page.locator('.kv-list').waitFor(); await shot('detail');
      await page.getByRole('link', { name: '캘린더로', exact: true }).click(); await cell('2026-09-01').waitFor();
      results.push(`${session.name}: clickable deep-linked detail and reload`);

      // When: navigating month boundaries. Then: fresh scoped HTTP queries and correct dates, not repeated event lists.
      let next = responseFor(); await page.getByRole('button', { name: '다음 달', exact: true }).click(); assert.equal((await next).status(), 200);
      await cell('2026-10-01').getByRole('link', { name: /UTC 날짜 경계/ }).waitFor();
      assert.equal(await page.locator('[aria-current="date"]').count(), 0); await shot('october');
      next = responseFor(); await page.getByRole('button', { name: '다음 달', exact: true }).click(); await next; await cell('2026-11-01').waitFor();
      assert.equal(await page.locator('.calendar__event').count(), 0); await shot('empty-november');
      next = responseFor(); await page.getByRole('button', { name: '오늘', exact: true }).click(); await next; await cell('2026-09-01').waitFor();
      next = responseFor(); await page.getByRole('button', { name: '이전 달', exact: true }).click(); await next;
      await cell('2026-08-31').getByRole('link', { name: /월경계 행사/ }).waitFor(); await shot('august');
      next = responseFor(); await page.getByRole('button', { name: '오늘', exact: true }).click(); await next; await cell('2026-09-01').waitFor();
      results.push(`${session.name}: previous, next, today, cross-month, empty month navigation`);
      next = responseFor(); await page.goto(origin + '/calendar?month=2024-02'); await next; await cell('2024-02-29').waitFor();
      assert.equal(await page.locator('.calendar__cell[data-date]').count(), 29);
      assert.equal(await page.locator('.calendar__cell').nth(3).getAttribute('data-date'), '2024-02-01'); await shot('leap-february');
      next = responseFor(); await page.goto(origin + '/calendar?month=2026-12'); await next; await cell('2026-12-01').waitFor();
      next = responseFor(); await page.getByRole('button', { name: '다음 달', exact: true }).click(); await next; await cell('2027-01-01').waitFor();
      assert.equal(await page.locator('.calendar__event').count(), session.pg ? 105 : 0); await shot('year-boundary');
      next = responseFor(); await page.getByRole('button', { name: '오늘', exact: true }).click(); await next; await cell('2026-09-01').waitFor();
      results.push(`${session.name}: leap-year weekday alignment, year rollover, complete bounded query`);

      // When: entering local times and submitting. Then: UTC instants persist and refreshed/reloaded month shows the event.
      await expect(page.getByRole('button', { name: '새로 만들기', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '새로 만들기', exact: true }).click();
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
      await cell('2026-09-16').getByRole('link', { name: /브라우저 저장 일정/ }).waitFor();
      next = responseFor(); await page.reload(); await next; await cell('2026-09-17').getByRole('link', { name: /브라우저 저장 일정/ }).waitFor();
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
        await shot(`month-${width}`);
        if (width === 375) {
          // 모바일에서 실제 링크·상세 복귀·생성 폼·맨 아래 날짜 접근까지 확인한다.
          await cell('2026-09-15').getByRole('link', { name: /브라우저 저장 일정/ }).click();
          await page.locator('.kv-list').waitFor(); await shot('mobile-detail');
          await page.getByRole('link', { name: '캘린더로', exact: true }).click(); await cell('2026-09-01').waitFor();
          await page.getByRole('button', { name: '새로 만들기', exact: true }).click();
          await page.getByRole('dialog').waitFor(); await shot('mobile-create');
          await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click();
          await cell('2026-09-30').scrollIntoViewIfNeeded(); await shot('mobile-month-bottom');
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
        assert.equal(await page.locator('.calendar__grid').count(), 0); await shot('read-denied');
        results.push(`${session.name}: explicit write/read permissions and server-denied save`);
      }
      assert.deepEqual(errors, []);
    } catch (error) { await shot('failure'); throw error; }
    finally { await context.close(); }
  }
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ chrome: browser.version(), results, pgEvidence: 'SQL boundary fixture using isolated SQLite; not real PostgreSQL', legacyEvidence: 'real Express HTTP + temporary SQLite', remoteCalls: false }, null, 2));
  for (const result of results) console.log('PASS ' + result);
  console.log('CALENDAR_MONTH_VIEW_PASS');
} finally {
  await browser?.close(); await vite?.close(); await fixture.close(); await server.close();
}
