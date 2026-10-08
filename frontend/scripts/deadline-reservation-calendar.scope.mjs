import assert from 'node:assert/strict';

async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP gate deadline')), 10000); })]); }
  finally { clearTimeout(timer); }
}
// 본문은 실제 Reservation HTTP 응답 그대로다. 늦은 응답의 전달 순서만 통제한다.
async function hold(page, routing, matches) {
  const ready = Promise.withResolvers(), release = Promise.withResolvers(), done = Promise.withResolvers();
  const handler = async route => {
    try {
      const response = await route.fetch(); ready.resolve(response);
      await bounded(release.promise); await route.fulfill({ response }); done.resolve(null);
    } catch (error) { ready.reject(error); done.resolve(error); }
  };
  const gate = { page, matches, handler };
  routing.gates.add(gate);
  return { ready: () => bounded(ready.promise), release: async () => { release.resolve(); const error = await bounded(done.promise); routing.gates.delete(gate); if (error) throw error; } };
}

export async function scopeChecks({ page, fixture, company, rendered, capture, result, routing }) {
  const checks = [];
  const selectDay = async day => {
    await page.locator(`.rsv-month-day[data-day="${day}"]`).click();
    await rendered(page, `.rsv-day-occupancy[data-day="${day}"][data-state="ready"]`);
  };
  const matches = day => url => url.pathname.endsWith('/reservations/timetable') && url.searchParams.get('date') === day;

  // Given: 이전 날짜의 실제 응답이 전송 대기 중.
  // When: 다른 날짜 선택. Then: 요청 중단 이벤트 + 새 날짜의 빈 구간만 유지.
  const gate = await hold(page, routing, matches('2032-01-31'));
  const aborted = page.waitForEvent('requestfailed', { predicate: request => matches('2032-01-31')(new URL(request.url())), timeout: 10000 });
  await page.locator('.rsv-month-day[data-day="2032-01-31"]').click();
  assert.equal((await gate.ready()).status(), 200);
  await selectDay('2032-01-30'); await aborted; await gate.release();
  assert.equal(await page.locator('[data-reservation-id]').count(), 0);
  assert.equal(await page.locator('.rsv-day-occupancy[data-day="2032-01-30"]').count(), 1);
  checks.push('old day response cancelled; latest day selection and empty free interval retained');

  // Given: 이전 공간의 날짜 요청이 보류됨. When: 카드 목록으로 돌아가 두번째 실제 공간 선택.
  const spaceGate = await hold(page, routing, matches('2032-01-31'));
  const spaceAbort = page.waitForEvent('requestfailed', { predicate: request => matches('2032-01-31')(new URL(request.url())), timeout: 10000 });
  await page.locator('.rsv-month-day[data-day="2032-01-31"]').click(); await spaceGate.ready();
  await page.locator('.rsv-selected-space-header button').click(); await rendered(page, '.rsv-space-card');
  await page.locator('.rsv-space-card').nth(1).click(); await rendered(page, '.rsv-month-calendar[data-state="ready"]');
  await spaceAbort; await spaceGate.release();
  assert.equal(await page.locator('.rsv-day-occupancy').count(), 0);
  await selectDay('2032-01-31'); assert.equal(await page.locator('[data-reservation-id]').count(), 0);
  await capture('second-space-empty-day');
  checks.push('space selection cancels old request and clears day selection');

  // Given: 격리 DB의 실제 테이블 접근 실패. When: 새 날짜 요청. Then: 실제500 오류이며 가짜 예약 가능 구간은 없음.
  await fixture.db.query('ALTER TABLE reservations RENAME TO t14_unavailable_reservations');
  try {
    const failed = page.waitForResponse(response => response.url().includes('/reservations/timetable') && response.status() === 500);
    await page.locator('.rsv-month-day[data-day="2032-01-30"]').click(); await failed;
    await rendered(page, '.rsv-day-occupancy[data-state="error"]');
    assert.equal(await page.locator('[data-free-start]').count(), 0);
    await capture('real-database-error');
  } finally { await fixture.db.query('ALTER TABLE t14_unavailable_reservations RENAME TO reservations'); }
  await page.locator('.rsv-day-occupancy [role="alert"] button').click();
  await rendered(page, '.rsv-day-occupancy[data-state="ready"]');
  checks.push('real native database HTTP500 displays error, not free availability; retry recovers after dependency restoration');

  await page.locator('.rsv-selected-space-header button').click(); await rendered(page, '.rsv-space-card');
  await page.locator('.rsv-space-card').first().click(); await rendered(page, '.rsv-month-calendar[data-state="ready"]');
  await selectDay('2032-01-31');
  await page.locator('[data-free-start]').first().locator('button').click(); await rendered(page, '.rsv-modal');
  // 원래 모달 접근성/시간 왕복은 TASK15. 현재 seam은 회사 전환 시 초안을 폐기해야 한다.
  await page.setViewportSize({ width: 1280, height: 900 });
  const switcherPage = await page.context().newPage();
  await switcherPage.goto(page.url(), { waitUntil: 'domcontentloaded' });
  await rendered(switcherPage, '.workspace-picker__button');
  await switcherPage.locator('.workspace-picker__button').click();
  await switcherPage.getByRole('menuitemradio').filter({ hasText: 'TASK14_EMPTY' }).click();
  await rendered(page, '.rsv-empty-text');
  await rendered(switcherPage, '.rsv-empty-text');
  assert.equal(await page.locator('.rsv-modal, .rsv-space-card, .rsv-month-calendar, [data-reservation-id]').count(), 0);
  await capture('empty-company');
  const other = await fixture.request({ ...fixture.A, orgId: company.org_id }, '/spaces');
  assert.deepEqual(other.body.data, []);
  checks.push('real company picker drops modal and all prior company state; no bootstrap on empty company navigation');

  await page.locator('.workspace-picker__button').click();
  await page.getByRole('menuitemradio').filter({ hasText: 't13-a' }).click(); await rendered(page, '.rsv-space-card');
  // Given: 회사A의 실제 월 응답이 보류됨. When: 동일 사용자의 회사B 선택.
  const monthMatch = url => url.pathname.endsWith('/reservations') && url.searchParams.has('from');
  const monthGate = await hold(page, routing, monthMatch);
  const monthAbort = page.waitForEvent('requestfailed', { predicate: request => monthMatch(new URL(request.url())), timeout: 10000 });
  await page.locator('.rsv-space-card').first().click(); await monthGate.ready();
  await page.locator('.workspace-picker__button').click();
  await page.getByRole('menuitemradio').filter({ hasText: 'TASK14_EMPTY' }).click();
  await rendered(page, '.rsv-empty-text'); await monthAbort; await monthGate.release();
  assert.equal(await page.locator('.rsv-month-calendar, .rsv-day-occupancy, .rsv-modal').count(), 0);
  checks.push('in-flight month request cancelled on company switch, late actual response cannot restore old records');
  result.scopeChecks = checks;
}
