import assert from 'node:assert/strict';

export async function conflictChecks({ page, fixture, bookings, rendered, capture, result, origin, context, routing }) {
  const { A, member, spaceId } = fixture;
  await rendered(page, '.rsv-month-calendar [data-day="2032-01-31"]');
  await page.locator('.rsv-month-calendar [data-day="2032-01-31"]').click();
  await rendered(page, '.rsv-day-occupancy[data-state="ready"]');
  const gap = page.locator('[data-free-start="2032-01-31T00:20:00.000Z"] button');
  await gap.focus(); await page.keyboard.press('Enter');
  await rendered(page, '.rsv-modal input[type="datetime-local"]');
  await capture('gap-prefill');
  assert.deepEqual(await page.locator('.rsv-modal input[type="datetime-local"]').evaluateAll(inputs => inputs.map(input => input.value)), ['2032-01-31T09:20', '2032-01-31T09:35'], 'free gap must display Seoul even in UTC Chrome');
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.count(), 1);
  assert.equal(await page.getByLabel('제목 *').evaluate(input => input === document.activeElement), true);
  await page.getByLabel('제목 *').fill('충돌 후 보존할 제목');
  await page.getByLabel('설명').fill('입력 초안 보존');
  const collision = await fixture.request(member, '/reservations', 'POST', { spaceId, title: '비공개 충돌 제목', startTime: '2032-01-31T09:20:00+09:00', endTime: '2032-01-31T09:35:00+09:00' });
  assert.equal(collision.status, 201);
  const failed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/reservations'), { timeout: 10000 });
  await dialog.getByRole('button', { name: '예약하기', exact: true }).click();
  assert.equal((await failed).status(), 409);
  await rendered(page, 'dialog [data-error-status="409"]');
  assert.equal(await page.getByLabel('제목 *').inputValue(), '충돌 후 보존할 제목');
  assert.equal(await page.getByLabel('설명').inputValue(), '입력 초안 보존');
  assert.equal(await dialog.count(), 1);
  await capture('conflict-draft');
  const refresh = page.waitForResponse(response => response.url().includes('/reservations/timetable'), { timeout: 10000 });
  await dialog.getByRole('button', { name: '예약 현황 새로고침' }).click(); await refresh;
  await rendered(page, `.rsv-day-occupancy[data-state="ready"] [data-reservation-id="${collision.body.data[0].id}"]`);
  assert.equal(await page.getByLabel('제목 *').inputValue(), '충돌 후 보존할 제목');
  await rendered(page, '[data-refreshed-day="2032-01-31"]');
  assert.equal(await dialog.locator('[data-busy-start="2032-01-31T00:20:00.000Z"]').count(), 1);
  await capture('conflict-refreshed');
  await page.getByLabel('시작 시간 *').fill('2032-01-31T10:00');
  await page.getByLabel('종료 시간 *').fill('2032-01-31T10:30');
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/reservations'), { timeout: 10000 });
  let release, receive, timer;
  const released = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { receive = resolve; });
  const gate = { page, matches: url => url.pathname === '/api/v1/reservations', handler: async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const response = await route.fetch(); receive(response.status()); await released; await route.fulfill({ response });
  } };
  routing.gates.add(gate);
  try {
    await dialog.getByRole('button', { name: '예약하기', exact: true }).click();
    const status = await Promise.race([received, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native save response gate deadline')), 10000); })]);
    assert.equal(status, 201);
    await rendered(page, 'dialog fieldset[disabled]');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 1, 'in-flight mutation cannot dismiss the draft');
    assert.equal(await dialog.getByRole('button', { name: '닫기' }).isDisabled(), true);
    await capture('saving-busy');
  } finally { clearTimeout(timer); release(); routing.gates.delete(gate); }
  const response = await saved; assert.equal(response.status(), 201);
  const created = (await response.json()).data[0];
  assert.equal(created.startTime, '2032-01-31T01:00:00.000Z'); assert.equal(created.endTime, '2032-01-31T01:30:00.000Z');
  await rendered(page, `[data-reservation-id="${created.id}"]`);
  assert.equal(await dialog.count(), 0);
  await capture('conflict-recovered');
  const { editHistoryChecks } = await import('./deadline-reservation-history.checks.mjs');
  await editHistoryChecks({ page, fixture, created, bookings, rendered, capture, result, origin, context });
  result.conflictChecks = { createdId: created.id, collisionId: collision.body.data[0].id, status: 409, utcRoundtrip: true };
}
