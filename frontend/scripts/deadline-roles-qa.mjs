import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { startDeadlineServer, createDeadlineFixture, evidenceBody } from '../../backend/tests/deadline-fixture.js';
import { protectedPorts, networkAudit } from '../../scripts/deadline-isolation-guard.mjs';

export async function rolesScenario() {
  const root = fileURLToPath(new URL('../../',import.meta.url));
  const evidence = path.join(root,'.omo/evidence/task-2-deadline-erp-redesign');
  await mkdir(evidence,{recursive:true}); await rm(path.join(evidence,'screen.png'),{force:true});
  const result = { scenario:'roles',status:'running',head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),http:[],resources:[],liveServicesUsed:false,blocked:[],errors:[] };
  await writeFile(path.join(evidence,'scenario.json'),JSON.stringify(result,null,2));
  await writeFile(path.join(evidence,'cleanup.json'),JSON.stringify({status:'pending'}));
  let api,vite,browserServer,browser,context;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('DEADLINE_CANCELLED'));
  const message = value => { if(value?.type==='deadline:cancel') cancel(); };
  process.on('SIGINT',cancel);process.on('SIGTERM',cancel);process.on('message',message);
  try {
    api=await startDeadlineServer(controller.signal);result.resources.push(api.resource);
    const fixture=await createDeadlineFixture(api);
    vite=await createServer({configFile:false,root:path.join(root,'frontend'),envDir:process.env.DEADLINE_TEMP_ROOT,plugins:[react()],
      server:{host:'127.0.0.1',port:0,proxy:{'/api':new URL(api.baseUrl).origin},watch:{ignored:['**/.omo/**','**/dist/**']}}});
    await vite.listen();
    const port=vite.httpServer.address().port;assert.ok(!protectedPorts.has(port));
    result.resources.push({kind:'vite',port,pid:process.pid,closed:false});
    const origin=`http://127.0.0.1:${port}`;
    browserServer=await chromium.launchServer({channel:'chrome',headless:true,timeout:20000,args:['--disable-background-networking','--disable-sync','--disable-component-update']});
    const child=browserServer.process(),profile=child.spawnargs.find(arg=>arg.startsWith('--user-data-dir='))?.slice(16);
    result.resources.push({kind:'chrome',pid:child.pid,port:Number(new URL(browserServer.wsEndpoint()).port),profile,closed:false});
    browser=await chromium.connect(browserServer.wsEndpoint());result.chrome=browser.version();
    context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block',reducedMotion:'reduce'});
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin===origin && !protectedPorts.has(Number(url.port))) return route.continue();
      result.blocked.push(url.href);return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*',socket=>{
      const url=new URL(socket.url());if(url.host===new URL(origin).host) socket.connectToServer();else socket.close();
    });
    await context.addInitScript(session=>localStorage.setItem('orbitflow.session.v1',JSON.stringify(session)),fixture.actorAdmin.session);
    const page=await context.newPage();page.on('pageerror',error=>result.errors.push(error.message));
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/settings/roles',{timeout:15000});
    await page.goto(origin+'/settings/roles',{waitUntil:'domcontentloaded',timeout:20000});
    assert.equal((await response).status(),200);
    // 실제 목록이 DOM에 들어오는 정확한 변경 신호. polling/sleep 없음.
    const rendered = () => page.evaluate(()=>new Promise((resolve,reject)=>{
      const observer=new MutationObserver(check);
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error('role DOM deadline'));},15000);
      function check(){if(document.querySelector('main input') && !document.querySelector('main .spinner')){clearTimeout(timer);observer.disconnect();resolve();}}
      observer.observe(document.documentElement,{childList:true,subtree:true});check();
    }));
    await rendered();
    // 브라우저의 실제 인증 HTTP 표면에서 CAS와 회사 전환을 검증한다. UI 수정은 task8 소유다.
    async function request(route,method,body,status,orgId=fixture.A.id) {
      const record=await page.evaluate(async ({route,method,body,orgId})=>{
        const session=JSON.parse(localStorage.getItem('orbitflow.session.v1'));
        const response=await fetch('/api/v1'+route,{method,headers:{Authorization:`Bearer ${session.token}`,'X-Org-Id':orgId,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
        const text=await response.text();return {route,method,orgId,status:response.status,body:text?JSON.parse(text):null};
      },{route,method,body,orgId});result.http.push(evidenceBody(record));assert.equal(record.status,status,JSON.stringify(record));return record.body;
    }
    const role=await request('/settings/roles','POST',{name:'브라우저 CAS 검증',scope:'all',permissions:['task.read']},201);
    const patch={name:role.name,scope:role.scope,permissions:[]};
    await request(`/settings/roles/${role.key}`,'PATCH',patch,400);
    const saved=await request(`/settings/roles/${role.key}`,'PATCH',{...patch,expected_version:role.version},200);
    assert.equal(saved.version,role.version+1);
    await request(`/settings/roles/${role.key}`,'PATCH',{...patch,expected_version:role.version},409);
    await request('/settings/roles','GET',undefined,403,fixture.B.id);
    const current=await request('/settings/roles','GET',undefined,200);
    assert.equal(current.items.find(row=>row.key===role.key).version,saved.version);
    const refreshed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/settings/roles',{timeout:15000});
    await page.reload({waitUntil:'domcontentloaded'});await refreshed;await rendered();
    await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({path:path.join(evidence,'screen.png'),fullPage:true,animations:'disabled'});
    result.fixture={companyA:fixture.A.id,companyB:fixture.B.id,role:role.key};
    result.limitations=['Task8 UI writes do not yet send CAS tokens; no UI behavior claimed.','Native concurrency recorded separately in native.json.'];
    assert.deepEqual(result.errors,[]);result.status='passed';
  } catch(error) {result.status=controller.signal.aborted?'cancelled':'failed';result.errors.push(error.stack);process.exitCode=controller.signal.aborted?130:1;console.error(error);}
  finally {
    const errors=[];
    async function close(kind,fn){try{await fn();const resource=result.resources.find(row=>row.kind===kind);if(resource)resource.closed=true;}catch(error){errors.push({kind,message:error.message});}}
    await close('context',async()=>{await context?.unrouteAll({behavior:'wait'});await context?.close();});
    await close('browser',()=>browser?.close());await close('chrome',()=>browserServer?.close());
    const chrome=result.resources.find(row=>row.kind==='chrome');if(chrome?.profile)chrome.profileRemoved=!existsSync(chrome.profile);
    await close('vite',()=>vite?.close());await close('api',()=>api?.close());
    process.off('SIGINT',cancel);process.off('SIGTERM',cancel);process.off('message',message);
    result.http=[...(api?.http??[]),...result.http];result.network=networkAudit;
    if(errors.length){result.status='failed';process.exitCode=1;}
    await writeFile(path.join(evidence,'scenario.json'),JSON.stringify(result,null,2));
    await writeFile(path.join(evidence,'cleanup.json'),JSON.stringify({status:errors.length?'failed':'complete',resources:result.resources,errors,browserExited:browserServer?browserServer.process().exitCode!==null:null,protectedPorts:[...protectedPorts]},null,2));
    console.log(JSON.stringify({scenario:'roles',status:result.status,evidence}));
  }
}
