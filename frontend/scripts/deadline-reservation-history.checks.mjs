import assert from 'node:assert/strict';

// A completed real click is the signal for this no-op: inspect immediately, never wait for
// missing cards to come back (that would allow a destructive clear/reload to pass).
export async function activeFilterChecks({ page, fixture, status, result }) {
  const cards = page.locator('.rsv-reservation-card');
  const snapshot = () => cards.evaluateAll(rows => rows.map(row => ({ id: Number(row.dataset.reservationId), html: row.innerHTML })));
  const before = await snapshot();
  assert.ok(before.length > 0, `${status} must start populated`);
  const requests = [];
  const onRequest = request => { if (new URL(request.url()).pathname === '/api/v1/reservations') requests.push({ method: request.method(), url: request.url() }); };
  page.on('request', onRequest);
  try {
    const tab = page.locator('.rsv-screen > .rsv-tabs .rsv-tab.active').last();
    const count = await tab.locator('span').innerText();
    for (let repeat = 1; repeat <= 2; repeat++) {
      await tab.click();
      const after = await snapshot();
      assert.deepEqual(after, before, `${status} repeated active click ${repeat} preserves every card`);
      assert.equal(await tab.locator('span').innerText(), count);
      const native = await fixture.request(fixture.A, `/reservations?mine=true&status=${status}`);
      assert.equal(native.status, 200);
      assert.deepEqual(after.map(row => row.id).sort((a, b) => a - b), native.body.data.map(row => row.id).sort((a, b) => a - b));
      const cancelled = page.locator('.rsv-reservation-card.cancelled');
      assert.equal(await cancelled.getByRole('button', { name: /^(수정|취소)$/ }).count(), 0);
      assert.equal(await cancelled.locator('[data-current-busy]').count(), 0);
      result.activeFilterChecks ??= [];
      result.activeFilterChecks.push({ status, repeat, ids: after.map(row => row.id), nativeIds: native.body.data.map(row => row.id), count, cancelledActions: 0 });
    }
    assert.deepEqual(requests, [], 'active filters do not reload or mutate reservations');
  } finally { page.off('request', onRequest); }
}

export async function editHistoryChecks({ page, fixture, created, bookings, rendered, capture, result, origin, context }) {
  const { A, member, spaceId } = fixture;
  // Given a controlled clock, when crossing the exclusive end, only the newly active interval is busy.
  assert.equal(await page.locator(`[data-reservation-id="${bookings[0].id}"] [data-current-busy]`).count(), 1);
  const boundary = rendered(page, `.rsv-day-occupancy [data-start="2032-01-31T00:20:00.000Z"] [data-current-busy]`);
  await page.clock.runFor(10 * 60 * 1000); await boundary;
  assert.equal(await page.locator(`[data-reservation-id="${bookings[0].id}"] [data-current-busy]`).count(), 0);
  assert.equal(await page.locator('.rsv-day-occupancy [data-current-busy]').count(), 1);
  await capture('current-busy-boundary');
  await page.getByRole('button', { name: '24시간 보기', exact: true }).click();
  await rendered(page, `[data-reservation-id="${bookings[2].id}"]`);
  const overnight = page.locator(`[data-reservation-id="${bookings[2].id}"]`);
  assert.equal(await overnight.getAttribute('data-end'), '2032-01-31T15:30:00.000Z');
  assert.match(await overnight.locator('.rsv-interval-time').innerText(), /23:30.*02-01 00:30/);
  await page.setViewportSize({ width: 375, height: 900 });
  await overnight.getByRole('button').focus();
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  // The compositor-backed capture asserts the last interval clears the fixed mobile navigation.
  await capture('all-times-reachable');
  await page.getByRole('button', { name: '08–22시 보기', exact: true }).click();
  const collision = await fixture.request(member, '/reservations', 'POST', { spaceId, title: '수정 충돌 비공개', startTime: '2032-01-31T10:30:00+09:00', endTime: '2032-01-31T11:00:00+09:00' });
  assert.equal(collision.status, 201);
  await page.locator(`[data-reservation-id="${created.id}"] button`).click();
  await rendered(page, 'dialog:modal');
  await capture('owner-detail');
  await page.getByRole('dialog').getByRole('button', { name: '수정', exact: true }).click();
  await rendered(page, 'dialog:modal input[type="datetime-local"]');
  assert.equal(await page.locator('.rsv-modal').count(), 1, 'edit replaces detail, never stacks');
  assert.equal(await page.getByLabel('시작 시간 *').inputValue(), '2032-01-31T10:00');
  const dialog = page.getByRole('dialog');
  const last = dialog.getByRole('button', { name: '수정하기', exact: true });
  await last.focus(); await page.keyboard.press('Tab');
  assert.equal(await dialog.getByRole('button', { name: '닫기', exact: true }).evaluate(button => button === document.activeElement), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await last.evaluate(button => button === document.activeElement), true);
  await page.keyboard.press('Escape');
  await rendered(page, 'body:not(:has(dialog[open]))');
  assert.equal(await page.locator(`[data-reservation-id="${created.id}"] button`).evaluate(button => button === document.activeElement), true, 'Escape returns to original interval across detail/edit');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: '수정', exact: true }).click();
  await page.getByLabel('시작 시간 *').fill('2032-01-31T10:30');
  await page.getByLabel('종료 시간 *').fill('2032-01-31T10:45');
  const conflict = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/reservations/${created.id}`), { timeout: 10000 });
  await last.click(); assert.equal((await conflict).status(), 409);
  await rendered(page, 'dialog [data-error-status="409"]');
  assert.equal(await page.getByLabel('시작 시간 *').inputValue(), '2032-01-31T10:30');
  assert.equal((await fixture.request(A, `/reservations/${created.id}`)).body.data.startTime, created.startTime, '409 must not modify original');
  await capture('edit-conflict');
  await page.getByLabel('시작 시간 *').fill('2032-01-31T11:00');
  await page.getByLabel('종료 시간 *').fill('2032-01-31T11:30');
  const patched = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/reservations/${created.id}`), { timeout: 10000 });
  await last.click(); const updated = await patched; assert.equal(updated.status(), 200);
  assert.equal((await updated.json()).data.startTime, '2032-01-31T02:00:00.000Z');
  await rendered(page, `[data-reservation-id="${created.id}"][data-start="2032-01-31T02:00:00.000Z"]`);
  await capture('edit-success');
  await page.locator(`[data-reservation-id="${created.id}"] button`).click();
  await page.getByRole('dialog').getByRole('button', { name: '예약 취소', exact: true }).click();
  await rendered(page, 'dialog input[name="cancelScope"]');
  assert.equal(await page.locator('.rsv-modal').count(), 1);
  await capture('cancel-scope');
  const cancelled = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes(`/reservations/${created.id}?`), { timeout: 10000 });
  await page.getByRole('dialog').getByRole('button', { name: '예약 취소', exact: true }).click(); assert.equal((await cancelled).status(), 200);
  await rendered(page, 'body:not(:has(dialog[open]))');
  // Given past cancelled data, the selected server filter must actually fetch it, not filter an upcoming-only response.
  const past = await fixture.request(A, '/reservations', 'POST', { spaceId, title: '과거 취소 이력', startTime: '2020-01-01T23:30:00+09:00', endTime: '2020-01-02T00:30:00+09:00' });
  assert.equal(past.status, 201); const pastId = past.body.data[0].id;
  assert.equal((await fixture.request(A, `/reservations/${pastId}`, 'DELETE')).status, 200);
  // CONFIRMED uses the native server's upcoming 30-day window, not the browser's
  // controlled 2032 clock. Seed well inside that window without changing backend time.
  const upcomingStart = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const upcoming = await fixture.request(A, '/reservations', 'POST', { spaceId, title: 'Active confirmed filter regression', startTime: new Date(upcomingStart).toISOString(), endTime: new Date(upcomingStart + 30 * 60 * 1000).toISOString() });
  assert.equal(upcoming.status, 201);
  await page.getByRole('button', { name: '내 예약', exact: true }).click();
  await rendered(page, `.rsv-reservation-card[data-reservation-id="${upcoming.body.data[0].id}"]`);
  await activeFilterChecks({ page, fixture, status: 'CONFIRMED', result });
  const history = page.waitForResponse(response => response.url().includes('mine=true&status=CANCELLED'), { timeout: 10000 });
  await page.getByRole('button', { name: /^취소됨/ }).click(); assert.equal((await history).status(), 200);
  await rendered(page, `.rsv-reservation-card.cancelled[data-reservation-id="${pastId}"]`);
  assert.equal(await page.locator(`.rsv-reservation-card[data-reservation-id="${created.id}"]`).count(), 1);
  assert.equal(await page.locator('.rsv-reservation-card').getByRole('button', { name: '수정', exact: true }).count(), 0);
  assert.equal(await page.locator('.rsv-reservation-card').getByRole('button', { name: '취소', exact: true }).count(), 0);
  assert.equal(await page.locator('.rsv-reservation-card [data-current-busy]').count(), 0);
  await activeFilterChecks({ page, fixture, status: 'CANCELLED', result });
  await capture('cancelled-history');
  const all = page.waitForResponse(response => response.url().includes('mine=true&status=ALL'), { timeout: 10000 });
  await page.getByRole('button', { name: /^전체/ }).click(); await all;
  await rendered(page, `.rsv-reservation-card[data-reservation-id="${bookings[0].id}"]`);
  assert.equal(await page.locator(`.rsv-reservation-card.cancelled[data-reservation-id="${pastId}"]`).count(), 1);
  await activeFilterChecks({ page, fixture, status: 'ALL', result });
  await capture('all-history');
  await page.locator(`.rsv-reservation-card[data-reservation-id="${bookings[0].id}"]`).getByRole('button', { name: '수정', exact: true }).click();
  await rendered(page, 'dialog input[type="datetime-local"]');
  assert.equal(await page.getByLabel('시작 시간 *').inputValue(), '2032-01-31T09:05:12.345');
  await capture('precision-edit');
  const precision = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/reservations/${bookings[0].id}`), { timeout: 10000 });
  await page.getByRole('dialog').getByRole('button', { name: '수정하기', exact: true }).click();
  const precisionResponse = await precision; assert.equal(precisionResponse.status(), 200);
  assert.equal((await precisionResponse.json()).data.startTime, '2032-01-31T00:05:12.345Z');
  await rendered(page, 'body:not(:has(dialog[open]))');
  await rendered(page, `.rsv-reservation-card[data-reservation-id="${bookings[0].id}"]`);
  await page.locator(`.rsv-reservation-card[data-reservation-id="${bookings[0].id}"]`).getByRole('button', { name: '수정', exact: true }).click();
  await page.getByLabel('시작 시간 *').fill('2032-01-31T10:30');
  await page.getByLabel('종료 시간 *').fill('2032-01-31T10:45');
  const myConflict = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/reservations/${bookings[0].id}`), { timeout: 10000 });
  await page.getByRole('dialog').getByRole('button', { name: '수정하기', exact: true }).click(); assert.equal((await myConflict).status(), 409);
  await rendered(page, 'dialog [data-error-status="409"]');
  await page.getByRole('dialog').getByRole('button', { name: '예약 현황 새로고침' }).click();
  await rendered(page, 'dialog [data-refreshed-day="2032-01-31"]');
  assert.equal(await page.getByRole('dialog').locator('[data-busy-start="2032-01-31T01:30:00.000Z"]').count(), 1);
  assert.equal(await page.getByLabel('시작 시간 *').inputValue(), '2032-01-31T10:30');
  await capture('my-edit-conflict-refreshed');
  await page.keyboard.press('Escape'); await rendered(page, 'body:not(:has(dialog[open]))');
  result.historyChecks = { pastId, updatedId: created.id, endExclusive: true, modalOne: true, focusRestored: true, nativePrecisionRoundtrip: true, myConflictRefresh: true };
  const { recurrenceAccessChecks } = await import('./deadline-reservation-recurrence.checks.mjs');
  await recurrenceAccessChecks({ page, fixture, rendered, capture, result, origin, context });
}
