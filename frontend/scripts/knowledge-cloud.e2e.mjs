import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { exerciseKnowledgeCloud } from '../../backend/tests/knowledge-cloud-scenarios.js';
import { captureGraphSurface, observeGraphRendering } from './graph-ui-capture.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const mode=process.argv[2] ?? 'legacy';
assert.ok(['legacy','pg'].includes(mode));
// 동작 전에 정확한 DOM 변화에 구독한다. 네트워크 완료나 고정 지연을 UI 완료로 추측하지 않는다.
async function arm(page,selector) {
  await page.evaluate(selector=>{window.__knowledgeCloudSignal=new Promise((resolve,reject)=>{
    const observer=new MutationObserver(check),timer=setTimeout(()=>{observer.disconnect();reject(new Error('DOM deadline '+selector));},20000);
    function check(){if(document.querySelector(selector)){clearTimeout(timer);observer.disconnect();resolve();}}
    observer.observe(document.documentElement,{subtree:true,attributes:true,childList:true,characterData:true});check();
  });},selector);
}
const done=page=>page.evaluate(()=>window.__knowledgeCloudSignal);
await exerciseKnowledgeCloud(mode,{surface:async(f,wire)=>{
  let browser,web,worker;const errors=[];
  const evidence=path.join(root,'.omo/evidence/knowledge-cloud-browser');await mkdir(evidence,{recursive:true});
  try {
    if(mode==='pg')await f.native.pool.query(await readFile(new URL('../../db/perp_additions_v8.sql',import.meta.url),'utf8'));
    await f.api.request(f.a,f.prefix+'/agent/api-key','PUT',{api_key:'synthetic-browser-personal'});
    const {startWikiWorker}=await import('../../backend/src/services/knowledge-wiki-worker.service.js');
    worker=startWikiWorker({stores:[mode],onError:event=>errors.push(event.code)});await worker.wake();
    web=await preview({configFile:false,root:path.join(root,'frontend'),envDir:process.env.DEADLINE_TEMP_ROOT,
      preview:{host:'127.0.0.1',port:0,proxy:{'/api':{target:new URL(f.api.baseUrl).origin}}}});
    const origin=`http://127.0.0.1:${web.httpServer.address().port}`;
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking','--disable-sync']});
    const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block',reducedMotion:'reduce'});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
    await context.addInitScript(session=>{sessionStorage.setItem('orbitflow.session.v1',JSON.stringify(session));localStorage.setItem('orbitflow.demoMode','0');},
      {token:f.a.token,orgId:f.a.orgId,name:'Synthetic browser',email:'synthetic@example.invalid',mustChangePassword:false,organizations:[]});
    await observeGraphRendering(context);
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    const graphResponse=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${f.prefix}/documents/graph`,{timeout:20000});
    await page.goto(origin+'/documents/graph',{waitUntil:'domcontentloaded'});assert.equal((await graphResponse).status(),200);
    // 초기 마운트도 DOM 관찰자로 완료를 확인한다.
    await arm(page,'[data-wiki-workspace][data-loading="false"]');await done(page);
    const sourceResponse=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${f.root}/sources`&&r.request().method()==='POST',{timeout:20000});
    await page.getByLabel('위키 원본 파일 올리기',{exact:true}).setInputFiles({name:'Synthetic browser source.md',mimeType:'text/markdown',buffer:Buffer.from('SYNTHETIC_BROWSER_RESEARCH')});
    assert.equal((await sourceResponse).status(),201);
    await arm(page,'[data-job-state="succeeded"]');
    await page.getByLabel('위키 조사 질문').fill('SYNTHETIC_BROWSER_RESEARCH');
    await page.getByRole('button',{name:'원본 기반 조사',exact:true}).click();await done(page);
    const jobId=await page.locator('[data-job-state="succeeded"]').getAttribute('data-job-id');
    const job=await f.api.request(f.a,`${f.root}/jobs/${jobId}`);
    assert.equal(job.result.review_state,'unreviewed');assert.equal(job.result.citation_validation,'anchors_valid');
    assert.equal(job.result.provenance.accounting.provider,'openrouter');
    assert.equal((await f.api.request(f.a,f.root+'/pages')).items.length,0);
    await arm(page,'.wiki-revision mark');await page.locator(`[data-job-id="${jobId}"] .wiki-citations button`).first().click();await done(page);
    assert.equal(await page.locator('.wiki-revision mark').textContent(),'SYNTHETIC_BROWSER_RESEARCH');
    await arm(page,'[data-review-id]');await page.getByRole('button',{name:'이 결과를 검토 초안으로 보관',exact:true}).click();await done(page);
    assert.equal(await page.getByRole('button',{name:'명시적으로 게시',exact:true}).isDisabled(),true);
    assert.equal((await f.api.request(f.a,f.root+'/pages')).items.length,0);
    // 회사 문서의 실제 분석 버튼과 응답 Zod 경계까지 실행한다.
    if(mode==='pg')await page.getByLabel('저장할 프로젝트',{exact:true}).selectOption({label:'Synthetic cloud project'});
    const uploadResponse=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${f.prefix}/documents/upload`&&r.request().method()==='POST',{timeout:20000});
    await page.getByLabel('조직 문서 파일 올리기',{exact:true}).setInputFiles({name:'Browser embeddings.md',mimeType:'text/markdown',buffer:Buffer.from('SYNTHETIC_BROWSER_EMBEDDING')});
    const uploaded=await(await uploadResponse).json();
    assert.equal((await f.api.request(f.a,`${f.prefix}/documents/${uploaded.id}/analysis?wait=1`)).state,'ready');
    await arm(page,'[data-document-analysis]');
    await page.locator('.graph-layout .knowledge-graph-stage__nodes').getByRole('button',{name:/Browser embeddings/}).click();await done(page);
    // 기존 ready/unavailable이 아니라 이 POST와 후속 GET으로 생긴 새 canvas를 기다린다.
    async function reanalyze(expected) {
      await page.evaluate(expected=>{
        const previous=document.querySelector('.graph-layout canvas');
        window.__analysisResultPaint=new Promise((resolve,reject)=>{
          const observer=new MutationObserver(check),timer=setTimeout(()=>{observer.disconnect();reject(new Error('analysis generation deadline'));},20000);
          function check(){const stage=document.querySelector('.graph-layout .knowledge-graph-stage'),canvas=stage?.querySelector('canvas'),analysis=document.querySelector('[data-document-analysis]');
            if(canvas&&canvas!==previous&&stage.dataset.engineState==='ready'&&stage.dataset.renderState==='idle'&&analysis?.getAttribute('data-document-analysis')===expected&&!analysis.nextElementSibling.disabled){clearTimeout(timer);observer.disconnect();resolve();}}
          observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true});check();
        });
      },expected);
      const analyzed=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${f.prefix}/documents/${uploaded.id}/analysis`&&r.request().method()==='POST',{timeout:20000});
      const refreshed=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${f.prefix}/documents/graph`&&r.request().method()==='GET',{timeout:20000});
      await page.getByRole('button',{name:'유사도 다시 분석',exact:true}).click();
      assert.equal((await(await analyzed).json()).state,expected);
      assert.equal((await(await refreshed).json()).analysis.find(item=>item.id===uploaded.id).state,expected);
      await page.evaluate(()=>window.__analysisResultPaint);
    }
    await reanalyze('ready');
    delete process.env.ORBITFLOW_DOCUMENT_OPENROUTER_EMBEDDING_MODEL;
    await reanalyze('unavailable');
    assert.ok((await page.locator('[data-document-analysis]').textContent()).includes('ORBITFLOW_DOCUMENT_OPENROUTER_EMBEDDING_MODEL'));
    process.env.ORBITFLOW_DOCUMENT_OPENROUTER_EMBEDDING_MODEL='synthetic-embedding';
    await reanalyze('ready');
    assert.ok(wire.calls.some(c=>c.path==='/embeddings'&&c.authorization==='Bearer synthetic-browser-personal'&&JSON.stringify(c.body).includes('SYNTHETIC_BROWSER_EMBEDDING')));
    const captures=await captureGraphSurface(page,evidence,mode+'-graph-ready');
    await copyFile(path.join(evidence,captures[0].file),path.join(evidence,mode+'.png'));
    assert.deepEqual(errors,[]);
    const result={mode,browser:browser.version(),surface:'built SPA /documents/graph',wiki:'cloud query, exact citation, unreviewed draft, publish disabled without confirmation',documents:'cloud embeddings, actionable missing-model result, explicit retry',captures,errors};
    await writeFile(path.join(evidence,mode+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  } finally {await browser?.close();await worker?.stop();if(web)await new Promise((resolve,reject)=>{web.httpServer.close(error=>error?reject(error):resolve());web.httpServer.closeAllConnections();});}
}});
