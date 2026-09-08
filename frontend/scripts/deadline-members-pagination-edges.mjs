import assert from 'node:assert/strict';
import path from 'node:path';

export async function membersPaginationEdges({ surface, api, fixture, result, attempt, change }) {
  await surface('members-pagination-modal-late-scope', fixture.actorAdmin, '/members', '.org-directory tbody tr', '/api/v1/members', async page => {
    // Given: another real browser tab can change the same authenticated company.
    const companion = await page.context().newPage();
    await companion.goto(page.url(), { waitUntil: 'domcontentloaded' });
    await change(companion, () => Boolean(document.querySelector('.org-directory tbody tr')), async () => {});
    await companion.locator('.workspace-picker__button').click();
    const fetched = Promise.withResolvers(), release = Promise.withResolvers(), finished = Promise.withResolvers();
    const pattern = '**/api/v1/members?limit=-1';
    let intercepted = false;
    const handler = async route => {
      if (intercepted) return route.continue();
      intercepted = true;
      try {
        const response = await route.fetch();
        const body = await response.json();
        assert.equal(response.status(), 200);
        assert.equal(body.items.length, 25);
        fetched.resolve(body);
        await release.promise;
        await route.fulfill({ response });
        finished.resolve(null);
      } catch (error) { fetched.resolve({ error: error.message }); finished.resolve(error.message); }
    };
    await page.route(pattern, handler);
    const timeout = setTimeout(() => { fetched.resolve({ error: 'API event deadline' }); release.resolve(); finished.resolve('Route completion deadline'); }, 15000);
    try {
      // When: close the old-company modal through an actual cross-tab company selection before its HTTP response arrives.
      await page.getByRole('button', { name: '구성원 목록 팝업' }).click();
      const body = await fetched.promise;
      assert.equal(body.error, undefined);
      assert.equal(await page.locator('.member-modal__list li').count(), 0);
      await change(page, () => !document.querySelector('.member-modal') && document.querySelectorAll('.org-directory tbody tr').length === 2, () => companion.getByRole('menuitemradio', { name: /DEADLINE_B/ }).click());
      release.resolve();
      assert.equal(await finished.promise, null);
      assert.equal(await page.locator('.member-modal').count(), 0);
      assert.equal(await page.locator('.org-directory nav').getAttribute('data-page'), '1');
      assert.equal(await page.evaluate(() => document.body.style.overflow), '');
      const names = await page.locator('.org-directory tbody tr td:first-child').allTextContents();
      assert.deepEqual(new Set(names), new Set([fixture.actorAdmin.name, fixture.B.actor.name]));
      await change(page, () => document.querySelectorAll('.member-modal__list li').length === 2, () => page.getByRole('button', { name: '구성원 목록 팝업' }).click());
      assert.equal(await page.locator('.member-modal nav').getAttribute('data-page'), '1');
      assert.equal(await page.locator('.member-modal input').inputValue(), '');
      result.memberChecks.push({ lateCompanyResponseDiscarded: true, currentCompanyModalRows: 2, scopeChangedViaRealSecondTab: true });
      return { lateCompanyResponseDiscarded: true, currentCompanyModalRows: 2 };
    } finally {
      release.resolve(); clearTimeout(timeout);
      await page.unroute(pattern, handler);
      await companion.close();
    }
  }, [375, 1280]);

  await surface('members-pagination-modal-recovered', fixture.actorAdmin, '/members', '.org-directory tbody tr', '/api/v1/members', async page => {
    // Given: remove member.read through the real role API after the directory was loaded.
    const otherAdmin = fixture.actors[3];
    await api.request(fixture.actorAdmin, `/settings/members/${otherAdmin.membershipId}/roles`, 'PUT', { roles: ['company_admin'] });
    const limitedRoles = fixture.members.find(member => member.user_id === fixture.actorManager.userId).roles;
    await api.request(fixture.actorAdmin, `/settings/members/${fixture.actorAdmin.membershipId}/roles`, 'PUT', { roles: limitedRoles });
    try {
      await change(page, () => Boolean(document.querySelector('.member-modal [role="alert"]')), () => page.getByRole('button', { name: '구성원 목록 팝업' }).click());
      assert.equal(await page.locator('.member-modal li').count(), 0);
      assert.equal(await page.locator('.member-modal nav').count(), 0);
      result.deniedScreenshots = [];
      for (const width of [375, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const screenshot = path.join(attempt, `modal-denied-${width}.png`);
        await page.screenshot({ path: screenshot, fullPage: false });
        result.deniedScreenshots.push({ state: 'HTTP 403', width, screenshot });
      }
      // HTTP response evidence is drained by the owning harness in finally; independently verify the real permission boundary here.
      await api.request(fixture.actorAdmin, '/members?limit=-1', 'GET', undefined, 403);
      await change(page, () => !document.querySelector('.member-modal'), () => page.keyboard.press('Escape'));
      assert.equal(await page.evaluate(() => document.body.style.overflow), '');
      await api.request(otherAdmin, `/settings/members/${fixture.actorAdmin.membershipId}/roles`, 'PUT', { roles: ['company_admin'] });
      await change(page, () => document.querySelectorAll('.member-modal__list li').length === 10, () => page.getByRole('button', { name: '구성원 목록 팝업' }).click());
      assert.equal(await page.locator('.member-modal [role="alert"]').count(), 0);
      result.memberChecks.push({ deniedStatus: 403, staleRowsOnDenied: 0, reopenAfterPermissionRestored: 10 });
      return { deniedStatus: 403, reopenAfterPermissionRestored: 10 };
    } finally {
      await api.request(otherAdmin, `/settings/members/${fixture.actorAdmin.membershipId}/roles`, 'PUT', { roles: ['company_admin'] });
    }
  }, [375, 1280]);
}
