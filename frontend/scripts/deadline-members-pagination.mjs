import assert from 'node:assert/strict';
import path from 'node:path';
import { membersPaginationEdges } from './deadline-members-pagination-edges.mjs';

// DOM mutation is the completion signal; the timer is only a failure bound.
export async function change(page, predicate, action) {
  await page.evaluate(source => {
    const checkState = new Function(`return (${source})()`);
    window.__membersGate = new Promise(resolve => {
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => { observer.disconnect(); resolve(`DOM deadline: ${source}`); }, 15000);
      function check() { if (checkState()) { clearTimeout(timer); observer.disconnect(); resolve(null); } }
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      check();
    });
  }, predicate.toString());
  await action();
  const error = await page.evaluate(() => window.__membersGate);
  assert.equal(error, null);
}

export async function membersPagination({ surface, api, fixture, result, attempt }) {
  // Given: two authorized companies, 25 API-created members, real filter values.
  const department = await api.request(fixture.actorAdmin, '/members/departments', 'POST', { name: '페이지 검증 부서' }, 201);
  const source = (await api.request(fixture.actorAdmin, '/members?limit=-1')).items;
  const assigned = source.filter(member => member.user_id !== fixture.actorAdmin.userId).slice(0, 12);
  for (const member of assigned) await api.request(fixture.actorAdmin, `/members/${member.membership_id}/assignment`, 'PATCH', { department_id: department.id });
  await api.request(fixture.actorAdmin, `/members/${assigned[0].membership_id}/status`, 'PATCH', { status: 'inactive' });
  const invite = await api.request(fixture.B.actor, '/members/invites', 'POST', { email: fixture.actorAdmin.email, roles: ['company_admin'] }, 201);
  await api.request(fixture.actorAdmin, '/auth/invitations/accept', 'POST', { token: invite.token }, 201);
  fixture.actorAdmin.session.organizations = (await api.request(fixture.actorAdmin, '/auth/me')).organizations;
  const members = (await api.request(fixture.actorAdmin, '/members?limit=-1')).items;
  result.memberChecks = [];
  await surface('members-pagination-directory', fixture.actorAdmin, '/members', '.org-directory__table tbody tr', '/api/v1/members', async page => {
    const rows = page.locator('.org-directory tbody tr');
    await page.screenshot({ path: path.join(attempt, 'directory-initial.png'), fullPage: true });
    // Then: RED is the actual 25-row directory, not a missing test selector.
    assert.equal(await rows.count(), 10, 'Directory must display ten of the 25 API members');
    const pager = page.getByRole('navigation', { name: '구성원 페이지' });
    const next = pager.getByRole('button', { name: '다음' });
    const previous = pager.getByRole('button', { name: '이전' });
    assert.equal(await previous.isDisabled(), true);
    const visible = [...await rows.locator('td:first-child').allTextContents()];
    await change(page, () => document.querySelector('.org-directory nav')?.dataset.page === '2', () => next.click());
    assert.equal(await rows.count(), 10);
    visible.push(...await rows.locator('td:first-child').allTextContents());
    await change(page, () => document.querySelector('.org-directory nav')?.dataset.page === '3', () => next.click());
    assert.equal(await rows.count(), 5);
    visible.push(...await rows.locator('td:first-child').allTextContents());
    assert.deepEqual(visible, members.map(member => member.name));
    assert.equal(await next.isDisabled(), true);
    result.memberChecks.push({ pages: [10, 10, 5], identities: members.map(member => ({ membershipId: member.membership_id, profileId: member.user_id })) });

    const downloadReady = page.waitForEvent('download', { timeout: 15000 });
    await page.getByRole('button', { name: '내보내기', exact: true }).click();
    const download = await downloadReady;
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const csv = Buffer.concat(chunks).toString('utf8');
    assert.equal(csv.trim().split('\n').length - 1, 25);
    for (const member of members) assert.ok(csv.includes(member.email));
    await download.delete();
    result.memberChecks.push({ csvRows: 25, pageAtExport: 3 });

    const search = page.locator('.org-directory').getByRole('searchbox');
    for (const index of [8, 24]) {
      const member = members[index];
      await change(page, () => document.querySelectorAll('.org-directory tbody tr').length === 1, () => search.fill(member.email));
      assert.equal(await rows.locator('td:first-child').innerText(), member.name);
      await rows.getByRole('button').click();
      const profile = page.locator('.member-detail a');
      assert.equal(await profile.getAttribute('href'), `/hr/members/${encodeURIComponent(member.user_id)}`);
      const responseReady = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/members/${member.user_id}/profile`, { timeout: 15000 });
      await profile.click();
      const response = await responseReady;
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).user_id, member.user_id);
      await change(page, () => document.querySelectorAll('.org-directory tbody tr').length === 10, () => page.goBack({ waitUntil: 'domcontentloaded' }));
    }
    await change(page, () => document.querySelector('.org-directory nav')?.dataset.page === '2', () => next.click());
    await change(page, () => document.querySelector('.org-directory nav')?.dataset.page === '1', () => page.locator('.org-directory').getByLabel('부서', { exact: true }).selectOption(department.id));
    assert.equal(await rows.count(), 10);
    await change(page, () => document.querySelector('.org-directory nav')?.dataset.page === '2', () => next.click());
    assert.equal(await rows.count(), 2);
    await change(page, () => document.querySelector('.org-directory nav')?.dataset.page === '1', () => page.locator('.org-directory').getByLabel('상태', { exact: true }).selectOption('inactive'));
    assert.equal(await rows.count(), 1);
    await change(page, () => document.querySelectorAll('.org-directory tbody tr').length === 0, () => search.fill('<script>"\u0001 NO_MATCH'));
    assert.equal(await previous.isDisabled(), true);
    assert.equal(await next.isDisabled(), true);
    await search.fill('');
    await page.locator('.org-directory').getByLabel('상태', { exact: true }).selectOption('');
    await change(page, () => document.querySelector('.org-directory nav')?.dataset.page === '2', () => next.click());
    const refreshReady = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/members', { timeout: 15000 });
    await page.getByRole('button', { name: '새로 고침', exact: true }).click();
    await refreshReady;
    await change(page, () => document.querySelector('.org-unified')?.dataset.orgState === 'ready', async () => {});
    assert.equal(await pager.getAttribute('data-page'), '2', 'Reload retains a still-valid page');
    // When the filtered source shrinks on reload, clamp to the last valid page, preserving filters.
    for (const member of assigned.slice(8)) await api.request(fixture.actorAdmin, `/members/${member.membership_id}/assignment`, 'PATCH', { department_id: null });
    await change(page, () => document.querySelector('.org-unified')?.dataset.orgState === 'ready' && document.querySelectorAll('.org-directory tbody tr').length === 8, () => page.getByRole('button', { name: '새로 고침', exact: true }).click());
    assert.equal(await pager.getAttribute('data-page'), '1');
    assert.equal(await page.locator('.org-directory').getByLabel('부서', { exact: true }).inputValue(), department.id);
    await page.locator('.org-directory').getByLabel('부서', { exact: true }).selectOption('');
    await change(page, () => document.querySelector('.org-directory nav')?.dataset.page === '2', () => next.click());
    await page.locator('.workspace-picker__button').click();
    await change(page, () => document.querySelectorAll('.org-directory tbody tr').length === 2, () => page.getByRole('menuitemradio', { name: /DEADLINE_B/ }).click());
    assert.equal(await pager.getAttribute('data-page'), '1');
    await page.locator('.workspace-picker__button').click();
    await change(page, () => document.querySelectorAll('.org-directory tbody tr').length === 10, () => page.getByRole('menuitemradio', { name: /DEADLINE_A/ }).click());
    result.memberChecks.push({ filterReset: true, reloadClamp: true, companyReset: true, malformedSearch: 'empty, no execution' });
    return { pages: [10, 10, 5], csvRows: 25, profileSearchOrdinals: [9, 25] };
  });
  await surface('members-pagination-modal', fixture.actorAdmin, '/members', '.org-directory tbody tr', '/api/v1/members', async page => {
    const trigger = page.getByRole('button', { name: '구성원 목록 팝업' });
    const open = async () => change(page, () => document.querySelectorAll('.member-modal__list li').length === 10, () => trigger.click());
    await open();
    const dialog = page.getByRole('dialog', { name: '구성원 목록' });
    const pager = dialog.getByRole('navigation', { name: '구성원 페이지' });
    const next = pager.getByRole('button', { name: '다음' });
    for (const [pageNumber, count] of [[2, 10], [3, 5]]) {
      await change(page, pageNumber === 2 ? () => document.querySelector('.member-modal nav')?.dataset.page === '2' : () => document.querySelector('.member-modal nav')?.dataset.page === '3', () => next.click());
      assert.equal(await dialog.locator('li').count(), count);
    }
    for (const index of [8, 24]) {
      const member = members[index];
      await change(page, () => document.querySelectorAll('.member-modal__list li').length === 1, () => dialog.getByRole('searchbox').fill(member.email));
      assert.equal(await dialog.locator('li strong').first().innerText(), member.name);
      const responseReady = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/members/${member.user_id}/profile`, { timeout: 15000 });
      await dialog.locator('li button').click();
      const response = await responseReady;
      assert.equal((await response.json()).user_id, member.user_id);
      assert.equal(new URL(page.url()).pathname, `/hr/members/${member.user_id}`);
      await change(page, () => Boolean(document.querySelector('.org-directory tbody tr')), () => page.goBack({ waitUntil: 'domcontentloaded' }));
      await open();
    }
    await page.setViewportSize({ width: 375, height: 812 });
    const geometry = await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const pager = element.querySelector('nav').getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: innerWidth, bottom: pager.bottom, height: innerHeight, buttons: [...element.querySelectorAll('nav button')].map(button => button.getBoundingClientRect().height) };
    });
    assert.ok(geometry.left >= 0 && geometry.right <= 375 && geometry.bottom <= 812);
    assert.ok(geometry.buttons.every(height => height >= 44));
    await change(page, () => document.querySelector('.member-modal nav')?.dataset.page === '2', () => next.click());
    await pager.getByRole('button', { name: '이전' }).focus();
    await change(page, () => document.querySelector('.member-modal nav')?.dataset.page === '1', () => page.keyboard.press('Enter'));
    await page.screenshot({ path: path.join(attempt, 'modal-375-keyboard.png'), fullPage: false });
    await change(page, () => !document.querySelector('.member-modal'), () => page.keyboard.press('Escape'));
    assert.equal(await page.evaluate(() => document.body.style.overflow), '');
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    await open();
    result.memberChecks.push({ modalPages: [10, 10, 5], modalProfileOrdinals: [9, 25], mobile: geometry, escapeRestoresFocus: true });
    return { pages: [10, 10, 5], profileSearchOrdinals: [9, 25], mobile: geometry };
  });
  await membersPaginationEdges({ surface, api, fixture, result, attempt, change });
}
