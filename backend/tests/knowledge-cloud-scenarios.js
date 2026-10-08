import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setupJobs } from './deadline-wiki-jobs-fixture.js';

export async function cloudFixture() {
  const calls=[], gate={mode:'valid',catalogHold:null}, events=new EventEmitter();
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;
    calls.push({path:req.url,body,authorization:req.headers.authorization});
    res.setHeader('Content-Type','application/json');
    if(req.url==='/models')return res.end(JSON.stringify({data:[{id:'synthetic-chat',context_length:32768,supported_parameters:['structured_outputs','response_format']}]}));
    if(req.url==='/embeddings/models' && gate.catalogHold) {events.emit('catalog');await gate.catalogHold.promise;}
    if(req.url==='/embeddings/models')return res.end(JSON.stringify({data:gate.mode==='unsupported'?[]:[{id:'synthetic-embedding',context_length:8192,architecture:{output_modalities:['embeddings']}}]}));
    if(gate.mode==='failure'){res.statusCode=401;return res.end(JSON.stringify({error:'must-not-leak-provider-body'}));}
    if(req.url==='/embeddings')return res.end(JSON.stringify({model:body.model,data:body.input.map((_,index)=>({index,embedding:gate.mode==='invalid-vector'?[0,0]:[1,0,0]})).reverse()}));
    if(req.url!=='/chat/completions'){res.statusCode=404;return res.end('{}');}
    const catalog=JSON.parse(body.messages.find(m=>m.role==='user').content);
    const refs=gate.mode==='citation'?[999]:[0];
    const output={answer_md:catalog.operation==='query'?'합성 근거 답변':null,citations:refs,uncertainty:[],pages:catalog.operation==='query'?[]:[{key:'draft',target_page_id:null,kind:'page',title:'합성 초안',markdown:'합성 근거 검토 초안',index_entry:'- 합성 초안',citations:refs,links:[]}],suggestions:[]};
    res.end(JSON.stringify({model:gate.mode==='alias'?'synthetic-chat-2026':body.model,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:600,completion_tokens:100}}));
  });
  const ready=once(server,'listening',{signal:AbortSignal.timeout(10000)});server.listen(0,'127.0.0.1');await ready;
  return {baseUrl:`http://127.0.0.1:${server.address().port}`,calls,gate,events,async close(){gate.catalogHold?.resolve();await new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();});}};
}

export async function exerciseKnowledgeCloud(mode,{surface}={}) {
  const f=await setupJobs(mode),wire=await cloudFixture();
  const {env}=await import('../src/config/env.js');
  const old={...env};
  Object.assign(env,{aiProvider:'echo',openrouterBaseUrl:wire.baseUrl,externalModel:'synthetic-chat',openrouterApiKey:'synthetic-shared',aiKeyEncryptionKey:Buffer.alloc(32,7).toString('base64')});
  process.env.ORBITFLOW_DOCUMENT_OPENROUTER_EMBEDDING_MODEL='synthetic-embedding';
  const jobs=await import('../src/services/knowledge-wiki-jobs.service.js');
  const {startWikiWorker}=await import('../src/services/knowledge-wiki-worker.service.js');
  const request=f.api.request, root=f.prefix+'/documents';
  let worker;
  try {
    await request(f.a,f.prefix+'/agent/api-key','PUT',{api_key:'synthetic-personal'});
    const source=await f.upload('SYNTHETIC_CLOUD_SOURCE');
    const headers={'Content-Type':'application/json',Authorization:`Bearer ${f.a.token}`,'X-Org-Id':f.a.orgId,'Idempotency-Key':randomUUID()};
    const admitted=await fetch(f.api.baseUrl+f.root+'/jobs',{method:'POST',headers,body:JSON.stringify({operation:'ingest',source_revision_ids:[source.current_revision_id]}),signal:AbortSignal.timeout(10000)});
    assert.equal(admitted.status,202);const job=await admitted.json();
    const errors=[];worker=startWikiWorker({stores:[mode],onError:e=>errors.push(e)});await worker.wake();await worker.stop();worker=null;
    const result=await request(f.a,f.root+'/jobs/'+job.id);
    assert.equal(result.state,'succeeded',JSON.stringify({result,errors}));
    assert.equal(result.result.review_state,'unreviewed');assert.equal(result.result.citation_validation,'anchors_valid');
    assert.ok(result.result.change_set_id);assert.equal((await request(f.a,f.root+'/pages')).items.length,0);
    assert.ok(wire.calls.some(c=>c.path==='/chat/completions'&&c.authorization==='Bearer synthetic-personal'));
    assert.ok(!JSON.stringify(result).includes('synthetic-personal'));assert.ok(!JSON.stringify(result).includes('synthetic-shared'));
    const original=await request(f.a,`${f.root}/sources/${source.id}/revisions/${source.current_revision_id}`);
    assert.ok(JSON.stringify(original).includes('SYNTHETIC_CLOUD_SOURCE'));
    await request(f.b,f.root+'/jobs/'+job.id,'GET',undefined,404);
    wire.gate.mode='alias';
    const alias=(await jobs.admitWikiJob(f.context,{operation:'query',question:'SYNTHETIC',retrieval:{raw:true,published_wiki:false,source_revision_ids:[source.current_revision_id]}},randomUUID())).job;
    const aliased=await jobs.runWikiJob(f.context,alias.id);
    assert.equal(aliased.provenance.accounting.actual_model,'synthetic-chat-2026');
    assert.equal(aliased.citation_validation,'anchors_valid');
    wire.gate.mode='citation';
    const forged=(await jobs.admitWikiJob(f.context,{operation:'ingest',source_revision_ids:[source.current_revision_id]},randomUUID())).job;
    await assert.rejects(()=>jobs.runWikiJob(f.context,forged.id),e=>e.code==='INVALID_CITATION');
    wire.gate.mode='failure';
    const failed=(await jobs.admitWikiJob(f.context,{operation:'ingest',source_revision_ids:[source.current_revision_id]},randomUUID())).job;
    await assert.rejects(()=>jobs.runWikiJob(f.context,failed.id),e=>e.code==='OPENROUTER_UNAVAILABLE');
    assert.equal((await jobs.getWikiJob(f.context,failed.id)).state,'unavailable');
    wire.gate.mode='valid';
    let project;
    if(mode==='pg')project=await request(f.a,'/pg/projects','POST',{name:'Synthetic cloud project'},201);
    const upload=async(actor,text,extra={})=>request(actor,root+'/upload','POST',{filename:'synthetic.md',mime:'text/markdown',content_base64:Buffer.from(text).toString('base64'),...(mode==='pg'?{project_id:String(project.id)}:{}),...extra},201);
    const document=await upload(f.a,'SYNTHETIC_EMBEDDING_SOURCE');
    const status=await request(f.a,`${root}/${document.id}/analysis?wait=1`);
    assert.equal(status.state,'ready',JSON.stringify(status));assert.equal(status.local_only,false);
    assert.ok(wire.calls.some(c=>c.path==='/embeddings'&&c.authorization==='Bearer synthetic-personal'));
    assert.ok(wire.calls.filter(c=>c.path==='/chat/completions').every(c=>!JSON.stringify(c.body).includes('SYNTHETIC_EMBEDDING_SOURCE')));
    if(mode==='legacy') {
      for(const sensitivity of ['sensitive','confidential','personal']){
        const before=wire.calls.length;
        const restricted=await upload(f.a,'DO_NOT_TRANSFER_'+sensitivity,{sensitivity});
        if(sensitivity==='confidential') {
          assert.equal(restricted.analysis,null);
          await request(f.a,`${root}/${restricted.id}/analysis?wait=1`,'GET',undefined,404);
          assert.equal(wire.calls.length,before);continue;
        }
        const local=await request(f.a,`${root}/${restricted.id}/analysis?wait=1`);
        assert.equal(local.local_only,true);assert.equal(wire.calls.length,before);
        const registered=await request(f.a,f.root+'/sources','POST',{kind:'record',origin_kind:'document',origin_id:restricted.id,version:restricted.version},201);
        const privateJob=(await jobs.admitWikiJob(f.context,{operation:'ingest',source_revision_ids:[registered.current_revision_id]},randomUUID())).job;
        await assert.rejects(()=>jobs.runWikiJob(f.context,privateJob.id),e=>e.code==='MODEL_UNAVAILABLE');
        assert.equal(wire.calls.length,before);
      }
      const another=await upload(f.a,'SYNTHETIC_PUBLIC_AGAIN');await request(f.a,`${root}/${another.id}/analysis?wait=1`);
      assert.ok(wire.calls.every(c=>!JSON.stringify(c.body).includes('DO_NOT_TRANSFER_')));
    }
    delete process.env.ORBITFLOW_DOCUMENT_OPENROUTER_EMBEDDING_MODEL;
    const unavailable=await request(f.a,`${root}/${document.id}/analysis?wait=1`,'POST',{});
    assert.equal(unavailable.state,'unavailable');assert.equal(unavailable.reason,'embedding_model_not_configured');
    process.env.ORBITFLOW_DOCUMENT_OPENROUTER_EMBEDDING_MODEL='synthetic-embedding';wire.gate.mode='unsupported';
    const unsupported=await upload(f.a,'SYNTHETIC_UNSUPPORTED');const unsupportedStatus=await request(f.a,`${root}/${unsupported.id}/analysis?wait=1`);
    assert.equal(unsupportedStatus.state,'unavailable');assert.equal(unsupportedStatus.reason,'embedding_model_unsupported');
    assert.ok(!wire.calls.some(c=>c.path==='/embeddings'&&JSON.stringify(c.body).includes('SYNTHETIC_UNSUPPORTED')));
    wire.gate.mode='invalid-vector';
    const invalid=await upload(f.a,'SYNTHETIC_INVALID_VECTOR');
    const invalidStatus=await request(f.a,`${root}/${invalid.id}/analysis?wait=1`);
    assert.equal(invalidStatus.state,'error');assert.equal(invalidStatus.reason,'invalid_embeddings');
    wire.gate.mode='valid';
    // 같은 회사의 다른 사용자는 앞 사용자의 벡터/키를 재사용하지 않는다.
    await request(f.b,`${root}/${document.id}/analysis`,'POST',{},404);
    if(mode==='pg') {
      await f.sql('INSERT INTO org.company_memberships(company_id,user_id) VALUES ($1,$2)',[f.context.companyId,f.b.userId]);
      await f.sql('INSERT INTO org.user_roles(user_id,role_id) SELECT $1,ur.role_id FROM org.user_roles ur JOIN org.roles r ON r.id=ur.role_id WHERE ur.user_id=$2 AND r.company_id=$3',[f.b.userId,f.a.userId,f.context.companyId]);
    } else await f.sql('INSERT INTO membership(id,tenant_id,org_id,user_id,roles,created_at,updated_at,status) SELECT ?,tenant_id,org_id,?,roles,created_at,updated_at,status FROM membership WHERE user_id=? AND org_id=?',[randomUUID(),f.b.userId,f.a.userId,f.context.companyId]);
    const colleague={...f.b,orgId:f.a.orgId};
    await request(colleague,f.prefix+'/agent/api-key','PUT',{api_key:'synthetic-colleague'});
    const beforeColleague=wire.calls.length;
    const colleagueStatus=await request(colleague,`${root}/${document.id}/analysis?wait=1`,'POST',{});
    assert.equal(colleagueStatus.state,'ready');
    assert.ok(wire.calls.slice(beforeColleague).some(c=>c.path==='/embeddings'&&c.authorization==='Bearer synthetic-colleague'));
    await request(colleague,f.root+'/jobs/'+job.id,'GET',undefined,404);
    // 같은 사람의 다른 회사 선택에도 기존 회사 키를 재사용하지 않는다.
    const second=await request(f.a,mode==='pg'?'/pg/companies':'/tenants','POST',{name:'Synthetic second scope',...(mode==='pg'?{}:{type:'custom'}),modules:['documents','agent','projects'],features:[],departments:[]},201);
    const switched={...f.a,orgId:second.org_id};
    const metadata=await request(switched,f.prefix+'/agent/api-key');assert.equal(metadata.credential_mode,'shared');
    await request(switched,`${root}/${document.id}/analysis`,'POST',{},404);
    // 모델 목록 조회 중 권한이 철회되면 본문 전송 전에 중단한다.
    wire.gate.catalogHold=Promise.withResolvers();const catalog=once(wire.events,'catalog',{signal:AbortSignal.timeout(10000)});
    const revoked=await upload(f.a,'SYNTHETIC_REVOKED_BEFORE_TRANSFER');await catalog;
    if(mode==='pg')await f.sql("UPDATE org.company_memberships SET status='suspended' WHERE user_id=$1 AND company_id=$2",[f.a.userId,f.context.companyId]);
    else await f.sql("UPDATE membership SET status='inactive' WHERE user_id=? AND org_id=?",[f.a.userId,f.context.companyId]);
    const {documentSemantic,documentSemanticScope,pgDocumentSemanticScope}=await import('../src/services/document-semantic.service.js');
    const scope=mode==='pg'?pgDocumentSemanticScope({userId:f.a.userId,companyId:f.context.companyId}):documentSemanticScope({userId:f.a.userId,tenantId:f.context.tenantId,orgId:f.context.companyId});
    const finished=documentSemantic.wait(scope,revoked.id);wire.gate.catalogHold.resolve();await finished;wire.gate.catalogHold=null;
    assert.ok(!wire.calls.some(c=>c.path==='/embeddings'&&JSON.stringify(c.body).includes('SYNTHETIC_REVOKED_BEFORE_TRANSFER')));
    if(mode==='pg')await f.sql("UPDATE org.company_memberships SET status='active' WHERE user_id=$1 AND company_id=$2",[f.a.userId,f.context.companyId]);
    else await f.sql("UPDATE membership SET status='active' WHERE user_id=? AND org_id=?",[f.a.userId,f.context.companyId]);
    assert.notEqual((await request(f.a,`${root}/${revoked.id}/analysis`)).state,'ready');
    await request(f.a,f.prefix+'/agent/api-key','DELETE');
    const shared=(await jobs.admitWikiJob(f.context,{operation:'ingest',source_revision_ids:[source.current_revision_id]},randomUUID())).job;
    await jobs.runWikiJob(f.context,shared.id);
    assert.equal(wire.calls.filter(c=>c.path==='/chat/completions').at(-1).authorization,'Bearer synthetic-shared');
    await surface?.(f,wire);
    console.log(JSON.stringify({mode,wiki:'HTTP admission, real worker, strict cited draft',embedding:'catalog + embeddings HTTP, not chat',dispatches:wire.calls.length}));
  } finally {await worker?.stop();Object.assign(env,old);delete process.env.ORBITFLOW_DOCUMENT_OPENROUTER_EMBEDDING_MODEL;await wire.close();await f.close({cloud:true});}
}
