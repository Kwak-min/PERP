import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {preview} from 'vite';
import {setupJobs} from '../../backend/tests/deadline-wiki-jobs-fixture.js';
import {captureGraphSurface,observeGraphRendering} from './graph-ui-capture.mjs';

assert.equal(process.env.DEADLINE_ISOLATED,'1');
const root=fileURLToPath(new URL('../../',import.meta.url));
const before=process.argv.includes('--before'),mode=process.argv.includes('pg')?'pg':'legacy';
const capture=before?(await import(new URL('../../.omo/evidence/capture-integrity/helper-before.mjs',import.meta.url))).captureGraphSurface:captureGraphSurface;
const evidence=path.join(root,'.omo/evidence/capture-integrity',before?'regression-before':'regression-after',process.env.DEADLINE_RUN_ID);
await mkdir(evidence,{recursive:true});
const report={mode,before,checks:[],errors:[]};
let f,web,browser;
try {
 f=await setupJobs(mode);
 if(mode==='pg')await f.native.pool.query(await readFile(new URL('../../db/perp_additions_v8.sql',import.meta.url),'utf8'));
 const project=mode==='pg'?await f.api.request(f.a,'/pg/projects','POST',{name:'Capture integrity project'},201):null;
 const doc=await f.api.request(f.a,f.prefix+'/documents','POST',{title:'Capture integrity source',...(project?{project_id:project.id,content_md:'Synthetic capture evidence'}:{content:'Synthetic capture evidence',visibility:'org'})},201);
 await f.api.request(f.a,f.root+'/sources','POST',{kind:'record',origin_kind:'document',origin_id:doc.id,version:doc.version},201);
 web=await preview({configFile:false,root:path.join(root,'frontend'),envDir:process.env.DEADLINE_TEMP_ROOT,preview:{host:'127.0.0.1',port:0,proxy:{'/api':{target:new URL(f.api.baseUrl).origin}}}});
 const origin=`http://127.0.0.1:${web.httpServer.address().port}`;
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking','--disable-sync']});
 const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce',serviceWorkers:'block'});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
 await context.addInitScript(session=>sessionStorage.setItem('orbitflow.session.v1',JSON.stringify(session)),{token:f.a.token,orgId:f.a.orgId,name:'Synthetic capture reviewer',email:'capture@example.invalid',mustChangePassword:false,organizations:[]});
 await observeGraphRendering(context);
 const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
 await page.addInitScript(()=>{
  window.__captureSurfaceReady=new Promise((resolve,reject)=>{
   const observer=new MutationObserver(check),timer=setTimeout(()=>{observer.disconnect();reject(new Error('capture surface mount deadline'));},20000);
   function check(){const stages=[...document.querySelectorAll('.knowledge-graph-stage')];if(stages.length===2&&stages.every(stage=>stage.dataset.engineState==='ready'&&stage.dataset.renderState==='idle')){clearTimeout(timer);observer.disconnect();resolve();}}
   observer.observe(document,{childList:true,subtree:true,attributes:true});check();
  });
 });
 await page.goto(origin+'/documents/graph',{waitUntil:'domcontentloaded'});await page.evaluate(()=>window.__captureSurfaceReady);
 // A real authenticated refresh is delivered after the helper's pre-capture read.
 // Geometry and responses are not replaced, frozen or synthesized in the browser.
 const screenshot=page.screenshot.bind(page);let inject=true;
 page.screenshot=async options=>{
  if(inject){
   inject=false;
   await page.evaluate(()=>{
    const previous=document.querySelector('.graph-layout canvas');
    window.__captureReplacement=new Promise((resolve,reject)=>{
     const observer=new MutationObserver(check),timer=setTimeout(()=>{observer.disconnect();reject(new Error('replacement canvas deadline'));},20000);
     function check(){const stage=document.querySelector('.graph-layout .knowledge-graph-stage'),canvas=stage?.querySelector('canvas');if(canvas&&canvas!==previous&&stage.dataset.engineState==='ready'&&stage.dataset.renderState==='idle'){clearTimeout(timer);observer.disconnect();resolve();}}
     observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true});check();
    });
   });
   const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${f.prefix}/documents/graph`&&r.request().method()==='GET',{timeout:20000});
   await page.getByRole('button',{name:'원본 새로고침',exact:true}).click();
   assert.equal((await response).status(),200);await page.evaluate(()=>window.__captureReplacement);
  }
  return screenshot(options);
 };
 let rejected;
 await assert.rejects(()=>capture(page,evidence,'raced'),error=>{if(error.code!=='GRAPH_CAPTURE_CHANGED'){report.unexpectedRejection={message:error.message,code:error.code,stack:error.stack};return false;}rejected=error.audit;return true;},'a ready-before/ready-after replacement must never publish an authoritative screenshot');
 assert.notEqual(rejected.before.graphs[0].canvasId,rejected.after.graphs[0].canvasId);
 assert.equal(rejected.before.graphs[0].state,'ready');assert.equal(rejected.after.graphs[0].state,'ready');
 assert.ok(rejected.traffic.some(request=>request.path.endsWith('/documents/graph')&&request.start>=rejected.started&&request.status===200));
 assert.equal(existsSync(path.join(evidence,'raced-1280.png')),false);
 report.checks.push('real GET/canvas replacement inside capture is rejected even after ready recovers; no authoritative PNG emitted');
 report.rejected={started:rejected.started,finished:rejected.finished,beforeCanvasIds:rejected.before.graphs.map(g=>g.canvasId),afterCanvasIds:rejected.after.graphs.map(g=>g.canvasId)};
 report.captures=await captureGraphSurface(page,evidence,'stable');
 for(const item of report.captures){assert.equal(item.captureAudit.changes,0);assert.deepEqual(item.captureAudit.beforeCanvasIds,item.captureAudit.afterCanvasIds);assert.ok(item.sha256);}
 report.checks.push('one subsequent event-complete capture set keeps identical canvases/states through the screenshot and binds each PNG hash');
 assert.deepEqual(report.errors,[]);console.log('GRAPH_CAPTURE_INTEGRITY_PASS');
} catch(error){report.error={message:error.message,stack:error.stack,audit:error.audit};process.exitCode=1;}
finally {
 await browser?.close();if(web)await new Promise((resolve,reject)=>{web.httpServer.close(error=>error?reject(error):resolve());web.httpServer.closeAllConnections();});if(f)await f.close({captureIntegrity:true});
 await writeFile(path.join(evidence,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({evidence,...report}));
}
