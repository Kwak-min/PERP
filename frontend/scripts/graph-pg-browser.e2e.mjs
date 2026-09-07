import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { api } from "../../backend/tests/http.js";
import { startPgGraphFixture } from "./graph-pg-fixture.mjs";

const frontend=fileURLToPath(new URL("../",import.meta.url));
const component=process.env.GRAPH_QA_COMPONENT==="1";
const built=process.env.GRAPH_QA_BUILT==="1";
const evidence=path.join(frontend,".artifacts/graph-release",component?"pg-component":built?"pg-built-spa":"pg-spa");
await mkdir(evidence,{recursive:true});
let fixture,vite,browser;
const checks=[],failures=[],captures=[],requests=[];
try{
  fixture=await startPgGraphFixture();
  const entry={name:"graph-fixture-entry",transformIndexHtml:{order:"pre",handler:()=>`<html><head></head><body><div id="root"></div><script type="module" src="/scripts/graph-component-entry.tsx"></script></body></html>`}};
  vite=await createServer({configFile:false,root:built?path.join(frontend,"dist"):frontend,plugins:built?[]:[react(),...(component?[entry]:[])],server:{host:"127.0.0.1",port:0,watch:{ignored:["**/.artifacts/**","**/dist/**"]},proxy:{"/api":fixture.baseUrl.replace("/api/v1","")}}});
  await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
  browser=await chromium.launch({channel:"chrome",headless:false});
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:"reduce"});page.setDefaultTimeout(10000);
  const session={token:fixture.token,orgId:fixture.orgId,name:"PG QA",email:"qa@example.invalid",mustChangePassword:false,organizations:[{org_id:fixture.orgId,org_name:"PG QA Workspace",org_type:"perp_db",roles:["member"]}]};
  await page.addInitScript(session=>{localStorage.setItem("orbitflow.session.v1",JSON.stringify(session));localStorage.setItem("orbitflow.demoMode","0");},session);
  page.on("pageerror",error=>failures.push({name:"pageerror",error:String(error)}));
  page.on("request",request=>{if(request.url().includes("/api/v1/"))requests.push({method:request.method(),path:new URL(request.url()).pathname});});
  async function check(name,fn){try{await fn();checks.push(name);console.log(`PASS ${name}`);}catch(error){failures.push({name,error:String(error)});console.error(`FAIL ${name}: ${error}`);}}
  async function capture(name){await page.screenshot({path:path.join(evidence,name),fullPage:true});captures.push(name);}
  const title=page.getByLabel("제목",{exact:true}),body=page.getByLabel("본문 마크다운");
  const responseFor=(suffix,method="GET")=>page.waitForResponse(r=>r.url().endsWith(`/api/v1/pg/vault${suffix}`)&&r.request().method()===method);
  await page.goto(`${origin}/vault`);await page.getByRole("button",{name:/PG Beta/}).waitFor();
  await check("PG note list edit uses real version and omits unsupported metadata",async()=>{
    const detail=responseFor("/notes/1");await page.getByRole("button",{name:/PG Beta/}).click();assert.equal((await detail).status(),200);await body.waitFor();
    assert.equal(await page.getByLabel("태그 (쉼표로 구분)").isVisible(),false);
    await body.fill("# PG_BETA_SAVED\n[[PG Gamma]]");const saved=responseFor("/notes/1","PATCH");await page.getByRole("button",{name:"변경 저장",exact:true}).click();const response=await saved;assert.equal(response.status(),200,await response.text());
    assert.equal(fixture.notes.get("1").content_md,"# PG_BETA_SAVED\n[[PG Gamma]]");await capture("pg-list-saved.png");
  });
  await check("PG note creation returns full detail and appears in the same graph store",async()=>{
    await page.getByRole("button",{name:"새 노트",exact:true}).click();await title.fill("PG Alpha");await body.fill("# Alpha\n[[PG Beta|alias]] [[PG Gamma#section]] [[Missing]]");
    const created=responseFor("/notes","POST");await page.getByRole("button",{name:"노트 만들기",exact:true}).click();const response=await created;assert.equal(response.status(),201,await response.text());
    const note=await response.json();assert.equal(note.title,"PG Alpha");assert.ok(Number.isInteger(note.version));
  });
  await check("PG graph and list are the same owner-only source with wiki links",async()=>{
    const loaded=responseFor("/graph");await page.goto(`${origin}/vault/graph`);const response=await loaded;assert.equal(response.status(),200);const graph=await response.json();
    assert.equal(graph.nodes.length,4);assert.ok(!graph.nodes.some(n=>n.id==="4"));assert.equal(graph.edges.filter(e=>e.target_id!==null).length,3);assert.equal(graph.edges.filter(e=>e.target_id===null).length,1);
    await page.getByRole("application",{name:"개인 노트 3D 그래프"}).waitFor();await capture("pg-graph-linked.png");
    const list=await api(fixture.baseUrl,"/pg/vault/notes",fixture);assert.deepEqual(graph.nodes.map(n=>n.id).sort(),list.body.items.map(n=>n.id).sort());
  });
  await check("PG graph editor saves the selected note and survives reload",async()=>{
    const detail=responseFor("/notes/1");await page.getByLabel("그래프 노트 선택").selectOption("1");await detail;await body.waitFor();
    assert.equal(await page.getByLabel("태그 (쉼표로 구분)").isVisible(),false);
    await title.fill("PG Beta Renamed");await body.fill("# GRAPH_PG_SAVED\n[[PG Gamma]]");const saved=responseFor("/notes/1","PATCH");await page.getByRole("button",{name:"변경 저장",exact:true}).click();const response=await saved;assert.equal(response.status(),200,await response.text());
    const note=await response.json();assert.equal(note.title,"PG Beta Renamed");assert.equal(note.content,"# GRAPH_PG_SAVED\n[[PG Gamma]]");assert.ok(note.version>41);
    await page.reload();await page.getByRole("application",{name:"개인 노트 3D 그래프"}).waitFor();await page.getByLabel("그래프 노트 선택").selectOption("1");await body.waitFor();assert.equal(await body.inputValue(),note.content);await capture("pg-graph-reloaded.png");
  });
  await check("PG stale save is rejected without losing local draft",async()=>{
    const fresh=await api(fixture.baseUrl,"/pg/vault/notes/1",fixture);const updated=await api(fixture.baseUrl,"/pg/vault/notes/1",{...fixture,method:"PATCH",body:{version:fresh.body.version,content:"# External"}});assert.equal(updated.status,200);
    await body.fill("# PG_LOCAL_UNSAVED");const saved=responseFor("/notes/1","PATCH");await page.getByRole("button",{name:"변경 저장",exact:true}).click();assert.equal((await saved).status(),409);await page.getByRole("alert").waitFor();assert.equal(await body.inputValue(),"# PG_LOCAL_UNSAVED");await capture("pg-conflict.png");
  });
  assert.ok(!requests.some(r=>r.path.startsWith("/api/v1/vault")),"PG workspace must never call the SQLite Vault API");
  await writeFile(path.join(evidence,"result.json"),JSON.stringify({browser:await browser.version(),fixture:"real PG HTTP routes/auth/controllers + controlled owner/version-aware SQL adapter; NOT a PostgreSQL server",surface:component?"actual Vault/graph screen components":built?"production-built SPA routes":"actual SPA routes",checks,failures,captures,requests,sqlCount:fixture.queries.length,cleanup:"pool query restored; pool/browser/Vite/temp SQLite closed in finally"},null,2));
  assert.equal(failures.length,0,JSON.stringify(failures,null,2));console.log("GRAPH_PG_BROWSER_PASS");
}finally{await browser?.close();await vite?.close();await fixture?.close();}
