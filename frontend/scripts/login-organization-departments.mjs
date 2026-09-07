import assert from 'node:assert/strict';

export async function departmentScenarios({ scenario, origin, storageKey, session }) {
  for (const state of ['loading-empty', 'error', 'forbidden', 'ready', 'inaccessible']) {
    await scenario('workspace-departments-' + state, async page => {
      // Given: 저장된 브랜치와 통제된 API 응답. When: 목록 확인. Then: 검증된 상태만 표시/선택한다.
      await page.addInitScript(({ key, value }) => {
        localStorage.setItem(key, JSON.stringify(value));
        localStorage.setItem('orbitflow.branch.v1', JSON.stringify({ [value.orgId]: 'saved-branch' }));
      }, { key: storageKey, value: session });
      const release = Promise.withResolvers();
      const requested = page.waitForRequest(request => request.url().endsWith('/api/v1/members/departments'));
      const successful = state === 'loading-empty' || state === 'ready' || state === 'inaccessible';
      await page.route('**/api/v1/members/departments', async route => {
        await release.promise;
        await route.fulfill(successful ? { json: { items: state === 'loading-empty' ? [] : [
          { id: 'saved-branch', name: 'QA_EXPLICIT_BRANCH', parent_id: null, access_roles: [], can_enter: state === 'ready' },
        ] } } : { status: state === 'forbidden' ? 403 : 503, json: { error: { code: state === 'forbidden' ? 'PERMISSION_DENIED' : 'SERVICE_UNAVAILABLE', message: 'QA department lookup failure' } } });
      });
      const responded = page.waitForResponse(response => response.url().endsWith('/api/v1/members/departments'), { timeout: 20000 });
      try {
        await page.goto(origin + '/');
        await requested;
        await page.locator('.workspace-picker__button').click();
        const menu = page.getByRole('menu');
        await menu.getByRole('status').waitFor();
        const initial = await page.evaluate(orgId => JSON.parse(localStorage.getItem('orbitflow.branch.v1'))[orgId], session.orgId);
        assert.equal(initial, 'saved-branch', 'loading cannot clear a persisted branch');
        if (state === 'loading-empty' || state === 'inaccessible') {
          await page.evaluate(async () => {
            const { branchStore } = await import('/src/store/branch.ts');
            window.qaBranchChanged = new Promise((resolve, reject) => {
              const unsubscribe = branchStore.subscribe(() => { unsubscribe(); resolve(); });
              AbortSignal.timeout(8000).addEventListener('abort', () => { unsubscribe(); reject(new Error('branch state signal timed out')); }, { once: true });
            });
          });
        }
        release.resolve();
        await responded;
        if (!successful) {
          await menu.getByRole('alert').waitFor();
          assert.equal(await menu.getByRole('button', { name: '부서 다시 확인', exact: true }).count(), 1);
          const retained = await page.evaluate(orgId => JSON.parse(localStorage.getItem('orbitflow.branch.v1'))[orgId], session.orgId);
          assert.equal(retained, 'saved-branch', 'lookup failure cannot clear a persisted branch');
        } else if (state === 'ready') {
          await menu.getByRole('menuitemradio', { name: /QA_EXPLICIT_BRANCH/ }).waitFor();
          assert.equal(await menu.getByRole('menuitemradio', { name: /QA_EXPLICIT_BRANCH/ }).getAttribute('aria-checked'), 'true');
        } else {
          await page.evaluate(() => window.qaBranchChanged);
          const selected = await page.evaluate(orgId => JSON.parse(localStorage.getItem('orbitflow.branch.v1'))[orgId], session.orgId);
          assert.equal(selected, null, 'successful empty or inaccessible response clears stale branch');
          if (state === 'inaccessible') assert.equal(await menu.getByRole('menuitemradio', { name: /QA_EXPLICIT_BRANCH/ }).isDisabled(), true);
        }
      } finally { release.resolve(); await responded; }
    });
  }
}
