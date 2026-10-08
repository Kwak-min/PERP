import assert from 'node:assert/strict';

export async function calendarChecks({ page, fixture, bookings, rendered, capture, result }) {
  // Given: 실제 HTTP로 생성한 동일 슬롯의 두 예약과 자정 경계 예약.
  // When: 공간 카드로 진입. Then: 월 달력 -> 날짜 -> 전체 실제 구간.
  await rendered(page, '.rsv-month-calendar[data-state="ready"] [data-day="2032-01-31"]');
  assert.equal(await page.locator('.rsv-day-occupancy').count(), 0);
  assert.equal(await page.locator('.rsv-month-day[data-day="2032-01-31"] [data-count="3"]').count(), 1);
  await capture('month');
  await page.locator('.rsv-month-day[data-day="2032-01-31"]').focus();
  await page.keyboard.press('Enter');
  await rendered(page, '.rsv-day-occupancy[data-state="ready"]');
  for (const row of bookings.slice(0, 2)) {
    const node = page.locator(`[data-reservation-id="${row.id}"]`);
    assert.equal(await node.count(), 1);
    assert.equal(await node.getAttribute('data-start'), row.startTime);
    assert.equal(await node.getAttribute('data-end'), row.endTime);
  }
  assert.equal(await page.locator(`[data-reservation-id="${bookings[2].id}"]`).count(), 0);
  const gaps = await page.locator('[data-free-start]').evaluateAll(nodes => nodes.map(node => [node.dataset.freeStart, node.dataset.freeEnd]));
  assert.deepEqual(gaps, [
    ['2032-01-30T23:00:00.000Z', '2032-01-31T00:05:00.000Z'],
    ['2032-01-31T00:20:00.000Z', '2032-01-31T00:35:00.000Z'],
    ['2032-01-31T00:50:00.000Z', '2032-01-31T13:00:00.000Z'],
  ]);
  assert.match(await page.locator(`[data-reservation-id="${bookings[0].id}"] .rsv-interval-time`).innerText(), /09:05.*09:20/);
  await capture('day-default');
  await page.locator('[data-action="full-day"]').click();
  assert.equal(await page.locator(`[data-reservation-id="${bookings[2].id}"]`).count(), 1);
  assert.ok(!(await page.locator('.rsv-day-occupancy').innerText()).includes(bookings[2].title));
  await capture('day-24h');
  const timetable = await fixture.request(fixture.A, `/reservations/timetable?spaceId=${fixture.spaceId}&date=2032-01-31`);
  assert.equal(timetable.body.data.reservations.length, 3);
  assert.equal(timetable.body.data.slots.filter(slot => slot.reservation?.id === bookings[1].id).length, 0);

  // When: 다음 달 첫날. Then: 시작일이 지난달인 예약도 overlap으로 보인다.
  await page.getByRole('button', { name: '다음 달', exact: true }).click();
  await rendered(page, '.rsv-month-calendar[data-state="ready"] [data-day="2032-02-01"]');
  assert.equal(await page.locator('.rsv-month-day').count(), 29);
  assert.equal(await page.locator('.rsv-month-day[data-day="2032-02-01"] [data-count="1"]').count(), 1);
  assert.equal(await page.locator('.rsv-day-occupancy').count(), 0);
  await page.locator('.rsv-month-day[data-day="2032-02-01"]').click();
  await rendered(page, '.rsv-day-occupancy[data-state="ready"]');
  assert.equal(await page.locator('[data-action="full-day"]').getAttribute('aria-pressed'), 'false');
  await page.locator('[data-action="full-day"]').click();
  assert.equal(await page.locator(`[data-reservation-id="${bookings[2].id}"]`).count(), 1);
  await capture('cross-month-second-day');
  // When: 인접한 빈 날짜. Then: 이전 예약/24시간 선택은 재사용하지 않는다.
  await page.locator('.rsv-month-day[data-day="2032-02-02"]').click();
  await rendered(page, '.rsv-day-occupancy[data-day="2032-02-02"][data-state="ready"]');
  assert.equal(await page.locator('[data-reservation-id]').count(), 0);
  assert.equal(await page.locator('[data-free-start]').count(), 1);
  assert.equal(await page.locator('[data-action="full-day"]').getAttribute('aria-pressed'), 'false');
  await capture('empty-day');
  await page.getByRole('button', { name: '이전 달', exact: true }).click();
  await rendered(page, '.rsv-month-calendar[data-state="ready"] [data-day="2032-01-31"]');
  await page.locator('.rsv-month-day[data-day="2032-01-30"]').click();
  await rendered(page, '.rsv-day-occupancy[data-state="ready"]');
  result.calendarChecks = ['keyboard space-month-day navigation', 'two bookings in first-match compatibility slot both rendered', 'exact start/end and maximal free gaps', 'UTC browser renders Seoul time', 'outside viewport booking available through 24h', 'nonowner privacy', 'midnight crossing both months/days', 'leap February29', 'empty day and viewport reset'];
}
