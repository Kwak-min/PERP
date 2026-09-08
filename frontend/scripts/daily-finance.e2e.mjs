import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';
import { api, startTestServer } from '../../backend/tests/http.js';
import { installFinanceFixture } from '../../backend/tests/pg-daily-finance-fixture.js';

// Production SPA + real Express/auth/permissions + isolated embedded PostgreSQL WASM.
process.env.DATABASE_URL=''; process.env.PG_HOST='127.0.0.1'; process.env.PG_PORT='1';
const root=fileURLToPath(new URL('../',import.meta.url));
const artifacts=fileURLToPath(new URL('../.artifacts/daily-finance/',import.meta.url));
await mkdir(artifacts,{recursive:true});
const server=await startTestServer(); let fixture, vite, browser;
try {
  fixture=await installFinanceFixture();
  const request=(route,method='GET',body,actor=fixture.actor())=>api(server.baseUrl,'/pg'+route,{...actor,method,body,headers:{'Idempotency-Key':randomUUID()}});
  const charge=await request('/finance/dues','POST',{target_user_id:'2',amount:'100.01'}); assert.equal(charge.status,201);
  const own=await request('/approvals','POST',{request_type:'Browser own request',note:'Review this request'},fixture.actor(1)); assert.equal(own.status,201);
  await request('/approvals','POST',{request_type:'Browser admin request'});
  vite=await preview({configFile:false,root,preview:{host:'127.0.0.1',port:0,proxy:{'/api':new URL(server.baseUrl).origin}}});
  const origin='http://127.0.0.1:'+vite.httpServer.address().port;
  browser=await chromium.launch({channel:'chrome'}); console.log('CHROME '+browser.version()+'; production registry; PGlite, not native PG');
  const contexts=[]; const errors=[];
  async function pageFor(actor) {
    const context=await browser.newContext({viewport:{width:1280,height:900}}); contexts.push(context);
    await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    await context.addInitScript(stored=>localStorage.setItem('orbitflow.session.v1',JSON.stringify(stored)),{...actor,name:'Finance QA',email:'qa@example.invalid',mustChangePassword:false,organizations:[{org_id:actor.orgId,org_name:'Finance fixture',org_type:'perp_db',roles:[]}]});
    const page=await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror',e=>errors.push(e.message)); return page;
  }
  const requester=await pageFor(fixture.actor(1));
  const listSignal=requester.waitForResponse(r=>r.url().endsWith('/api/v1/pg/approvals')&&r.request().method()==='GET');
  await requester.goto(origin+'/approvals'); assert.equal((await listSignal).status(),200);
  await expect(requester.locator('[data-approval-id]')).toHaveCount(1);
  assert.equal(await requester.locator('[data-approval-id]').getAttribute('data-approval-id'),own.body.id);
  await expect(requester.locator('[data-decision]')).toHaveCount(0);
  const admin=await pageFor(fixture.actor());
  await admin.goto(origin+'/approvals'); const approvalRow=admin.locator(`[data-approval-id="${own.body.id}"]`);
  await expect(approvalRow.locator('[data-decision="approve"]')).toBeEnabled();
  await approvalRow.locator('textarea').fill('Reviewed in browser');
  const decided=admin.waitForResponse(r=>r.url().endsWith(`/approvals/${own.body.id}/decide`)&&r.request().method()==='POST');
  await approvalRow.locator('[data-decision="approve"]').click(); assert.equal((await decided).status(),200);
  await expect(approvalRow).toHaveAttribute('data-status','approved');
  assert.equal((await request(`/approvals/${own.body.id}/decide`,'POST',{decision:'reject'})).status,409);
  const reloadRequest=requester.waitForResponse(r=>r.url().endsWith('/api/v1/pg/approvals'));
  await requester.reload(); await reloadRequest; await expect(requester.locator('[data-approval-id]')).toHaveAttribute('data-status','approved');
  await admin.screenshot({path:artifacts+'approvals.png',fullPage:true});

  await admin.goto(origin+'/finance/dues');
  const row=admin.locator(`[data-dues-id="${charge.body.id}"]`); await expect(row).toBeVisible();
  const historySignal=admin.waitForResponse(r=>r.url().endsWith(`/dues/${charge.body.id}/payments`)&&r.request().method()==='GET');
  await row.locator('[data-open-payments]').click(); assert.equal((await historySignal).status(),200);
  const panel=admin.locator('[data-payment-panel]'); await expect(panel.locator('[data-outstanding]')).toHaveText('100.01');
  async function pay(amount) {
    await panel.locator('input[name="amount"]').fill(amount);
    const response=admin.waitForResponse(r=>r.url().endsWith(`/dues/${charge.body.id}/payments`)&&r.request().method()==='POST');
    await panel.locator('button[type="submit"]').click(); const saved=await response; assert.equal(saved.status(),201); return saved;
  }
  const first=await pay('40.01'); const originalRequest=first.request();
  const replay=await api(server.baseUrl,`/pg/finance/dues/${charge.body.id}/payments`,{...fixture.actor(),method:'POST',headers:{'Idempotency-Key':originalRequest.headers()['idempotency-key']},body:originalRequest.postDataJSON()});
  assert.equal(replay.status,201); assert.equal(replay.body.id,(await first.json()).id);
  await expect(panel.locator('[data-outstanding]')).toHaveText('60.00'); await expect(panel.locator('[data-payment-id]')).toHaveCount(1);
  await pay('60.00'); await expect(panel.locator('[data-outstanding]')).toHaveText('0.00'); await expect(panel.locator('[data-payment-id]')).toHaveCount(2);
  await admin.reload(); await expect(row).toHaveAttribute('data-status','paid');
  const reloaded=admin.waitForResponse(r=>r.url().endsWith(`/dues/${charge.body.id}/payments`)&&r.request().method()==='GET');
  await row.locator('[data-open-payments]').click(); await reloaded;
  await expect(panel.locator('[data-payment-id]')).toHaveCount(2); await expect(panel.locator('[data-outstanding]')).toHaveText('0.00');
  await expect(panel.locator('button[type="submit"]')).toHaveCount(0);
  await admin.setViewportSize({width:390,height:844});
  await expect(admin.locator('.sidebar')).not.toHaveClass(/sidebar--open/);
  await admin.screenshot({path:artifacts+'dues-mobile.png',fullPage:true,animations:'disabled'});
  assert.ok(await admin.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'no mobile horizontal overflow');
  await admin.setViewportSize({width:1280,height:900});

  // Dedicated dues creation/correction/deletion still uses the real generic record route.
  await admin.getByRole('button',{name:'회비 만들기',exact:true}).click();
  const modal=admin.getByRole('dialog');
  await modal.getByLabel('대상자').selectOption('2'); await modal.getByLabel('금액').fill('15.01');
  let saved=admin.waitForResponse(r=>r.url().endsWith('/api/v1/pg/finance/dues')&&r.request().method()==='POST');
  await modal.locator('button[type="submit"]').click(); let response=await saved; assert.equal(response.status(),201); assert.ok(response.request().headers()['idempotency-key']);
  const editableId=(await response.json()).id, editable=admin.locator(`[data-dues-id="${editableId}"]`);
  await editable.getByRole('button',{name:'수정',exact:true}).click(); await modal.getByLabel('금액').fill('20.01');
  saved=admin.waitForResponse(r=>r.url().endsWith(`/records/dues/${editableId}`)&&r.request().method()==='PATCH');
  await modal.locator('button[type="submit"]').click(); response=await saved; assert.equal(response.status(),200); assert.equal(response.request().postDataJSON().expected_version,1);
  await expect(modal).toHaveCount(0);
  saved=admin.waitForResponse(r=>r.url().endsWith(`/records/dues/${editableId}`)&&r.request().method()==='DELETE');
  admin.once('dialog',dialog=>dialog.accept()); await editable.getByRole('button',{name:'삭제',exact:true}).click(); response=await saved;
  assert.equal(response.status(),200); assert.equal(response.request().postDataJSON().expected_version,2);

  // Lose a successful HTTP response after the actual server transaction commits.
  // Retrying the still-open creation form must reuse its key, not create a second journal.
  await admin.goto(origin+'/finance/transactions'); await admin.getByRole('button',{name:'새로 만들기',exact:true}).click();
  await modal.getByLabel('계정(수입/지출)').selectOption('2'); await modal.getByLabel('금액').fill('10.01');
  await modal.getByLabel('일자').fill('2026-09-08'); await modal.getByLabel('내용').fill('Lost response browser');
  const attempts=[]; let committed, loseResponse=true;
  await admin.route('**/api/v1/pg/finance/transactions',async route=>{
    if(route.request().method()!=='POST') return route.continue();
    attempts.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});
    if(!loseResponse) return route.continue();
    loseResponse=false; const result=await route.fetch(); assert.equal(result.status(),201); committed=await result.json(); await route.abort('failed');
  });
  const failed=admin.waitForEvent('requestfailed',{predicate:r=>r.url().endsWith('/pg/finance/transactions')&&r.method()==='POST',timeout:10000});
  await modal.locator('button[type="submit"]').click(); await failed; await expect(modal.getByRole('alert')).toBeVisible();
  saved=admin.waitForResponse(r=>r.url().endsWith('/pg/finance/transactions')&&r.request().method()==='POST');
  await modal.locator('button[type="submit"]').click(); response=await saved;
  assert.equal(response.status(),201); assert.equal((await response.json()).id,committed.id); assert.equal(attempts.length,2); assert.ok(attempts[0].key); assert.deepEqual(attempts[0],attempts[1]);
  await admin.unroute('**/api/v1/pg/finance/transactions');
  assert.equal((await fixture.db.query("SELECT count(*) AS n FROM accounting.journal_entries WHERE memo='Lost response browser'")).rows[0].n,1);
  const journal=admin.locator('tbody tr').filter({hasText:'Lost response browser'}); await expect(journal).toHaveCount(1);
  saved=admin.waitForResponse(r=>r.url().endsWith(`/records/transactions/${committed.id}`)&&r.request().method()==='DELETE');
  admin.once('dialog',dialog=>dialog.accept()); await journal.getByRole('button',{name:'삭제',exact:true}).click(); response=await saved;
  assert.equal(response.status(),409); assert.equal(response.request().postDataJSON().expected_version,1);

  await admin.goto(origin+'/finance/budgets'); await admin.getByRole('button',{name:'새로 만들기',exact:true}).click();
  await modal.getByLabel('이름').fill('Browser budget'); await modal.getByLabel('편성액').fill('100.01');
  saved=admin.waitForResponse(r=>r.url().endsWith('/pg/finance/budgets')&&r.request().method()==='POST');
  await modal.locator('button[type="submit"]').click(); response=await saved; assert.equal(response.status(),201); assert.ok(response.request().headers()['idempotency-key']);
  const budgetId=(await response.json()).id, budget=admin.locator('tbody tr').filter({hasText:'Browser budget'});
  await budget.getByRole('button',{name:'수정',exact:true}).click(); await modal.getByLabel('편성액').fill('200.01');
  assert.equal((await request(`/records/budgets/${budgetId}`,'PATCH',{amount:'150.01',expected_version:1})).status,200);
  saved=admin.waitForResponse(r=>r.url().endsWith(`/records/budgets/${budgetId}`)&&r.request().method()==='PATCH');
  await modal.locator('button[type="submit"]').click(); response=await saved; assert.equal(response.status(),409); assert.equal(response.request().postDataJSON().expected_version,1);
  await expect(modal.getByRole('alert')).toBeVisible(); admin.once('dialog',dialog=>dialog.accept()); await modal.getByRole('button',{name:'닫기',exact:true}).click();
  await admin.reload(); await budget.getByRole('button',{name:'수정',exact:true}).click(); await modal.getByLabel('편성액').fill('200.01');
  saved=admin.waitForResponse(r=>r.url().endsWith(`/records/budgets/${budgetId}`)&&r.request().method()==='PATCH');
  const refreshed=admin.waitForResponse(r=>r.url().endsWith('/pg/finance/budgets')&&r.request().method()==='GET');
  await modal.locator('button[type="submit"]').click(); response=await saved; assert.equal(response.status(),200); assert.equal(response.request().postDataJSON().expected_version,2); await refreshed;
  await expect(modal).toHaveCount(0); await expect(budget).toContainText('200.01');
  assert.equal((await request(`/records/budgets/${budgetId}`,'PATCH',{amount:'250.01',expected_version:3})).status,200);
  saved=admin.waitForResponse(r=>r.url().endsWith(`/records/budgets/${budgetId}`)&&r.request().method()==='DELETE');
  admin.once('dialog',dialog=>dialog.accept()); await budget.getByRole('button',{name:'삭제',exact:true}).click(); response=await saved;
  assert.equal(response.status(),409); assert.equal(response.request().postDataJSON().expected_version,3);
  await admin.reload(); await expect(budget).toContainText('250.01');
  saved=admin.waitForResponse(r=>r.url().endsWith(`/records/budgets/${budgetId}`)&&r.request().method()==='DELETE');
  admin.once('dialog',dialog=>dialog.accept()); await budget.getByRole('button',{name:'삭제',exact:true}).click(); response=await saved;
  assert.equal(response.status(),200); assert.equal(response.request().postDataJSON().expected_version,4);
  assert.equal((await fixture.db.query("SELECT count(*) AS n FROM accounting.record_events WHERE resource='budgets' AND resource_id=$1",[budgetId])).rows[0].n,4);

  assert.equal((await request('/finance/transactions','POST',{account_id:'2',amount:'9999999999999999.99'})).status,201);
  const summary=await request('/finance/summary'); assert.equal(summary.body.수입,'10000000000000010.00');
  await admin.goto(origin+'/finance'); await expect(admin.getByText(summary.body.수입,{exact:true}).first()).toBeVisible();
  await admin.screenshot({path:artifacts+'precise-summary.png',fullPage:true});
  assert.deepEqual(errors,[]); console.log('PASS requester ownership; approval once/reload; partial/remainder/replay/history/reload; dues create/edit/delete; lost-response stable creation key; posted delete409; generic stale edit/delete409 and refresh; audit retention; exact summary; mobile; no JS errors');
  for(const context of contexts) await context.close();
} finally { await browser?.close(); await vite?.close(); await fixture?.close(); await server.close(); }
