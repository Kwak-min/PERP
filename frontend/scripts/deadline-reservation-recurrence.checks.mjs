import assert from 'node:assert/strict';

export async function reservationViewport(page, width) {
  await page.evaluate(width => {
    window.reservationViewportReady = new Promise(resolve => {
      const main = document.querySelector('.app-main');
      const screen = document.querySelector('.rsv-screen');
      const padding = parseFloat(getComputedStyle(document.documentElement).fontSize) * (width <= 600 ? 1 : 1.5);
      const observations = [];
      const observer = new ResizeObserver(() => {
        const box = main.getBoundingClientRect();
        const left = width <= 1100 ? 0 : parseFloat(getComputedStyle(main).getPropertyValue('--sidebar-w'));
        const screenPadding = parseFloat(getComputedStyle(screen).paddingLeft);
        observations.push({ viewport: innerWidth, mainLeft: box.left, mainWidth: box.width, screenPadding });
        if (innerWidth === width && innerHeight === 900 && box.left === left && box.width === width - left && screenPadding === padding) {
          observer.disconnect(); resolve(observations);
        }
      });
      observer.observe(main); observer.observe(screen);
    });
  }, width);
  let timer;
  try {
    await page.setViewportSize({ width, height: 900 });
    return await Promise.race([page.evaluate(() => window.reservationViewportReady), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Viewport layout ResizeObserver deadline')), 10000); })]);
  } finally { clearTimeout(timer); }
}

export async function scrollTable(page, edge) {
  let timer;
  try {
    await Promise.race([
      page.locator('.rsv-table-scroll').evaluate((node, edge) => new Promise(resolve => {
        const left = edge === 'end' ? node.scrollWidth - node.clientWidth : 0;
        if (node.scrollLeft === left) { resolve(); return; }
        node.addEventListener('scrollend', () => resolve(), { once: true });
        node.scrollTo({ left, behavior: 'instant' });
      }), edge),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Table edge scrollend deadline')), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function assertTableEdge(page, edge) {
  const geometry = await page.locator('.rsv-table-scroll').evaluate(node => {
    const box = node.getBoundingClientRect();
    const textRects = selector => [...node.querySelectorAll(selector)].map(cell => {
      const range = document.createRange(); range.selectNodeContents(cell);
      const text = range.getBoundingClientRect(); return { left: text.left, right: text.right };
    });
    return { scrollLeft: node.scrollLeft, width: node.clientWidth, scrollWidth: node.scrollWidth,
      left: box.left, right: box.right, tableLeft: node.querySelector('table').getBoundingClientRect().left,
      firstText: textRects('th:first-child, td:first-child'), lastText: textRects('th:last-child, td:last-child'),
      visibleCells: [...node.querySelectorAll('th')].filter(cell => getComputedStyle(cell).display !== 'none').length };
  });
  assert.equal(geometry.visibleCells, 7);
  if (edge === 'start') {
    assert.equal(geometry.scrollLeft, 0, JSON.stringify(geometry));
    assert.ok(geometry.tableLeft >= geometry.left, JSON.stringify(geometry));
    assert.ok(geometry.firstText.every(text => text.left >= geometry.left && text.right <= geometry.right), JSON.stringify(geometry));
  } else {
    assert.equal(geometry.scrollLeft, geometry.scrollWidth - geometry.width, JSON.stringify(geometry));
    assert.ok(geometry.lastText.every(text => text.left >= geometry.left && text.right <= geometry.right + 1), JSON.stringify(geometry));
  }
  return geometry;
}

export async function recurrenceAccessChecks({ page, fixture, rendered, capture, result, origin }) {
  const { A, member, spaceId } = fixture;
  const memberBefore = await fixture.erp.request(member, '/auth/reservation-principal');
  assert.deepEqual(memberBefore.roles, ['member']);
  assert.ok(Array.isArray(memberBefore.permissions));
  assert.equal(memberBefore.permissions.includes('reservation.manage'), false);
  // Given a real collision on the second day, then the UI must expose the exact created/skipped DTO.
  const collision = await fixture.request(member, '/reservations', 'POST', { spaceId, title: '반복 충돌 비공개', startTime: '2032-02-02T14:00:00+09:00', endTime: '2032-02-02T14:30:00+09:00' });
  assert.equal(collision.status, 201);
  await page.getByRole('button', { name: '공간 예약', exact: true }).click();
  await rendered(page, '.rsv-space-card');
  await page.locator('.rsv-filter-bar input[type=date]').fill('2032-02-01');
  await page.locator('.rsv-space-card').first().click();
  await rendered(page, '.rsv-month-calendar [data-day="2032-02-01"]');
  await page.locator('.rsv-month-calendar [data-day="2032-02-01"]').click();
  await rendered(page, '.rsv-day-occupancy[data-state="ready"]');
  await page.locator('.rsv-interval-free').first().click();
  await page.getByLabel('제목 *').fill('반복 생성 결과 · 연구팀과 운영팀의 다음 분기 공동 프로젝트 일정 및 공간 배정 검토 · very-long-unbroken-reference-abcdefghijklmnopqrstuvwxyz0123456789');
  await page.getByLabel('시작 시간 *').fill('2032-02-01T14:00');
  await page.getByLabel('종료 시간 *').fill('2032-02-01T14:30');
  await page.getByLabel('반복 예약 설정').check();
  await page.getByLabel('반복 주기').selectOption('DAILY');
  await page.getByLabel('종료 날짜 (선택)').fill('2032-02-03');
  await capture('recurrence-form');
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/reservations'), { timeout: 10000 });
  await page.getByRole('dialog').getByRole('button', { name: '예약하기', exact: true }).click();
  const response = await saved; assert.equal(response.status(), 201); const dto = (await response.json()).data;
  assert.deepEqual(Object.keys(dto).sort(), ['created', 'skipped']);
  assert.deepEqual(dto.created.map(row => [row.startTime, row.endTime]), [['2032-02-01T05:00:00.000Z', '2032-02-01T05:30:00.000Z'], ['2032-02-03T05:00:00.000Z', '2032-02-03T05:30:00.000Z']]);
  assert.deepEqual(dto.skipped, [{ startTime: '2032-02-02T05:00:00.000Z', endTime: '2032-02-02T05:30:00.000Z', code: 'RESERVATION_CONFLICT' }]);
  await rendered(page, '[data-created-count="2"][data-skipped-count="1"]');
  assert.deepEqual(await page.locator('[data-skipped-start]').evaluateAll(rows => rows.map(row => [row.dataset.skippedStart, row.dataset.skippedEnd])), dto.skipped.map(row => [row.startTime, row.endTime]));
  await capture('recurrence-result');
  // A is a space manager, not the owner of this booking. No edit or cancellation capability is inherited.
  assert.equal((await fixture.request(A, `/reservations/${collision.body.data[0].id}`, 'PATCH', { title: 'forbidden' })).status, 403);
  assert.equal((await fixture.request(A, `/reservations/${collision.body.data[0].id}`, 'DELETE')).status, 403);
  await page.locator('.rsv-month-calendar [data-day="2032-02-02"]').click();
  await rendered(page, `.rsv-day-occupancy[data-state="ready"] [data-reservation-id="${collision.body.data[0].id}"]`);
  const busy = page.locator(`[data-reservation-id="${collision.body.data[0].id}"]`);
  assert.equal((await busy.innerText()).includes('반복 충돌 비공개'), false);
  assert.equal(await busy.locator('.rsv-interval-busy').count(), 1);
  page.once('dialog', dialog => void dialog.dismiss());
  await busy.getByRole('button').click(); assert.equal(await page.getByRole('dialog').count(), 0);
  await capture('nonowner-busy');
  await page.getByRole('button', { name: '공간 관리', exact: true }).click();
  await rendered(page, '.rsv-admin-table tbody tr');
  assert.equal(await page.locator('.rsv-admin-table th').count(), 7);
  for (const width of [375, 768, 1280]) {
    await reservationViewport(page, width);
    const region = page.getByRole('region', { name: '공간 관리 표' });
    await region.focus(); assert.equal(await region.evaluate(node => document.activeElement === node), true);
    if (width === 375) {
      let timer;
      // Install before input, then await completion, not the first scroll frame. Otherwise
      // Chrome's keyboard animation can resume after resize and move a left-edge capture.
      await region.evaluate(node => { window.reservationKeyboardScrollEnd = new Promise(resolve => node.addEventListener('scrollend', () => resolve(node.scrollLeft), { once: true })); });
      try {
        await page.keyboard.press('ArrowRight');
        const offset = await Promise.race([page.evaluate(() => window.reservationKeyboardScrollEnd), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Keyboard table scrollend deadline')), 10000); })]);
        assert.ok(offset > 0, `keyboard scroll offset ${offset}`);
        result.keyboardTableScroll = { event: 'scrollend', offset };
      } finally { clearTimeout(timer); }
    }
    await scrollTable(page, 'start');
    const left = await assertTableEdge(page, 'start');
    await scrollTable(page, 'end');
    const geometry = await assertTableEdge(page, 'end');
    if (width === 375) assert.ok(geometry.scrollLeft > 0);
    result.tableGeometry ??= []; result.tableGeometry.push({ viewport: width, left, ...geometry });
  }
  await capture('admin-table-left');
  await capture('admin-table-right', 'end');
  await page.getByRole('button', { name: '+ 공간 등록', exact: true }).click();
  await rendered(page, 'dialog:modal'); await capture('space-create-modal');
  await page.keyboard.press('Escape'); await rendered(page, 'body:not(:has(dialog[open]))');
  assert.equal(await page.getByRole('button', { name: '+ 공간 등록', exact: true }).evaluate(button => document.activeElement === button), true);
  // Switch only the test browser session; no role writes or implicit grants are permitted.
  const me = await fixture.erp.request(member, '/auth/me');
  await page.evaluate(session => localStorage.setItem('orbitflow.session.v1', JSON.stringify(session)), { token: member.token, orgId: member.orgId, name: me.name, email: 't13-member@example.invalid', mustChangePassword: false, organizations: me.organizations });
  await page.goto(origin + '/reserve?tab=admin', { waitUntil: 'domcontentloaded' });
  await rendered(page, '.rsv-screen .rsv-empty');
  assert.equal(await page.getByRole('button', { name: '공간 관리', exact: true }).count(), 0);
  assert.equal(await page.locator('.rsv-admin-table').count(), 0);
  assert.equal((await fixture.request(member, '/spaces', 'POST', { name: 'forbidden', location: 'test', capacity: 2 })).status, 403);
  assert.equal((await fixture.request(member, `/reservations/${dto.created[0].id}`, 'PATCH', { title: 'forbidden' })).status, 403);
  await capture('member-no-manage');
  await page.getByRole('button', { name: '공간 예약', exact: true }).click();
  await rendered(page, '.rsv-space-card');
  await page.locator('.rsv-filter-bar input[type=date]').fill('2032-02-02');
  await page.locator('.rsv-space-card').first().click();
  await page.locator('.rsv-month-calendar [data-day="2032-02-02"]').click();
  const memberOwnedId = collision.body.data[0].id;
  await rendered(page, `.rsv-day-occupancy[data-state="ready"] [data-reservation-id="${memberOwnedId}"]`);
  await page.locator(`[data-reservation-id="${memberOwnedId}"] button`).click();
  await rendered(page, 'dialog:modal');
  assert.equal(await page.getByRole('dialog').getByRole('button', { name: '수정', exact: true }).count(), 1);
  assert.equal(await page.getByRole('dialog').getByRole('button', { name: '예약 취소', exact: true }).count(), 1);
  await capture('member-owner-detail');
  await page.getByRole('dialog').getByRole('button', { name: '수정', exact: true }).click();
  await page.getByLabel('시작 시간 *').fill('2032-02-02T14:30');
  await page.getByLabel('종료 시간 *').fill('2032-02-02T15:00');
  const memberSave = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/reservations/${memberOwnedId}`), { timeout: 10000 });
  await page.getByRole('dialog').getByRole('button', { name: '수정하기', exact: true }).click(); assert.equal((await memberSave).status(), 200);
  await rendered(page, `[data-reservation-id="${memberOwnedId}"][data-start="2032-02-02T05:30:00.000Z"]`);
  await capture('member-owner-edited');
  await page.locator(`[data-reservation-id="${memberOwnedId}"] button`).click();
  await page.getByRole('dialog').getByRole('button', { name: '예약 취소', exact: true }).click();
  await rendered(page, 'dialog input[name="cancelScope"]');
  const memberCancel = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes(`/reservations/${memberOwnedId}?`), { timeout: 10000 });
  await page.getByRole('dialog').getByRole('button', { name: '예약 취소', exact: true }).click(); assert.equal((await memberCancel).status(), 200);
  await rendered(page, 'body:not(:has(dialog[open]))');
  assert.equal((await fixture.request(member, `/reservations/${memberOwnedId}`)).body.data.status, 'CANCELLED');
  const memberAfter = await fixture.erp.request(member, '/auth/reservation-principal');
  assert.deepEqual(memberAfter.roles, memberBefore.roles);
  assert.deepEqual(memberAfter.permissions, memberBefore.permissions);
  result.recurrenceChecks = { created: dto.created.map(row => row.id), skipped: dto.skipped, ownerOnly: true, ordinaryOwnerEditCancel: true, noRoleAutoGrant: true, memberRoles: memberAfter.roles };
}
