import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as netServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from '@playwright/test';
import { setupJobs } from '../../backend/tests/deadline-wiki-jobs-fixture.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=path.join(root,'.omo/evidence/task-28-deadline-erp-redesign');
await mkdir(dir,{recursive:true});
assert.equal(process.env.DEADLINE_ISOLATED,'1');
const lms='C:/Users/A/.lmstudio/bin/lms.exe',model='perp-task28-smoke',result={status:'running',commands:[],checks:[],cleanup:{}};
let loaded=false,started=false,f,worker,vite,browser;
async function cli(args){
 const child=spawn(lms,args,{env:{...process.env,HOME:process.env.USERPROFILE},stdio:['ignore','pipe','pipe'],windowsHide:true});let out='',err='',code=null;
 console.log('OWNED_LMS',args.join(' '));
 child.stdout.on('data',c=>{out+=c;process.stdout.write(c);});child.stderr.on('data',c=>{err+=c;process.stderr.write(c);});
 try { [code]=await once(child,'exit',{signal:AbortSignal.timeout(180000)});assert.equal(code,0,err);return args[0]==='server'&&args[1]==='status'?out+err:out; }
 finally { if(child.exitCode===null){const exited=once(child,'exit',{signal:AbortSignal.timeout(10000)});child.kill();await exited;}result.commands.push({args,code,out,err}); }
}
async function wait(page,selector){await page.evaluate(selector=>new Promise((resolve,reject)=>{const observer=new MutationObserver(check),timer=setTimeout(()=>{observer.disconnect();reject(new Error('Gemma UI deadline '+selector));},180000);function check(){if(document.querySelector(selector)){clearTimeout(timer);observer.disconnect();resolve(true);}}observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true});check();}),selector);}
try{
 assert.deepEqual(JSON.parse(await cli(['ps','--json'])),[],'another model owner is active');
 assert.match(await cli(['server','status']),/not running/,'another server owner is active');
 result.inventory=JSON.parse(await cli(['ls','--llm','--json']));
 assert.ok(result.inventory.some(item=>item.modelKey==='google/gemma-4-e4b'));
 const socket=netServer();const ready=once(socket,'listening');socket.listen(0,'127.0.0.1');await ready;const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 await cli(['load','google/gemma-4-e4b','--identifier',model,'--context-length','32768','--parallel','1','--yes']);loaded=true;
 await cli(['server','start','--bind','127.0.0.1','--port',String(port)]);started=true;
 f=await setupJobs('legacy');
 process.env.WIKI_LOCAL_MODEL_CONFIG=JSON.stringify({base_url:`http://127.0.0.1:${port}`,model,context_tokens:32768,output_tokens:2048,timeout_ms:180000,temperature:0});
 const {startWikiWorker}=await import('../../backend/src/services/knowledge-wiki-worker.service.js');worker=startWikiWorker({stores:['legacy'],onError:e=>result.checks.push({workerError:e.code})});
 vite=await createServer({configFile:false,root:path.join(root,'frontend'),envDir:process.env.DEADLINE_TEMP_ROOT,cacheDir:path.join(process.env.DEADLINE_TEMP_ROOT,'vite-gemma28'),plugins:[react()],server:{host:'127.0.0.1',port:0,proxy:{'/api':new URL(f.api.baseUrl).origin}}});await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking','--disable-sync']});
 const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce',serviceWorkers:'block'});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await context.addInitScript(session=>sessionStorage.setItem('orbitflow.session.v1',JSON.stringify(session)),{token:f.a.token,orgId:f.a.orgId,name:'Gemma synthetic',email:'gemma@example.invalid',mustChangePassword:false,organizations:[]});
 const page=await context.newPage();await page.goto(origin+'/documents/graph',{waitUntil:'domcontentloaded'});await wait(page,'[data-wiki-workspace]');
 assert.equal((await f.api.request(f.a,f.root+'/pages')).items.length,0);
 const rawResponse=page.waitForResponse(r=>r.url().endsWith('/wiki/sources')&&r.request().method()==='POST');
 await page.getByLabel('위키 원본 파일 올리기',{exact:true}).setInputFiles({name:'TASK28_GEMMA.md',mimeType:'text/markdown',buffer:Buffer.from('TASK28_GEMMA 합성 자료. 오로라 프로젝트의 시연일은 2026-10-12입니다. 실제 회사 또는 개인정보가 아닙니다.')});
 const source=await(await rawResponse).json();await wait(page,'[data-source-count="1"][data-loading="false"]');
 const response=page.waitForResponse(r=>r.url().endsWith('/wiki/jobs')&&r.request().method()==='POST');
 await page.getByLabel('위키 조사 질문').fill('TASK28_GEMMA 오로라 프로젝트의 시연일은 언제인가요?');await page.getByRole('button',{name:'원본 기반 조사',exact:true}).click();
 const job=await(await response).json();await wait(page,`[data-job-id="${job.id}"]:not([data-job-state="queued"]):not([data-job-state="running"])`);
 const actual=await f.api.request(f.a,`${f.root}/jobs/${job.id}`);result.job=actual;assert.equal(actual.state,'succeeded');assert.equal(actual.result.review_state,'unreviewed');assert.equal(actual.result.citations[0].revision_id,source.current_revision_id);
 await page.locator(`[data-job-id="${job.id}"] .wiki-citations button`).first().click();await wait(page,`.wiki-revision[data-revision-id="${source.current_revision_id}"] mark`);
 await page.getByRole('button',{name:'이 결과를 검토 초안으로 보관'}).click();await wait(page,'[data-review-id]');
 const changeId=await page.locator('[data-review-id]').getAttribute('data-review-id');const change=await f.api.request(f.a,`${f.root}/change-sets/${changeId}`);
 await page.getByLabel('이 정확한 변경 묶음 게시 확인').check();const published=page.waitForResponse(r=>r.url().endsWith('/publish'));
 await page.getByRole('button',{name:'명시적으로 게시'}).click();const publication=await published;assert.equal(publication.status(),200);result.publication=await publication.json();assert.equal(result.publication.manifest_hash,change.manifest_hash);
 await page.reload({waitUntil:'domcontentloaded'});await wait(page,'[data-page-count="1"][data-loading="false"]');
 await page.screenshot({path:path.join(dir,'screens/gemma-new-ui-workflow.png'),fullPage:true,animations:'disabled'});
 result.checks.push('actual new UI raw upload with zero pages -> real synthetic Gemma research -> fixed citation -> exact draft -> explicit digest publication -> browser reload');result.status='passed';
}catch(error){result.status='failed';result.error={message:error.message,stack:error.stack};process.exitCode=1;console.error(error);}
finally{
 delete process.env.WIKI_LOCAL_MODEL_CONFIG;await worker?.stop();await browser?.close();await vite?.close();if(f)await f.close({task28Gemma:true});
 if(started)await cli(['server','stop']);if(loaded)await cli(['unload',model]);result.cleanup={worker:true,chrome:true,vite:true,api:true,ownedServerStopped:started,ownedModelUnloaded:loaded,loadedAfter:JSON.parse(await cli(['ps','--json']))};
 await writeFile(path.join(dir,'gemma-ui-workflow.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,checks:result.checks,error:result.error,cleanup:result.cleanup}));
}
