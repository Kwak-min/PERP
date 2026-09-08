import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setupJobs, localProviderFixture } from './deadline-wiki-jobs-fixture.js';

export async function exerciseReaderJobs(mode,t) {
  const f=await setupJobs(mode),p=await localProviderFixture(),checks=[];
  const jobs=await import('../src/services/knowledge-wiki-jobs.service.js');
  const store=await import('../src/services/knowledge-wiki-store.service.js');
  const request=(...args)=>f.api.request(...args);
  try {
    const roles={};
    for(const [key,permissions] of Object.entries({reader:['menu.documents','document.read'],writer:['menu.documents','document.read','document.write'],writeOnly:['menu.documents','document.write'],denied:['menu.home']}))
      roles[key]=await request(f.a,'/settings/roles','POST',{name:'Reader regression '+key,scope:'all',permissions},201);
    const email='reader-regression@example.invalid';let member;
    if(mode==='pg') {
      const created=await request(f.a,'/pg/members','POST',{email,name:'Reader regression',password:'password-1234'},201);
      const login=await request(null,'/pg/auth/login','POST',{email,password:'password-1234'});
      member={userId:String(created.id),token:login.token,orgId:f.a.orgId};
    } else {
      const invite=await request(f.a,'/members/invites','POST',{email,roles:[roles.reader.key]},201);
      const signup=await request(null,'/auth/signup','POST',{email,name:'Reader regression',password:'password-1234',invitation_token:invite.token},201);
      member={userId:signup.user.id,token:signup.access_token,orgId:f.a.orgId};
    }
    const c=store.wikiContext({...f.context,actorId:member.userId});
    async function assign(key) {
      const m=(await request(f.a,'/settings/members')).items.find(m=>m.user_id===member.userId);
      await request(f.a,`/settings/members/${m.membership_id}/roles`,'PUT',{roles:[roles[key].key],expected_roles_version:m.roles_version});
    }
    const source=await f.upload('reader-regression synthetic source');
    const query=s=>({operation:'query',question:'reader-regression',retrieval:{raw:true,published_wiki:false,source_revision_ids:[s.current_revision_id]}});
    const stored=id=>f.tx(f.context,{},function*(tx){return yield* tx.get('job',id);});
    const related=(table,id)=>f.tx(f.context,{},function*(tx){return yield* tx.all(table,{where:{job_id:id}});});
    const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
    async function admit(body=query(source),status=202,key=randomUUID()) {
      const response=await fetch(f.api.baseUrl+f.root+'/jobs',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${member.token}`,'X-Org-Id':member.orgId,'Idempotency-Key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
      const value=await response.json();f.api.http.push({method:'POST',route:f.root+'/jobs',actor:member.userId,status:response.status,body:value});
      assert.equal(response.status,status,JSON.stringify(value));return value;
    }
    process.env.WIKI_LOCAL_MODEL_CONFIG=JSON.stringify(p.config);
    await t.test('HTTP reader-only raw-first query, retry/cancel and mutation negatives',async()=>{
      await assign('reader');
      await request(member,`${f.root}/sources/${source.id}/revisions/${source.current_revision_id}`);
      assert.equal((await request(member,f.root+'/pages')).items.length,0);
      const key=randomUUID(),job=await admit(query(source),202,key);
      assert.equal((await admit(query(source),200,key)).id,job.id);
      const result=await jobs.runWikiJob(c,job.id);
      const visible=await request(member,f.root+'/jobs/'+job.id);
      assert.equal(visible.state,'succeeded');assert.deepEqual(visible.result,result);
      assert.equal(result.review_state,'unreviewed');assert.equal(result.citation_validation,'anchors_valid');
      assert.equal(result.citations[0].revision_id,source.current_revision_id);assert.equal(result.change_set_id,null);
      assert.equal(result.retrieval_coverage.published_wiki,false);
      const upload={kind:'upload',filename:'denied.txt',mime:'text/plain',content_base64:Buffer.from('denied').toString('base64')};
      await request(member,f.root+'/sources','POST',upload,403);
      await request(member,`${f.root}/sources/${source.id}/revisions`,'POST',{expected_version:source.version,filename:'denied.txt',mime:'text/plain',content_base64:upload.content_base64},403);
      await request(member,`${f.root}/sources/${source.id}`,'DELETE',{expected_version:source.version},403);
      const project=mode==='pg' ? await request(f.a,'/pg/projects','POST',{name:'Reader mutation negative'},201) : null;
      const documentBody={title:'Reader cannot modify',content:'immutable original',...(project ? {project_id:project.id} : {visibility:'org'})};
      const document=await request(f.a,f.prefix+'/documents','POST',documentBody,201);
      const detail=await request(f.a,f.prefix+'/documents/'+document.id);
      await request(member,f.prefix+'/documents','POST',documentBody,403);
      await request(member,f.prefix+'/documents/'+document.id,'PATCH',{version:detail.version,content:'forbidden edit'},403);
      assert.equal((await request(f.a,f.prefix+'/documents/'+document.id)).version,detail.version);
      await request(member,f.root+'/jobs/'+job.id+'/draft','POST',{},403);
      await reject(()=>jobs.draftWikiQuery(c,job.id),'PERMISSION_DENIED');
      await admit({operation:'ingest',source_revision_ids:[source.current_revision_id]},403);
      await admit({operation:'lint',page_revision_ids:['not-a-page']},403);
      await admit({...query(source),write:true},400);
      for(const table of ['source','page','page_revision','change_set','publication']) {
        await reject(async()=>f.tx(c,{write:true,authorization:'read',bookkeeping:true},function*(tx){yield* tx.insert(table,{});}),'PERMISSION_DENIED');
        await reject(async()=>store.withKnowledgeJobTransaction(c,{jobId:job.id},function*(tx){yield* tx.insert(table,{});}),'INVALID_JOB_OPERATION');
      }
      await reject(async()=>store.withKnowledgeJobTransaction(c,{jobId:job.id},function*(tx){yield* tx.update('job',job.id,{operation:'ingest'});}),'INVALID_JOB_OPERATION');
      await reject(async()=>store.withKnowledgeJobTransaction(c,{jobId:job.id},function*(tx){yield* tx.updateWiki({generation:99});}),'INVALID_JOB_OPERATION');
      const cancelled=await admit();await request(member,f.root+'/jobs/'+cancelled.id+'/cancel','POST',{});
      const retry=await admit();p.gate.mode='unavailable';
      await reject(()=>jobs.runWikiJob(c,retry.id),'MODEL_UNAVAILABLE');p.gate.mode='valid';
      await request(member,f.root+'/jobs/'+retry.id+'/retry','POST',{});await jobs.runWikiJob(c,retry.id);
      assert.equal((await request(member,f.root+'/jobs/'+retry.id)).state,'succeeded');
      assert.equal((await related('change_set',job.id)).length,0);
      checks.push('reader-only HTTP raw query/replay/read/retry/cancel; source/manual-page/publication/draft capability negatives; no client bypass');
    });
    for (const surface of ['HTTP','service']) for (const replay of [false,true]) {
      await t.test(`${surface} exact query draft ${replay ? 'replay' : 'creation'} requires current read and write`,async()=>{
        await assign('reader');const job=await admit(),result=await jobs.runWikiJob(c,job.id);
        const resultBytes=(await stored(job.id)).result_json;
        await assign('writer');
        const prior=replay ? await jobs.draftWikiQuery(c,job.id) : null;
        const snapshot=()=>f.tx(f.context,{},function*(tx){
          const rows={};
          for (const table of ['job','job_attempt','job_input','change_set','dependency','event','page','page_revision','publication']) rows[table]=yield* tx.all(table,{orderBy:['id']});
          return rows;
        });
        await assign('writeOnly');
        try {
          await request(member,f.root+'/jobs/'+job.id,'GET',undefined,403);
          await reject(()=>jobs.getWikiJob(c,job.id),'PERMISSION_DENIED');
          // The original storage write contract intentionally does not require read.
          assert.ok(await f.tx(c,{write:true},function*(tx){return tx.wiki.id;}));
          const before=await snapshot();
          if (surface==='HTTP') await request(member,f.root+'/jobs/'+job.id+'/draft','POST',{},403);
          else await reject(()=>jobs.draftWikiQuery(c,job.id),'PERMISSION_DENIED');
          assert.deepEqual(await snapshot(),before,'denied conversion/replay must leave every stored row unchanged');
          await assign('writer');
          const direct=await jobs.draftWikiQuery(c,job.id);
          const http=await request(member,f.root+'/jobs/'+job.id+'/draft','POST',{});
          assert.deepEqual(http,direct);if (prior) assert.deepEqual(direct,prior);
          const drafts=await related('change_set',job.id);assert.equal(drafts.length,1);
          const proposed=JSON.parse(drafts[0].proposed_revisions_json);
          assert.deepEqual(proposed[0].provenance.exact_result,result);
          assert.equal(proposed[0].markdown,result.answer_md);
          assert.equal((await stored(job.id)).result_json,resultBytes);
          checks.push(`${surface} read-revoked draft ${replay ? 'replay' : 'creation'} denied without mutation; restored read+write exact immutable draft/replay succeeds`);
        } finally {await assign('reader');}
      });
    }
    await t.test('write-only revocation during exact dispatch event does not strand research',async()=>{
      await assign('writer');const job=await admit();
      p.gate.hold=Promise.withResolvers();const entered=p.dispatched();
      const pending=jobs.runWikiJob(c,job.id).then(value=>({value}),error=>({error}));
      try {
        await entered;const row=await stored(job.id),lease={owner:row.lease_owner,fence:row.fence,attempt_id:row.current_attempt_id};
        await assign('reader');await request(member,`${f.root}/sources/${source.id}/revisions/${source.current_revision_id}`);
        await jobs.heartbeatWikiJob(c,job.id,lease);
      } finally {p.gate.hold.resolve();p.gate.hold=null;}
      const outcome=await pending;assert.equal(outcome.error,undefined);assert.equal(outcome.value.review_state,'unreviewed');
      assert.equal((await request(member,f.root+'/jobs/'+job.id)).state,'succeeded');
      await request(member,f.root+'/jobs/'+job.id+'/draft','POST',{},403);
      await assign('writer');const ingest=await admit({operation:'ingest',source_revision_ids:[source.current_revision_id]});await assign('reader');
      await request(member,f.root+'/jobs/'+ingest.id+'/retry','POST',{},403);
      await request(member,f.root+'/jobs/'+ingest.id+'/cancel','POST',{},403);
      await reject(()=>jobs.claimWikiJob(c,ingest.id,'not-a-writer',{}),'PERMISSION_DENIED');
      await reject(async()=>store.withKnowledgeJobTransaction(c,{jobId:ingest.id,operation:'query'},function*(){}),'INVALID_JOB_OPERATION');
      await assign('writer');await request(member,f.root+'/jobs/'+ingest.id+'/cancel','POST',{});await assign('reader');
      checks.push('write-only HTTP role revocation during inference preserves heartbeat, atomic acceptance and reader result; stored ingestion cannot borrow query authority');
    });
    await t.test('read revocation blocks disclosure, retires/fences active and queued jobs',async()=>{
      await assign('writer');const job=await admit(),queued=await admit();
      p.gate.hold=Promise.withResolvers();const entered=p.dispatched();
      const pending=jobs.runWikiJob(c,job.id).then(value=>({value}),error=>({error}));let lease;
      try {
        await entered;const row=await stored(job.id);lease={owner:row.lease_owner,fence:row.fence,attempt_id:row.current_attempt_id};
        await assign('denied');await request(member,f.root+'/jobs/'+job.id,'GET',undefined,403);
        await request(member,f.root+'/jobs/'+job.id+'/retry','POST',{},403);
        await reject(()=>jobs.heartbeatWikiJob(c,job.id,lease),'PERMISSION_DENIED');
      } finally {p.gate.hold.resolve();p.gate.hold=null;}
      assert.equal((await pending).error.code,'PERMISSION_DENIED');
      const row=await stored(job.id);assert.equal(row.state,'failed');assert.equal(row.failure_code,'PERMISSION_DENIED');
      assert.equal(row.result_json,null);assert.equal(row.lease_owner,null);assert.ok(row.fence>lease.fence);
      assert.equal((await related('job_attempt',job.id))[0].failure_code,'PERMISSION_DENIED');
      assert.equal((await related('change_set',job.id)).length,0);
      await reject(()=>jobs.runWikiJob(c,queued.id),'PERMISSION_DENIED');assert.equal((await stored(queued.id)).state,'failed');
      await assign('reader');await reject(()=>jobs.acceptWikiResult(c,job.id,lease,{}),'LEASE_LOST');
      checks.push('actual read-role revocation denies all private reads/renewal/late acceptance; running and queued metadata retired with incremented fence');
    });
    await t.test('trusted retirement checks current denial, ownership and exact live lease',async()=>{
      await assign('reader');const job=await admit();
      assert.equal(await store.retireUnauthorizedWikiJob(c,job.id),false);
      const {createLocalWikiCompiler}=await import('../src/services/knowledge-wiki-compiler.service.js');
      const model=await createLocalWikiCompiler(p.config).inspect();
      const lease=await jobs.claimWikiJob(c,job.id,'retirement-fence',model);
      await assign('denied');
      assert.equal(await store.retireUnauthorizedWikiJob(c,job.id),false);
      assert.equal(await store.retireUnauthorizedWikiJob(c,job.id,{...lease,fence:lease.fence+1}),false);
      assert.equal(await store.retireUnauthorizedWikiJob(store.wikiContext({...c,actorId:f.b.userId}),job.id,lease),false);
      assert.equal((await stored(job.id)).state,'running');
      await f.tx(f.context,{write:true},function*(tx){yield* tx.update('job',job.id,{lease_until:'2000-01-01T00:00:00.000Z'});});
      assert.equal(await store.retireUnauthorizedWikiJob(c,job.id,lease),false);
      const calls=p.calls.length,errors=[];
      const {startWikiWorker}=await import('../src/services/knowledge-wiki-worker.service.js');
      const worker=startWikiWorker({stores:[mode],onError:error=>errors.push(error)});
      try {await worker.wake();}finally {await worker.stop();}
      assert.equal((await stored(job.id)).state,'failed');assert.equal(p.calls.length,calls);
      assert.ok(errors.some(error=>error.job_id===job.id && error.code==='PERMISSION_DENIED'));
      assert.equal(await store.retireUnauthorizedWikiJob(c,job.id,lease),false);
      await assign('reader');await reject(()=>jobs.heartbeatWikiJob(c,job.id,lease),'LEASE_LOST');
      checks.push('metadata retirement denies authorized/foreign/live-without-lease/wrong-fence/expired-owner calls; real scheduler retires inaccessible expired job without dispatch');
    });
    await t.test('source revocation terminates reader query without result or draft',async()=>{
      await assign('reader');const s=await f.upload('reader-regression revoked source'),job=await admit(query(s));
      p.gate.hold=Promise.withResolvers();const entered=p.dispatched();const pending=jobs.runWikiJob(c,job.id).then(value=>({value}),error=>({error}));
      try {await entered;await request(f.a,`${f.root}/sources/${s.id}`,'DELETE',{expected_version:s.version});}
      finally {p.gate.hold.resolve();p.gate.hold=null;}
      assert.equal((await pending).error.code,'LEASE_LOST');
      const row=await stored(job.id);assert.equal(row.state,'unavailable');assert.equal(row.failure_code,'SOURCE_REVOKED');assert.equal(row.result_json,null);assert.equal(row.lease_until,null);
      await request(member,f.root+'/jobs/'+job.id,'GET',undefined,409);
      await request(member,f.root+'/jobs/'+job.id+'/retry','POST',{},409);
      assert.equal((await related('change_set',job.id)).length,0);
      checks.push('source withdrawal during reader inference blocks result and retry and terminates job');
    });
  } finally {
    delete process.env.WIKI_LOCAL_MODEL_CONFIG;await p.close();await f.close({readerRevision:true,checks});
  }
}
