import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from '@playwright/test';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';
import { startTestServer, createOwnerOrg, api } from '../../backend/tests/http.js';

const evidence = new URL('../../.omo/evidence/home-detail-popups/', import.meta.url);
// 렌더 이벤트를 구독하고 현재 상태도 검사한다. 고정 지연이나 polling을 사용하지 않는다.
async function rendered(page, selector) {
  await page.evaluate(selector => new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Render deadline: ${selector}`)); }, 10000);
    function check() { if (document.querySelector(selector)) { clearTimeout(timer); observer.disconnect(); resolve(); } }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true }); check();
  }), selector);
}

test('HOME real card/list clicks show scoped SQLite and native PG records in Chrome', { timeout: 120000 }, async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const result = { surfaces: [], requests: [], errors: [], cleanup: {} };
  let native, server, web, browser, pg;
  await mkdir(evidence, { recursive: true });
  try {
    native = await startDailyNativePostgres();
    await native.pool.query(await readFile(new URL('../../db/perp_additions_v8.sql', import.meta.url), 'utf8'));
    result.native = (await native.pool.query("SELECT version() AS engine,current_setting('data_directory') AS directory")).rows[0];
    server = await startTestServer(); pg = await import('../../backend/src/config/pg.js');
    const { db } = await import('../../backend/src/config/db.js');
    const { insert } = await import('../../backend/src/models/base.js');
    const sqlite = await createOwnerOrg(server.baseUrl, ['projects','tasks','documents']);
    sqlite.name = 'Owner'; sqlite.store = 'sqlite';
    const limitedRole = await api(server.baseUrl, '/settings/roles', { ...sqlite, method:'POST', body:{ name:'홈 제한 역할', scope:'all', permissions:['organization.settings','member.read','project.read','task.read','document.read','menu.home','menu.projects','menu.documents'] } });
    assert.equal(limitedRole.status,201);
    const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: native.identity.users[0].email, password: 'password-1234' } });
    assert.equal(login.status, 200);
    const postgres = { token: login.body.token, orgId: `pg:${native.companyId}`, userId: native.identity.users[0].id, name: native.identity.users[0].name, store: 'pg' };
    assert.ok(postgres.token);
    await native.pool.query("INSERT INTO org.company_modules(company_id,module_key) VALUES($1,'documents') ON CONFLICT DO NOTHING", [native.companyId]);
    await native.pool.query("INSERT INTO org.permissions(code,module,description) VALUES('document.read','documents','home fixture'),('menu.documents','documents','home fixture') ON CONFLICT DO NOTHING");
    await native.pool.query("INSERT INTO org.role_permissions(role_id,permission_id) SELECT r.id,p.id FROM org.roles r CROSS JOIN org.permissions p WHERE r.company_id=$1 AND r.name='DAILY_TEST_ROLE' AND p.code=ANY($2::text[]) ON CONFLICT DO NOTHING", [native.companyId,['document.read','menu.documents']]);
    const foreign = await createOwnerOrg(server.baseUrl, ['projects','tasks','documents']);
    const foreignTenant = db().prepare('SELECT tenant_id FROM membership WHERE org_id=?').get(foreign.orgId).tenant_id;
    insert('project', { tenant_id: foreignTenant, org_id: foreign.orgId, name: 'FOREIGN_PRIVATE_PROJECT', owner_id: foreign.userId });
    for (const actor of [sqlite, postgres]) {
      const prefix = actor.store === 'pg' ? '/pg' : '';
      actor.prefix = prefix;
      if (actor.store === 'sqlite') {
        const tenant = db().prepare('SELECT tenant_id FROM membership WHERE org_id=?').get(actor.orgId).tenant_id;
        const common = { tenant_id: tenant, org_id: actor.orgId, created_by: actor.userId };
        for (let i = 0; i < 105; i++) {
          const row = insert('project', { ...common, name: `홈 프로젝트 ${String(i).padStart(3,'0')}`, description: '실제 프로젝트 설명', owner_id: actor.userId });
          if (i === 0) actor.project = row.id;
        }
        actor.task = insert('task', { ...common, project_id: actor.project, title: '홈 업무 원본', description: '업무 설명', assignee_id: actor.userId }).id;
        actor.document = insert('document', { ...common, title: '홈 문서 원본', content: 'HOMEDOCUMENTBODY', owner_id: actor.userId, visibility: 'org', sensitivity: 'internal' }).id;
        actor.secondDocument = insert('document', { ...common, title: '두 번째 문서', content:'SECONDDOCUMENTBODY', owner_id:actor.userId, visibility:'org', sensitivity:'internal' }).id;
        actor.hiddenDocument = insert('document', { ...common, title:'FOREIGN_PRIVATE_DOCUMENT', content:'PRIVATEBODY', owner_id:foreign.userId, visibility:'private', sensitivity:'internal' }).id;
      } else {
        const rows = (await native.pool.query("INSERT INTO project.projects(company_id,name,description,lead_id) SELECT $1,'홈 프로젝트 '||lpad(i::text,3,'0'),'실제 프로젝트 설명',$2 FROM generate_series(0,104) i RETURNING id", [native.companyId,actor.userId])).rows;
        actor.project = String(rows[0].id);
        actor.task = String((await native.pool.query("INSERT INTO project.tasks(project_id,title,description,assignee_id) VALUES($1,'홈 업무 원본','업무 설명',$2) RETURNING id", [actor.project,actor.userId])).rows[0].id);
        actor.document = String((await native.pool.query("INSERT INTO project.documents(project_id,title,content_md,author_id) VALUES($1,'홈 문서 원본','HOMEDOCUMENTBODY',$2) RETURNING id", [actor.project,actor.userId])).rows[0].id);
        actor.secondDocument = String((await native.pool.query("INSERT INTO project.documents(project_id,title,content_md,author_id) VALUES($1,'두 번째 문서','SECONDDOCUMENTBODY',$2) RETURNING id", [actor.project,actor.userId])).rows[0].id);
        const foreignProject = (await native.pool.query("INSERT INTO project.projects(company_id,name) VALUES($1,'FOREIGN_PRIVATE_PROJECT') RETURNING id", [native.otherCompanyId])).rows[0].id;
        actor.hiddenDocument = String((await native.pool.query("INSERT INTO project.documents(project_id,title,content_md) VALUES($1,'FOREIGN_PRIVATE_DOCUMENT','PRIVATEBODY') RETURNING id", [foreignProject])).rows[0].id);
      }
      const hidden = await api(server.baseUrl, `${prefix}/documents/${actor.hiddenDocument}`, actor);
      assert.equal(hidden.status,404, `${actor.store}: ${JSON.stringify(hidden.body)}`);
    }
    web = await preview({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), envDir: process.env.DEADLINE_TEMP_ROOT, preview: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(server.baseUrl).origin } } });
    const origin = `http://127.0.0.1:${web.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-background-networking','--disable-component-update','--disable-sync'] });
    result.chrome = browser.version();
    for (const actor of [sqlite,postgres]) for (const width of [375,768,1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
      await context.addInitScript(session => localStorage.setItem('orbitflow.session.v1', JSON.stringify(session)), { token: actor.token, orgId: actor.orgId, name: actor.name, email: 'home@example.invalid', mustChangePassword: false, organizations: [{ org_id: actor.orgId, org_name: '홈 검증 회사', org_type: 'custom', roles: [] }] });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', error => result.errors.push(error.message));
      page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) result.requests.push({ store: actor.store, path: url.pathname + url.search }); });
      async function capture(label) {
        const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        assert.ok(geometry.scrollWidth <= geometry.width, label);
        const bounds = await page.getByRole('dialog').boundingBox();
        assert.ok(bounds.x >= 12 && bounds.x + bounds.width <= width - 12, `${label}: modal needs a usable backdrop gutter`);
        assert.ok(bounds.y >= 12 && bounds.y + bounds.height <= 888, `${label}: modal must fit the viewport`);
        await page.screenshot({ path: fileURLToPath(new URL(`${actor.store}-${label}-${width}.png`, evidence)) });
        result.surfaces.push({ store: actor.store, width, label, ...geometry });
      }
      try {
        const usage = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1${actor.prefix || '/tenants'}/usage`);
        await page.goto(origin, { waitUntil: 'domcontentloaded' }); assert.equal((await usage).status(),200);
        await rendered(page, '.stat-card button');
        // 기존 버전에서는 실제 클릭 후 dialog가 생기지 않아 이 검사가 실패한다.
        for (const [index, category, id] of [[0,'members',actor.userId],[1,'projects',actor.project],[2,'tasks',actor.task],[3,'documents',actor.document]]) {
          const trigger = page.locator('.stat-card button').nth(index);
          const loaded = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1${actor.prefix}/${category}`);
          await trigger.click();
          const [response] = await Promise.all([loaded, rendered(page, '[role="dialog"]')]); assert.equal(response.status(),200);
          await rendered(page, `[data-home-category="${category}"][data-state="ready"]`);
          assert.equal(await page.getByRole('dialog').count(),1);
          assert.ok(!(await page.getByRole('dialog').innerText()).includes('FOREIGN_PRIVATE_PROJECT'));
          assert.ok(!(await page.getByRole('dialog').innerText()).includes('FOREIGN_PRIVATE_DOCUMENT'));
          if (category === 'projects') {
            assert.equal(await page.locator('[data-home-total]').getAttribute('data-home-total'),'105');
            const firstPage = await page.locator('[data-home-row]').evaluateAll(rows => rows.map(row => row.dataset.homeRow));
            assert.equal(firstPage.length,10);
            await page.getByRole('button', { name:'다음', exact:true }).click();
            const secondPage = await page.locator('[data-home-row]').evaluateAll(rows => rows.map(row => row.dataset.homeRow));
            assert.equal(secondPage.length,10); assert.ok(secondPage.every(id => !firstPage.includes(id)));
            await capture('projects-page-2');
            await page.getByRole('searchbox', { name: '목록 검색' }).fill('NO_MATCH_SENTINEL');
            assert.equal(await page.locator('[data-home-row]').count(),0); await capture('search-empty');
            await page.getByRole('searchbox', { name: '목록 검색' }).fill('홈 프로젝트 000');
          }
          await page.locator(`[data-home-row="${id}"] button`).click();
          await rendered(page, `[data-home-detail="${id}"]`);
          if (category === 'documents') {
            await rendered(page, '[data-home-document-state="ready"]');
            assert.ok((await page.getByRole('dialog').innerText()).includes('HOMEDOCUMENTBODY'));
          }
          if (category === 'projects' || category === 'tasks') assert.equal(await page.locator(`[data-home-detail="${id}"] a`).getAttribute('href'), `/${category}/${id}`);
          await capture(category);
          if (category === 'documents') {
            await page.locator('[data-home-document-state="ready"]').scrollIntoViewIfNeeded();
            await capture('document-body');
          }
          const close = page.getByRole('button', { name: '홈 자세히 닫기' }); await close.focus();
          await page.keyboard.press('Shift+Tab'); assert.equal(await page.getByRole('dialog').evaluate(el => el.contains(document.activeElement)), true);
          await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(),0);
          assert.equal(await trigger.evaluate(el => el === document.activeElement),true);
        }
        await page.locator('.section-card__header button').click();
        await rendered(page, '[data-home-overview="ready"]');
        assert.equal(await page.getByRole('dialog').locator('[data-home-overview] button').count(),4);
        await capture('overview');
        await page.getByRole('button', { name: '업무 목록 열기' }).click();
        await rendered(page, '[data-home-category="tasks"][data-state="ready"]');
        assert.equal(await page.getByRole('dialog').count(),1);
        await page.keyboard.press('Escape');
        // 실제 HTTP 응답을 변환해 빈 상태/403/실패 경계를 검증한다. 저장소 조회 자체는 실행된다.
        for (const [state,status,payload] of [['empty',200,{ items: [] }],['forbidden',403,{ error: { code:'PERMISSION_DENIED',message:'fixture denied' } }],['error',500,{ error: { code:'TEST_ERROR',message:'fixture failure' } }]]) {
          const pattern = `**/api/v1${actor.prefix}/tasks*`;
          await page.route(pattern, async route => { const response = await route.fetch(); await route.fulfill({ response, status, json: payload }); });
          await page.locator('.stat-card button').nth(2).click();
          await rendered(page, `[data-home-category="tasks"][data-state="${state}"]`);
          assert.equal(await page.locator('[data-home-row]').count(),0); await capture(state);
          await page.unroute(pattern);
          if (state === 'error') {
            const retried = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1${actor.prefix}/tasks`);
            await page.getByRole('button', { name:'다시 시도', exact:true }).click(); assert.equal((await retried).status(),200);
            await rendered(page,'[data-home-category="tasks"][data-state="ready"]');
            assert.equal(await page.locator(`[data-home-row="${actor.task}"]`).count(),1); await capture('retry-ready');
          }
          await page.keyboard.press('Escape');
        }
        // 닫힌 popup의 지연 응답은 새 범주에 들어오면 안 된다.
        let release, arrived, settled; const held = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { arrived = resolve; }), handled = new Promise(resolve => { settled = resolve; });
        const pattern = `**/api/v1${actor.prefix}/documents*`;
        await page.route(pattern, async route => { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }); settled(); });
        await page.locator('.stat-card button').nth(3).click(); await requested;
        await rendered(page, '[data-home-category="documents"][data-state="loading"]'); await capture('loading');
        await page.getByRole('button', { name: '업무', exact: true }).click();
        await rendered(page, '[data-home-category="tasks"][data-state="ready"]');
        release(); await handled; await page.unroute(pattern);
        assert.equal(await page.locator('[data-home-row]').count(),1);
        await capture('stale-category'); await page.keyboard.press('Escape');
        // 항목 변경도 원본 본문 요청을 중단한다.
        let releaseItem, itemArrived, itemSettled;
        const itemHeld = new Promise(resolve => { releaseItem = resolve; }), itemRequested = new Promise(resolve => { itemArrived = resolve; }), itemHandled = new Promise(resolve => { itemSettled = resolve; });
        const itemPattern = `**/api/v1${actor.prefix}/documents/${actor.document}`;
        await page.route(itemPattern, async route => { const response = await route.fetch(); itemArrived(); await itemHeld; await route.fulfill({ response }); itemSettled(); });
        await page.locator('.stat-card button').nth(3).click(); await rendered(page,'[data-home-category="documents"][data-state="ready"]');
        await page.locator(`[data-home-row="${actor.document}"] button`).click(); await itemRequested;
        const itemAbort = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname.endsWith(`/documents/${actor.document}`));
        await page.locator(`[data-home-row="${actor.secondDocument}"] button`).click(); await itemAbort;
        await rendered(page,'[data-home-document-state="ready"]'); releaseItem(); await itemHandled; await page.unroute(itemPattern);
        assert.ok((await page.getByRole('dialog').innerText()).includes('SECONDDOCUMENTBODY'));
        assert.ok(!(await page.getByRole('dialog').innerText()).includes('HOMEDOCUMENTBODY'));
        await capture('stale-item'); await page.keyboard.press('Escape');
        // 실제 서버 권한을 바꾸고 403을 확인한다. 구성원 전체 조회는 UI에서 보내지 않는다.
        let originalRoles;
        if (actor.store === 'pg') await native.pool.query("DELETE FROM org.role_permissions rp USING org.roles r,org.permissions p WHERE rp.role_id=r.id AND rp.permission_id=p.id AND r.company_id=$1 AND r.name='DAILY_TEST_ROLE' AND p.code='menu.members'", [native.companyId]);
        else {
          originalRoles = db().prepare('SELECT roles FROM membership WHERE org_id=? AND user_id=?').get(actor.orgId,actor.userId).roles;
          db().prepare('UPDATE membership SET roles=? WHERE org_id=? AND user_id=?').run(limitedRole.body.key,actor.orgId,actor.userId);
        }
        assert.equal((await api(server.baseUrl, `${actor.prefix}/members`, actor)).status,403);
        await page.reload({ waitUntil:'domcontentloaded' }); await rendered(page,'.stat-card button');
        const before = result.requests.filter(r => r.store === actor.store && /^\/api\/v1\/(pg\/)?members(?:\?|$)/.test(r.path)).length;
        await page.locator('.stat-card button').nth(0).click(); await rendered(page,'[data-home-category="members"][data-state="forbidden"]');
        assert.equal(result.requests.filter(r => r.store === actor.store && /^\/api\/v1\/(pg\/)?members(?:\?|$)/.test(r.path)).length,before);
        await capture('members-denied'); await page.keyboard.press('Escape');
        if (actor.store === 'pg') await native.pool.query("INSERT INTO org.role_permissions(role_id,permission_id) SELECT r.id,p.id FROM org.roles r CROSS JOIN org.permissions p WHERE r.company_id=$1 AND r.name='DAILY_TEST_ROLE' AND p.code='menu.members'", [native.companyId]);
        else db().prepare('UPDATE membership SET roles=? WHERE org_id=? AND user_id=?').run(originalRoles,actor.orgId,actor.userId);
        await page.reload({ waitUntil:'domcontentloaded' }); await rendered(page,'.stat-card button');
        await page.locator('.stat-card button').nth(1).click(); await rendered(page,'[data-home-category="projects"][data-state="ready"]');
        // 바깥 클릭/포커스 복원.
        await page.locator('.home-detail-scrim').click({ position:{ x:2,y:2 } });
        assert.equal(await page.getByRole('dialog').count(),0);
        assert.equal(await page.locator('.stat-card button').nth(1).evaluate(el => el === document.activeElement),true);
        // 다른 탭에서 세션/회사를 전환하는 실제 storage 이벤트 동안 열린 요청이 폐기되어야 한다.
        let releaseScope, scopeArrived, scopeSettled;
        const scopeHeld = new Promise(resolve => { releaseScope = resolve; }), scopeRequested = new Promise(resolve => { scopeArrived = resolve; }), scopeHandled = new Promise(resolve => { scopeSettled = resolve; });
        await page.route(pattern, async route => { const response = await route.fetch(); scopeArrived(); await scopeHeld; await route.fulfill({ response }); scopeSettled(); });
        await page.locator('.stat-card button').nth(3).click(); await scopeRequested;
        const scopeAbort = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === `/api/v1${actor.prefix}/documents`);
        await page.evaluate(session => {
          const key='orbitflow.session.v1', newValue=JSON.stringify(session); localStorage.setItem(key,newValue); window.dispatchEvent(new StorageEvent('storage',{key,newValue}));
        }, { token:foreign.token,orgId:foreign.orgId,name:'다른 회사',email:'foreign@example.invalid',mustChangePassword:false,organizations:[{org_id:foreign.orgId,org_name:'다른 회사',roles:[]}] });
        await scopeAbort; releaseScope(); await scopeHandled; await page.unroute(pattern);
        await rendered(page,'.stat-card button'); assert.equal(await page.getByRole('dialog').count(),0);
        await page.locator('.stat-card button').nth(2).click(); await rendered(page,'[data-home-category="tasks"][data-state="empty"]');
        assert.ok(!(await page.locator('main').innerText()).includes('홈 업무 원본'));
        await capture('scope-empty');
      } finally { await context.close(); }
    }
    assert.deepEqual(result.errors, []); result.passed = true;
  } finally {
    await browser?.close(); result.cleanup.browserClosed = true;
    if (web) await new Promise((resolve, reject) => { web.httpServer.close(error => error ? reject(error) : resolve()); web.httpServer.closeAllConnections(); });
    result.cleanup.webClosed = true;
    await server?.close(); result.cleanup.sqliteClosed = true;
    await pg?.closePgPool(); await native?.close(); result.cleanup.pgClosed = true;
    result.cleanup.nativeDirectoryRemoved = !existsSync(result.native?.directory ?? '');
    await writeFile(new URL('browser.json', evidence), JSON.stringify(result,null,2));
  }
});
