import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// DOM 상태 신호를 동작 전에 구독한다. 타이머는 실패 상한에만 사용한다.
async function change(page, expected, action) {
  await page.evaluate(expected => {
    window.assetTransition = new Promise((resolve, reject) => {
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Asset render deadline: ${JSON.stringify(expected)}`)); }, 15000);
      function check() {
        const nodes = [...document.querySelectorAll(expected.selector)];
        if (nodes.length === expected.count && (!expected.text || nodes.some(node => node.textContent.includes(expected.text)))) {
          clearTimeout(timer); observer.disconnect(); resolve();
        }
      }
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    });
  }, expected);
  await action();
  await page.evaluate(() => window.assetTransition);
}

async function observe(page) {
  return page.evaluate(() => {
    const screen = document.querySelector('main [data-screen-id="AST-001"]');
    const footer = screen.querySelector('.assets-list-footer') ?? screen.querySelector('nav[aria-label="목록 페이지"]');
    const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const numbers = element => [...(element?.textContent.match(/\d+/g) ?? [])].map(Number);
    const leaves = footer ? [...footer.querySelectorAll('button, .assets-list-counts > span, .assets-list-pager > span')] : [];
    const bounds = footer ? box(footer) : null;
    const clipping = leaves.filter(element => {
      const r = box(element);
      return r.x < bounds.x || r.right > bounds.right || r.y < bounds.y || r.bottom > bounds.bottom || element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight;
    }).map(element => element.outerHTML);
    const overlaps = [];
    for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
      const a = box(leaves[i]), b = box(leaves[j]);
      if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 0.5) overlaps.push([i, j]);
    }
    return {
      footer: footer?.textContent, bounds, clipping, overlaps, documentWidth: document.documentElement.scrollWidth, viewport: innerWidth,
      headerCounts: numbers(screen.querySelector('.filter-bar .assets-list-counts')),
      footerCounts: numbers(footer?.querySelector('.assets-list-counts')),
      pages: numbers(footer?.querySelector('.assets-list-pager > span')),
      buttons: footer ? [...footer.querySelectorAll('button')].map(button => ({ disabled: button.disabled, bounds: box(button) })) : [],
      rows: [...screen.querySelectorAll('tbody tr')].map(row => row.cells[0].textContent),
    };
  });
}

export async function assetsFooter({ surface, fixture, api, result, attempt, evidence }) {
  for (const file of ['frontend/src/pages/ScreenPage.tsx', 'frontend/src/styles.css', 'frontend/src/pages/screenTable.ts', 'frontend/src/services/workspace.ts', 'backend/src/controllers/assets.controller.js', 'backend/src/models/base.js', 'frontend/scripts/deadline-assets-footer.mjs', 'frontend/scripts/deadline-assets-footer.test.mjs']) {
    result.provenance.files[file] = createHash('sha256').update(await readFile(new URL('../../' + file, import.meta.url))).digest('hex');
  }
  const failures = [], checks = [];
  result.checks = checks;
  result.assertionFailures = failures;
  const actor = fixture.B.actor, assets = [];
  const record = (name, actual, expected) => {
    checks.push({ name, actual, expected });
    try { assert.deepEqual(actual, expected, name); } catch (error) { failures.push(error.message); }
  };
  async function capture(page, state) {
    const screenshot = path.join(attempt, `${state.name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
    const observation = await observe(page);
    observation.screenshot = path.relative(evidence, screenshot);
    const prefix = state.name;
    record(`${prefix}: header total/filtered`, observation.headerCounts, [state.total, state.filtered]);
    record(`${prefix}: footer total/filtered/range`, observation.footerCounts, [state.total, state.filtered, state.start, state.end]);
    record(`${prefix}: page numbers`, observation.pages, [state.page, Math.max(1, Math.ceil(state.filtered / 10))]);
    const pageCount = Math.max(1, Math.ceil(state.filtered / 10));
    record(`${prefix}: movement controls`, observation.buttons.map(button => button.disabled), pageCount > 1 ? [state.page === 1, state.page === pageCount] : []);
    record(`${prefix}: row IDs`, observation.rows, state.ids);
    record(`${prefix}: clipping`, observation.clipping, []);
    record(`${prefix}: overlap`, observation.overlaps, []);
    record(`${prefix}: viewport containment`, observation.documentWidth <= observation.viewport, true);
    if (observation.viewport === 375) record(`${prefix}: touch targets`, observation.buttons.every(button => button.bounds.height >= 44 && button.bounds.width >= 44), true);
    return observation;
  }
  // Given: API 기본 제한 100개를 넘겨도 전체 검색/페이지 계약을 유지한다.
  for (const count of [1, 11, 25, 101]) {
    while (assets.length < count) {
      const index = assets.length + 1;
      assets.push(await api.request(actor, '/assets', 'POST', { asset_no: `FOOTER-${String(index).padStart(2, '0')}`, name: `푸터 자산 ${String(index).padStart(2, '0')}` }, 201));
    }
    const response = await api.request(actor, '/assets?limit=-1');
    assert.equal(response.items.length, count);
    assert.deepEqual(new Set(response.items.map(row => row.id)), new Set(assets.map(row => row.id)));
    let omitted;
    if (count === 101) {
      const limited = await api.request(actor, '/assets');
      assert.equal(limited.items.length, 100);
      omitted = response.items.find(row => !limited.items.some(item => item.id === row.id));
      assert.ok(omitted);
      assert.equal((await api.request(actor, `/assets/${omitted.id}`)).id, omitted.id);
      result.fullData = { created: count, defaultCount: limited.items.length, omittedId: omitted.id, omittedAssetNo: omitted.asset_no };
    }
    for (const width of [375, 768, 1280]) {
      await surface(`assets-${count}-${width}`, actor, '/assets', '[data-screen-id="AST-001"] tbody tr', '/api/v1/assets', async page => {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => document.fonts.ready);
        const observations = [];
        if (count === 101) {
          observations.push(await capture(page, { name: `assets-${count}-${width}-full-count`, total: count, filtered: count, start: 1, end: 10, page: 1, ids: response.items.slice(0, 10).map(row => row.id) }));
          assert.deepEqual(observations[0].headerCounts, [101, 101], '101 authorized assets must not be truncated to the default 100');
        }
        for (let current = 1; current <= Math.ceil(count / 10); current++) {
          const rows = response.items.slice((current - 1) * 10, current * 10);
          if (current > 1) await change(page, { selector: 'tbody tr', count: rows.length, text: rows[0].id }, () => page.getByRole('button', { name: '다음 페이지', exact: true }).click());
          observations.push(await capture(page, { name: `assets-${count}-${width}-page-${current}`, total: count, filtered: count, start: (current - 1) * 10 + 1, end: Math.min(current * 10, count), page: current, ids: rows.map(row => row.id) }));
        }
        if (count > 1) {
          // When: 마지막 페이지에서 검색한다. 101개일 때 기본 응답에서 누락된 ID를 고른다.
          const target = omitted ?? assets[count - 1];
          await change(page, { selector: 'tbody tr', count: 1, text: target.id }, () => page.getByRole('searchbox', { name: '이 화면에서 검색' }).fill(target.asset_no));
          observations.push(await capture(page, { name: `assets-${count}-${width}-filtered`, total: count, filtered: 1, start: 1, end: 1, page: 1, ids: [target.id] }));
          // Then: 필터 행 액션이 같은 API ID의 상세를 요청한다. 취소는 쓰지 않는다.
          const detail = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/assets/${target.id}`, { timeout: 15000 });
          await change(page, { selector: '[role="dialog"] .form-stack', count: 1, text: target.name }, () => page.getByRole('button', { name: '담당·상태', exact: true }).click());
          assert.equal((await (await detail).json()).id, target.id);
          const mutations = () => result.browserAllowedRequests.filter(request => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)).length;
          const requestCount = mutations();
          await change(page, { selector: '[aria-labelledby="asset-custody-title"]', count: 0 }, () => page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click());
          assert.equal(mutations(), requestCount);
          // 비신뢰 검색 문자열은 빈 결과이지 HTML이나 에러가 아니다.
          await change(page, { selector: 'tbody tr', count: 0 }, () => page.getByRole('searchbox', { name: '이 화면에서 검색' }).fill('<img src=x onerror=alert(1)>'));
          observations.push(await capture(page, { name: `assets-${count}-${width}-empty-search`, total: count, filtered: 0, start: 0, end: 0, page: 1, ids: [] }));
          await change(page, { selector: 'tbody tr', count: 10, text: response.items[0].id }, () => page.getByRole('searchbox', { name: '이 화면에서 검색' }).fill(''));
          observations.push(await capture(page, { name: `assets-${count}-${width}-reset`, total: count, filtered: count, start: 1, end: 10, page: 1, ids: response.items.slice(0, 10).map(row => row.id) }));
        }
        return { count, observations };
      }, [width]);
    }
  }
  // 회사 전환은 실제 선택기에서 수행하며 이전 마지막 페이지를 이어받지 않는다.
  const company = await api.request(actor, '/tenants', 'POST', { name: 'FOOTER_EMPTY_SCOPE', type: 'custom', modules: ['assets'], features: [], departments: [] }, 201);
  const me = await api.request(actor, '/auth/me');
  const scopedActor = { ...actor, session: { ...actor.session, organizations: me.organizations } };
  await surface('assets-scope-switch', scopedActor, '/assets', '[data-screen-id="AST-001"] tbody tr', '/api/v1/assets', async page => {
    const rows = (await api.request(actor, '/assets?limit=-1')).items;
    for (let current = 2; current <= Math.ceil(rows.length / 10); current++) await change(page, { selector: 'tbody tr', count: Math.min(10, rows.length - (current - 1) * 10), text: rows[(current - 1) * 10].id }, () => page.getByRole('button', { name: '다음 페이지', exact: true }).click());
    await page.locator('.workspace-picker__button').click();
    const emptyResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/assets' && response.request().headers()['x-org-id'] === company.org_id, { timeout: 15000 });
    await change(page, { selector: '.assets-list-footer .assets-list-counts', count: 1, text: '0' }, () => page.getByRole('menuitemradio', { name: /FOOTER_EMPTY_SCOPE/ }).click());
    assert.equal((await (await emptyResponse).json()).items.length, 0);
    const empty = await capture(page, { name: 'assets-scope-empty', total: 0, filtered: 0, start: 0, end: 0, page: 1, ids: [] });
    await page.locator('.workspace-picker__button').click();
    await change(page, { selector: 'tbody tr', count: 10, text: rows[0].id }, () => page.getByRole('menuitemradio', { name: /DEADLINE_B/ }).click());
    const restored = await capture(page, { name: 'assets-scope-restored', total: assets.length, filtered: assets.length, start: 1, end: 10, page: 1, ids: rows.slice(0, 10).map(row => row.id) });
    return { empty, restored, companyId: company.org_id };
  }, [1280]);
  await surface('assets-denied-manager', fixture.actorManager, '/assets', 'main [role="alert"]', null, async page => {
    assert.equal(await page.locator('tbody tr').count(), 0);
    assert.equal(await page.locator('.assets-list-footer').count(), 0);
    return { directApiStatus: 403 };
  }, [375]);
  result.fixtureAssets = assets;
  assert.deepEqual(failures, [], 'AST-001 footer acceptance');
}
