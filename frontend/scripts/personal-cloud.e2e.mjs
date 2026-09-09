import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {preview} from 'vite';
import {personalCloudScenario} from '../../backend/tests/personal-cloud-scenarios.js';
const repo=fileURLToPath(new URL('../../',import.meta.url)),mode=process.argv[2]??'legacy';
assert.ok(['legacy','pg'].includes(mode));
async function arm(page,selector){await page.evaluate(selector=>{window.__personalSignal=new Promise((resolve,reject)=>{
 const observer=new MutationObserver(check),timer=setTimeout(()=>{observer.disconnect();reject(new Error('DOM deadline '+selector));},20000);
 function check(){if(document.querySelector(selector)){clearTimeout(timer);observer.disconnect();resolve();}}
 observer.observe(document.documentElement,{subtree:true,attributes:true,childList:true,characterData:true});check();
});},selector);}
const done=page=>page.evaluate(()=>window.__personalSignal);
await personalCloudScenario(mode,{surface:async({f,wire,base,root,source})=>{
 let browser,web,worker;const errors=[];
 try {
  if(mode==='pg')await f.native.pool.query(await readFile(new URL('../../db/perp_additions_v8.sql',import.meta.url),'utf8'));
  const {startWikiWorker}=await import('../../backend/src/services/knowledge-wiki-worker.service.js');worker=startWikiWorker({stores:[mode],onError:e=>errors.push(e.code)});await worker.wake();
  web=await preview({configFile:false,root:path.join(repo,'frontend'),envDir:process.env.DEADLINE_TEMP_ROOT,preview:{host:'127.0.0.1',port:0,proxy:{'/api':{target:new URL(f.api.baseUrl).origin}}}});
  const origin=`http://127.0.0.1:${web.httpServer.address().port}`;
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking','--disable-sync']});
  const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block',reducedMotion:'reduce'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
  await context.addInitScript(session=>{sessionStorage.setItem('orbitflow.session.v1',JSON.stringify(session));localStorage.setItem('orbitflow.demoMode','0');localStorage.setItem('orbitflow.agent.useVault','1');},{token:f.a.token,orgId:f.a.orgId,name:'Personal Synthetic',email:'personal@example.invalid',mustChangePassword:false,organizations:[]});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const beforeOpen=wire.calls.length;await page.goto(origin+'/vault/graph',{waitUntil:'domcontentloaded'});
  await arm(page,'[data-wiki-workspace][data-loading="false"]');await done(page);
  await arm(page,'[data-note-id]');await page.getByLabel('그래프 노트 선택').selectOption(source.id);await done(page);
  assert.equal(wire.calls.length,beforeOpen,'default-true browser Vault preference does not authorize transfer');
  const graphPreview=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${base}/notes/${source.id}/cloud-preview`&&r.request().method()==='POST',{timeout:20000});
  await arm(page,'[data-consent-hash]');await page.getByRole('button',{name:'개인 연결 클라우드 범위 확인',exact:true}).click();const displayed=await(await graphPreview).json();await done(page);
  assert.equal(wire.calls.length,beforeOpen);assert.ok(displayed.scope.inputs.some(i=>i.title==='Source'&&i.version===String(source.version)));
  assert.equal(await page.getByRole('button',{name:'동의한 범위만 클라우드 실행',exact:true}).isDisabled(),true);
  const cancelled=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/cloud-preview')&&r.request().method()==='DELETE',{timeout:20000});await page.getByRole('button',{name:'전송 승인 취소',exact:true}).click();assert.equal((await cancelled).status(),200);assert.equal(wire.calls.length,beforeOpen);
  await arm(page,'[data-consent-hash]');await page.getByRole('button',{name:'개인 연결 클라우드 범위 확인',exact:true}).click();await done(page);
  await page.getByLabel('이 정확한 개인 자료 범위를 OpenRouter로 전송하는 데 동의합니다',{exact:true}).check();
  const graphResult=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/cloud-analyze'),{timeout:20000});
  await page.getByRole('button',{name:'동의한 범위만 클라우드 실행',exact:true}).click();const actual=await(await graphResult).json();assert.equal(actual.state,'ready');assert.equal(actual.local_only,false);
  await arm(page,'[data-analysis-state="ready"]');await done(page);
  assert.ok(wire.calls.filter(c=>c.path==='/embeddings').every(c=>c.authorization==='Bearer synthetic-shared'));
  const workspace=page.locator('[data-wiki-workspace]');
  await workspace.getByLabel('조사 원본 Source',{exact:true}).check();
  await workspace.getByLabel('개인 위키 클라우드 범위를 먼저 확인 (끄면 로컬 전용)',{exact:true}).check();
  await workspace.getByLabel('위키 조사 질문').fill('PERSONAL_SYNTHETIC_Source');
  const beforeWiki=wire.calls.length;
  await arm(page,'[data-wiki-workspace] [data-consent-hash]');await workspace.getByRole('button',{name:'원본 기반 조사',exact:true}).click();await done(page);assert.equal(wire.calls.length,beforeWiki);
  assert.equal(await workspace.getByRole('button',{name:'동의한 범위만 클라우드 실행',exact:true}).isDisabled(),true);
  await workspace.getByLabel('이 정확한 개인 자료 범위를 OpenRouter로 전송하는 데 동의합니다',{exact:true}).check();
  await arm(page,'[data-job-state="succeeded"]');await workspace.getByRole('button',{name:'동의한 범위만 클라우드 실행',exact:true}).click();await done(page);
  const id=await workspace.locator('[data-job-state="succeeded"]').getAttribute('data-job-id');const job=await f.api.request(f.a,`${root}/jobs/${id}`);
  assert.equal(job.result.review_state,'unreviewed');assert.equal(job.result.citation_validation,'anchors_valid');assert.equal(job.result.provenance.consent.actor_id,f.a.userId);
  await arm(page,'.wiki-revision mark');await workspace.locator(`[data-job-id="${id}"] .wiki-citations button`).first().click();await done(page);assert.equal(await workspace.locator('.wiki-revision mark').textContent(),'PERSONAL_SYNTHETIC_Source');
  await arm(page,'[data-review-id]');await workspace.getByRole('button',{name:'이 결과를 검토 초안으로 보관',exact:true}).click();await done(page);assert.equal(await workspace.getByRole('button',{name:'명시적으로 게시',exact:true}).isDisabled(),true);assert.equal((await f.api.request(f.a,root+'/pages')).items.length,0);
  const evidence=path.join(repo,'.omo/evidence/personal-cloud');await mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,mode+'.png'),fullPage:true,animations:'disabled'});
  assert.deepEqual(errors,[]);const result={mode,browser:browser.version(),surface:'built /vault/graph',explicitConsent:true,graph:'ready/openrouter',wiki:'unreviewed/cited',publishedPages:0,errors};await writeFile(path.join(evidence,mode+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await browser?.close();await worker?.stop();if(web)await new Promise((resolve,reject)=>{web.httpServer.close(e=>e?reject(e):resolve());web.httpServer.closeAllConnections();});}
}});
