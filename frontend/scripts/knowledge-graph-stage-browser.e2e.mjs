import assert from 'node:assert/strict';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {protectedPorts, networkAudit} from '../../scripts/deadline-isolation-guard.mjs';
const root=process.cwd(), evidence=path.join(root,'.omo/evidence/task-27-suite-revision',process.argv.includes('--red')?'red':'green');
await mkdir(evidence, {recursive:true});
assert.equal(process.env.DEADLINE_ISOLATED,'1');
const result={runId:process.env.DEADLINE_RUN_ID,cases:[], findings:[], errors:[], requests:[], cleanup:{}};
// Collect independent assertions so a red run proves all three defects, not just the first.
function check(name, assertion) {
 try { assertion(); } catch (error) { result.findings.push({name,message:error.message,stack:error.stack}); }
}
const entry=`import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {KnowledgeGraphStage} from '/src/components/data/KnowledgeGraphStage.tsx';
import {knowledgeGraphSchema} from '/src/screens/knowledge/model.ts';
import {graphSchema} from '/src/screens/vault/graph3d.ts';
import '/src/styles.css';
const root=createRoot(document.getElementById('root'));
window.selections=[]; window.snapshots=[];window.flush=flushSync;
window.makeData=(count=1,scope='A',personal=false,reciprocal=false)=>{
 const nodes=Array.from({length:count},(_,i)=>{const kind=personal?'note':'document';const identity={store:'pg',company:personal?null:scope,owner:personal?scope:null,kind,opaque_id:String(i)};return {id:String(i),renderer_id:JSON.stringify(['pg',identity.company,identity.owner,kind,String(i)]),identity,kind,title:i===0?'<img src="https://untrusted.invalid/a" onerror="window.unsafe=true">':'Node '+i,image:'https://untrusted.invalid/a',source:{nested:{scope}}};});
 const edge=(a,b,kind,i)=>({source:nodes[a].id,target_id:nodes[b].id,source_renderer_id:nodes[a].renderer_id,target_renderer_id:nodes[b].renderer_id,target_title:nodes[b].title,kind,binding:kind==='ai_similarity'?'inference':'explicit',resolution:'resolved',score:0.7,provenance:{provider:'synthetic',model:'local',method:'test',source_version:'123',target_version:'456',analyzed_at:'2026-09-08',nested:{i}}});
 const base=personal?'manual':'link';
 const edges=count<2?[]:[edge(0,1,base,0),edge(1,0,base,1),...(reciprocal?[]:[edge(0,1,'ai_similarity',2),...Array.from({length:count-2},(_,i)=>edge(i+1,i+2,base,i+3))])];
 const parsed=(personal?graphSchema:knowledgeGraphSchema).parse({nodes,edges});
 const data={nodes:parsed.nodes.map(n=>({...n,kind:n.identity.kind})),edges:parsed.edges};
 const freeze=o=>{if(o && typeof o==='object'){Object.freeze(o);Object.values(o).forEach(freeze);}return o;};
 freeze(data);window.snapshots.push({data,json:JSON.stringify(data)});return data;
};
window.strictEffects={setups:0,cleanups:0};
function Probe(){React.useLayoutEffect(()=>{window.strictEffects.setups++;return ()=>{window.strictEffects.cleanups++;};},[]);return null;}
window.reviewRender=(data,scope='A',strict=false)=>flushSync(()=>root.render(data?React.createElement(strict?React.StrictMode:React.Fragment,null,React.createElement(Probe),React.createElement(KnowledgeGraphStage,{data,scopeKey:scope,ariaLabel:'Review graph',emptyMessage:'Empty graph',onNodeSelect:node=>window.selections.push(node)})):null));
window.allUnchanged=()=>window.snapshots.every(s=>JSON.stringify(s.data)===s.json);
window.reviewReady=true;window.dispatchEvent(new Event('review-ready'));
`;
const shim=`import Actual from 'review-actual-engine';
import {REVISION} from 'three';
window.threeRevision=REVISION;
await window.engineImportGate;
window.engineImportResolved=true;window.dispatchEvent(new Event('engine-import-resolved'));
export default function Instrumented(...args){try{const graph=new Actual(...args);window.captureGraph(graph);return graph;}catch(error){window.constructorError=error.stack;throw error;}}
`;
let vite,server,browser,context,page;
const cdpSessions=new Map(),ownedContexts=new Set();
async function closeOwned(p,proofComplete=false){
 const c=p.context(),record=result.contextLifetimes.find(x=>x.name===p.reviewCase);
 record.proofComplete=proofComplete;
 const cdp=cdpSessions.get(p);
 if(cdp){await cdp.detach();cdpSessions.delete(p);}
 await c.close();ownedContexts.delete(c);record.closed=p.isClosed();
}
async function captureFailure(p,error){
 result.failedCase=p.reviewCase;
 result.debug=await p.evaluate(()=>({case:window.reviewCase,state:document.querySelector('.knowledge-graph-stage')?.dataset,graphs:window.graphs.map(g=>({owner:g.owner,generation:g.generation,ticks:g.ticks,stopped:g.stopped,disposed:g.disposed})),constructorError:window.constructorError,runtime:window.runtimeSnapshot()}));
 result.error={message:error.message,stack:error.stack};
}
async function nativeListeners(p,label){
 let cdp=cdpSessions.get(p);
 if(!cdp){cdp=await p.context().newCDPSession(p);await cdp.send('Debugger.enable');cdpSessions.set(p,cdp);}
 const snapshot={label};
 for(const target of ['document','window']){
  const {result:object}=await cdp.send('Runtime.evaluate',{expression:target});
  const {listeners}=await cdp.send('DOMDebugger.getEventListeners',{objectId:object.objectId});
  snapshot[target]=listeners.map(l=>({type:l.type,capture:l.useCapture,passive:l.passive,once:l.once,scriptId:l.scriptId,lineNumber:l.lineNumber,columnNumber:l.columnNumber,handler:l.originalHandler?.description??l.handler?.description}));
  await cdp.send('Runtime.releaseObject',{objectId:object.objectId});
 }
 const playwrightScript=snapshot.window.find(x=>x.type==='__playwright_global_listeners_check__')?.scriptId;
 for(const listener of [...snapshot.document,...snapshot.window]){
  listener.automation=Boolean(playwrightScript&&listener.scriptId===playwrightScript);
  if(['keydown','keyup','pointerup','__playwright_global_listeners_check__'].includes(listener.type)){
   const {scriptSource}=await cdp.send('Debugger.getScriptSource',{scriptId:listener.scriptId});
   listener.sourceExcerpt=scriptSource.split('\n').slice(Math.max(0,listener.lineNumber-2),listener.lineNumber+8).join('\n');
  }
 }
 (result.cdpListeners??=[]).push(snapshot);return snapshot;
}
function assertNativeReleased(snapshot,baseline=result.cdpBaseline,active=0){
 // Playwright's hit-target interception is not an application listener. Preserve
 // its raw inventory, identifying it by the automation script's own sentinel.
 for(const target of ['document','window'])for(const type of ['keydown','keyup','pointermove','pointerup'])
  check('CDP '+snapshot.label+' '+target+' '+type,()=>assert.equal(
   snapshot[target].filter(x=>x.type===type&&!x.automation).length,
   baseline[target].filter(x=>x.type===type&&!x.automation).length+(target==='document'&&type==='keydown'?active:0)));
}
try{
 vite=await createServer({configFile:false,root:path.join(root,'frontend'),envDir:process.env.DEADLINE_TEMP_ROOT,resolve:{alias:{'review-actual-engine':path.join(root,'node_modules/3d-force-graph/dist/3d-force-graph.mjs').replaceAll('\\','/')}},optimizeDeps:{exclude:['3d-force-graph'],include:['review-actual-engine','three','react','react-dom/client','react-dom','zod']},plugins:[{name:'independent-observer',enforce:'pre',resolveId(id){if(id==='3d-force-graph')return '\0review-engine';if(id==='/review-entry.jsx')return '\0review-entry.jsx';},load(id){if(id==='\0review-engine')return shim;if(id==='\0review-entry.jsx')return entry;},configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url!=='/__review')return next();res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml(req.url,'<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/review-entry.jsx"></script></body></html>'));});}},react()],server:{host:'127.0.0.1',port:0,watch:{ignored:['**/.omo/**','**/dist/**']}}});
 await vite.listen();const port=vite.httpServer.address().port;assert.ok(!protectedPorts.has(port));const origin=`http://127.0.0.1:${port}`;
 server=await chromium.launchServer({channel:'chrome',headless:true,args:['--disable-background-networking','--disable-component-update','--disable-sync']});browser=await chromium.connect(server.wsEndpoint());result.chrome=browser.version();
 const openOwned=async(name)=>{
  const c=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});ownedContexts.add(c);
  await c.route('**/*',r=>{const url=r.request().url();result.requests.push(url);return new URL(url).origin===origin?r.continue():r.abort('blockedbyclient');});
  await c.addInitScript(instrument);await c.addInitScript(name=>{window.reviewCase=name;},name);
  const p=await c.newPage();p.reviewCase=name;p.setDefaultTimeout(15000);
  p.on('pageerror',e=>result.errors.push(name+': '+e.message));
  (result.contextLifetimes??=[]).push({name,proofComplete:false,closed:false});return p;
 };
 page=await openOwned('base-graphics');context=page.context();
 await page.goto(origin+'/__review',{waitUntil:'domcontentloaded'});
 await page.evaluate(()=>window.reviewReady?true:window.bounded(new Promise(r=>window.addEventListener('review-ready',r,{once:true}))));
 const baseline=await page.evaluate(()=>window.runtimeSnapshot().liveControlGlobalListeners.length);
 result.listenerBaseline=baseline;result.cdpBaseline=await nativeListeners(page,'baseline');
 const render=async(count,scope='A',personal=false,reciprocal=false,strict=false)=>{
  await page.evaluate(async({count,scope,personal,reciprocal,strict})=>{
   await window.renderStage(count,scope,personal,reciprocal,strict);
  },{count,scope,personal,reciprocal,strict});
 };
 const settled=()=>page.evaluate(()=>window.waitStopped());
 const release=async()=>{await page.evaluate(async()=>{const losses=window.waitLosses();await window.releaseStage();await losses;});assertNativeReleased(await nativeListeners(page,'released'));};
 const assertReleased=(snapshot,label)=>check(label,()=>{
  assert.equal(snapshot.liveControlGlobalListeners.length-baseline,0,'actual OrbitControls global listener delta');
  assert.equal(snapshot.pendingRaf,0);assert.equal(snapshot.observers,0);
  assert.equal(snapshot.contextsCreated,snapshot.contextsLostEvents);
  assert.ok(snapshot.contextStates.every(c=>c.lostEvent&&c.isContextLost));
  assert.equal(snapshot.contextsCreated,snapshot.renderersDisposed);
  assert.equal(snapshot.contextsCreated,snapshot.controlsDisposed);
 });
 await render(1);await settled();
 result.runtime={threeRevision:await page.evaluate(()=>window.threeRevision),enginePackage:JSON.parse(await readFile(path.join(root,'node_modules/3d-force-graph/package.json'),'utf8')).version};
 await page.getByRole('button',{name:'자동 회전 끄기'}).click();
 let pos=await page.evaluate(()=>window.current.graph.cameraPosition());await page.getByRole('button',{name:'왼쪽으로 회전'}).click();let pos2=await page.evaluate(()=>window.current.graph.cameraPosition());assert.notDeepEqual(pos,pos2);
 await page.getByRole('button',{name:'확대',exact:true}).click();let pos3=await page.evaluate(()=>window.current.graph.cameraPosition());assert.notDeepEqual(pos2,pos3);
 const canvas=page.locator('canvas');const box=await canvas.boundingBox();assert.ok(box);
 // Register exact OrbitControls change before native drag and wheel.
 await page.evaluate(()=>window.armControlChange());await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+90,box.y+box.height/2+30);await page.mouse.up();await page.evaluate(()=>window.controlSignal);let drag=await page.evaluate(()=>window.current.graph.cameraPosition());assert.notDeepEqual(pos3,drag);
 await page.evaluate(()=>window.armControlChange());await page.mouse.wheel(0,-100);await page.evaluate(()=>window.controlSignal);let wheel=await page.evaluate(()=>window.current.graph.cameraPosition());assert.notDeepEqual(drag,wheel);
 await page.getByRole('button',{name:'화면 맞춤'}).click();
 await page.evaluate(()=>{window.pickSignal=window.bounded(new Promise(r=>window.addEventListener('review-pick',r,{once:true})));});
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await page.evaluate(()=>window.pickSignal);
 assert.equal(await page.evaluate(()=>window.selections.at(-1)===window.snapshots[0].data.nodes[0]),true);
 assert.equal(await page.locator('.knowledge-graph-stage img').count(),0);assert.equal(await page.evaluate(()=>Boolean(window.unsafe)),false);
 result.cases.push({name:'real-native-controls-pick',buttons:true,orbitDrag:true,wheel:true,originalObjectSelected:true,safeText:true});
 await render(0);assert.equal(await canvas.count(),0);
 await render(1000);await settled();
 assert.equal(await page.locator('.knowledge-graph-stage__nodes button').count(),1000);
 const thousand=await page.evaluate(()=>({nodes:window.current.graph.graphData().nodes.length,links:window.current.graph.graphData().links.length,unchanged:window.allUnchanged(),linkDirections:window.current.graph.graphData().links.slice(0,3).map(l=>[l.source.render_id,l.target.render_id]),arrowLength:window.current.graph.linkDirectionalArrowLength()(window.current.graph.graphData().links[0]),colors:window.current.graph.graphData().links.slice(0,3).map(l=>window.current.graph.linkColor()(l)),nestedClone:window.current.graph.graphData().links[0].provenance!==window.snapshots.at(-1).data.edges[0].provenance}));
 assert.equal(thousand.nodes,1000);assert.equal(thousand.links,1001);assert.equal(thousand.unchanged,true);assert.equal(thousand.nestedClone,true);assert.notEqual(thousand.colors[0],thousand.colors[2]);result.cases.push({name:'1000-real-simulation',...thousand});
 const buttons=page.locator('.knowledge-graph-stage__nodes button');await buttons.first().focus();await page.keyboard.press('ArrowDown');assert.equal(await buttons.nth(1).evaluate(e=>e===document.activeElement),true);await page.keyboard.press('End');assert.equal(await buttons.nth(999).evaluate(e=>e===document.activeElement),true);await page.keyboard.press('Home');await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.selections.at(-1)===window.snapshots.at(-1).data.nodes[0]),true);result.cases.push({name:'semantic-keyboard',arrowDown:true,home:true,end:true,enter:true});
 await render(1);
 result.transitions=[];
 for(let i=0;i<10;i++){await release();const s=await page.evaluate(()=>window.runtimeSnapshot());result.transitions.push(s);assertReleased(s,`transition-${i}`);await render(1);}
 await release();result.lifecycle=await page.evaluate(()=>window.runtimeSnapshot());assert.equal(result.lifecycle.contextsCreated,13);assert.equal(result.lifecycle.contextsLostEvents,13);assert.equal(result.lifecycle.renderersDisposed,13);assert.equal(result.lifecycle.controlsDisposed,13);
 assertReleased(result.lifecycle,'ten-transition-final');
 // Actual scope generation invalidation and stale captured engine callbacks, not dataset repaint.
 await render(2,'owner-A',true);await settled();
 await page.evaluate(()=>{window.old=window.current;window.oldNode=window.old.graph.graphData().nodes[0];});
 await render(2,'owner-B',true);await settled();
 result.scope=await page.evaluate(()=>{const count=window.selections.length;window.flush(()=>{window.old.callbacks.onNodeClick(window.oldNode);window.old.callbacks.onNodeHover(window.oldNode);window.old.callbacks.onEngineStop();});return {state:document.querySelector('.knowledge-graph-stage').dataset.engineState,alerts:document.querySelectorAll('[role=alert]').length,oldDisposed:window.old.disposed,oldScope:window.oldNode.identity.owner,newScope:window.current.graph.graphData().nodes[0].identity.owner,staleSelections:window.selections.length-count,unchanged:window.allUnchanged(),hover:document.querySelector('.knowledge-graph-stage__hover')?.textContent??'',listenerDelta:window.runtimeSnapshot().liveControlGlobalListeners.length};});
 assert.equal(result.scope.oldDisposed,true);assert.equal(result.scope.staleSelections,0);assert.equal(result.scope.hover,'');assert.equal(result.scope.newScope,'owner-B');
 check('scope-listener-delta',()=>assert.equal(result.scope.listenerDelta-baseline,1));
 assert.equal(result.scope.state,'ready');assert.equal(result.scope.alerts,0);
 result.parallel=await page.evaluate(()=>window.curveSnapshot());
 check('parallel-and-reciprocal-geometry',()=>assertPaths(result.parallel,3));
 await page.getByRole('button',{name:'자동 회전 끄기'}).click();await render(2,'owner-B',true,true);await settled();
 result.reciprocal=await page.evaluate(()=>window.curveSnapshot());
 check('two-reciprocal-actual-geometry',()=>assertPaths(result.reciprocal,2));
 await release();
 await render(2,'strict-A',true,false,true);await settled();
 result.strict=await page.evaluate(()=>({effects:window.strictEffects,created:window.graphs.length,attached:window.current.graph.renderer().domElement.isConnected}));
 await render(2,'strict-B',true,false,true);await settled();
 await release();result.strict.cleanup=await page.evaluate(()=>window.runtimeSnapshot());
 assertReleased(result.strict.cleanup,'StrictMode-scope-and-unmount');
 await page.emulateMedia({reducedMotion:'reduce'});await render(2,'reduced',true);await page.evaluate(()=>window.stageSignal('ready','reduced','idle'));
 result.reduced=await page.evaluate(()=>({pendingRaf:window.runtimeSnapshot().pendingRaf,cooldownTicks:window.current.graph.cooldownTicks(),autoRotate:window.current.graph.controls().autoRotate}));assert.equal(result.reduced.pendingRaf,0);assert.equal(result.reduced.cooldownTicks,0);assert.equal(result.reduced.autoRotate,false);
 // Exercise actual loss event after successful initialization, separately from constructor failure.
 const loseContext=async(scope)=>{
  await page.evaluate(()=>{window.lostGraph=window.current;window.lostNode=window.current.graph.graphData().nodes[0];});
  const observation=await page.evaluate(async(scope)=>{
   const g=window.current.graph,c=g.renderer().domElement;
   const loss=window.bounded(new Promise(r=>c.addEventListener('webglcontextlost',r,{once:true})));
   // Subscribe before loss; convert a bounded missing-state failure into red-run evidence.
   const state=window.stageSignal('error',scope,'idle').then(()=>null,error=>error.message);
   g.renderer().getContext().getExtension('WEBGL_lose_context').loseContext();await loss;
   const missingState=await state;
   return {missingState,state:document.querySelector('.knowledge-graph-stage').dataset.engineState,alerts:document.querySelectorAll('[role=alert]').length,semanticNodes:document.querySelectorAll('.knowledge-graph-stage__nodes button').length};
  },scope);
  check(`runtime-context-loss-${scope}`,()=>{assert.equal(observation.state,'error');assert.equal(observation.alerts,1);assert.equal(observation.missingState,null);});
  const stale=await page.evaluate(()=>{
   const before=window.selections.length;
   window.flush(()=>{
    window.lostGraph.callbacks.onNodeClick(window.lostNode);window.lostGraph.callbacks.onNodeHover(window.lostNode);
    window.lostGraph.callbacks.onEngineTick();window.lostGraph.callbacks.onEngineStop();
   });
   return {selections:window.selections.length-before,disposed:window.lostGraph.disposed};
  });
  check(`runtime-loss-stale-callbacks-${scope}`,()=>{assert.equal(stale.selections,0);assert.equal(stale.disposed,true);});
  assertNativeReleased(await nativeListeners(page,'context-loss-'+scope));
  observation.stale=stale;observation.cleanup=await page.evaluate(()=>window.runtimeSnapshot());
  assertReleased(observation.cleanup,`runtime-loss-cleanup-${scope}`);
  await buttons.first().focus();await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>window.selections.at(-1)===window.snapshots.at(-1).data.nodes[0]),true);
  observation.afterSelection=await page.evaluate(()=>({state:document.querySelector('.knowledge-graph-stage').dataset.engineState,hover:document.querySelector('.knowledge-graph-stage__hover')?.textContent??''}));
  check(`runtime-loss-remains-error-${scope}`,()=>{assert.equal(observation.afterSelection.state,'error');assert.equal(observation.afterSelection.hover,'');});
  return observation;
 };
 result.contextLoss=await loseContext('reduced');
 await page.screenshot({path:path.join(evidence,'runtime-context-loss.png')});
 await buttons.first().focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.selections.at(-1)===window.snapshots.at(-1).data.nodes[0]),true);
 // Already lost context will not emit a second event during release.
 await page.evaluate(()=>window.reviewRender(null));
 await page.emulateMedia({reducedMotion:'no-preference'});await render(2,'active-loss',true);
 result.activeContextLoss=await loseContext('active-loss');
 await page.evaluate(()=>window.reviewRender(null));
 result.final=await page.evaluate(()=>window.runtimeSnapshot());
 assertReleased(result.final,'final');
 check('dispose-before-DOM-detachment',()=>assert.ok(result.final.disposalRoots.every(Boolean)));
 result.unchanged=await page.evaluate(()=>window.allUnchanged());assert.equal(result.unchanged,true);
 await page.screenshot({path:path.join(evidence,'browser-final.png')});
 assertNativeReleased(await nativeListeners(page,'base-final'));
 // Instrumentation intentionally retains graph/GL/resource/listener objects for
 // teardown evidence. Release that document and its CDP session only AFTER proof,
 // rather than keeping twenty retired graphics instances alive during later cases.
 assert.deepEqual(result.errors,[]);assert.deepEqual(result.findings,[]);
 await closeOwned(page,true);
 // An import blocked at module evaluation must not instantiate the retired StrictMode lifetime.
 result.delayed=[];
 for(const replaceScope of [false,true]) {
  const delayed=await openOwned('delayed-'+replaceScope);let proven=false;
  try {
   await delayed.addInitScript(()=>{window.engineImportGate=new Promise(resolve=>{window.releaseEngineImport=resolve;});});
   await delayed.goto(origin+'/__review',{waitUntil:'domcontentloaded'});
   await delayed.evaluate(()=>window.reviewReady?true:window.bounded(new Promise(r=>window.addEventListener('review-ready',r,{once:true}))));
   const observation=await delayed.evaluate(async(replaceScope)=>{
    const baseline=window.runtimeSnapshot().liveControlGlobalListeners.length;
    window.reviewRender(window.makeData(2,'pending-A',true),'pending-A',true);
    const replay={...window.strictEffects};
    const ready=replaceScope?window.stageSignal('ready','pending-B'):Promise.resolve();
    window.reviewRender(replaceScope?window.makeData(2,'pending-B',true):null,'pending-B',true);
    window.releaseEngineImport();await window.bounded(import('/@id/__x00__review-engine'));await ready;
    const created=window.graphs.length,owner=window.current?.graph.graphData().nodes[0]?.identity.owner;
    const losses=window.waitLosses();
    await window.releaseStage();await losses;
    return {replaceScope,baseline,replay,created,owner,cleanup:window.runtimeSnapshot(),unchanged:window.allUnchanged()};
   },replaceScope);
   assertNativeReleased(await nativeListeners(delayed,'delayed-'+replaceScope));
   result.delayed.push(observation);
   assert.equal(observation.created,replaceScope?1:0);assert.equal(observation.replay.setups,2);assert.equal(observation.replay.cleanups,1);
   if(replaceScope)assert.equal(observation.owner,'pending-B');
   assert.equal(observation.unchanged,true);
   assertReleased(observation.cleanup,`delayed-import-${replaceScope?'scope-replacement':'unmount'}`);
   assert.ok(observation.cleanup.disposalRoots.every(Boolean));
   assert.deepEqual(result.errors,[]);assert.deepEqual(result.findings,[]);proven=true;
  } catch(error){await captureFailure(delayed,error);throw error;}
  finally {await closeOwned(delayed,proven);}
 }
 assert.equal(result.requests.filter(u=>u.includes('untrusted.invalid')).length,0);assert.equal(networkAudit.blocked.length,0);
 assert.deepEqual(result.errors,[]);
 result.base21={created:result.final.contextsCreated+result.delayed.reduce((n,x)=>n+x.cleanup.contextsCreated,0),lost:result.final.contextsLostEvents+result.delayed.reduce((n,x)=>n+x.cleanup.contextsLostEvents,0),findings:[...result.findings]};
 assert.equal(result.base21.created,21);assert.equal(result.base21.lost,21);
 // Each held-key boundary owns a fresh context, document and CDP session. Native
 // input and all cleanup/witness assertions finish before that context is closed.
 result.heldModifiers=[];
 for(const boundary of ['unmount','scope','context-loss','reduced-context-loss','all-modifiers-unmount']){
  const p=await openOwned('held-'+boundary);let proven=false;
  const keys=boundary==='all-modifiers-unmount'?['Control','Shift','Alt','Meta']:['Control'];
  const observation={boundary,keys};result.heldModifiers.push(observation);
  try{
   if(boundary==='reduced-context-loss')await p.emulateMedia({reducedMotion:'reduce'});
   await p.goto(origin+'/__review',{waitUntil:'domcontentloaded'});
   await p.evaluate(()=>window.reviewReady?true:window.bounded(new Promise(r=>window.addEventListener('review-ready',r,{once:true}))));
   await p.evaluate(()=>{
    window.witnessEvents=[];
    window.keyupWitness=function unrelatedKeyupWitness(e){window.witnessEvents.push({key:e.key,trusted:e.isTrusted});};
    document.addEventListener('keyup',window.keyupWitness,{capture:true,passive:true});
   });
   observation.baseline=await nativeListeners(p,boundary+'-baseline');
   observation.initialReady=await p.evaluate(async(reduced)=>{
    // Reduced motion deliberately pauses without requiring a simulation tick.
    // Its completion is the hook's ready/idle paint, not onEngineStop (which
    // need not fire at all when the graph's deferred update follows that pause).
    const idle=reduced?window.stageSignal('ready','held-A','idle'):Promise.resolve();
    await window.renderStage(2,'held-A',true,false,true);window.heldOld=window.current;
    if(!reduced)return {event:'onEngineStop',...await window.waitStopped(window.heldOld)};
    await idle;
    const rec=window.heldOld;
    return {event:'ready/idle',owner:rec.owner,generation:rec.generation,nodes:rec.graph.graphData().nodes.length,pendingRaf:window.runtimeSnapshot().pendingRaf,cooldownTicks:rec.graph.cooldownTicks(),autoRotate:rec.graph.controls().autoRotate};
   },boundary==='reduced-context-loss');
   assert.equal(observation.initialReady.owner,0);assert.equal(observation.initialReady.nodes,2);
   if(boundary==='reduced-context-loss'){
    assert.equal(observation.initialReady.pendingRaf,0);assert.equal(observation.initialReady.cooldownTicks,0);assert.equal(observation.initialReady.autoRotate,false);
   }
   observation.before=await nativeListeners(p,boundary+'-before');
   for(const key of keys)await p.keyboard.down(key);
   observation.down=await nativeListeners(p,boundary+'-down');
   observation.downRuntime=await p.evaluate(()=>window.controlListenerSnapshot());
   assert.equal(observation.down.document.filter(x=>x.type==='keyup').length-observation.baseline.document.filter(x=>x.type==='keyup').length,1);
   assert.equal(observation.downRuntime.filter(x=>x.owner===0&&x.type==='keyup').length,1);
   if(boundary==='scope'){
    observation.replacementStop=await p.evaluate(async()=>{const losses=window.waitLosses();await window.renderStage(2,'held-B',true,false,true);await losses;return window.waitStopped(window.current);});
    assert.equal(observation.replacementStop.owner,1);assert.equal(observation.replacementStop.nodes,2);
   }else if(boundary.includes('context-loss')){
    await p.evaluate(async()=>{
     const g=window.current.graph,c=g.renderer().domElement;
     const loss=window.bounded(new Promise(r=>c.addEventListener('webglcontextlost',r,{once:true})));
     const state=window.stageSignal('error','held-A','idle');
     g.renderer().getContext().getExtension('WEBGL_lose_context').loseContext();await loss;await state;await window.waitFramesIdle();
    });
   }else await p.evaluate(async()=>{const losses=window.waitLosses();await window.releaseStage();await losses;});
   observation.teardown=await nativeListeners(p,boundary+'-held-after-teardown');
   observation.teardownRuntime=await p.evaluate(()=>({runtime:window.runtimeSnapshot(),controls:window.controlListenerSnapshot(),oldDisposed:window.heldOld.disposed,state:document.querySelector('.knowledge-graph-stage')?.dataset.engineState??null,witnessEvents:[...window.witnessEvents]}));
   assertNativeReleased(observation.teardown,observation.baseline,boundary==='scope'?1:0);
   check(boundary+' exact retired instance listeners',()=>assert.equal(observation.teardownRuntime.controls.filter(x=>x.owner===0).length,0));
   assert.equal(observation.teardownRuntime.oldDisposed,true);
   assert.deepEqual(observation.teardownRuntime.witnessEvents,[],'cleanup must not fabricate key events');
   for(const key of [...keys].reverse())await p.keyboard.up(key);
   observation.afterKeyup=await nativeListeners(p,boundary+'-after-real-keyup');
   observation.afterKeyupRuntime=await p.evaluate(()=>({runtime:window.runtimeSnapshot(),controls:window.controlListenerSnapshot(),witnessEvents:[...window.witnessEvents]}));
   assertNativeReleased(observation.afterKeyup,observation.baseline,boundary==='scope'?1:0);
   check(boundary+' exact retired instance after keyup',()=>assert.equal(observation.afterKeyupRuntime.controls.filter(x=>x.owner===0).length,0));
   assert.deepEqual(observation.afterKeyupRuntime.witnessEvents,keys.toReversed().map(key=>({key,trusted:true})),'unrelated capture listener survives and receives only real input');
   if(boundary==='scope'){
    // The replacement still owns its keydown and can acquire/release its own
    // transient keyup; disposing A must not disconnect B's required controls.
    await p.keyboard.down('Control');observation.replacementDown=await nativeListeners(p,boundary+'-replacement-down');
    observation.replacementDownRuntime=await p.evaluate(()=>window.controlListenerSnapshot());
    assert.equal(observation.replacementDownRuntime.filter(x=>x.owner===1&&x.type==='keyup').length,1);
    await p.keyboard.up('Control');observation.replacementUp=await nativeListeners(p,boundary+'-replacement-up');
    assertNativeReleased(observation.replacementUp,observation.baseline,1);
    assert.equal(observation.teardownRuntime.state,'ready');
   }else if(boundary.includes('context-loss')){
    assert.equal(observation.teardownRuntime.state,'error');
    assert.equal(await p.getByRole('alert').count(),1);
    await p.locator('.knowledge-graph-stage__nodes button').first().focus();await p.keyboard.press('Enter');
    assert.equal(await p.evaluate(()=>window.selections.at(-1)===window.snapshots.at(-1).data.nodes[0]),true);
   }
   await p.evaluate(async()=>{const losses=window.waitLosses();await window.releaseStage();await losses;});
   observation.final=await nativeListeners(p,boundary+'-final');
   observation.cleanup=await p.evaluate(()=>window.runtimeSnapshot());
   observation.unchanged=await p.evaluate(()=>window.allUnchanged());assert.equal(observation.unchanged,true);
   assertNativeReleased(observation.final,observation.baseline);assertReleased(observation.cleanup,boundary+' cleanup');
   assert.ok(observation.cleanup.disposalRoots.every(Boolean));
   await p.evaluate(()=>document.removeEventListener('keyup',window.keyupWitness,{capture:true}));
   observation.witnessRemoved=await nativeListeners(p,boundary+'-witness-removed');
   assertNativeReleased(observation.witnessRemoved);
   assert.deepEqual(result.errors,[]);assert.deepEqual(result.findings,[]);proven=true;
  }catch(error){await captureFailure(p,error);throw error;}
  finally{await closeOwned(p,proven);}
 }
 assert.deepEqual(result.errors,[]);
 assert.deepEqual(result.findings,[],'browser regressions');
 assert.equal(result.requests.filter(u=>u.includes('untrusted.invalid')).length,0);assert.equal(networkAudit.blocked.length,0);
 assert.ok(result.contextLifetimes.every(x=>x.proofComplete&&x.closed));
 result.status='passed';
}catch(e){result.status='failed';result.error={message:e.message,stack:e.stack};if(!result.failedCase&&page&&!page.isClosed())await captureFailure(page,e);throw e;}
finally{for(const c of ownedContexts)await c.close();ownedContexts.clear();cdpSessions.clear();await browser?.close();await server?.close();await vite?.close();result.cleanup={chrome:server?server.process().exitCode!==null||server.process().signalCode!==null:true,vite:true,ownedContexts:ownedContexts.size,cdpSessions:cdpSessions.size};await writeFile(path.join(evidence,'browser.json'),JSON.stringify(result,null,2));}
function assertPaths(links,count) {
 assert.equal(links.length,count);
 for(let i=0;i<count;i++) {
  const link=links[i];
  assert.equal(link.arrowLength,5);assert.equal(link.arrowVisible,true);
  assert.deepEqual(link.start,link.sourcePosition);assert.deepEqual(link.end,link.targetPosition);
  assert.equal(link.sourceId,i===1?'1':'0');assert.equal(link.targetId,i===1?'0':'1');
  assert.equal(link.kind,i===2?'ai_similarity':'manual');
  assert.equal(link.metadataMatches,true);
  for(let j=0;j<i;j++)assert.ok(Math.hypot(...link.midpoint.map((x,k)=>x-links[j].midpoint[k]))>1e-6,'actual physical midpoints must differ');
 }
}
function instrument(){
 window.bounded=(p,event='fixture event')=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Review event timeout: '+JSON.stringify({case:window.reviewCase,event,scope:document.querySelector('.knowledge-graph-stage')?.dataset.scopeKey,state:document.querySelector('.knowledge-graph-stage')?.dataset.engineState,owner:window.current?.owner,generation:window.current?.generation,ticks:window.current?.ticks,stopped:window.current?.stopped}))),15000);p.then(v=>{clearTimeout(t);resolve(v);},e=>{clearTimeout(t);reject(e);});});
 const nativeAdd=EventTarget.prototype.addEventListener,nativeRemove=EventTarget.prototype.removeEventListener;
 const listeners=[];
 EventTarget.prototype.addEventListener=function(type,fn,options){const capture=typeof options==='boolean'?options:Boolean(options?.capture);if(!listeners.some(x=>x.active&&x.target===this&&x.type===type&&x.fn===fn&&x.capture===capture))listeners.push({target:this,type,fn,capture,active:true,stack:new Error().stack});return nativeAdd.call(this,type,fn,options);};
 EventTarget.prototype.removeEventListener=function(type,fn,options){const capture=typeof options==='boolean'?options:Boolean(options?.capture);for(const x of listeners)if(x.target===this&&x.type===type&&x.fn===fn&&x.capture===capture)x.active=false;return nativeRemove.call(this,type,fn,options);};
 const raf=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window),pending=new Map();window.requestAnimationFrame=fn=>{const stack=new Error().stack;const id=raf(t=>{pending.delete(id);fn(t);if(!pending.size)window.dispatchEvent(new Event('frames-idle'));});pending.set(id,stack);return id;};window.cancelAnimationFrame=id=>{pending.delete(id);cancel(id);if(!pending.size)window.dispatchEvent(new Event('frames-idle'));};
 // d3 Timer.stop leaves its already queued clearNow/wake housekeeping frames.
 // Subscribe before teardown and observe their actual drain, never a fixed frame delay.
 window.releaseStage=()=>window.bounded(new Promise(resolve=>{
  let removed=false;
  const done=()=>{if(removed&&!pending.size){window.removeEventListener('frames-idle',done);resolve();}};
  window.addEventListener('frames-idle',done);
  window.reviewRender(null);removed=true;done();
 }));
 window.waitFramesIdle=()=>pending.size===0?Promise.resolve():window.bounded(new Promise(resolve=>{const done=()=>{if(!pending.size){window.removeEventListener('frames-idle',done);resolve();}};window.addEventListener('frames-idle',done);}));
 window.controlListenerSnapshot=()=>listeners.filter(x=>x.active).flatMap(x=>window.graphs.flatMap((rec,owner)=>{
  const c=rec.graph.controls();
  return x.fn===c._interceptControlDown||x.fn===c._interceptControlUp?[{owner,type:x.type,capture:x.capture,root:x.target===document?'document':'other',disposed:rec.disposed}]:[];
 }));
 const RO=ResizeObserver;let observers=0;window.ResizeObserver=class extends RO{constructor(fn){super(fn);this.live=true;observers++;}disconnect(){if(this.live){this.live=false;observers--;}super.disconnect();}};
 const getContext=HTMLCanvasElement.prototype.getContext;const contexts=[];
 HTMLCanvasElement.prototype.getContext=function(type,...args){const gl=getContext.call(this,type,...args);if(gl&&['webgl','webgl2'].includes(type)&&!contexts.some(x=>x.gl===gl)){const rec={gl,canvas:this,lost:false,calls:0};contexts.push(rec);nativeAdd.call(this,'webglcontextlost',()=>{rec.lost=true;window.dispatchEvent(new Event('review-loss'));});const ext=gl.getExtension.bind(gl);gl.getExtension=name=>{const e=ext(name);if(name==='WEBGL_lose_context'&&e&&!e.tracked){e.tracked=true;const lose=e.loseContext.bind(e);e.loseContext=()=>{rec.calls++;return lose();};}return e;};}return gl;};
 window.graphs=[];const resources=new Map();let rendererDisposes=0,controlDisposes=0;
 window.captureGraph=graph=>{
  const rec={graph,owner:window.graphs.length,generation:0,ticks:0,callbacks:{},stopped:false,disposed:false,rootAttachedAtDisposal:null};window.graphs.push(rec);window.current=rec;
  // Subscribe at graphData assignment, before the engine can tick/stop. A stop
  // belongs to this exact instance AND data generation, never window.current or
  // a sticky stop flag left over from a previous graphData lifecycle.
  const data=graph.graphData;
  graph.graphData=function(...args){if(args.length&&args[0]!==data.call(this)){
   rec.generation++;rec.ticks=0;rec.stopped=false;
   rec.stopSignal=new Promise(resolve=>{rec.resolveStop=resolve;});
  }return data.apply(this,args);};
  for(const name of ['onNodeClick','onNodeHover','onEngineTick','onEngineStop']){const original=graph[name];graph[name]=function(...args){if(args.length){rec.callbacks[name]=args[0];const fn=args[0];return original.call(this,(...values)=>{const ret=fn(...values);if(name==='onEngineTick')rec.ticks++;if(name==='onEngineStop'&&!rec.disposed&&rec.resolveStop){rec.stopped=true;rec.resolveStop({owner:rec.owner,generation:rec.generation,nodes:graph.graphData().nodes.length,ticks:rec.ticks});}if(name==='onNodeClick')window.dispatchEvent(new Event('review-pick'));return ret;});}return original.call(this);};}
  const destructor=graph._destructor;graph._destructor=function(...args){rec.rootAttachedAtDisposal=graph.controls().domElement.getRootNode()===document;rec.disposed=true;return destructor.apply(this,args);};
  const renderer=graph.renderer(),controls=graph.controls();const rd=renderer.dispose,cd=controls.dispose;renderer.dispose=function(...a){rendererDisposes++;return rd.apply(this,a);};controls.dispose=function(...a){controlDisposes++;return cd.apply(this,a);};
  const track=o=>{if(!o||resources.has(o))return;const r={kind:o.isBufferGeometry?'geometry':o.isMaterial?'material':'texture',disposed:false};resources.set(o,r);o.addEventListener('dispose',()=>r.disposed=true);};
  const render=renderer.render;renderer.render=function(scene,camera){scene.traverse(o=>{track(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material]){track(m);if(m)track(m.map);}});return render.call(this,scene,camera);};
 };
 window.curveSnapshot=()=>window.current.graph.graphData().links.map((l,i)=>{
  const point=t=>l.__curve?l.__curve.getPoint(t).toArray():['x','y','z'].map(k=>(l.source[k]||0)*(1-t)+(l.target[k]||0)*t);
  const dto=window.snapshots.at(-1).data.edges[i];
  return {curvature:l.curvature,midpoint:point(.5),start:point(0),end:point(1),sourcePosition:['x','y','z'].map(k=>l.source[k]||0),targetPosition:['x','y','z'].map(k=>l.target[k]||0),sourceId:l.source.id,targetId:l.target.id,kind:l.kind,metadataMatches:Object.keys(dto).every(k=>JSON.stringify(k==='source'?l.source.id:l[k])===JSON.stringify(dto[k])),arrowLength:window.current.graph.linkDirectionalArrowLength()(l),arrowVisible:Boolean(l.__arrowObj?.visible)};
 });
 window.waitStopped=(rec=window.current)=>{
  const generation=rec.generation;
  return window.bounded(rec.stopSignal,`onEngineStop owner=${rec.owner} generation=${generation}`).then(stop=>{
   if(rec!==window.current||rec.disposed||generation!==rec.generation)throw new Error('Retired graph satisfied engine-stop wait');
   return stop;
  });
 };
 window.waitLosses=()=>{const target=contexts.slice();return target.every(c=>c.lost)?Promise.resolve():window.bounded(new Promise(resolve=>{const listener=()=>{if(target.every(c=>c.lost)){window.removeEventListener('review-loss',listener);resolve();}};window.addEventListener('review-loss',listener);}),`webglcontextlost contexts=${target.length}`);};
 window.renderStage=async(count,scope='A',personal=false,reciprocal=false,strict=false)=>{
  const previous=window.current;
  const signal=window.bounded(new Promise(resolve=>{const check=()=>{const s=document.querySelector('.knowledge-graph-stage');if(count===null?!s:s&&s.dataset.scopeKey===scope&&s.dataset.engineState===(count===0?'empty':'ready')&&(count===0||(window.current!==previous&&!window.current.disposed))){observer.disconnect();resolve(true);}};const observer=new MutationObserver(check);observer.observe(document.documentElement,{subtree:true,attributes:true,childList:true});}),`new stage scope=${scope} nodes=${count}`);
  window.reviewRender(count===null?null:window.makeData(count,scope,personal,reciprocal),scope,strict);await signal;
 };
 window.armControlChange=()=>{window.controlSignal=window.bounded(new Promise(r=>{const c=window.current.graph.controls();const fn=()=>{c.removeEventListener('change',fn);r(true);};c.addEventListener('change',fn);}));};
 window.stageSignal=(state,scope,render)=>window.bounded(new Promise(resolve=>{const check=()=>{const s=document.querySelector('.knowledge-graph-stage');if(state===null?!s:s&&s.dataset.engineState===state&&s.dataset.scopeKey===scope&&(!render||s.dataset.renderState===render)){o.disconnect();resolve(true);}};const o=new MutationObserver(check);o.observe(document.documentElement,{subtree:true,childList:true,attributes:true});check();}),`stage scope=${scope} state=${state} render=${render}`);
 window.runtimeSnapshot=()=>({contextStates:contexts.map(c=>({lostEvent:c.lost,isContextLost:c.gl.isContextLost(),lossCalls:c.calls,canvasConnected:c.canvas.isConnected})),disposalRoots:window.graphs.filter(g=>g.disposed).map(g=>g.rootAttachedAtDisposal),pendingRaf:pending.size,pendingRafStacks:[...pending.values()],observers,contextsCreated:contexts.length,contextsLossCalls:contexts.reduce((s,x)=>s+x.calls,0),contextsLostEvents:contexts.filter(x=>x.lost).length,renderersDisposed:rendererDisposes,controlsDisposed:controlDisposes,resources:[...resources.values()].reduce((s,x)=>{const k=x.kind+(x.disposed?'Disposed':'Live');s[k]=(s[k]??0)+1;return s;},{}),liveGraphDomListeners:listeners.filter(x=>x.active&&x.target instanceof Element&&(x.target.matches('canvas,.scene-container')||x.target.closest('.scene-container'))).map(x=>({type:x.type,target:x.target.tagName,connected:x.target.isConnected,stack:x.stack})),liveControlGlobalListeners:listeners.filter(x=>x.active&&(x.target===document||x.target===window)&&x.stack.includes('OrbitControls')).map(x=>({type:x.type,stack:x.stack}))});
}
