import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { api, createOwnerOrg, startTestServer } from "../../backend/tests/http.js";
import { startGraphApi } from "./graph-local-api.mjs";
import { graphResponseBody } from "./graph-response.mjs";

const frontend = fileURLToPath(new URL("../", import.meta.url));
const componentOnly = process.env.GRAPH_QA_COMPONENT === "1";
const built = process.env.GRAPH_QA_BUILT === "1";
const evidence = path.join(frontend, ".artifacts/graph-release", componentOnly ? "component" : built ? "built-spa" : "spa");
await mkdir(evidence, { recursive: true });
let server, vite, browser;
const failures = [], checks = [], captures = [], metrics = {};
async function bounded(promise) {
  const signal = AbortSignal.timeout(10000);
  return Promise.race([promise, new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))]);
}
try {
  server = await (componentOnly ? startGraphApi() : startTestServer());
  const owner = await createOwnerOrg(server.baseUrl, ["agent", "documents"]);
  const me = await api(server.baseUrl, "/auth/me", owner);
  const notes = [];
  for (const [title, content, folder] of [["QA Alpha", "# Alpha\n[[QA Beta]]", "/work"], ["QA Beta", "# Beta\n[[QA Gamma]]", "/work"], ["QA Gamma", "# Gamma\n[[QA Alpha]]", "/ideas"], ["QA Island", "# Alone", "/ideas"]]) {
    const result = await api(server.baseUrl, "/vault/notes", { ...owner, method: "POST", body: { title, content, folder } });
    assert.equal(result.status, 201, JSON.stringify(result.body)); notes.push(result.body);
  }
  const componentPlugin = { name:"graph-fixture-entry", transformIndexHtml: { order:"pre", handler: () => `<html><head></head><body><div id="root"></div><script type="module" src="/scripts/graph-component-entry.tsx"></script></body></html>` } };
  vite = await createServer({ configFile:false, root:built?path.join(frontend,"dist"):frontend, plugins:built?[]:[react(),...(componentOnly?[componentPlugin]:[])], server:{ host:"127.0.0.1",port:0,watch:{ignored:["**/.artifacts/**","**/dist/**"]},proxy:{"/api":server.baseUrl.replace("/api/v1","")} } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({channel:"chrome",headless:false});
  const page = await browser.newPage({viewport:{width:1280,height:900},reducedMotion:"reduce"});
  page.setDefaultTimeout(10000);
  const session = {token:owner.token,orgId:owner.orgId,name:me.body.name,email:me.body.email,mustChangePassword:false,organizations:me.body.organizations};
  await page.addInitScript(value => {
    localStorage.setItem("orbitflow.session.v1",JSON.stringify(value));
    localStorage.setItem("orbitflow.demoMode","0");
    window.__graphPaint = {frames:0,arcs:[],labels:[]};
    const pending=new Set(),raf=window.requestAnimationFrame,cancel=window.cancelAnimationFrame;
    window.__graphPending=pending;
    window.requestAnimationFrame=callback=>{const id=raf(time=>{pending.delete(id);callback(time);queueMicrotask(()=>{if(pending.size===0)window.dispatchEvent(new Event("graph-idle"));});});pending.add(id);return id;};
    window.cancelAnimationFrame=id=>{pending.delete(id);cancel(id);};
    const proto=CanvasRenderingContext2D.prototype, clear=proto.clearRect, arc=proto.arc, text=proto.fillText;
    proto.clearRect=function(...args){window.__graphPaint={frames:window.__graphPaint.frames+1,arcs:[],labels:[]};queueMicrotask(()=>window.dispatchEvent(new Event("graph-painted")));return clear.apply(this,args);};
    proto.arc=function(...args){window.__graphPaint.arcs.push(args.slice(0,3));return arc.apply(this,args);};
    proto.fillText=function(...args){window.__graphPaint.labels.push(args.slice(0,3));return text.apply(this,args);};
  },session);
  page.on("pageerror",error=>failures.push({name:"pageerror",error:String(error)}));
  async function check(name,fn){try{await fn();checks.push(name);console.log(`PASS ${name}`);}catch(error){failures.push({name,error:String(error)});console.error(`FAIL ${name}: ${error}`);}}
  async function capture(name){await page.screenshot({path:path.join(evidence,name),fullPage:true,animations:"disabled"});captures.push(name);}
  // DOM/캔버스 완료 신호를 행동 전에 구독한다. sleep/polling 없이 경합을 재현한다.
  async function arm(kind,value="") {
    await page.evaluate(({kind,value})=>{
      window.__graphSignal=new Promise((resolve,reject)=>{
        const timeout=AbortSignal.timeout(10000);
        if(kind==="paint"){
          window.addEventListener("graph-painted",()=>resolve(),{once:true,signal:timeout});
          timeout.addEventListener("abort",()=>reject(timeout.reason),{once:true});return;
        }
        const observer=new MutationObserver(records=>{
          const ready=kind==="layout" ? records.some(r=>r.type==="attributes" && r.attributeName==="data-layout" && r.target.getAttribute("data-layout")==="settled")
            : kind==="editor" ? document.querySelector(".graph-editor")?.getAttribute("data-note-id")===value
            : kind==="alert" ? Boolean(document.querySelector('[role="alert"]'))
            : kind==="spin" ? Boolean(document.querySelector('[aria-pressed="false"]'))
            : Boolean(document.querySelector(".graph-editor:not([disabled])"));
          if(ready){observer.disconnect();resolve();}
        });
        observer.observe(document,{subtree:true,childList:true,attributes:true});
        timeout.addEventListener("abort",()=>{observer.disconnect();reject(timeout.reason);},{once:true});
      });
    },{kind,value});
  }
  const signal=()=>page.evaluate(()=>window.__graphSignal);
  const paint=()=>page.evaluate(()=>window.__graphPaint);
  let canvas=page.getByRole("application",{name:"개인 노트 3D 그래프"});
  const title=page.getByLabel("제목",{exact:true});
  const body=page.getByLabel("본문 마크다운");
  const picker=page.getByLabel("그래프 노트 선택");
  async function select(note){await arm("editor",note.id);await picker.selectOption(note.id);await signal();}
  async function refresh(){await arm("layout");await page.getByRole("button",{name:"새로고침",exact:true}).click();await signal();}
  async function pick(label) {
    const point=await page.evaluate(label=>{
      const p=window.__graphPaint,l=p.labels.find(l=>l[0]===label);if(!l)return null;
      const s=p.arcs.find(a=>Math.abs(a[0]-l[1])<0.01&&Math.abs(a[1]-a[2]-7-l[2])<0.01);
      return s?{x:s[0],y:s[1]}:null;
    },label);
    assert.ok(point,`painted node ${label}`);await canvas.click({position:point});
  }
  const loaded=page.waitForResponse(r=>r.url().endsWith("/api/v1/vault/graph"));
  await page.goto(`${origin}/vault/graph`);assert.equal((await loaded).status(),200);await canvas.waitFor();
  await check("reduced motion defaults off and settled graph has depth",async()=>{
    assert.equal(await page.getByRole("button",{name:"자동 회전 끄기",exact:true}).count(),0);
    assert.equal(await canvas.getAttribute("data-layout"),"settled");
    const p=await paint();assert.ok(p.labels.length>=2);assert.ok(new Set(p.arcs.map(a=>a[2].toFixed(2))).size>4);
    metrics.initialPaint=p;
  });
  await capture("personal-1280.png");
  await check("keyboard rotation zoom and Home fit change the actual projection",async()=>{
    assert.equal(await canvas.getAttribute("tabindex"),"0");await canvas.focus();
    const before=await paint();await arm("paint");await page.keyboard.press("ArrowRight");await signal();assert.notDeepEqual((await paint()).arcs,before.arcs);
    const rotated=await paint();await arm("paint");await page.keyboard.press("-");await signal();assert.ok(Math.max(...(await paint()).arcs.map(a=>a[2]))<Math.max(...rotated.arcs.map(a=>a[2])));
    await arm("paint");await page.keyboard.press("Home");await signal();assert.deepEqual((await paint()).arcs,before.arcs);
  });
  await check("pointer drag rotates and wheel zooms",async()=>{
    const before=await paint(),box=await canvas.boundingBox();assert.ok(box);
    await arm("paint");await page.mouse.move(box.x+100,box.y+100);await page.mouse.down();await page.mouse.move(box.x+180,box.y+150);await page.mouse.up();await signal();
    assert.notDeepEqual((await paint()).arcs,before.arcs);await capture("personal-rotated.png");
    await arm("paint");await page.mouse.wheel(0,180);await signal();assert.notDeepEqual((await paint()).arcs,before.arcs);await capture("personal-zoomed.png");
    await arm("paint");await page.getByRole("button",{name:"화면 맞춤",exact:true}).click();await signal();
  });
  await check("canvas picking opens real note and Markdown preview",async()=>{
    await arm("editor",notes[0].id);await pick("QA Alpha");await signal();assert.equal(await title.inputValue(),"QA Alpha");
    await page.getByRole("tab",{name:"미리보기",exact:true}).click();assert.equal(await page.locator(".note-editor__preview h2").textContent(),"Alpha");await capture("personal-preview.png");
    await page.getByRole("tab",{name:"편집",exact:true}).click();
  });
  await check("save response cannot replace a newer selection or draft",async()=>{
    await body.fill("# ALPHA_SAVED\n[[QA Beta]]");
    const gate=Promise.withResolvers(),entered=Promise.withResolvers();const matcher=`**/vault/notes/${notes[0].id}`;
    await page.route(matcher,async route=>{if(route.request().method()!=="PATCH")return route.continue();const response=await route.fetch();entered.resolve();await gate.promise;await route.fulfill({response});});
    try{
      await page.getByRole("button",{name:"변경 저장",exact:true}).click();await bounded(entered.promise);
      await select(notes[1]);assert.equal(await body.isDisabled(),true);
      await arm("layout");gate.resolve();await signal();
      assert.equal(await title.inputValue(),"QA Beta");assert.equal(await body.inputValue(),"# Beta\n[[QA Gamma]]");
      assert.equal(await page.locator(".graph-editor").getAttribute("data-note-id"),notes[1].id);
      assert.equal(await body.isEnabled(),true);await capture("personal-rapid-save-selection.png");
    }finally{gate.resolve();await page.unroute(matcher);}
  });
  await check("save persists through browser reload and fresh HTTP detail",async()=>{
    const detail=await api(server.baseUrl,`/vault/notes/${notes[0].id}`,owner);assert.equal(detail.body.content,"# ALPHA_SAVED\n[[QA Beta]]");assert.equal(detail.body.version,2);
    await page.reload();await canvas.waitFor();await select(notes[0]);assert.equal(await body.inputValue(),detail.body.content);await capture("personal-reloaded.png");
  });
  await check("rapid detail selection aborts old request before it can replace new note",async()=>{
    const gate=Promise.withResolvers(),entered=Promise.withResolvers(),released=Promise.withResolvers();const matcher=`**/vault/notes/${notes[1].id}`;
    await page.route(matcher,async route=>{const response=await route.fetch();entered.resolve();await gate.promise;await route.fulfill({response});released.resolve();});
    try{
      await picker.selectOption(notes[1].id);await bounded(entered.promise);
      const aborted=page.waitForEvent("requestfailed",{predicate:r=>r.url().endsWith(`/vault/notes/${notes[1].id}`)});
      await select(notes[2]);await aborted;gate.resolve();await bounded(released.promise);
      assert.equal(await title.inputValue(),"QA Gamma");assert.equal(await body.inputValue(),"# Gamma\n[[QA Alpha]]");
    }finally{gate.resolve();await page.unroute(matcher);}
  });
  await check("optimistic conflict preserves unsaved editor content",async()=>{
    await select(notes[0]);const fresh=await api(server.baseUrl,`/vault/notes/${notes[0].id}`,owner);
    const concurrent=await api(server.baseUrl,`/vault/notes/${notes[0].id}`,{...owner,method:"PATCH",body:{version:fresh.body.version,content:"# EXTERNAL_EDIT"}});assert.equal(concurrent.status,200);
    await body.fill("# LOCAL_UNSAVED");await arm("alert");const response=page.waitForResponse(r=>r.request().method()==="PATCH"&&r.url().endsWith(`/vault/notes/${notes[0].id}`));
    await page.getByRole("button",{name:"변경 저장",exact:true}).click();assert.equal((await response).status(),409);await signal();assert.equal(await body.inputValue(),"# LOCAL_UNSAVED");await capture("personal-version-conflict.png");
  });
  await check("reduced motion change stops explicit auto rotation",async()=>{
    await page.emulateMedia({reducedMotion:"no-preference"});await arm("paint");await page.getByRole("button",{name:"자동 회전",exact:true}).click();await signal();const a=await paint();
    await arm("paint");await signal();assert.notDeepEqual((await paint()).arcs,a.arcs);
    await arm("spin");await page.emulateMedia({reducedMotion:"reduce"});await signal();assert.equal(await page.getByRole("button",{name:"자동 회전 끄기",exact:true}).count(),0);
  });
  for(const width of [375,768,1280]) await check(`personal responsive ${width}`,async()=>{
    await page.setViewportSize({width,height:900});await canvas.scrollIntoViewIfNeeded();
    await arm("paint");await page.getByRole("button",{name:"화면 맞춤",exact:true}).click();await signal();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await capture(`personal-${width}-editor.png`);
  });
  await check("empty singleton and 1000-node graphs use real isolated notes",async()=>{
    for(const note of notes){const result=await api(server.baseUrl,`/vault/notes/${note.id}`,{...owner,method:"DELETE"});assert.equal(result.status,200);}
    await page.reload();await canvas.waitFor();assert.equal(await picker.locator("option").count(),1);await capture("personal-empty.png");
    const one=await api(server.baseUrl,"/vault/notes",{...owner,method:"POST",body:{title:"QA Singleton",content:"# One"}});assert.equal(one.status,201);await refresh();
    const p=await paint(),box=await canvas.boundingBox();assert.ok(box);assert.ok(p.arcs.some(a=>Math.abs(a[0]-box.width/2)<1&&Math.abs(a[1]-box.height/2)<1));await capture("personal-singleton.png");
    // 직접 삽입도 이 프로세스가 생성한 임시 SQLite 파일에만 한다.
    const {insert}=await import("../../backend/src/models/base.js");const principal=await api(server.baseUrl,"/auth/principal",owner);
    for(let i=1;i<1000;i++)insert("vault_note",{tenant_id:principal.body.tenantId,org_id:owner.orgId,owner_id:owner.userId,title:`QA Large ${i}`,content:"",folder:`/folder-${i%4}`,created_by:owner.userId});
    const start=performance.now();await refresh();metrics.largeLayoutMs=performance.now()-start;
    assert.equal(await picker.locator("option").count(),1001);assert.ok((await paint()).arcs.length>=3000);await capture("personal-1000.png");
  });
  await check("company graph retains hub links rotation zoom and document picking",async()=>{
    const space=await api(server.baseUrl,"/documents/spaces",{...owner,method:"POST",body:{name:"QA Company Space"}});assert.equal(space.status,201);
    const docs=[];for(const [name,content]of[["QA Policy","# Policy"],["QA Guide","# Guide\n[[QA Policy]]"]]){const r=await api(server.baseUrl,"/documents",{...owner,method:"POST",body:{title:name,content,space_id:space.body.id}});assert.equal(r.status,201);docs.push(r.body);}
    const response=graphResponseBody(page,r=>r.url().endsWith("/api/v1/documents/graph"));await page.goto(`${origin}/documents/graph`);const completed=await response;assert.equal(completed.status,200);const data=completed.body;assert.equal(data.edges.length,3);
    canvas=page.getByRole("application",{name:"조직 지식 3D 그래프"});await canvas.waitFor();await page.getByRole("button",{name:"자동 회전 끄기",exact:true}).click();
    // 회사 화면은 기존 애니메이션 배치를 유지한다. 사용자 드래그/휠 입력 뒤 실제 draw 이벤트를 검증한다.
    const box=await canvas.boundingBox();assert.ok(box);await arm("paint");await page.mouse.move(box.x+70,box.y+70);await page.mouse.down();await page.mouse.move(box.x+120,box.y+110);await page.mouse.up();await signal();
    await arm("paint");await page.mouse.wheel(0,120);await signal();
    await page.evaluate(()=>new Promise((resolve,reject)=>{if(window.__graphPending.size===0)return resolve();const timeout=AbortSignal.timeout(10000);window.addEventListener("graph-idle",()=>resolve(),{once:true,signal:timeout});timeout.addEventListener("abort",()=>reject(timeout.reason),{once:true});}));
    const opened=page.waitForResponse(r=>r.request().method()==="GET"&&r.url().endsWith(`/documents/${docs[0].id}`));
    await pick("QA Policy");
    assert.equal((await opened).status(),200);await page.locator(".note-editor__preview h2").waitFor();
    for(const width of[375,768,1280]){
      await arm("paint");await page.setViewportSize({width,height:900});await signal();
      await arm("paint");await page.getByRole("button",{name:"화면 맞춤",exact:true}).click();await signal();
      const painted=await paint(),bounds=await canvas.boundingBox();assert.ok(bounds);
      assert.ok(painted.arcs.length>=9);assert.ok(painted.arcs.every(a=>a.every(Number.isFinite)));
      assert.ok(painted.arcs.some(a=>a[0]>0&&a[0]<bounds.width&&a[1]>0&&a[1]<bounds.height));
      metrics[`company${width}`]={labels:painted.labels,canvas:{width:bounds.width,height:bounds.height}};
      await capture(`company-${width}.png`);
    }
  });
  await writeFile(path.join(evidence,"result.json"),JSON.stringify({browser:await browser.version(),fixture:"real isolated SQLite HTTP controllers; no PG persistence claim",surface:componentOnly?"actual screen components":built?"production-built SPA routes":"actual SPA routes",checks,failures,metrics,captures,cleanup:"browser, Vite and temporary SQLite server closed in finally"},null,2));
  assert.equal(failures.length,0,JSON.stringify(failures,null,2));console.log("GRAPH_BROWSER_PASS");
}finally{await browser?.close();await vite?.close();await server?.close();}
