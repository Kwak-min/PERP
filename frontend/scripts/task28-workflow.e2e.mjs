import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { setupJobs } from '../../backend/tests/deadline-wiki-jobs-fixture.js';
import { task28LocalProvider } from './task28-local-provider.mjs';
import { personalWikiScenario } from './task28-personal.scenario.mjs';
import { networkAudit, protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
export async function task28Workflow({mode='legacy',evidence=path.join(root,'.omo/evidence/task-28-deadline-erp-redesign')}={}) {
assert.ok(['legacy','pg'].includes(mode));
await mkdir(path.join(evidence,'screens'),{recursive:true});
const result={mode,status:'running',checks:[],http:[],screens:[],pageErrors:[],cleanup:{},hashes:{}};
let f,vite,browser,provider,worker,restarted,proxyOptions,completePersonal;
function ipc(child,type,predicate=()=>true){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.off('message',message);reject(new Error('IPC deadline '+type));},20000);const message=value=>{if(value.type===type&&predicate(value)){clearTimeout(timer);child.off('message',message);resolve(value);}};child.on('message',message);});}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Gate deadline '+label)),20000);})]);}finally{clearTimeout(timer);}}
// 정확한 DOM 상태 신호. action 전에 구독하며 지연/폴링으로 완료를 추측하지 않는다.
async function arm(page,selector) {
  await page.evaluate(selector=>{window.__task28Signal=new Promise((resolve,reject)=>{
    const check=()=>{if(document.querySelector(selector)){clearTimeout(timer);observer.disconnect();resolve(true);}};
    const observer=new MutationObserver(check),timer=setTimeout(()=>{observer.disconnect();reject(new Error('DOM signal deadline: '+selector));},20000);
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});check();
  });},selector);
}
async function done(page){await page.evaluate(()=>window.__task28Signal);}
async function after(page,selector,action){await arm(page,selector);await action();await done(page);}
try {
  f=await setupJobs(mode);provider=await task28LocalProvider();
  process.env.WIKI_LOCAL_MODEL_CONFIG=JSON.stringify(provider.config);
  const {startWikiWorker}=await import('../../backend/src/services/knowledge-wiki-worker.service.js');
  worker=startWikiWorker({stores:[mode],onError:error=>result.http.push({worker:error.code})});
  const prefix=f.prefix;
  const originalText='한글😀\r\n같은 구절\r\n같은 구절';
  const note=await f.api.request(f.a,prefix+'/vault/notes','POST',{title:'Task28 원본 노트',content:originalText},201);
  const project=mode==='pg'?await f.api.request(f.a,'/pg/projects','POST',{name:'Task28 typed project'},201):null;
  const space=mode==='legacy'?await f.api.request(f.a,'/documents/spaces','POST',{name:'Task28 typed space'},201):null;
  const document=await f.api.request(f.a,prefix+'/documents','POST',{title:'Task28 원본 문서',...(project?{project_id:project.id,content_md:originalText}:{visibility:'org',content:originalText,space_id:space.id})},201);
  const roles={};
  for(const [name,permissions] of Object.entries({reader:['menu.documents','document.read'],writer:['menu.documents','document.read','document.write'],denied:['menu.home']})) roles[name]=await f.api.request(f.a,'/settings/roles','POST',{name:'Task28 '+name,scope:'all',permissions},201);
  let reader;
  if(mode==='pg') {
    const user=await f.api.request(f.a,'/pg/members','POST',{email:'task28-reader@example.invalid',name:'Task28 reader',password:'password-1234'},201);
    const login=await f.api.request(null,'/pg/auth/login','POST',{email:'task28-reader@example.invalid',password:'password-1234'});
    reader={token:login.token,userId:String(user.id),orgId:f.a.orgId};
  } else {
    const invite=await f.api.request(f.a,'/members/invites','POST',{email:'task28-reader@example.invalid',roles:[roles.reader.key]},201);
    const signup=await f.api.request(null,'/auth/signup','POST',{email:'task28-reader@example.invalid',name:'Task28 reader',password:'password-1234',invitation_token:invite.token},201);
    reader={token:signup.access_token,userId:signup.user.id,orgId:f.a.orgId};
  }
  async function assign(name){const member=(await f.api.request(f.a,'/settings/members')).items.find(m=>m.user_id===reader.userId);await f.api.request(f.a,`/settings/members/${member.membership_id}/roles`,'PUT',{roles:[roles[name].key],expected_roles_version:member.roles_version});}
  await assign('reader');
  vite=await createServer({configFile:false,root:path.join(root,'frontend'),cacheDir:path.join(process.env.DEADLINE_TEMP_ROOT,'vite-task28'),envDir:process.env.DEADLINE_TEMP_ROOT,plugins:[react()],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:new URL(f.api.baseUrl).origin,configure(_proxy,options){proxyOptions=options;}}},watch:{ignored:['**/.omo/**']}}});
  await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
  assert.ok(!protectedPorts.has(vite.httpServer.address().port));
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking','--disable-sync']});result.chrome=browser.version();
  async function open(actor,route='/documents/graph',observe) {
    const me=await f.api.request(actor,prefix?'/pg/auth/workspace':'/auth/me');
    const session={token:actor.token,orgId:actor.orgId,name:'Task28 synthetic',email:'task28@example.invalid',mustChangePassword:false,organizations:me.organizations??[]};
    const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce',serviceWorkers:'block'});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
    await context.addInitScript(session=>{sessionStorage.setItem('orbitflow.session.v1',JSON.stringify(session));localStorage.setItem('orbitflow.demoMode','0');},session);
    const page=await context.newPage();page.on('pageerror',error=>result.pageErrors.push(error.message));observe?.(page);
    const graph=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${prefix}${route.startsWith('/vault')?'/vault':'/documents'}/graph`);
    await page.goto(origin+route,{waitUntil:'domcontentloaded'});await graph;
    await arm(page,'[data-wiki-workspace]');await done(page);
    return {page,context};
  }
  async function capture(page,name){for(const width of [375,768,1280]){await page.setViewportSize({width,height:900});await page.evaluate(()=>document.fonts.ready);const file=`${mode}-${name}-${width}.png`;await page.screenshot({path:path.join(evidence,'screens',file),fullPage:true,animations:'disabled'});const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(size.scroll<=size.width+1,JSON.stringify(size));result.screens.push(file);}}
  const admin=await open(f.a);
  assert.equal(await admin.page.locator('[data-wiki-workspace]').count(),1,'actual company screen must expose empty-Wiki raw-first research');
  await capture(admin.page,'empty');
  const detailHeld=Promise.withResolvers(),detailRelease=Promise.withResolvers(),detailFinished=Promise.withResolvers();
  await admin.context.route(`**/api/v1${prefix}/documents/${document.id}`,async route=>{try{const response=await route.fetch();detailHeld.resolve();await bounded(detailRelease.promise,'detail release');await route.fulfill({response});detailFinished.resolve();}catch(error){detailFinished.reject(error);}},{times:1});
  await admin.page.locator('.graph-layout .knowledge-graph-stage__nodes').getByRole('button',{name:/Task28 원본 문서/}).click();await bounded(detailHeld.promise,'detail held');
  await admin.page.locator('.graph-layout .knowledge-graph-stage__nodes').getByRole('button',{name:mode==='pg'?/Task28 typed project/:/Task28 typed space/}).click();
  detailRelease.resolve();await bounded(detailFinished.promise,'detail finished');
  assert.equal(await admin.page.getByRole('button',{name:'본문 수정',exact:true}).count(),0);assert.equal(await admin.page.getByLabel('원본 문서 본문').count(),0);
  result.checks.push('document->typed hub selection aborts late document detail; no document editing through project/space identity');
  const rawResponse=admin.page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${f.root}/sources`&&r.request().method()==='POST');
  await admin.page.getByLabel('위키 원본 파일 올리기',{exact:true}).setInputFiles({name:'Task28 합성 원본.md',mimeType:'text/markdown',buffer:Buffer.from(originalText)});
  const raw=await (await rawResponse).json();assert.ok(raw.current_revision_id);
  await arm(admin.page,'.wiki-sources li');await done(admin.page);
  assert.equal((await f.api.request(f.a,f.root+'/pages')).items.length,0);
  const personal=await open(f.a,'/vault/graph');
  const detail=personal.page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${prefix}/vault/notes/${note.id}`);
  await personal.page.getByLabel('그래프 노트 선택').selectOption(note.id);await detail;
  const registeredResponse=personal.page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${prefix}/vault/wiki/sources`&&r.request().method()==='POST');
  await personal.page.getByRole('button',{name:'선택 원본 등록',exact:true}).click();const personalSource=await(await registeredResponse).json();assert.ok(personalSource.id);
  await arm(personal.page,'.graph-layout [data-engine-state="ready"]');await done(personal.page);
  await after(personal.page,'.graph-layout [data-engine-state="error"]',()=>personal.page.evaluate(()=>document.querySelector('.graph-layout canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()));
  await personal.page.getByLabel('본문 마크다운').fill('Task28 보존할 사용자 초안');
  const updatedNote=await f.api.request(f.a,`${prefix}/vault/notes/${note.id}`,'PATCH',{version:note.version,content:'Task28 concurrent source edit'});
  const staleSave=personal.page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${prefix}/vault/notes/${note.id}`&&r.request().method()==='PATCH');
  await personal.page.getByRole('button',{name:'변경 저장',exact:true}).click();assert.equal((await staleSave).status(),409);
  assert.equal(await personal.page.getByLabel('본문 마크다운').inputValue(),'Task28 보존할 사용자 초안');
  const reread=personal.page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${prefix}/vault/notes/${note.id}`&&r.request().method()==='GET');
  await personal.page.locator('.graph-layout .knowledge-graph-stage__nodes button').first().click();await reread;
  await personal.page.getByLabel('본문 마크다운').fill(originalText);
  const saved=personal.page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${prefix}/vault/notes/${note.id}`&&r.request().method()==='PATCH');
  await personal.page.getByRole('button',{name:'변경 저장',exact:true}).click();const savedResponse=await saved;assert.equal(savedResponse.status(),200);assert.equal(String(savedResponse.request().postDataJSON().version),String(updatedNote.version));
  // textarea normalizes CRLF; restore the original bytes explicitly for the subsequent Wiki non-mutation assertion.
  const savedNote=await savedResponse.json();await f.api.request(f.a,`${prefix}/vault/notes/${note.id}`,'PATCH',{version:savedNote.version,content:originalText});
  result.checks.push('actual screen WebGL context loss retains semantic selection/editor/save; original version409 preserves draft; next save uses server version');
  if(mode==='pg') {
    const second=await f.api.request(f.a,'/pg/companies','POST',{name:'Task28 personal scope independence',modules:['documents','agent','projects'],features:[],departments:[]},201);
    const switched=personal.page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/pg/vault/graph'&&r.request().headers()['x-org-id']===second.org_id);
    await personal.page.evaluate(async orgId=>{const {sessionStore}=await import('/src/store/session.ts');sessionStore.patch({orgId});},second.org_id);const scoped=await(await switched).json();
    assert.equal(scoped.nodes.find(n=>n.id===note.id).identity.owner,f.a.userId);assert.equal(scoped.nodes.find(n=>n.id===note.id).identity.company,null);
    const fixed=await f.api.request({...f.a,orgId:second.org_id},`/pg/vault/wiki/sources/${personalSource.id}/revisions/${personalSource.current_revision_id}`);assert.equal(fixed.source_identity.owner,f.a.userId);assert.equal(fixed.source_identity.company,null);
    result.checks.push('PG personal owner and registered revision independent of selected company through real session switch');
  }
  await capture(personal.page,'personal');await personal.context.close();
  result.checks.push('actual company raw upload with Wiki0; personal original note registration; both common stages; 375/768/1280');
  completePersonal=await personalWikiScenario({f,mode,open,arm,done,after,capture});

  const research=await open(reader),page=research.page;
  assert.equal(await page.getByLabel('위키 원본 파일 올리기',{exact:true}).count(),0);
  provider.gate.hold=Promise.withResolvers();const dispatched=provider.dispatched();
  const jobResponse=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${f.root}/jobs`&&r.request().method()==='POST');
  await page.getByLabel('위키 조사 질문').fill('한글');await page.getByRole('button',{name:'원본 기반 조사',exact:true}).click();
  const job=await(await jobResponse).json();await dispatched;
  await after(page,`[data-job-id="${job.id}"][data-job-state="succeeded"]`,async()=>{provider.gate.hold.resolve();provider.gate.hold=null;});
  const serverJob=await f.api.request(reader,`${f.root}/jobs/${job.id}`);
  assert.equal(serverJob.result.review_state,'unreviewed');assert.equal(serverJob.result.citations[0].revision_id,raw.current_revision_id);
  assert.equal(await page.getByRole('button',{name:'이 결과를 검토 초안으로 보관'}).count(),0);
  await page.locator(`[data-job-id="${job.id}"] .wiki-citations button`).first().click();
  await arm(page,`.wiki-revision[data-revision-id="${raw.current_revision_id}"] mark`);await done(page);
  assert.equal(await page.locator('.wiki-revision mark').textContent(),originalText);
  assert.equal(await page.locator('.wiki-revision').getAttribute('data-revision-id'),raw.current_revision_id);
  await capture(page,'reader-citation');
  await page.reload({waitUntil:'domcontentloaded'});await page.getByText('저장한 작업·초안 다시 열기',{exact:true}).click();await page.getByLabel('저장한 작업 ID',{exact:true}).fill(job.id);await page.getByRole('button',{name:'인가된 작업 다시 열기'}).click();await arm(page,`[data-job-id="${job.id}"][data-job-state="succeeded"]`);await done(page);
  result.checks.push('reader can reopen their durable private job by ID after reload without document.write or private browser storage');
  await assign('writer');
  await page.evaluate(()=>window.dispatchEvent(new Event('orbitflow:access-changed')));
  await arm(page,'[data-job-state="succeeded"]');await done(page);
  await page.getByRole('button',{name:'이 결과를 검토 초안으로 보관'}).click();
  await arm(page,'[data-review-id]');await done(page);
  const changeId=await page.locator('[data-review-id]').getAttribute('data-review-id');
  const inspected=await f.api.request(reader,`${f.root}/change-sets/${changeId}`);
  assert.equal(await page.locator('[data-review-digest]').textContent(),inspected.manifest_hash);
  await page.reload({waitUntil:'domcontentloaded'});await page.getByText('저장한 작업·초안 다시 열기',{exact:true}).click();await page.getByLabel('저장한 초안 ID',{exact:true}).fill(changeId);await page.getByRole('button',{name:'인가된 초안 다시 열기'}).click();await arm(page,`[data-review-id="${changeId}"]`);await done(page);assert.equal(await page.locator('[data-review-digest]').textContent(),inspected.manifest_hash);
  result.checks.push('durable immutable draft reopens by authorized ID after reload with the identical review digest');
  assert.equal(await page.getByRole('button',{name:'명시적으로 게시'}).isDisabled(),true);
  assert.equal((await f.api.request(reader,f.root+'/pages')).items.length,0);
  const publicationResponse=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${f.root}/change-sets/${changeId}/publish`);
  await page.getByLabel('이 정확한 변경 묶음 게시 확인').check();await page.getByRole('button',{name:'명시적으로 게시'}).click();
  const publishedResponse=await publicationResponse;assert.equal(publishedResponse.status(),200);const receipt=await publishedResponse.json();
  assert.deepEqual(publishedResponse.request().postDataJSON(),{manifest_hash:inspected.manifest_hash,confirmed:true});
  assert.equal(receipt.manifest_hash,inspected.manifest_hash);
  const published=receipt.result_json.pages[0];
  await arm(page,'[data-wiki-workspace] .knowledge-graph-stage__nodes button');await done(page);
  assert.equal((await f.api.request(f.a,prefix+`/vault/notes/${note.id}`)).content,originalText);
  assert.equal((await f.api.request(f.a,prefix+`/documents/${document.id}`)).content,originalText);
  result.checks.push('reader-only raw research; exact UTF8 revision citation; upgrade same actor to writer; exact query draft/digest review; explicit publication; originals unchanged');
  await page.reload({waitUntil:'domcontentloaded'});
  const pageButton=page.getByRole('button',{name:/한글 · page · 게시됨/});await pageButton.click();
  await arm(page,`[data-revision-id="${published.revision_id}"]`);await done(page);
  await page.getByRole('button',{name:'게시 이력 보기',exact:true}).click();
  await page.getByRole('button',{name:'위키 수동 편집',exact:true}).click();
  await page.getByLabel('위키 편집 본문').fill('Task28 사용자가 수정한 누적 위키');
  await page.getByRole('button',{name:'수동 변경을 검토 초안으로 저장'}).click();
  await arm(page,'[data-review-id]');await done(page);
  const manualId=await page.locator('[data-review-id]').getAttribute('data-review-id');
  assert.notEqual(manualId,changeId);
  await page.getByLabel('이 정확한 변경 묶음 게시 확인').check();
  const manualPublication=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${f.root}/change-sets/${manualId}/publish`);
  await page.getByRole('button',{name:'명시적으로 게시'}).click();assert.equal((await manualPublication).status(),200);
  await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('button',{name:/한글 · page · 게시됨/}).click();
  await arm(page,'.wiki-revision');await done(page);assert.ok((await page.locator('.wiki-revision').innerText()).includes('Task28 사용자가 수정한 누적 위키'));
  await capture(page,'published');result.checks.push('reload published graph; published history; manual edit produces review draft; explicit republish and reload');
  await page.getByRole('button',{name:'위키 수동 편집',exact:true}).click();await page.getByLabel('위키 편집 본문').fill('TASK28-STALE-DRAFT');await page.getByRole('button',{name:'수동 변경을 검토 초안으로 저장'}).click();await arm(page,'[data-review-id]');await done(page);
  const staleId=await page.locator('[data-review-id]').getAttribute('data-review-id');const currentPage=await f.api.request(reader,`${f.root}/pages/${published.id}`);
  const competitor=await f.api.request(reader,`${f.root}/pages/${published.id}/change-sets`,'POST',{expected_version:currentPage.version,title:currentPage.title,markdown:currentPage.markdown},201);
  const competitorReview=await f.api.request(reader,`${f.root}/change-sets/${competitor.id}`);
  const competing=await fetch(f.api.baseUrl+`${f.root}/change-sets/${competitor.id}/publish`,{method:'POST',headers:{Authorization:`Bearer ${reader.token}`,'X-Org-Id':reader.orgId,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({manifest_hash:competitorReview.manifest_hash,confirmed:true}),signal:AbortSignal.timeout(10000)});assert.equal(competing.status,200);
  await page.getByLabel('이 정확한 변경 묶음 게시 확인').check();const stalePublish=page.waitForResponse(r=>r.url().endsWith(`/change-sets/${staleId}/publish`));await page.getByRole('button',{name:'명시적으로 게시'}).click();assert.equal((await stalePublish).status(),409);
  assert.ok((await page.locator('[data-review-id]').innerText()).includes('TASK28-STALE-DRAFT'));
  const rejected=page.waitForResponse(r=>r.url().endsWith(`/change-sets/${staleId}/reject`));await page.getByRole('button',{name:'이 묶음 거절'}).click();assert.equal((await rejected).status(),200);
  assert.equal((await f.api.request(reader,`${f.root}/change-sets/${staleId}`)).state,'rejected');
  result.checks.push('concurrent page head publication rejects stale reviewed draft409 without overwriting head; exact digest rejection remains usable');

  // 새 작업은 모델 설정 부재를 실제 서버 상태로 표시한다. Echo/가짜 답변이 아니다.
  delete process.env.WIKI_LOCAL_MODEL_CONFIG;
  await page.getByLabel('위키 조사 질문').fill('한글');
  const missingResponse=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${f.root}/jobs`&&r.request().method()==='POST');
  await page.getByRole('button',{name:'원본 기반 조사',exact:true}).click();const missing=await(await missingResponse).json();
  await arm(page,`[data-job-id="${missing.id}"][data-job-state="unavailable"]`);await done(page);
  assert.equal((await f.api.request(reader,`${f.root}/jobs/${missing.id}`)).failure_code,'MODEL_UNAVAILABLE');
  assert.equal(await page.locator(`[data-job-id="${missing.id}"] .md-body`).count(),0);
  await page.getByLabel('위키 조사 질문').fill('NO_MATCH_TASK28');
  const noEvidenceResponse=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${f.root}/jobs`&&r.request().method()==='POST');
  await page.getByRole('button',{name:'원본 기반 조사',exact:true}).click();const noEvidence=await(await noEvidenceResponse).json();
  await arm(page,`[data-job-id="${noEvidence.id}"][data-job-state="succeeded"]`);await done(page);
  assert.equal((await f.api.request(reader,`${f.root}/jobs/${noEvidence.id}`)).result.answer_md,null);
  result.checks.push('missing model durable unavailable no fake answer; no-evidence abstention distinct');
  await capture(page,'no-model');
  process.env.WIKI_LOCAL_MODEL_CONFIG=JSON.stringify(provider.config);
  const privateSources=[];
  for(const name of ['PRIVATE_INPUT_A','PRIVATE_INPUT_B']) privateSources.push(await f.api.request(f.a,f.root+'/sources','POST',{kind:'upload',filename:name+'.md',mime:'text/markdown',content_base64:Buffer.from('한글 '+name+' synthetic only').toString('base64')},201));
  await page.getByRole('button',{name:'다시 연결·새로고침'}).click();
  await arm(page,'[data-source-count="3"][data-loading="false"]');await done(page);
  for(const name of ['PRIVATE_INPUT_A','PRIVATE_INPUT_B'])await page.getByLabel('조사 원본 '+name+'.md',{exact:true}).check();
  await page.getByLabel('위키 조사 질문').fill('한글 TASK28_PRIVATE_TITLE');
  const privateResponse=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${f.root}/jobs`&&r.request().method()==='POST');
  await page.getByRole('button',{name:'원본 기반 조사',exact:true}).click();const privateJob=await(await privateResponse).json();
  await arm(page,`[data-job-id="${privateJob.id}"][data-job-state="succeeded"]`);await done(page);
  const privateResult=await f.api.request(reader,`${f.root}/jobs/${privateJob.id}`);
  assert.equal(privateResult.result.retrieval_coverage.selected_revision_ids.filter(id=>privateSources.some(s=>s.current_revision_id===id)).length,2);
  const uncited=privateSources.find(s=>!privateResult.result.citations.some(c=>c.revision_id===s.current_revision_id));assert.ok(uncited);
  await page.locator(`[data-job-id="${privateJob.id}"]`).getByRole('button',{name:'이 결과를 검토 초안으로 보관'}).click();await arm(page,'[data-review-id]');await done(page);
  await page.getByLabel('이 정확한 변경 묶음 게시 확인').check();
  const privatePublished=page.waitForResponse(r=>r.url().endsWith('/publish')&&r.request().method()==='POST');await page.getByRole('button',{name:'명시적으로 게시'}).click();assert.equal((await privatePublished).status(),200);
  const held=Promise.withResolvers(),release=Promise.withResolvers(),finished=Promise.withResolvers();
  await research.context.route(`**/wiki/jobs/${privateJob.id}`,async route=>{
    try { const response=await route.fetch();held.resolve();await bounded(release.promise,'stale response release');await route.fulfill({response});finished.resolve(); }
    catch(error){finished.reject(error);}
  },{times:1});
  await page.getByRole('button',{name:'다시 연결·새로고침'}).click();await bounded(held.promise,'stale response held');
  await arm(page,'[data-wiki-workspace]:not([data-access-epoch="0"])');
  await f.api.request(f.a,`${f.root}/sources/${uncited.id}`,'DELETE',{expected_version:uncited.version});
  await done(page);release.resolve();await bounded(finished.promise,'stale response finished');
  // 명시 새 인가 조회 후 private job/draft/page/graph/body가 모두 사라져야 한다.
  await page.getByRole('button',{name:'다시 연결·새로고침'}).click();await arm(page,'[data-wiki-workspace][data-loading="false"]');await done(page);
  assert.equal(await page.locator(`[data-job-id="${privateJob.id}"]`).count(),0);assert.ok(!(await page.locator('[data-wiki-workspace]').innerText()).includes('TASK28_PRIVATE_TITLE'));
  assert.equal((await f.api.request(reader,f.root+'/pages')).items.some(p=>p.title.includes('TASK28_PRIVATE_TITLE')),false);
  await capture(page,'revoked-uncited');result.checks.push('uncited dependency withdrawal removes private result/draft/published title/body/graph; delayed old HTTP result cannot repopulate');

  await admin.page.reload({waitUntil:'domcontentloaded'});await arm(admin.page,'[data-wiki-workspace][data-loading="false"]');await done(admin.page);
  await admin.page.getByLabel('조사 원본 Task28 합성 원본.md',{exact:true}).check();
  const compiledResponse=admin.page.waitForResponse(r=>r.url().endsWith('/wiki/jobs')&&r.request().method()==='POST');await admin.page.getByRole('button',{name:'선택 원본 위키 초안 생성'}).click();const compiled=await(await compiledResponse).json();
  await arm(admin.page,`[data-job-id="${compiled.id}"][data-job-state="succeeded"]`);await done(admin.page);await admin.page.getByRole('button',{name:'생성 초안 검토'}).click();await arm(admin.page,'[data-review-id]');await done(admin.page);
  const compiledId=await admin.page.locator('[data-review-id]').getAttribute('data-review-id');await admin.page.getByLabel('이 정확한 변경 묶음 게시 확인').check();const compiledPublish=admin.page.waitForResponse(r=>r.url().endsWith(`/change-sets/${compiledId}/publish`));await admin.page.getByRole('button',{name:'명시적으로 게시'}).click();assert.equal((await compiledPublish).status(),200);
  const publishedGraph=await f.api.request(f.a,f.root+'/graph');assert.ok(['source','page','entity','concept'].every(kind=>publishedGraph.nodes.some(n=>n.kind===kind)));
  const derived=publishedGraph.edges.filter(edge=>edge.type==='ai_derived');assert.equal(derived.length,4);assert.ok(derived.some(edge=>edge.direction==='undirected'));assert.equal(derived.filter(edge=>edge.predicate==='supports'||edge.predicate==='contradicts').length,2);
  await admin.page.getByRole('button',{name:/Task28 entity · entity · 게시됨/}).click();await arm(admin.page,'.wiki-revision');await done(admin.page);
  await admin.page.getByRole('button',{name:'위키 수동 편집',exact:true}).click();await admin.page.getByLabel('위키 편집 본문').fill('Task28 editable entity');const entityDraft=admin.page.waitForResponse(r=>r.url().endsWith('/change-sets')&&r.request().method()==='POST');await admin.page.getByRole('button',{name:'수동 변경을 검토 초안으로 저장'}).click();const entityId=(await(await entityDraft).json()).id;await arm(admin.page,`[data-review-id="${entityId}"]`);await done(admin.page);
  assert.equal((await f.api.request(f.a,`${f.root}/change-sets/${entityId}`)).proposed_revisions[0].kind,'entity');
  await capture(admin.page,'typed-directed-parallel');result.checks.push('actual HTTP compiler creates source/page/entity/concept graph; AI-derived directed/undirected parallel relations retained; entity is editable Wiki page');
  await worker.stop();worker=null;
  restarted=fork(path.join(root,'frontend/scripts/task28-restart-api.mjs'),[],{env:{...process.env},stdio:['ignore','pipe','pipe','ipc']});
  restarted.stderr.on('data',chunk=>console.error(chunk.toString()));
  const ready=await ipc(restarted,'ready');assert.notEqual(ready.pid,process.pid);assert.ok(!protectedPorts.has(ready.port));proxyOptions.target=`http://127.0.0.1:${ready.port}`;
  const opened=ipc(restarted,'stream-open');await page.reload({waitUntil:'domcontentloaded'});const firstStream=await opened;assert.equal(firstStream.hasBearer,true);
  await page.getByRole('button',{name:/한글 · page · 게시됨/}).click();await arm(page,'.wiki-revision');await done(page);
  assert.ok((await page.locator('.wiki-revision').innerText()).includes('Task28 사용자가 수정한 누적 위키'));
  await arm(page,'[data-wiki-workspace][data-loading="false"]');await done(page);
  const reconnected=ipc(restarted,'stream-open');restarted.send({type:'close-streams'});const nextStream=await reconnected;
  assert.ok(Number(nextStream.cursor)>0);assert.equal(nextStream.hasBearer,true);assert.ok(!nextStream.url.includes('token'));
  result.checks.push('fresh backend OS process reads published revisions from persistent DB; authenticated SSE reconnect after normal EOF carries last authorized sequence');
  await capture(page,'restart-reconnect');
  const otherGraph=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${prefix}/documents/graph`&&r.request().headers()['x-org-id']===f.b.orgId);
  await page.evaluate(async actor=>{const {sessionStore}=await import('/src/store/session.ts');sessionStore.patch({token:actor.token,orgId:actor.orgId});},{token:f.b.token,orgId:f.b.orgId});await otherGraph;
  await arm(page,'[data-wiki-workspace][data-loading="false"][data-source-count="0"][data-page-count="0"]');await done(page);
  assert.ok(!(await page.locator('main').innerText()).includes('Task28 editable entity'));assert.equal(await page.locator('[data-review-id],[data-job-id],.wiki-revision').count(),0);
  result.checks.push('real user/company switch clears source/title/job/review/selection/graph state and loads only new authorized scope');
  await research.context.close();await admin.context.close();
  result.personal=await completePersonal.finish({restarted,ipc});
  result.checks.push(...result.personal.checks);
  assert.deepEqual(result.pageErrors,[]);assert.equal(networkAudit.blocked.length,0);
  result.model={kind:'structured synthetic local HTTP boundary, not real Gemma',calls:provider.calls.length};result.status='passed';
} catch(error) {result.status='failed';result.error={message:error.message,stack:error.stack};process.exitCode=1;console.error(error);}
finally {
  delete process.env.WIKI_LOCAL_MODEL_CONFIG;await worker?.stop();result.cleanup.worker=true;
  await completePersonal?.close(result.status==='failed'?new Error(result.error.message):undefined);
  await browser?.close();result.cleanup.chrome=true;await vite?.close();result.cleanup.vite=true;await provider?.close();result.cleanup.model=true;
  if(restarted?.connected){const closed=ipc(restarted,'closed'),exit=once(restarted,'exit',{signal:AbortSignal.timeout(20000)});restarted.send({type:'close'});await closed;await exit;}result.cleanup.restartedApi=true;
  if(f){result.http.push(...f.api.http);await f.close({task28:true});}result.cleanup.api=true;
  for(const file of ['frontend/src/screens/VaultGraphScreen.tsx','frontend/src/screens/KnowledgeGraphScreen.tsx','frontend/src/screens/knowledge/WikiWorkspace.tsx','frontend/src/screens/knowledge/wikiModel.ts','frontend/src/components/data/knowledgeGraphStageModel.ts'])result.hashes[file]=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
  await writeFile(path.join(evidence,`${mode}-workflow.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify({mode,status:result.status,checks:result.checks,error:result.error,cleanup:result.cleanup}));
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await task28Workflow({mode:process.argv[2]==='pg'?'pg':'legacy'});
}
