import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { startDeadlineServer } from './deadline-fixture.js';
import { startOrgPostgres } from './pg-org-native-fixture.js';

export async function localProviderFixture() {
  const events=new EventEmitter(), calls=[], gate={mode:'valid',hold:null};
  const server=createServer(async(req,res)=>{
    if (req.url==='/api/v0/models') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'synthetic-local',state:'loaded',loaded_context_length:32768,arch:'fixture',quantization:'not-a-real-model'}]}));return;}
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());calls.push(body);
    const hold=gate.hold, mode=gate.mode;events.emit('dispatch',body);
    if(hold) await hold.promise;
    if(res.destroyed) return;
    if(mode==='redirect'){res.writeHead(302,{Location:'https://example.invalid/not-followed'});res.end();return;}
    if(mode==='unavailable'){res.writeHead(503);res.end('not available');return;}
    if(mode==='oversized'){res.writeHead(200);res.end('x'.repeat(262145));return;}
    if(mode==='malformed'){res.end('{');return;}
    const catalog=JSON.parse(body.messages.find(m=>m.role==='user').content);
    const citations=catalog.evidence.length ? [0] : [];
    const target=catalog.targets[0];
    const output={answer_md:catalog.operation==='query' && citations.length ? '한글 합성 근거에 대한 검토 전 답변입니다.' : null,citations,uncertainty:['인용 위치는 사실 검증이 아닙니다.'],pages:catalog.operation==='query' ? [] : [{key:'draft',target_page_id:target?.page_id ?? null,kind:'page',title:'검토용 초안',markdown:'합성 원문을 바탕으로 한 검토용 초안입니다.',index_entry:'- 검토용 초안',citations,links:[]}],suggestions:catalog.operation==='lint' ? [{code:'POSSIBLE_CONTRADICTION',message:'모델 검토 제안이며 확정 오류가 아닙니다.',citations}] : []};
    if(mode==='citation') output.citations=[999];
    if(mode==='extra') output.tools=['shell'];
    if(mode==='image') {if(output.pages[0]) output.pages[0].markdown='![x](https://example.invalid/x)';else output.answer_md='![x](https://example.invalid/x)';}
    const message={role:'assistant',content:JSON.stringify(output)};
    if(mode==='tools')message.tool_calls=[{id:'bad'}];
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:body.model,choices:[{finish_reason:'stop',message}],usage:{prompt_tokens:600,completion_tokens:150}}));
  });
  const ready=once(server,'listening',{signal:AbortSignal.timeout(10000)});server.listen(0,'127.0.0.1');await ready;
  const config={base_url:`http://127.0.0.1:${server.address().port}`,model:'synthetic-local',context_tokens:32768,output_tokens:2048,timeout_ms:10000,temperature:0};
  return {config,calls,gate,events,dispatched:()=>once(events,'dispatch',{signal:AbortSignal.timeout(10000)}),async close(){gate.hold?.resolve();await new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();});}};
}

export async function setupJobs(mode) {
  const api=await startDeadlineServer();let native,nativeData;
  if(mode==='pg') {
    native=await startOrgPostgres();
    const {pgPool}=await import('../src/config/pg.js');
    Object.assign(pgPool.options,{host:'127.0.0.1',port:Number(process.env.PG_PORT),database:'postgres',user:'org_test',password:'',connectionTimeoutMillis:5000});
    for(const file of ['perp_additions_v11_deadline_roles.sql','perp_additions_v9_daily_corrections.sql','perp_additions_v15_knowledge_wiki.sql'])await native.pool.query(await readFile(new URL(`../../db/${file}`,import.meta.url),'utf8'));
    nativeData=(await native.pool.query('SHOW data_directory')).rows[0].data_directory;
  }
  const {db}=await import('../src/config/db.js');
  const {wikiContext,withKnowledgeTransaction:tx}=await import('../src/services/knowledge-wiki-store.service.js');
  const prefix=mode==='pg'?'/pg':'';
  async function actor(name) {
    const signup=await api.request(null,`${prefix}/auth/signup`,'POST',{name,email:`${name}-${mode}@example.invalid`,password:'password-1234'},201);
    const user={token:signup.access_token??signup.token,userId:String(signup.user.id)};
    const company=await api.request(user,prefix?'/pg/companies':'/tenants','POST',{name,...(prefix?{}:{type:'custom'}),modules:['documents','agent','projects'],features:[],departments:[]},201);
    user.orgId=company.org_id;
    return user;
  }
  const a=await actor('job-a'),b=await actor('job-b');
  const context=wikiContext({store:mode,scope:'company',actorId:a.userId,companyId:prefix?a.orgId.slice(3):a.orgId,tenantId:prefix?null:db().prepare('SELECT tenant_id FROM organization WHERE id=?').get(a.orgId).tenant_id});
  const root=prefix+'/documents/wiki';
  const upload=async(text='한글 합성 원문입니다. 다른 원문 명령은 실행하지 않습니다.')=>api.request(a,root+'/sources','POST',{kind:'upload',filename:'synthetic.md',mime:'text/markdown',content_base64:Buffer.from(text).toString('base64')},201);
  const sql=async(statement,params=[])=>native?native.pool.query(statement,params):db().prepare(statement).run(...params);
  return {api,native,context,tx,db,a,b,prefix,root,upload,sql,
    async close(evidence){await api.close();if(native)await native.close();const dir=new URL(evidence.readerRevision ? '../../.omo/evidence/task-32-reader-revision/' : '../../.omo/evidence/task-32-deadline-erp-redesign/',import.meta.url);await mkdir(dir,{recursive:true});await writeFile(new URL(mode+(evidence.readerRevision ? '-reader-http.json' : evidence.runtime ? '-runtime-http.json' : evidence.smoke ? '-smoke-http.json' : '-jobs.json'),dir),JSON.stringify({mode,...evidence,http:api.http,cleanup:{...api.resource,nativeRemoved:nativeData?!existsSync(nativeData):null}},null,2));},
  };
}

export async function exerciseJobs(mode) {
  const f=await setupJobs(mode),provider=await localProviderFixture(), checks=[];
  const {canonical,sha256}=await import('../src/services/knowledge-wiki-contract.service.js');
  const {createLocalWikiCompiler}=await import('../src/services/knowledge-wiki-compiler.service.js');
  const jobs=await import('../src/services/knowledge-wiki-jobs.service.js');
  const {context:c,tx}=f;
  const model=await createLocalWikiCompiler(provider.config).inspect();
  const admit=async(request,key=randomUUID())=>(await jobs.admitWikiJob(c,request,key,provider.config)).job;
  const ingest=source=>({operation:'ingest',source_revision_ids:[source.current_revision_id],target_base_versions:[]});
  const query=source=>({operation:'query',question:'한글',retrieval:{raw:true,published_wiki:true,source_revision_ids:[source.current_revision_id]}});
  const stored=id=>tx(c,{},function*(t){return yield* t.get('job',id);});
  const expire=id=>tx(c,{write:true},function*(t){yield* t.update('job',id,{lease_until:'2000-01-01T00:00:00.000Z'});});
  const reject=(promise,code)=>assert.rejects(async()=>promise,e=>e.code===code,code);
  try {
    const source=await f.upload(),uncited=await f.upload('한글 인용하지 않은 전체 입력입니다.');
    const request={operation:'ingest',source_revision_ids:[source.current_revision_id,uncited.current_revision_id],target_base_versions:[]};
    const key=randomUUID(), admitted=await Promise.all([jobs.admitWikiJob(c,request,key,provider.config),jobs.admitWikiJob(c,request,key,provider.config)]);
    assert.equal(admitted.filter(a=>a.created).length,1);assert.equal(admitted[0].job.id,admitted[1].job.id);
    await reject(jobs.admitWikiJob(c,ingest(source),key,provider.config),'IDEMPOTENCY_CONFLICT');
    const first=admitted[0].job;
    const entered=provider.dispatched();provider.gate.hold=Promise.withResolvers();
    const pending=jobs.runWikiJob(c,first.id);const observed=pending.then(value=>({value}),error=>({error}));await entered;
    const during=await stored(first.id);
    const manifest=await tx(c,{},function*(t){return yield* t.storedManifest(first.id,during.current_attempt_id);});
    assert.equal(manifest.hash,during.input_manifest_hash);assert.equal(manifest.inputs.filter(i=>i.kind==='source_revision').length,2);
    assert.equal(sha256(canonical(manifest.inputs)),manifest.hash);
    assert.equal(provider.calls[0].messages.map(m=>m.content).join(''),manifest.inputs.map(i=>i.supplied_text).join(''));
    const inferences=provider.calls.length;
    assert.equal(await jobs.claimWikiJob(c,first.id,'competitor',model),null);
    const lease={owner:during.lease_owner,fence:during.fence,attempt_id:during.current_attempt_id};
    await jobs.heartbeatWikiJob(c,first.id,lease);await expire(first.id);
    await reject(jobs.heartbeatWikiJob(c,first.id,lease),'LEASE_LOST');
    const blocked=provider.gate.hold;provider.gate.hold=null;
    const recovered=await jobs.runWikiJob(c,first.id,{owner:'restarted-worker'});
    blocked.resolve();const late=await observed;assert.equal(late.error.code,'LEASE_LOST');
    assert.equal(provider.calls.length,inferences+1);assert.ok(recovered.change_set_id);
    const success=await jobs.getWikiJob(c,first.id);assert.equal(success.attempts.length,2);assert.equal(success.attempts[0].failure_code,'LEASE_EXPIRED');
    const draft=await tx(c,{},function*(t){return yield* t.get('change_set',recovered.change_set_id);});
    const lineage=JSON.parse(draft.lineage_json);assert.deepEqual(lineage,manifest);
    const revisions=JSON.parse(draft.proposed_revisions_json),heads=JSON.parse(draft.expected_heads_json);
    assert.equal(draft.manifest_hash,sha256(canonical({wiki_id:draft.wiki_id,actor_id:draft.actor_id,job_id:draft.job_id,proposed_revisions:revisions,expected_heads:heads,lineage,schema_revision_id:draft.schema_revision_id,input_manifest_hash:draft.input_manifest_hash})));
    assert.equal(revisions[0].citations.length,1);assert.equal(lineage.inputs.filter(i=>i.kind==='source_revision').length,2);
    assert.equal((await f.api.request(f.a,f.root+'/pages')).items.length,0);
    await f.api.request(f.b,f.root+'/jobs/'+first.id,'GET',undefined,404);
    await reject(jobs.retryWikiJob(c,first.id),'JOB_STATE_CONFLICT');
    checks.push('atomic idempotent admission; complete pre-dispatch manifest; DB lease reclaim; expired heartbeat and old acceptance fenced; uncited lineage; drafts never publish');
    if(mode==='pg') {
      await f.sql('INSERT INTO org.company_memberships(company_id,user_id) VALUES ($1,$2)',[c.companyId,f.b.userId]);
      await f.sql('INSERT INTO org.user_roles(user_id,role_id) SELECT $1,ur.role_id FROM org.user_roles ur JOIN org.roles r ON r.id=ur.role_id WHERE ur.user_id=$2 AND r.company_id=$3',[f.b.userId,f.a.userId,c.companyId]);
    }else await f.sql('INSERT INTO membership(id,tenant_id,org_id,user_id,roles,created_at,updated_at,status) SELECT ?,tenant_id,org_id,?,roles,created_at,updated_at,status FROM membership WHERE user_id=? AND org_id=?',[randomUUID(),f.b.userId,f.a.userId,c.companyId]);
    const {wikiContext}=await import('../src/services/knowledge-wiki-store.service.js');
    const otherAdmin=wikiContext({...c,actorId:f.b.userId});
    assert.ok(await tx(otherAdmin,{},function*(t){return yield* t.sourceRevision(source.current_revision_id);}));
    await reject(jobs.getWikiJob(otherAdmin,first.id),'NOT_FOUND');await reject(jobs.claimWikiJob(otherAdmin,first.id,'foreign-admin',model),'NOT_FOUND');
    checks.push('same-company administrator can read permitted raw source but cannot read or claim another actor private job');

    const q=await admit(query(source)),answer=await jobs.runWikiJob(c,q.id);
    assert.equal(answer.review_state,'unreviewed');assert.equal(answer.citation_validation,'anchors_valid');assert.equal(answer.provenance.anchor_meaning,'traceability_not_verified_truth');
    assert.equal(answer.retrieval_coverage.published_wiki,true);
    assert.equal(answer.retrieval_coverage.selected_spans[0].revision_id,source.current_revision_id);
    assert.equal(answer.retrieval_coverage.selected_spans[0].start_byte,0);
    const before=(await stored(q.id)).result_json;
    const [qd1,qd2]=await Promise.all([jobs.draftWikiQuery(c,q.id),jobs.draftWikiQuery(c,q.id)]);assert.deepEqual(qd1,qd2);
    assert.equal((await stored(q.id)).result_json,before);
    const qdraft=await tx(c,{},function*(t){return yield* t.get('change_set',qd1.change_set_id);});
    assert.equal(JSON.parse(qdraft.proposed_revisions_json)[0].markdown,answer.answer_md);
    assert.deepEqual(JSON.parse(qdraft.proposed_revisions_json)[0].provenance.exact_result,answer);
    const empty=await admit({operation:'query',question:'NO_MATCH',retrieval:{raw:true,published_wiki:false}}),count=provider.calls.length;
    const noEvidence=await jobs.runWikiJob(c,empty.id);assert.equal(noEvidence.answer_md,null);assert.equal(noEvidence.citation_validation,'no_evidence');assert.equal(provider.calls.length,count);
    await reject(jobs.draftWikiQuery(c,empty.id),'NO_EVIDENCE');
    checks.push('raw-first unreviewed cited query; exact immutable query draft replay; no-evidence distinct from model failure');
    const unconfigured=(await jobs.admitWikiJob(c,query(source),randomUUID(),null)).job;
    await reject(jobs.runWikiJob(c,unconfigured.id),'MODEL_UNAVAILABLE');assert.equal((await jobs.getWikiJob(c,unconfigured.id)).state,'unavailable');
    const emptyWithoutModel=(await jobs.admitWikiJob(c,{operation:'query',question:'NO_MATCH_WITHOUT_MODEL',retrieval:{raw:true,published_wiki:false}},randomUUID(),null)).job;
    assert.equal((await jobs.runWikiJob(c,emptyWithoutModel.id)).citation_validation,'no_evidence');
    checks.push('missing configuration is durable unavailable; no-evidence needs no model or model metadata');

    for (const [mode,code] of [['malformed','MODEL_OUTPUT_INVALID'],['oversized','MODEL_OUTPUT_LIMIT'],['redirect','MODEL_REDIRECT'],['tools','MODEL_OUTPUT_INVALID'],['extra','MODEL_OUTPUT_INVALID'],['image','MODEL_OUTPUT_INVALID'],['citation','INVALID_CITATION'],['unavailable','MODEL_UNAVAILABLE']]) {
      provider.gate.mode=mode;const j=await admit(query(source));await reject(jobs.runWikiJob(c,j.id),code);
      const failed=await jobs.getWikiJob(c,j.id);assert.ok(['failed','unavailable'].includes(failed.state));assert.equal(failed.failure_code,code);assert.equal(failed.attempts.length,1);
      assert.equal(await jobs.claimWikiJob(c,j.id,'no-auto-retry',model),null);
      provider.gate.mode='valid';await jobs.retryWikiJob(c,j.id);assert.equal((await jobs.runWikiJob(c,j.id)).review_state,'unreviewed');
    }
    checks.push('malformed oversized redirect tools extra-fields images forged-citation provider-unavailable; no automatic validation retry; explicit retry succeeds');
    const exhausted=await admit(query(source));provider.gate.mode='malformed';
    for(let attempt=1;attempt<=3;attempt++){await reject(jobs.runWikiJob(c,exhausted.id),'MODEL_OUTPUT_INVALID');if(attempt<3)await jobs.retryWikiJob(c,exhausted.id);}
    await reject(jobs.retryWikiJob(c,exhausted.id),'ATTEMPTS_EXHAUSTED');provider.gate.mode='valid';
    const lost=await admit(query(source));
    for(let n=1;n<=3;n++){assert.ok(await jobs.claimWikiJob(c,lost.id,'lost-'+n,model));await expire(lost.id);}
    assert.equal(await jobs.claimWikiJob(c,lost.id,'fourth',model),null);assert.equal((await jobs.getWikiJob(c,lost.id)).failure_code,'ATTEMPTS_EXHAUSTED');
    checks.push('three bounded explicit failure attempts and three DB-clock lost-worker attempts');

    async function lateMutation(action,code) {
      const s=await f.upload(),j=await admit(ingest(s));provider.gate.hold=Promise.withResolvers();const entered=provider.dispatched();
      const observed=jobs.runWikiJob(c,j.id).then(value=>({value}),error=>({error}));await entered;
      await action(s,j);provider.gate.hold.resolve();provider.gate.hold=null;
      const outcome=await observed;assert.equal(outcome.error.code,code);
      assert.equal((await tx(c,{},function*(t){return yield* t.all('change_set',{where:{job_id:j.id}});})).length,0);
      return {s,j};
    }
    await lateMutation(async(s,j)=>{await jobs.cancelWikiJob(c,j.id);assert.equal((await jobs.cancelWikiJob(c,j.id)).failure_code,'CANCELLED');},'LEASE_LOST');
    const changed=await lateMutation(async s=>{await f.api.request(f.a,`${f.root}/sources/${s.id}/revisions`,'POST',{expected_version:s.version,filename:'new.md',mime:'text/markdown',content_base64:Buffer.from('한글 새 원문').toString('base64')},201);},'SOURCE_REVOKED');
    await reject(jobs.retryWikiJob(c,changed.j.id),'SOURCE_REVOKED');await reject(jobs.getWikiJob(c,changed.j.id),'SOURCE_REVOKED');
    await f.api.request(f.a,`${f.root}/sources/${uncited.id}`,'DELETE',{expected_version:uncited.version});
    await reject(jobs.getWikiJob(c,first.id),'SOURCE_REVOKED');
    await reject(jobs.admitWikiJob(c,request,key,provider.config),'SOURCE_REVOKED');
    checks.push('event-barrier cancel/source change late acceptance rejection; source changes demand new job; uncited source revocation denies replay/result');

    // Account revocation is an actual database authority change, not a mocked predicate.
    const aclSource=await f.upload(),aclJob=await admit(ingest(aclSource));provider.gate.hold=Promise.withResolvers();const aclEntered=provider.dispatched();
    const aclObserved=jobs.runWikiJob(c,aclJob.id).then(value=>({value}),error=>({error}));await aclEntered;
    if(mode==='pg')await f.sql("UPDATE auth.users SET account_status='suspended' WHERE id=$1",[f.a.userId]);else await f.sql("UPDATE app_user SET auth_status='disabled' WHERE id=?",[f.a.userId]);
    await reject(jobs.getWikiJob(c,aclJob.id),'PERMISSION_DENIED');provider.gate.hold.resolve();provider.gate.hold=null;
    assert.equal((await aclObserved).error.code,'PERMISSION_DENIED');
    if(mode==='pg')await f.sql("UPDATE auth.users SET account_status='active' WHERE id=$1",[f.a.userId]);else await f.sql("UPDATE app_user SET auth_status='active' WHERE id=?",[f.a.userId]);
    const retired=await stored(aclJob.id);assert.equal(retired.result_json,null);assert.equal(retired.state,'failed');assert.equal(retired.failure_code,'PERMISSION_DENIED');assert.equal(retired.lease_until,null);
    checks.push('late worker and private read blocked after actual account ACL revocation');

    // Atomic acceptance failure after draft inserts: native triggers reject final job write.
    const atomic=await admit(ingest(source)),leaseAtomic=await jobs.claimWikiJob(c,atomic.id,'atomic',model);
    const atomicManifest=await tx(c,{},function*(t){return yield* t.storedManifest(atomic.id,leaseAtomic.attempt_id);});
    const envelope=await createLocalWikiCompiler(provider.config).compile(atomicManifest);
    if(mode==='pg') await f.native.pool.query("CREATE FUNCTION knowledge.test_reject_success() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'acceptance-injected'; END $$; CREATE TRIGGER test_reject_success BEFORE UPDATE ON knowledge.job FOR EACH ROW WHEN (NEW.state='succeeded') EXECUTE FUNCTION knowledge.test_reject_success()");
    else f.db().exec("CREATE TRIGGER test_reject_success BEFORE UPDATE ON knowledge_job WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'acceptance-injected'); END");
    await assert.rejects(async()=>jobs.acceptWikiResult(c,atomic.id,leaseAtomic,envelope),/acceptance-injected/);
    assert.equal((await tx(c,{},function*(t){return yield* t.all('change_set',{where:{job_id:atomic.id}});})).length,0);
    assert.equal((await stored(atomic.id)).state,'running');
    if(mode==='pg')await f.native.pool.query('DROP TRIGGER test_reject_success ON knowledge.job; DROP FUNCTION knowledge.test_reject_success()');else f.db().exec('DROP TRIGGER test_reject_success');
    assert.ok((await jobs.acceptWikiResult(c,atomic.id,leaseAtomic,envelope)).change_set_id);
    checks.push('SQLite/nativePG final acceptance write failure rolls back draft dependencies events and result; exact lease can retry acceptance');

    // Lint input is explicitly a published storage fixture, not Task33 publication evidence.
    const lintPage=await tx(c,{write:true},function*(t){
      const now=yield* t.clock(),page=yield* t.insert('page',{kind:'page',created_at:now});
      const revision=yield* t.insert('page_revision',{page_id:page.id,title:'한글 구조 검사',markdown:'한글 검토 대상',index_entry:'',content_sha256:sha256('한글 검토 대상'),citations_json:'[]',links_json:'[]',provenance_json:'{"fixture":"storage-only"}',input_manifest_hash:atomicManifest.hash,schema_revision_id:t.wiki.active_schema_id,actor_id:c.actorId,created_at:now});
      yield* t.insert('dependency',{dependent_page_revision_id:revision.id,source_revision_id:source.current_revision_id,relation:'direct'});
      const cs=yield* t.insert('change_set',{actor_id:c.actorId,state:'published',proposed_revisions_json:'[]',expected_heads_json:'[]',lineage_json:canonical(atomicManifest),schema_revision_id:t.wiki.active_schema_id,input_manifest_hash:atomicManifest.hash,manifest_hash:sha256(page.id),created_at:now});
      yield* t.insert('publication',{change_set_id:cs.id,actor_id:c.actorId,idempotency_key:randomUUID(),manifest_hash:cs.manifest_hash,result_json:canonical({page_revision_ids:[revision.id]}),created_at:now});
      yield* t.update('page',page.id,{state:'published',published_head_id:revision.id});return {page,revision};
    });
    const lint=await admit({operation:'lint',page_revision_ids:[lintPage.revision.id]}),lintResult=await jobs.runWikiJob(c,lint.id);
    assert.ok(lintResult.issues.some(i=>i.kind==='structural'&&i.code==='EMPTY_INDEX_ENTRY'));
    assert.ok(lintResult.issues.some(i=>i.kind==='model_suggestion'));assert.ok(lintResult.change_set_id);
    assert.equal((await tx(c,{},function*(t){return yield* t.get('page',lintPage.page.id);})).published_head_id,lintPage.revision.id);
    checks.push('lint deterministic structural issue versus model suggestion; review proposal leaves published head intact');

    const queued=[];for(let n=0;n<20;n++)queued.push(await admit(query(source)));
    await reject(admit(query(source)),'QUEUE_LIMIT');for(const j of queued)await jobs.cancelWikiJob(c,j.id);
    await assert.rejects(()=>jobs.admitWikiJob(c,{...query(source),actor_id:f.b.userId},randomUUID(),provider.config),e=>e.name==='ZodError');
    // Real HTTP admission, state, retry/cancel body strictness and Idempotency-Key.
    process.env.WIKI_LOCAL_MODEL_CONFIG=JSON.stringify(provider.config);
    const httpKey=randomUUID(),headers={'Content-Type':'application/json',Authorization:`Bearer ${f.a.token}`,'X-Org-Id':f.a.orgId,'Idempotency-Key':httpKey};
    const httpResponse=await fetch(f.api.baseUrl+f.root+'/jobs',{method:'POST',headers,body:JSON.stringify(query(source)),signal:AbortSignal.timeout(10000)});
    assert.equal(httpResponse.status,202);assert.match(httpResponse.headers.get('cache-control'),/no-store/);const httpJob=await httpResponse.json();
    assert.equal((await f.api.request(f.a,f.root+'/jobs/'+httpJob.id)).state,'queued');
    await f.api.request(f.a,f.root+'/jobs/'+httpJob.id+'/cancel','POST',{owner_id:'bad'},400);
    await f.api.request(f.a,f.root+'/jobs/'+httpJob.id+'/cancel','POST',{});
    delete process.env.WIKI_LOCAL_MODEL_CONFIG;
    checks.push('scope queue20 limit; real private HTTP202/GET/cancel strict body and no-store');
    const race=await admit(query(source));
    const claims=await Promise.all(['one','two','three'].map(owner=>jobs.claimWikiJob(c,race.id,owner,model)));
    assert.equal(claims.filter(Boolean).length,1);await expire(race.id);
    const {startWikiWorker}=await import('../src/services/knowledge-wiki-worker.service.js');
    const errors=[];const worker=startWikiWorker({stores:[mode],onError:e=>errors.push(e)});
    try {await worker.wake();assert.equal((await jobs.getWikiJob(c,race.id)).state,'succeeded');assert.deepEqual(errors,[]);}finally{await worker.stop();}
    checks.push('native/scoped concurrent claims one winner; private restarted scheduler discovers persisted headers and reclaims');
    return checks;
  } finally {await provider.close();await f.close({checks,provider:{kind:'synthetic-openai-protocol-fixture-not-real-model',dispatches:provider.calls.length},nativeEngine:f.native?'PostgreSQL18':null});}
}
