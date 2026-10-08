import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';

// Read continuously; subscribe to an exact frame before each mutation. Timeouts only bound failures.
async function stream(url,headers,cursor=0){
  const stop=new AbortController();
  const response=await fetch(url,{headers:{...headers,'Last-Event-ID':String(cursor)},signal:AbortSignal.any([stop.signal,AbortSignal.timeout(20000)])});
  assert.equal(response.status,200,await (response.status===200?Promise.resolve(''):response.text()));
  assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const reader=response.body.getReader(),decoder=new TextDecoder(),frames=[],waiting=new Set();let buffer='',failure;
  function wait(predicate){
    const found=frames.find(predicate);if(found)return Promise.resolve(found);
    if(failure)return Promise.reject(failure);
    const gate=Promise.withResolvers(),timeout=setTimeout(()=>{waiting.delete(entry);gate.reject(new Error('expected SSE frame not delivered'));},5000);
    const entry={predicate,resolve:value=>{clearTimeout(timeout);waiting.delete(entry);gate.resolve(value);},reject:error=>{clearTimeout(timeout);waiting.delete(entry);gate.reject(error);}};
    waiting.add(entry);return gate.promise;
  }
  const consume=(async()=>{
    while(true){
      const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});
      let split;while((split=buffer.indexOf('\n\n'))>=0){
        const text=buffer.slice(0,split);buffer=buffer.slice(split+2);
        const lines=Object.fromEntries(text.split('\n').map(line=>{const at=line.indexOf(':');return[line.slice(0,at),line.slice(at+1).trimStart()];}));
        if(!lines.data)continue;const frame={event:lines.event,id:lines.id,data:JSON.parse(lines.data)};frames.push(frame);
        for(const entry of [...waiting])if(entry.predicate(frame))entry.resolve(frame);
      }
    }
    failure=new Error('SSE ended');
  })().catch(error=>{failure=error;}).finally(()=>{for(const entry of [...waiting])entry.reject(failure);reader.releaseLock();});
  await wait(f=>f.event==='state');
  return {frames,wait,close:async()=>{stop.abort();await consume;}};
}
async function childServer(mode,evidence){
  const child=fork(new URL('./deadline-wiki-sse-child.mjs',import.meta.url),[mode],{env:{...process.env,PG_CONNECTION_TIMEOUT_MS:'5000'},stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',()=>{});
  const [ready]=await once(child,'message',{signal:AbortSignal.timeout(10000)});assert.equal(ready.type,'ready',stderr);
  return {base:`http://127.0.0.1:${ready.port}/api/v1`,phase:()=>once(child,'message',{signal:AbortSignal.timeout(10000)}),release:()=>child.send({type:'release-snapshot'}),close:async()=>{
    const message=once(child,'message',{signal:AbortSignal.timeout(10000)}),exit=once(child,'exit',{signal:AbortSignal.timeout(10000)});
    child.send({type:'close'});const [closed]=await message;assert.equal((await exit)[0],0,stderr);
    assert.equal(closed.listening,false);assert.equal(closed.changedListeners,0);assert.equal(closed.invalidatedListeners,0);
    evidence.push({kind:'child-cleanup',pid:child.pid,port:ready.port,...closed});
  }};
}
export async function sseScenarios(t,api,prefix=''){
  const {wikiContext,withKnowledgeTransaction}=await import('../src/services/knowledge-wiki-store.service.js');
  const {canonical,citationFor,sha256}=await import('../src/services/knowledge-wiki-contract.service.js');
  const {changeSetDigest,wikiEvents}=await import('../src/services/knowledge-wiki-publication.service.js');
  async function fixture(scope){
    const signup=await api.request(null,`${prefix}/auth/signup`,'POST',{name:'SSE owner',email:`sse-${randomUUID()}@example.invalid`,password:'password-1234'},201);
    const actor={token:signup.access_token??signup.token,userId:String(signup.user.id)};
    const company=await api.request(actor,prefix?'/pg/companies':'/tenants','POST',{name:'SSE scope',...(prefix?{}:{type:'custom'}),modules:['documents','agent','projects'],features:[],departments:[]},201);
    actor.orgId=company.org_id;
    const ctx=wikiContext({store:prefix?'pg':'legacy',scope,actorId:actor.userId,tenantId:company.tenant_id,companyId:prefix?company.org_id.slice(3):company.org_id});
    const root=`${prefix}/${scope==='company'?'documents':'vault'}/wiki`,headers={'Content-Type':'application/json',Authorization:`Bearer ${actor.token}`,'X-Org-Id':actor.orgId};
    async function http(base,path,method='GET',body,status=200){
      const res=await fetch(base+root+path,{method,headers:{...headers,'Idempotency-Key':body?.manifest_hash??'sse'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
      const result=await res.json();assert.equal(res.status,status,JSON.stringify(result));return result;
    }
    const tx=(write,work)=>withKnowledgeTransaction(ctx,{write},work);
    const source=()=>api.request(actor,root+'/sources','POST',{kind:'upload',filename:'sse.md',mime:'text/markdown',content_base64:Buffer.from('SSE immutable source').toString('base64')},201);
    async function draft(src){
      return tx(true,function*(db){
        const raw=yield* db.sourceRevision(src.current_revision_id),lineage=yield* db.manifest([{kind:'source_revision',revision_id:raw.id,supplied_text:raw.content,classification:'internal'}]);
        const page_id=randomUUID(),proposed_revisions=[{page_id,kind:'concept',title:'SSE page',markdown:'SSE page body',index_entry:'- SSE page',citations:[citationFor(raw)],links:[],provenance:{origin:'compiler',fixture:true}}],expected_heads=[{page_id,version:null,published_head_id:null}];
        const fields={wiki_id:db.wiki.id,actor_id:ctx.actorId,job_id:null,proposed_revisions,expected_heads,lineage,schema_revision_id:db.wiki.active_schema_id,input_manifest_hash:lineage.hash};
        const row=yield* db.insert('change_set',{actor_id:ctx.actorId,job_id:null,state:'draft',proposed_revisions_json:canonical(proposed_revisions),expected_heads_json:canonical(expected_heads),lineage_json:canonical(lineage),schema_revision_id:fields.schema_revision_id,input_manifest_hash:lineage.hash,manifest_hash:changeSetDigest(fields),created_at:yield* db.clock()});
        yield* db.insert('dependency',{dependent_change_set_id:row.id,source_revision_id:raw.id,relation:'transitive'});
        yield* db.event('change_set.created',{change_set_id:row.id});return row;
      });
    }
    return {actor,ctx,root,headers,http,tx,source,draft};
  }
  for(const mode of ['app','exported'])for(const scope of ['company','personal']){
    await t.test(`${mode}: empty ${scope} scope adopts creation and publication`,async()=>{
      const f=await fixture(scope),child=await childServer(mode,api.http);let s;
      try{
        assert.equal((await api.request(f.actor,f.root)).wiki,null);
        assert.deepEqual((await f.http(child.base,'/graph')).counts,{nodes:0,edges:0});
        s=await stream(child.base+f.root+'/events',f.headers);
        const captured=s.wait(e=>e.event==='wiki'&&e.data.kind==='source.captured').then(value=>({value}),error=>({error}));
        const src=await f.source();const first=await captured;assert.ifError(first.error);assert.equal(first.value.data.source_revision_id,src.current_revision_id);
        const created=s.wait(e=>e.event==='wiki'&&e.data.kind==='change_set.created').then(value=>({value}),error=>({error}));
        const draft=await f.draft(src);assert.ifError((await created).error);
        const published=s.wait(e=>e.event==='wiki'&&e.data.kind==='change_set.published').then(value=>({value}),error=>({error}));
        const receipt=await f.http(child.base,`/change-sets/${draft.id}/publish`,'POST',{manifest_hash:draft.manifest_hash,confirmed:true});
        const event=await published;assert.ifError(event.error);assert.equal(event.value.data.change_set_id,draft.id);
        assert.equal(receipt.result_json.pages[0].version,1);
        assert.equal((await f.http(api.baseUrl,'/graph')).nodes.filter(n=>n.page_id).length,1);
        api.http.push({kind:'empty-wiki-SSE-green',mode,scope,store:f.ctx.store,frames:s.frames});
      }finally{await s?.close();await child.close();}
    });
  }
  if(prefix)await t.test('createApp: commit while initial repeatable-read event snapshot is held is not lost',async()=>{
    const f=await fixture('company'),child=await childServer('snapshot',api.http);let s,opening;
    try{
      await f.source();const cursor=(await wikiEvents(f.ctx)).next_cursor;
      const held=child.phase();
      opening=stream(child.base+f.root+'/events',f.headers,cursor).then(value=>({value}),error=>({error}));
      assert.equal((await held)[0].type,'snapshot-held');
      const committed=await f.source();child.release();
      const opened=await opening;assert.ifError(opened.error);s=opened.value;
      await s.wait(e=>e.event==='wiki'&&e.data.source_revision_id===committed.current_revision_id);
      assert.equal(s.frames.filter(e=>e.event==='wiki'&&e.data.source_revision_id===committed.current_revision_id).length,1);
      api.http.push({kind:'initial-snapshot-commit-barrier',cursor,frames:s.frames});
    }finally{child.release();if(opening&&!s)s=(await opening).value;await s?.close();await child.close();}
  });
  await t.test('exported cross-process durable events without generation, scoped isolation, replay and authorization',async()=>{
    const f=await fixture('company'),child=await childServer('exported',api.http),writer=await childServer('exported',api.http);let s,replay,otherStream,viewerStream;
    try{
      const email=`sse-viewer-${randomUUID()}@example.invalid`;let viewer;
      if(prefix){
        const joined=await api.request(f.actor,'/pg/members','POST',{name:'SSE viewer',email,password:'password-1234'},201);
        const login=await api.request(null,'/pg/auth/login','POST',{email,password:'password-1234'});
        viewer={userId:String(joined.id),token:login.token,orgId:f.actor.orgId};
      }else{
        const invitation=await api.request(f.actor,'/members/invites','POST',{email,roles:['company_admin']},201);
        const joined=await api.request(null,'/auth/signup','POST',{name:'SSE viewer',email,password:'password-1234',invitation_token:invitation.token},201);
        viewer={userId:joined.user.id,token:joined.access_token,orgId:f.actor.orgId};
      }
      const member=(await api.request(f.actor,'/settings/members')).items.find(m=>m.user_id===viewer.userId);
      await api.request(f.actor,`/settings/members/${member.membership_id}/roles`,'PUT',{roles:['company_admin'],expected_roles_version:member.roles_version});
      const src=await f.source(),draft=await f.draft(src);
      const receipt=await f.http(child.base,`/change-sets/${draft.id}/publish`,'POST',{manifest_hash:draft.manifest_hash,confirmed:true});
      const page=receipt.result_json.pages[0],before=(await api.request(f.actor,f.root)).wiki.generation,cursor=(await wikiEvents(f.ctx)).next_cursor;
      s=await stream(child.base+f.root+'/events',f.headers,cursor);
      viewerStream=await stream(child.base+f.root+'/events',{...f.headers,Authorization:`Bearer ${viewer.token}`},cursor);
      // Another company and owner are authenticated independently, never selected by a wake hint.
      const other=await fixture('company');otherStream=await stream(child.base+other.root+'/events',other.headers);
      const expected=['source.captured','change_set.created','change_set.rejected'];
      const gates=expected.map(kind=>s.wait(e=>e.event==='wiki'&&e.data.kind===kind).then(value=>({value}),error=>({error})));
      await f.source();
      const manual=await f.http(writer.base,`/pages/${page.id}/change-sets`,'POST',{expected_version:1,title:'private manual',markdown:'private manual body'},201);
      await f.http(writer.base,`/change-sets/${manual.id}/reject`,'POST',{manifest_hash:manual.manifest_hash});
      assert.equal((await api.request(f.actor,f.root)).wiki.generation,before);
      const durable=await wikiEvents(f.ctx,cursor);assert.deepEqual(durable.items.map(e=>e.kind),expected);
      const observed=await Promise.all(gates);api.http.push({kind:'cross-process-durable-events',store:f.ctx.store,generation:before,durable,observed:observed.map(e=>e.value??{error:e.error.message})});
      for(const event of observed)assert.ifError(event.error);
      assert.deepEqual(s.frames.filter(e=>e.event==='wiki').map(e=>e.data),durable.items);
      // An own-source barrier proves the other stream processed later commits without receiving ours.
      const otherCaptured=otherStream.wait(e=>e.event==='wiki'&&e.data.kind==='source.captured');await other.source();await otherCaptured;
      assert.ok(!JSON.stringify(otherStream.frames).includes(manual.id));assert.ok(!JSON.stringify(otherStream.frames).includes(src.current_revision_id));
      await s.close();s=null;
      replay=await stream(child.base+f.root+'/events',f.headers,durable.items[0].sequence);
      await replay.wait(e=>e.event==='wiki'&&e.data.kind==='change_set.rejected');
      assert.deepEqual(replay.frames.filter(e=>e.event==='wiki').map(e=>e.data.kind),expected.slice(1));
      assert.ok(replay.frames.filter(e=>e.event==='wiki').every(e=>!('actor_id'in e.data)&&!('metadata_json'in e.data)&&!('job_id'in e.data)));
      const jobEvent=replay.wait(e=>e.event==='wiki'&&e.data.kind==='job.queued');
      const job=await f.tx(true,function*(db){
        const now=yield* db.clock();
        const job=yield* db.insert('job',{operation:'query',request_json:'{}',request_hash:sha256('{}'),actor_id:f.ctx.actorId,idempotency_key:randomUUID(),state:'queued',source_vector_json:'[]',target_vector_json:'[]',schema_revision_id:db.wiki.active_schema_id,config_version:'SYNTHETIC-PRIVATE-CONFIG',created_at:now,updated_at:now});
        yield* db.event('job.queued',{job_id:job.id},{private_body:'DO-NOT-LEAK'});return job;
      });
      assert.equal((await jobEvent).data.job_id,job.id);
      const publicBarrier=viewerStream.wait(e=>e.event==='wiki'&&e.data.kind==='source.captured'&&e.data.sequence>durable.next_cursor);
      await f.source();await publicBarrier;
      for(const secret of [manual.id,draft.id,job.id,'DO-NOT-LEAK','SYNTHETIC-PRIVATE-CONFIG'])assert.ok(!JSON.stringify(viewerStream.frames).includes(secret));
      assert.ok(!JSON.stringify(replay.frames).includes('DO-NOT-LEAK'));
      const unavailable=replay.wait(e=>e.event==='unavailable').then(value=>({value}),error=>({error}));
      const members=(await api.request(f.actor,'/settings/members')).items,owner=members.find(m=>m.user_id===f.actor.userId);
      const localCommit=Promise.withResolvers(),localState=localCommit.promise.then(value=>({value}),error=>({error}));
      const localDeadline=AbortSignal.timeout(5000),localExpired=()=>localCommit.reject(localDeadline.reason);
      if(!prefix)localDeadline.addEventListener('abort',localExpired,{once:true});
      const database=prefix?null:(await import('../src/config/db.js')).db();
      const committedHint=()=>localCommit.resolve({inTransaction:database.isTransaction});
      if(!prefix)process.once('orbitflow:wiki-changed',committedHint);
      try{
        await api.request(viewer,`/settings/members/${owner.membership_id}/roles`,'PUT',{roles:[],expected_roles_version:owner.roles_version});
        if(!prefix){const state=await localState;assert.ifError(state.error);api.http.push({kind:'role-wake-commit-boundary',...state.value});assert.equal(state.value.inTransaction,false,'wake hints must be emitted after the synchronous role transaction');}
      }finally{process.off('orbitflow:wiki-changed',committedHint);localDeadline.removeEventListener('abort',localExpired);}
      const denied=await unavailable;assert.ifError(denied.error);assert.equal(denied.value.data.code,'SOURCE_REVOKED');
      await f.http(child.base,'/graph','GET',undefined,403);
    }finally{await s?.close();await replay?.close();await otherStream?.close();await viewerStream?.close();await child.close();await writer.close();}
  });
}
