import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {readFile,writeFile,rm} from 'node:fs/promises';
import ts from 'typescript';

export async function httpScenarios(api,fixture,prefix='') {
  const {pgAuthBridge}=await import('../src/middleware/pgAuth.js');
  const {errorHandler,requestContext}=await import('../src/middleware/error.js');
  const {knowledgeWikiPublicationRouter}=await import('../src/routes/knowledge-wiki-publication.routes.js');
  const {actor,root,ctx,draft,publication,tx}=fixture;
  const {citationFor}=await import('../src/services/knowledge-wiki-contract.service.js');
  const app=express();app.use(express.json(),requestContext,pgAuthBridge);
  app.use(`/api/v1${root}`,knowledgeWikiPublicationRouter(ctx.store,ctx.scope));app.use(errorHandler);
  const server=createServer(app);const ready=once(server,'listening',{signal:AbortSignal.timeout(10000)});server.listen(0,'127.0.0.1');await ready;
  const url=`http://127.0.0.1:${server.address().port}/api/v1${root}`;
  const headers={'Content-Type':'application/json',Authorization:`Bearer ${actor.token}`,'X-Org-Id':actor.orgId};
  const request=async(path,method='GET',body,expected=200,extra={})=>{
    const res=await fetch(url+path,{method,headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    const text=await res.text(),result=res.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text;
    api.http.push({method,route:root+path,status:res.status,body:result});assert.equal(res.status,expected,JSON.stringify(result));return result;
  };
  try {
    const src=await api.request(actor,`${root}/sources`,'POST',{kind:'upload',filename:'http.md',mime:'text/markdown',content_base64:Buffer.from('한글\r\n근거 근거').toString('base64')},201);
    const raw=await tx(false,function*(t){return yield* t.sourceRevision(src.current_revision_id);});
    const inputs=[{kind:'source_revision',revision_id:raw.id,supplied_text:raw.content,classification:'internal'}];
    const a=randomUUID(),b=randomUUID();
    const d=await draft({ids:[a,b],inputs,links:[],title:'HTTP published'});
    await request(`/change-sets/${d.id}`);
    await request(`/change-sets/${d.id}/publish`,'POST',{manifest_hash:d.manifest_hash,confirmed:true},400);
    await request(`/change-sets/${d.id}/publish`,'POST',{manifest_hash:d.manifest_hash,confirmed:true,actor_id:actor.userId},400,{'Idempotency-Key':'bad-extra'});
    const receipt=await request(`/change-sets/${d.id}/publish`,'POST',{manifest_hash:d.manifest_hash,confirmed:true},200,{'Idempotency-Key':'http-exact'});
    assert.deepEqual(await request(`/change-sets/${d.id}/publish`,'POST',{manifest_hash:d.manifest_hash,confirmed:true},200,{'Idempotency-Key':'http-exact'}),receipt);
    const target=await request(`/pages/${b}`);
    const relationInputs=[...inputs,{kind:'page_revision',revision_id:target.id,supplied_text:target.markdown,classification:'internal'}];
    const citation=citationFor(raw);
    const links=[{id:randomUUID(),type:'manual',origin:'human',direction:'directed',predicate:'related',target_page_id:b,citations:[]},{id:randomUUID(),type:'ai_derived',origin:'compiler',direction:'directed',predicate:'supports',target_page_id:b,citations:[citation]}];
    const edgeDraft=await draft({inputs:relationInputs,links});
    // 동일 끝점의 평행 관계와 서로 다른 인용 범위를 보존한다.
    const proposed=JSON.parse(edgeDraft.proposed_revisions_json);proposed[0].citations=[citationFor(raw,0,Buffer.byteLength('한글')),citationFor(raw,Buffer.byteLength('한글\r\n'),Buffer.byteLength(raw.content))];
    const {canonical,sha256}=await import('../src/services/knowledge-wiki-contract.service.js');
    const exact=await tx(true,function*(t){const fields={wiki_id:t.wiki.id,actor_id:ctx.actorId,job_id:null,proposed_revisions:proposed,expected_heads:JSON.parse(edgeDraft.expected_heads_json),lineage:JSON.parse(edgeDraft.lineage_json),schema_revision_id:edgeDraft.schema_revision_id,input_manifest_hash:edgeDraft.input_manifest_hash};return yield* t.insert('change_set',{...edgeDraft,id:randomUUID(),proposed_revisions_json:canonical(proposed),manifest_hash:sha256(canonical(fields))});});
    // Subscribe to the exact stream state before publication, never sleep/poll.
    const controller=new AbortController();
    const stream=await fetch(url+'/events',{headers,signal:controller.signal});assert.equal(stream.status,200);assert.match(stream.headers.get('content-type'),/text\/event-stream/);
    const reader=stream.body.getReader();let pending='';const decoder=new TextDecoder();
    async function frame(){while(true){const split=pending.indexOf('\n\n');if(split>=0){const result=pending.slice(0,split);pending=pending.slice(split+2);return result;}const {done,value}=await reader.read();assert.equal(done,false);pending+=decoder.decode(value,{stream:true});}}
    const firstFrame=await frame();assert.match(firstFrame,/event: state/);
    const eventGate=Promise.withResolvers();
    const timeout=AbortSignal.timeout(10000);const abort=()=>eventGate.reject(timeout.reason);timeout.addEventListener('abort',abort,{once:true});
    const observed=(async()=>{try{while(true){const value=await frame();if(value.includes('change_set.published')&&value.includes(exact.id)){eventGate.resolve(value);return;}}}catch(error){eventGate.reject(error);}})();
    try{await request(`/change-sets/${exact.id}/publish`,'POST',{manifest_hash:exact.manifest_hash,confirmed:true},200,{'Idempotency-Key':'http-edges'});await eventGate.promise;}
    finally{timeout.removeEventListener('abort',abort);controller.abort();await observed;reader.releaseLock();}
    const graph=await request('/graph');const pair=graph.edges.filter(e=>e.target_page_id===b);assert.equal(pair.length,2);assert.deepEqual(pair.map(e=>e.type).sort(),['ai_derived','manual']);assert.ok(pair.every(e=>e.direction==='directed'));
    assert.equal(graph.edges.filter(e=>e.type==='citation').length,2);assert.ok(graph.edges.filter(e=>e.type==='citation').every(e=>e.target_revision_id===raw.id));
    assert.equal((await request(`/pages/${a}/history`)).items.length,1);
    assert.equal((await request(`/pages/${b}/backlinks`)).items.length,2);
    await request('/index.md');await request('/log.md');
    const noToken=await fetch(url+'/events?token=fake',{signal:AbortSignal.timeout(10000)});assert.equal(noToken.status,400);await noToken.body.cancel();
    const moduleFile=new URL(`../../.omo/evidence/task-33-deadline-erp-redesign/api-runtime-${prefix?'pg':'sqlite'}.mjs`,import.meta.url);
    const apiSource=await readFile(new URL('../../frontend/src/services/api.ts',import.meta.url),'utf8');
    const compiled=ts.transpileModule(apiSource,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
      .replace('"./workspace"',JSON.stringify(new URL('../../frontend/src/services/workspace.ts',import.meta.url).href))
      .replace('import.meta.env.VITE_API_BASE_URL',JSON.stringify(url.slice(0,-root.length)));
    await writeFile(moduleFile,compiled);
    try {
      const {apiEventStream}=await import(moduleFile.href);
      assert.equal(typeof apiEventStream,'function');
      const stop=new AbortController(),state=Promise.withResolvers(),created=Promise.withResolvers();
      const bounded=AbortSignal.timeout(10000);const abort=()=>{state.reject(bounded.reason);created.reject(bounded.reason);};bounded.addEventListener('abort',abort,{once:true});
      const cursor=(await publication.wikiEvents(ctx)).next_cursor;
      const consume=apiEventStream(root+'/events',{session:{token:actor.token,orgId:actor.orgId},signal:AbortSignal.any([stop.signal,bounded]),cursor,onEvent:event=>{if(event.event==='state')state.resolve();if(event.event==='wiki'&&event.data.kind==='change_set.created')created.resolve(event.data);}});
      // Observe rejection before an action so transport failures cannot be hidden by the barrier.
      consume.catch(error=>{state.reject(error);created.reject(error);});
      let edit;
      try{await state.promise;edit=await request(`/pages/${a}/change-sets`,'POST',{expected_version:1,title:'manual HTTP',markdown:'manual HTTP markdown'},201);assert.equal((await created.promise).change_set_id,edit.id);}
      finally{bounded.removeEventListener('abort',abort);stop.abort();await assert.rejects(consume,error=>error.name==='AbortError');}
      await request(`/change-sets/${edit.id}/reject`,'POST',{manifest_hash:edit.manifest_hash});
    }finally{await rm(moduleFile,{force:true});}
    api.http.push({kind:'SSE-exact-event-barrier',authenticated_bearer:true,url_tokens:false,stream_state:firstFrame,parallel_edges:pair.map(e=>e.id),source_revision_id:raw.id});
  }finally{await new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();});api.http.push({kind:'publication-http-owned-cleanup',closed:!server.listening});}
}
