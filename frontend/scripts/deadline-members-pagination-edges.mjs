import assert from 'node:assert/strict';
import path from 'node:path';

// Timers bound missing signals; they never advance the request schedule.
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} deadline`)), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function membersPaginationEdges({ surface, api, fixture, result, attempt, change }) {
  await surface('members-pagination-modal-late-scope', fixture.actorAdmin, '/members', '.org-directory tbody tr', '/api/v1/members', async page => {
    // Given: another real browser tab can change the same authenticated company.
    const companion = await page.context().newPage();
    const release = Promise.withResolvers(), failed = Promise.withResolvers();
    const fetched = Object.fromEntries(['competitor', 'modal', 'focus'].map(phase => [phase, Promise.withResolvers()]));
    const pattern = new URL('/api/v1/members?limit=-1', page.url()).href;
    const tasks = new Set(), errors = [];
    const gate = result.memberGate = { oldOrgId: fixture.A.id, newOrgId: fixture.B.id, requests: [], errors: [], released: false, drained: false };
    let phase = 'competitor', competingStarted = false;
    const wait = (promise, label) => bounded(Promise.race([promise, failed.promise.then(error => { throw error; })]), label);
    const handler = route => {
      const requestPhase = phase;
      const task = (async () => {
        const request = route.request(), headers = await request.allHeaders();
        const oldScope = request.method() === 'GET' && headers['x-org-id'] === fixture.A.id && headers.authorization === `Bearer ${fixture.actorAdmin.token}`;
        const record = { phase: requestPhase, orgId: headers['x-org-id'], oldScope, competitor: headers['x-deadline-competing'] === '1', state: 'captured' };
        gate.requests.push(record);
        // The URL is shared by the workspace, modal and StrictMode reissues.
        // Hold every old authenticated scope, not whichever caller wins first.
        if (!oldScope) { await route.continue(); record.state = 'continued'; return; }
        const response = await route.fetch({ timeout: 10000, maxRetries: 0 });
        const body = await response.json();
        assert.equal(response.status(), 200);
        assert.equal(body.items.length, 25);
        Object.assign(record, { status: response.status(), count: body.items.length, state: 'held' });
        if (record.competitor) fetched.competitor.resolve(record);
        else if (requestPhase !== 'competitor') fetched[requestPhase]?.resolve(record);
        await release.promise;
        await route.fulfill({ response });
        record.state = 'fulfilled';
      })().catch(error => { errors.push(error); gate.errors.push(error.message); failed.resolve(error); });
      tasks.add(task);
      void task.then(() => tasks.delete(task));
      return task;
    };
    const drain = async () => {
      gate.released = true; release.resolve();
      // This surface owns the only page route; the harness guard is context-level.
      // Wait before removing interception: plain unroute can continue held routes
      // through that guard while our fulfill callbacks are still resuming.
      await bounded(page.unrouteAll({ behavior: 'wait' }), 'Unroute and drain');
      await bounded(Promise.all([...tasks]), 'Route completion');
      if (competingStarted) assert.deepEqual(await bounded(page.evaluate(() => window.__membersCompeting), 'Competing client completion'), { count: 25 });
      if (errors.length) throw new AggregateError(errors, 'Member gate handlers failed');
      gate.drained = true;
    };
    try {
      await companion.goto(page.url(), { waitUntil: 'domcontentloaded' });
      await change(companion, () => Boolean(document.querySelector('.org-directory tbody tr')), async () => {});
      await companion.locator('.workspace-picker__button').click();
      await page.bringToFront();
      await change(page, () => document.querySelector('.org-unified')?.dataset.orgState === 'loading', () => page.evaluate(() => window.dispatchEvent(new Event('focus'))));
      await change(page, () => document.querySelector('.org-unified')?.dataset.orgState === 'ready', async () => {});
      await page.route(pattern, handler);
      // Schedule a real shared-client request first, before opening the modal.
      // The old first-only gate leaks the modal response under this exact order.
      competingStarted = true;
      await page.evaluate(async () => {
        const { apiRequest } = await import('/src/services/api.ts');
        const { sessionStore } = await import('/src/store/session.ts');
        window.__membersCompeting = apiRequest('/members?limit=-1', { session: sessionStore.getSnapshot(), headers: { 'X-Deadline-Competing': '1' } })
          .then(body => ({ count: body.items.length }), error => ({ error: error.message }));
      });
      assert.equal((await wait(fetched.competitor.promise, 'Competing response')).competitor, true);
      phase = 'modal';
      await change(page, () => Boolean(document.querySelector('.member-modal .modal__loading')), () => page.getByRole('button', { name: '구성원 목록 팝업' }).click());
      await wait(fetched.modal.promise, 'Modal response');
      assert.equal(await page.locator('.member-modal__list li').count(), 0);
      // Also exercise the actual workspace focus listener while the modal waits.
      phase = 'focus';
      await change(page, () => document.querySelector('.org-unified')?.dataset.orgState === 'loading', () => page.evaluate(() => window.dispatchEvent(new Event('focus'))));
      await wait(fetched.focus.promise, 'Focus response');
      assert.equal(await page.locator('.member-modal__list li').count(), 0);
      assert.equal(await page.locator('.member-modal .modal__loading').count(), 1);
      gate.rowsBeforeSwitch = 0;
      phase = 'switch';
      // New-company requests must finish while every old-company response waits.
      await change(page, () => !document.querySelector('.member-modal') && document.querySelectorAll('.org-directory tbody tr').length === 2, () => companion.getByRole('menuitemradio', { name: /DEADLINE_B/ }).click());
      assert.ok(gate.requests.some(record => record.orgId === fixture.B.id && !record.oldScope));
      assert.equal(gate.released, false);
      assert.ok(gate.requests.filter(record => record.oldScope).every(record => record.state !== 'fulfilled'));
      gate.newCompanyReadyBeforeRelease = true;
      await drain();
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
      // Attempt both cleanups even if a handler/client failed; never hide errors.
      const cleanup = await Promise.allSettled([drain(), bounded(companion.close(), 'Companion close')]);
      const failures = cleanup.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
      if (failures.length) throw new AggregateError(failures, 'Member gate cleanup failed');
      gate.companionClosed = companion.isClosed();
    }
  }, [375, 1280]);

  await surface('members-pagination-modal-recovered', fixture.actorAdmin, '/members', '.org-directory tbody tr', '/api/v1/members', async page => {
    // Given: remove member.read through the real role API after the directory was loaded.
    const otherAdmin = fixture.actors[3];
    const assignments = await api.request(fixture.actorAdmin, '/settings/members');
    await api.request(fixture.actorAdmin, `/settings/members/${otherAdmin.membershipId}/roles`, 'PUT', { roles: ['company_admin'], expected_roles_version: assignments.items.find(member => member.membership_id === otherAdmin.membershipId).roles_version });
    const limitedRoles = fixture.members.find(member => member.user_id === fixture.actorManager.userId).roles;
    await api.request(fixture.actorAdmin, `/settings/members/${fixture.actorAdmin.membershipId}/roles`, 'PUT', { roles: limitedRoles, expected_roles_version: assignments.items.find(member => member.membership_id === fixture.actorAdmin.membershipId).roles_version });
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
      const current = (await api.request(otherAdmin, '/settings/members')).items.find(member => member.membership_id === fixture.actorAdmin.membershipId);
      await api.request(otherAdmin, `/settings/members/${fixture.actorAdmin.membershipId}/roles`, 'PUT', { roles: ['company_admin'], expected_roles_version: current.roles_version });
      await change(page, () => document.querySelectorAll('.member-modal__list li').length === 10, () => page.getByRole('button', { name: '구성원 목록 팝업' }).click());
      assert.equal(await page.locator('.member-modal [role="alert"]').count(), 0);
      result.memberChecks.push({ deniedStatus: 403, staleRowsOnDenied: 0, reopenAfterPermissionRestored: 10 });
      return { deniedStatus: 403, reopenAfterPermissionRestored: 10 };
    } finally {
      const current = (await api.request(otherAdmin, '/settings/members')).items.find(member => member.membership_id === fixture.actorAdmin.membershipId);
      await api.request(otherAdmin, `/settings/members/${fixture.actorAdmin.membershipId}/roles`, 'PUT', { roles: ['company_admin'], expected_roles_version: current.roles_version });
    }
  }, [375, 1280]);
}
