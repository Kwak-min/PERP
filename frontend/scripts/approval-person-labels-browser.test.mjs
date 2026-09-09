import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from '@playwright/test';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';
import { startTestServer } from '../../backend/tests/http.js';
import { evidenceBody } from '../../backend/tests/deadline-fixture.js';

const evidence = new URL('../../.omo/evidence/approval-person-labels/', import.meta.url);
async function rendered(page, selector) {
  await page.evaluate(selector => new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Render deadline: ${selector}`)); }, 15000);
    function check() { if (document.querySelector(selector)) { clearTimeout(timer); observer.disconnect(); resolve(); } }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true }); check();
  }), selector);
}

test('Chrome production approval detail, inbox and history identify authorized people at 375 and 1280', async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const result = { http: [], surfaces: [], browserRequests: [], pageErrors: [], cleanup: {} };
  let native, server, pg, web, browser;
  await mkdir(evidence, { recursive: true });
  try {
    native = await startDailyNativePostgres();
    // The real app shell also reads department/role metadata; include its migration.
    await native.pool.query(await readFile(new URL('../../db/perp_additions_v8.sql', import.meta.url), 'utf8'));
    result.native = (await native.pool.query("SELECT version() AS engine,current_setting('data_directory') AS directory")).rows[0];
    server = await startTestServer(); pg = await import('../../backend/src/config/pg.js');
    const { db } = await import('../../backend/src/config/db.js');
    async function api(actor, route, method = 'GET', body, expected = 200) {
      const response = await fetch(server.baseUrl + route, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const value = await response.json(); result.http.push({ actor: actor?.id, route, method, status: response.status, body: evidenceBody(value) });
      assert.equal(response.status, expected, `${route}: ${JSON.stringify(value)}`); return value;
    }
    async function company(store, name) {
      const prefix = store === 'pg' ? '/pg' : '', email = `${randomUUID()}@example.invalid`;
      const signup = await api(null, prefix + '/auth/signup', 'POST', { name, email, password: 'password-1234' }, 201);
      const actor = { id: signup.user.id, token: signup.token ?? signup.access_token, name, email };
      actor.orgId = (await api(actor, store === 'pg' ? '/pg/companies' : '/tenants', 'POST', { name: '신원 검증 회사', ...(store === 'pg' ? {} : { type: 'custom' }), modules: ['approvals','finance'], features: ['approvals'], departments: [] }, 201)).org_id;
      return actor;
    }
    async function decider(store, owner) {
      const name = '김도윤 결재자', email = `${randomUUID()}@example.invalid`; let signup;
      if (store === 'pg') {
        const user = await api(owner, '/pg/members', 'POST', { name, email, password: 'password-1234' }, 201);
        const role = (await native.pool.query('INSERT INTO org.roles(company_id,name) VALUES($1,$2) RETURNING id', [owner.orgId.slice(3), '결재 전용'])).rows[0];
        await native.pool.query('INSERT INTO org.role_permissions(role_id,permission_id) SELECT $1,id FROM org.permissions WHERE code=ANY($2::text[])', [role.id, ['menu.approvals','menu.configured','approval.decide']]);
        await native.pool.query('DELETE FROM org.user_roles WHERE user_id=$1', [user.id]);
        await native.pool.query('INSERT INTO org.user_roles(user_id,role_id) VALUES($1,$2)', [user.id, role.id]);
        signup = await api(null, '/pg/auth/login', 'POST', { email, password: 'password-1234' });
      } else {
        const role = await api(owner, '/settings/roles', 'POST', { name: '결재 전용', scope: 'all', permissions: ['menu.approvals','approval.decide'] }, 201);
        const invite = await api(owner, '/members/invites', 'POST', { email, roles: [role.key] }, 201);
        signup = await api(null, '/auth/signup', 'POST', { name, email, password: 'password-1234', invitation_token: invite.token }, 201);
      }
      return { id: signup.user.id, token: signup.token ?? signup.access_token, orgId: owner.orgId, name, email };
    }
    web = await preview({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), envDir: process.env.DEADLINE_TEMP_ROOT, preview: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(server.baseUrl).origin } } });
    const origin = `http://127.0.0.1:${web.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-background-networking','--disable-component-update','--disable-sync'] });
    result.chrome = browser.version();
    async function surface(actor, width) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
      await context.addInitScript(session => localStorage.setItem('orbitflow.session.v1', JSON.stringify(session)), { token: actor.token, orgId: actor.orgId, name: actor.name, email: actor.email, mustChangePassword: false, organizations: [{ org_id: actor.orgId, org_name: '신원 검증 회사', org_type: 'custom', roles: [] }] });
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on('pageerror', error => result.pageErrors.push(error.message));
      page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) result.browserRequests.push({ actor: actor.id, path: url.pathname, method: request.method() }); });
      return { page, context };
    }
    async function navigate(page, path, apiPath, selector, status = 200) {
      const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1' + apiPath && r.request().method() === 'GET');
      await page.goto(origin + path, { waitUntil: 'domcontentloaded' }); assert.equal((await response).status(), status);
      await rendered(page, selector);
    }
    async function capture(page, label) {
      const text = await page.locator('main').innerText();
      const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(geometry.scrollWidth <= geometry.width, `${label}: horizontal overflow`);
      await page.screenshot({ path: fileURLToPath(new URL(label + '.png', evidence)), fullPage: false });
      await writeFile(new URL(label + '.txt', evidence), text);
      result.surfaces.push({ label, ...geometry }); return text;
    }
    for (const store of ['sqlite','pg']) {
      const owner = await company(store, '한서윤 요청자'), approver = await decider(store, owner), foreign = await company(store, '외부 사용자');
      const root = store === 'pg' ? '/pg/approvals' : '/approvals', requests = store === 'pg' ? root : root + '/requests';
      await api(approver, store === 'pg' ? '/pg/members' : '/members', 'GET', undefined, 403);
      for (const width of [375,1280]) {
        const draft = await api(owner, root + '/drafts', 'POST', { title: '구매 검토 요청', body: { purpose: '사무용품 구매 검토' }, ...(store === 'sqlite' ? { steps: [{ approver_id: approver.id }] } : {}) }, 201);
        await api(owner, requests + '/' + draft.id + '/submit', 'POST', { expected_version: draft.version, form_revision: 1 });
        const own = await surface(owner, width), assigned = await surface(approver, width), denied = await surface(foreign, width);
        try {
          await navigate(own.page, `/approvals?request=${draft.id}`, `${requests}/${draft.id}`, `[data-approval-detail="${draft.id}"]`);
          assert.equal(await own.page.locator('[data-approval-person="requester"]').innerText(), owner.name);
          if (store === 'sqlite') assert.equal(await own.page.locator('[data-approval-person="approver"]').innerText(), approver.name);
          let visible = await capture(own.page, `${store}-requester-detail-${width}`);
          if (store === 'sqlite') { assert.ok(!visible.includes(owner.id)); assert.ok(!visible.includes(approver.id)); }
          // IDs remain available in the disclosure, and the history deep link remains navigable.
          await own.page.locator('.approval-record > header details > summary').click();
          assert.ok((await own.page.locator('.approval-record > header details').innerText()).includes(owner.id));
          await own.page.locator('.approval-record > header details > summary').click();
          assert.equal(await own.page.locator(`a[href$="&view=history#approval-history"]`).count(), 1);
          const listPath = store === 'pg' ? root : requests;
          await navigate(assigned.page, '/approvals?box=inbox', listPath, `[data-approval-row="${draft.id}"]`);
          assert.equal(await assigned.page.locator(`[data-approval-row="${draft.id}"] [data-approval-person="requester"]`).innerText(), owner.name);
          await capture(assigned.page, `${store}-approver-inbox-${width}`);
          await navigate(assigned.page, `/approvals?request=${draft.id}`, `${requests}/${draft.id}`, `[data-approval-detail="${draft.id}"]`);
          assert.equal(await assigned.page.locator('[data-approval-person="requester"]').innerText(), owner.name);
          if (store === 'sqlite') assert.equal(await assigned.page.locator('[data-approval-person="approver"]').innerText(), approver.name);
          await capture(assigned.page, `${store}-approver-detail-${width}`);
          const decision = assigned.page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1' + requests + '/' + draft.id + '/actions' && r.request().method() === 'POST');
          await assigned.page.getByRole('button', { name: '승인', exact: true }).click(); assert.equal((await decision).status(), 200);
          await rendered(assigned.page, '[data-approval-status="approved"]');
          await rendered(assigned.page, '#approval-history li:nth-child(3)');
          assert.ok((await assigned.page.locator('[data-approval-person="actor"]').allTextContents()).includes(approver.name));
          if (store === 'pg') assert.equal(await assigned.page.locator('[data-approval-person="decider"]').innerText(), approver.name);
          await navigate(own.page, `/approvals?request=${draft.id}&view=history#approval-history`, `${requests}/${draft.id}`, '[data-approval-status="approved"]');
          assert.ok((await own.page.locator('[data-approval-person="actor"]').allTextContents()).includes(approver.name));
          await own.page.locator('#approval-history').scrollIntoViewIfNeeded();
          await capture(own.page, `${store}-requester-history-${width}`);
          await navigate(denied.page, `/approvals?request=${draft.id}`, `${requests}/${draft.id}`, '.approval-record [role="alert"]', 404);
          visible = await capture(denied.page, `${store}-foreign-denied-${width}`);
          assert.ok(!visible.includes(owner.name)); assert.ok(!visible.includes(approver.name));
          assert.equal(await denied.page.locator('[data-approval-person]').count(), 0);
          if (store === 'pg') await native.pool.query("UPDATE org.company_memberships SET status='left' WHERE company_id=$1 AND user_id=$2", [owner.orgId.slice(3), approver.id]);
          else db().prepare("UPDATE membership SET status='left' WHERE org_id=? AND user_id=?").run(owner.orgId, approver.id);
          await navigate(own.page, `/approvals?request=${draft.id}`, `${requests}/${draft.id}`, '[data-approval-status="approved"]');
          const missing = await own.page.locator(`[data-approval-person="${store === 'pg' ? 'decider' : 'approver'}"]`).innerText();
          assert.ok(missing.length > 0); assert.notEqual(missing, approver.name); assert.notEqual(missing, approver.id);
          const actors = await own.page.locator('[data-approval-person="actor"]').allTextContents(); assert.ok(actors.includes(missing)); assert.ok(!actors.includes(approver.name));
          await capture(own.page, `${store}-removed-person-${width}`);
          if (store === 'pg') await native.pool.query("UPDATE org.company_memberships SET status='active' WHERE company_id=$1 AND user_id=$2", [owner.orgId.slice(3), approver.id]);
          else db().prepare("UPDATE membership SET status='active' WHERE org_id=? AND user_id=?").run(owner.orgId, approver.id);
        } finally { await Promise.all([own.context.close(), assigned.context.close(), denied.context.close()]); }
      }
      if (store === 'pg') {
        const charge = (await native.pool.query('INSERT INTO accounting.dues_charges(company_id,target_user_id,amount) VALUES($1,$2,10.00) RETURNING id', [owner.orgId.slice(3), approver.id])).rows[0];
        const finance = await surface(owner, 1280);
        try {
          await navigate(finance.page, '/finance/dues', '/pg/finance/dues', `[data-dues-id="${charge.id}"]`);
          assert.equal(await finance.page.locator('[data-approval-create]').count(), 0);
          assert.equal(await finance.page.locator('[data-screen-id="FIN-004"]').count(), 1);
          await capture(finance.page, 'fin004-preserved-1280');
        } finally { await finance.context.close(); }
      }
    }
    assert.deepEqual(result.pageErrors, []);
    // Existing shell department/role metadata is not a member directory lookup.
    assert.ok(!result.browserRequests.some(row => /\/members\/?$|\/members\/(?:options|org-chart)|approver-candidates/.test(row.path)));
    result.passed = true;
  } finally {
    await browser?.close(); result.cleanup.browserClosed = true;
    if (web) await new Promise((resolve, reject) => { web.httpServer.close(error => error ? reject(error) : resolve()); web.httpServer.closeAllConnections(); });
    result.cleanup.previewClosed = true;
    if (server) await server.close(); result.cleanup.apiClosed = true;
    await pg?.closePgPool(); await native?.close(); result.cleanup.nativeClosed = true;
    result.cleanup.nativeDirectoryRemoved = !existsSync(result.native?.directory ?? '');
    await writeFile(new URL('browser.json', evidence), JSON.stringify(result, null, 2));
  }
});
