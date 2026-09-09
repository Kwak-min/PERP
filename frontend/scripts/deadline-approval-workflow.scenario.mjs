import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';
import { startTestServer } from '../../backend/tests/http.js';
import { assertIsolated, evidenceBody } from '../../backend/tests/deadline-fixture.js';
import { networkAudit, protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';
import { observeApiResponses, captureJsonResponse } from './deadline-approval-responses.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
// DOM 상태의 정확한 변경을 구독한다. 고정 지연이나 상태 polling을 사용하지 않는다.
export async function rendered(page, selector) {
  await page.evaluate(selector => new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Render deadline: ${selector}`)); }, 15000);
    function check() { if (document.querySelector(selector)) { clearTimeout(timer); observer.disconnect(); resolve(); } }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true }); check();
  }), selector);
}

export async function approvalWorkflow() {
  assertIsolated();
  process.env.PG_CONNECTION_TIMEOUT_MS = '10000';
  process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'approval-receipts');
  const evidence = path.join(root, '.omo/evidence/task-23-revision');
  const attempt = path.join(evidence, 'runs', randomUUID()); await mkdir(attempt, { recursive: true });
  const result = { status: 'running', http: [], surfaces: [], errors: [], blocked: [], cleanup: {} };
  let native, api, vite, browserServer, browser, pg;
  try {
    native = await startDailyNativePostgres();
    result.native = (await native.pool.query("SELECT version() AS version,current_setting('data_directory') AS directory,current_setting('port') AS port")).rows[0];
    assert.match(result.native.version, /PostgreSQL 18/);
    for (const file of ['perp_additions_v12_deadline_expenses.sql','perp_additions_v13_approval_states.sql','perp_additions_v14_approval_details.sql']) await native.pool.query(await readFile(path.join(root, 'db', file), 'utf8'));
    api = await startTestServer(); pg = await import('../../backend/src/config/pg.js');
    const request = async (actor, route, method = 'GET', body, expected = 200) => {
      const response = await fetch(api.baseUrl + route, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const value = await response.json(); result.http.push({ origin: 'fixture', route, method, status: response.status, body: evidenceBody(value) });
      assert.equal(response.status, expected, `${route}: ${JSON.stringify(value)}`); return value;
    };
    async function company(pgStore, suffix) {
      const prefix = pgStore ? '/pg' : '';
      const email = `${suffix}-${randomUUID()}@example.invalid`;
      const signup = await request(null, prefix + '/auth/signup', 'POST', { name: '동명이인', email, password: 'password-1234' }, 201);
      const actor = { id: String(signup.user.id), token: signup.token ?? signup.access_token, name: '동명이인', email };
      const company = await request(actor, pgStore ? '/pg/companies' : '/tenants', 'POST', { name: suffix, ...(pgStore ? {} : { type: 'custom' }), modules: ['approvals','finance'], features: ['approvals'], departments: [] }, 201);
      actor.orgId = company.org_id;
      actor.session = { token: actor.token, orgId: actor.orgId, name: actor.name, email, mustChangePassword: false, organizations: [{ org_id: actor.orgId, org_name: suffix, org_type: 'custom', roles: ['owner'] }] };
      return actor;
    }
    const sqlite = await company(false, 'T23_SQLITE'), postgres = await company(true, 'T23_PG');
    async function peer(owner, pgStore) {
      const email = `peer-${randomUUID()}@example.invalid`; let signup;
      if (pgStore) {
        await request(owner, '/pg/members', 'POST', { name: '동명이인', email, password: 'password-1234' }, 201);
        signup = await request(null, '/pg/auth/login', 'POST', { email, password: 'password-1234' });
      } else {
        const invitation = await request(owner, '/members/invites', 'POST', { email, roles: ['member'] }, 201);
        signup = await request(null, '/auth/signup', 'POST', { name: '동명이인', email, password: 'password-1234', invitation_token: invitation.token }, 201);
      }
      const actor = { id: String(signup.user.id), token: signup.token ?? signup.access_token, orgId: owner.orgId, name: '동명이인', email };
      actor.session = { ...owner.session, token: actor.token, email }; return actor;
    }
    const sqlitePeer = await peer(sqlite, false), pgPeer = await peer(postgres, true);
    const requesterRole = (await native.pool.query("INSERT INTO org.roles(company_id,name) VALUES($1,'T23_REQUESTER') RETURNING id", [postgres.orgId.slice(3)])).rows[0].id;
    await native.pool.query('INSERT INTO org.role_permissions(role_id,permission_id) SELECT $1,id FROM org.permissions WHERE code=ANY($2::text[])', [requesterRole,['approval.request','menu.approvals','menu.configured']]);
    await native.pool.query('INSERT INTO org.user_roles(user_id,role_id) VALUES($1,$2)', [pgPeer.id,requesterRole]);
    vite = await createServer({ configFile: false, root: path.join(root,'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT, plugins: [react()], server: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(api.baseUrl).origin }, watch: { ignored: ['**/.omo/**','**/dist/**'] } } });
    await vite.listen(); const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browserServer = await chromium.launchServer({ channel: 'chrome', headless: true, args: ['--disable-background-networking','--disable-component-update','--disable-sync'] });
    browser = await chromium.connect(browserServer.wsEndpoint()); result.chrome = browser.version();
    const allowed = new Set([origin, new URL(api.baseUrl).origin]);
    async function surface(actor) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (allowed.has(url.origin) && !protectedPorts.has(Number(url.port))) return route.continue();
        result.blocked.push(url.origin + url.pathname); return route.abort('blockedbyclient');
      });
      await context.addInitScript(session => { localStorage.setItem('orbitflow.session.v1', JSON.stringify(session)); localStorage.setItem('orbitflow.demoMode','0'); }, actor.session);
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on('pageerror', error => result.errors.push(error.message));
      observeApiResponses(page, actor, result);
      return { context, page };
    }
    async function action(page, suffix, trigger, status = 200) {
      const captured = captureJsonResponse(page, r => new URL(r.url()).pathname.endsWith(suffix) && r.request().method() !== 'GET', result);
      const [{ response, body }] = await Promise.all([captured, trigger()]); assert.equal(response.status(), status, JSON.stringify(body));
      await rendered(page, '[data-operation-state="idle"]'); return body;
    }
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
    const document = await PDFDocument.create(); document.addPage(); const pdf = Buffer.from(await document.save());
    for (const [store, owner, other] of [['sqlite', sqlite, sqlitePeer], ['pg', postgres, pgPeer]]) {
      const { context, page } = await surface(owner);
      try {
        await page.goto(origin + '/approvals', { waitUntil: 'domcontentloaded' });
        await rendered(page, 'main [data-screen-id="APR-001"]');
        // 최초 RED는 실제 앱에 전용 구조화 기안 화면이 없음을 확인한다.
        assert.equal(await page.locator('[data-approval-create]').count(), 1, 'APR001 must expose dedicated draft creation, not an immediate generic request');
        await page.locator('[data-approval-create]').click();
        await rendered(page, '[data-approval-editor]');
        await page.getByLabel('양식', { exact: true }).selectOption('expense_review');
        await page.getByLabel('제목', { exact: true }).fill('T23 ' + store + ' exact expense');
        if (store === 'sqlite') await page.getByLabel('결재자 1', { exact: true }).selectOption(owner.id);
        let draft = await action(page, '/drafts', () => page.locator('[data-approval-editor]').getByRole('button', { name: '임시저장', exact: true }).click(), 201);
        await rendered(page, `[data-approval-detail="${draft.id}"]`); await rendered(page, '[data-form-revision="1"]');
        await page.reload({ waitUntil: 'domcontentloaded' }); await rendered(page, '[data-approval-editor]');
        await action(page, '/submit', () => page.getByRole('button', { name: '제출', exact: true }).click(), 400);
        assert.equal(await page.getByLabel('제목', { exact: true }).inputValue(), 'T23 ' + store + ' exact expense');
        await page.getByLabel('목적 (필수)', { exact: true }).fill('원본 증빙을 검토합니다');
        await page.getByLabel('금액 (필수) · KRW', { exact: true }).fill(store === 'pg' ? '9007199254740991.23' : '1000000.00');
        draft = await action(page, '/draft', () => page.locator('[data-approval-editor]').getByRole('button', { name: '임시저장', exact: true }).click());
        const formPath = store === 'pg' ? '/pg/approvals/forms' : '/approvals/forms';
        await request(owner, formPath, 'POST', { key: 'expense_review', name: '지출 검토', fields: [{ key: 'purpose', label: '목적', required: true }, { key: 'amount_krw', label: '금액', type: 'krw', required: true }] }, 201);
        await action(page, '/submit', () => page.getByRole('button', { name: '제출', exact: true }).click(), 409);
        assert.equal(await page.getByLabel('목적 (필수)', { exact: true }).inputValue(), '원본 증빙을 검토합니다');
        const formsResponse = captureJsonResponse(page, r => new URL(r.url()).pathname.endsWith('/approvals/forms'), result);
        await page.getByRole('button', { name: '양식 새로고침', exact: true }).click(); await formsResponse;
        await rendered(page, '[data-form-revision="2"]');
        await action(page, '/receipt-uploads', () => page.getByLabel('첨부 파일').setInputFiles({ name: 'original.png', mimeType: 'image/png', buffer: png }), 201);
        await rendered(page, '[data-staged-receipt]');
        await action(page, '/receipt-uploads', () => page.getByLabel('첨부 파일').setInputFiles({ name: 'original.pdf', mimeType: 'application/pdf', buffer: pdf }), 201);
        draft = await action(page, '/draft', () => page.locator('[data-approval-editor]').getByRole('button', { name: '임시저장', exact: true }).click());
        const denied = await surface(other);
        try {
          const response = captureJsonResponse(denied.page, r => new URL(r.url()).pathname.endsWith('/' + draft.id), result);
          await denied.page.goto(origin + `/approvals?request=${encodeURIComponent(draft.id)}`); assert.equal((await response).response.status(), 404);
          await rendered(denied.page, 'main [role="alert"]'); assert.equal(await denied.page.locator('[data-approval-editor]').count(), 0);
        } finally { await denied.context.close(); }
        const submitted = await action(page, '/submit', () => page.getByRole('button', { name: '제출', exact: true }).click());
        assert.equal(submitted.status, 'pending'); assert.equal(submitted.attachment_snapshot.length, 2);
        await rendered(page, '[data-approval-status="pending"]');
        const downloadEvent = page.waitForEvent('download');
        await page.getByRole('button', { name: 'original.png 원본 다운로드', exact: true }).click();
        const download = await downloadEvent;
        const downloadPath = path.join(attempt, store + '-original.png'); await download.saveAs(downloadPath);
        assert.equal(createHash('sha256').update(await readFile(downloadPath)).digest('hex'), createHash('sha256').update(png).digest('hex'));
        const pdfEvent = page.waitForEvent('download');
        await page.getByRole('button', { name: 'original.pdf 원본 다운로드', exact: true }).click();
        const pdfDownload = await pdfEvent, pdfPath = path.join(attempt, store + '-original.pdf'); await pdfDownload.saveAs(pdfPath);
        assert.deepEqual(await readFile(pdfPath), pdf);
        assert.equal(await page.locator('iframe,object,embed').count(), 0);
        if (store === 'sqlite') {
          await action(page, '/actions', () => page.getByRole('button', { name: '승인', exact: true }).click(), 403);
          await page.getByLabel('재인증 비밀번호').fill('wrong-password');
          await action(page, '/actions', () => page.getByRole('button', { name: '승인', exact: true }).click(), 403);
          assert.equal(await page.getByLabel('재인증 비밀번호').inputValue(), '');
        } else {
          await action(page, '/actions', () => page.getByRole('button', { name: '승인', exact: true }).click(), 400);
          await page.getByLabel('본인 요청을 직접 결정함을 확인합니다').check();
        }
        await action(page, '/actions', () => page.getByRole('button', { name: '반려', exact: true }).click(), 400);
        await page.getByLabel('처리 의견 / 반려 사유').fill('증빙 내용 보완');
        if (store === 'pg') await page.getByLabel('본인 요청을 직접 결정함을 확인합니다').check();
        const rejected = await action(page, '/actions', () => page.getByRole('button', { name: '반려', exact: true }).click()); assert.equal(rejected.status, 'rejected');
        await rendered(page, '[data-approval-status="rejected"]');
        for (const width of [375,768,1280]) {
          await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => { window.scrollTo({ top: 0, behavior: 'instant' }); return document.fonts.ready; });
          const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth })); assert.ok(geometry.scroll <= width, JSON.stringify(geometry));
          const screenshot = `${store}-${width}.png`; await page.screenshot({ path: path.join(attempt,screenshot), fullPage: true, animations: 'disabled' }); result.surfaces.push({ store, width, geometry, screenshot });
        }
        const linked = await action(page, '/resubmit', () => page.getByRole('button', { name: '새 초안으로 재상신', exact: true }).click(), 201);
        assert.notEqual(linked.id, rejected.id); assert.equal(linked.predecessor_id, rejected.id); assert.equal(linked.status, 'draft'); assert.deepEqual(linked.attachment_snapshot, []);
        await rendered(page, `[data-approval-detail="${linked.id}"]`);
        await page.getByRole('link', { name: '이전 요청 원본', exact: true }).click(); await rendered(page, `[data-approval-detail="${rejected.id}"]`);
        assert.equal(await page.locator('[data-approval-status]').getAttribute('data-approval-status'), 'rejected');
        const { extendedWorkflow } = await import('./deadline-approval-extended.scenario.mjs');
        await extendedWorkflow({ store, owner, other, page, context, origin, linked, rejected, surface, action, rendered, request, native, attempt, result });
      } catch (error) {
        await writeFile(path.join(attempt, store + '-failure.html'), await page.content());
        await page.screenshot({ path: path.join(attempt, store + '-failure.png'), fullPage: true });
        throw error;
      } finally { await context.close(); }
    }
    const charge = (await native.pool.query('INSERT INTO accounting.dues_charges(company_id,target_user_id,amount) VALUES($1,$2,10.00) RETURNING id', [postgres.orgId.slice(3),pgPeer.id])).rows[0];
    const finance = await surface(postgres);
    try {
      await finance.page.goto(origin + '/finance/dues'); await rendered(finance.page, `[data-dues-id="${charge.id}"]`);
      assert.equal(await finance.page.locator('[data-approval-create]').count(),0);
      await finance.page.locator(`[data-dues-id="${charge.id}"] [data-open-payments]`).click(); await rendered(finance.page,'[data-outstanding]');
      await finance.page.getByLabel('납부액').fill('5.00');
      const response=captureJsonResponse(finance.page,r=>new URL(r.url()).pathname.endsWith(`/dues/${charge.id}/payments`) && r.request().method()==='POST',result);
      await finance.page.getByRole('button',{name:'납부 기록',exact:true}).click(); const {response:paid,body:value}=await response; assert.equal(paid.status(),201); assert.equal(value.outstanding,'5.00');
      await rendered(finance.page,`[data-payment-id="${value.id}"]`); assert.equal(await finance.page.locator('[data-outstanding]').innerText(),'5.00');
      result.dues={charge:String(charge.id),payment:value.id,outstanding:value.outstanding};
      await finance.page.screenshot({path:path.join(attempt,'fin004-preserved.png'),fullPage:true});
    } finally { await finance.context.close(); }
    const mutations=result.http.filter(row=>row.origin==='Chrome' && row.method!=='GET');
    assert.ok(mutations.every(row=>/^\/api\/v1\/(?:pg\/)?approvals\//.test(row.route) || /^\/api\/v1\/pg\/finance\/dues\/[^/]+\/payments$/.test(row.route)));
    assert.deepEqual(result.errors, []); assert.deepEqual(networkAudit.blocked, []); result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.errors.push(error.stack); console.error(error); process.exitCode = 1; }
  finally {
    await browser?.close(); await browserServer?.close(); result.cleanup.chromeClosed = !browserServer || browserServer.process().exitCode !== null;
    await vite?.close(); result.cleanup.viteClosed = true;
    await api?.close(); await pg?.closePgPool(); result.cleanup.apiClosed = true;
    await native?.close(); result.cleanup.nativeClosed = true;
    result.cleanup.nativeRemoved = !result.native || !existsSync(path.dirname(result.native.directory));
    result.networkAudit = networkAudit;
    await writeFile(path.join(attempt,'scenario.json'), JSON.stringify(result,null,2));
    await writeFile(path.join(evidence,'scenario.json'), JSON.stringify({ attempt, ...result },null,2));
    await writeFile(path.join(evidence,'cleanup.json'), JSON.stringify(result.cleanup,null,2));
    console.log(JSON.stringify({ status: result.status, attempt, cleanup: result.cleanup }));
  }
}
