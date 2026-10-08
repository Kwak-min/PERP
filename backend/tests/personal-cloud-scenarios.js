import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {once} from 'node:events';
import { setupJobs } from './deadline-wiki-jobs-fixture.js';
import { cloudFixture } from './knowledge-cloud-scenarios.js';
export async function personalCloudScenario(mode,{surface}={}) {
 const f=await setupJobs(mode),wire=await cloudFixture();
 const {env}=await import('../src/config/env.js');const old={...env};
 Object.assign(env,{openrouterBaseUrl:wire.baseUrl,openrouterApiKey:'synthetic-shared',externalModel:'synthetic-chat',aiKeyEncryptionKey:Buffer.alloc(32,7).toString('base64')});
 process.env.ORBITFLOW_VAULT_OPENROUTER_EMBEDDING_MODEL='synthetic-embedding';
 const base=f.prefix+'/vault',root=base+'/wiki',r=f.api.request;
 const note=async(title,extra={})=>r(f.a,base+'/notes','POST',{title,content:'PERSONAL_SYNTHETIC_'+title,...extra},201);
 const preview=id=>r(f.a,`${base}/notes/${id}/cloud-preview`,'POST',{});
 const approve=(id,p,actor=f.a,expected=200)=>r(actor,`${base}/notes/${id}/cloud-analyze`,'POST',{token:p.token,confirmed:true},expected);
 try {
  await r(f.a,f.prefix+'/agent/api-key','PUT',{api_key:'synthetic-company-personal-must-not-use'});
  const source=await note('Source'),candidate=await note('Candidate');
  const p=await preview(source.id);assert.equal(wire.calls.length,0,'preview never contacts external provider');
  assert.equal(p.credential_mode,'shared');assert.equal(p.scope.inputs.length,2);assert.ok(p.scope.inputs.every(i=>i.classification==='personal'));
  await r(f.a,`${base}/notes/${source.id}/cloud-analyze`,'POST',{token:p.token,confirmed:false},400);
  await approve(source.id,p,f.b,403);assert.equal(wire.calls.length,0);
  const result=await approve(source.id,p);assert.equal(result.state,'ready');assert.equal(result.local_only,false);assert.equal(result.consent.scope_hash,p.scope_hash);
  assert.ok(wire.calls.filter(c=>c.path==='/embeddings').every(c=>c.authorization==='Bearer synthetic-shared'));
  await approve(source.id,p,f.a,409);
  const changed=await preview(source.id);
  await r(f.a,`${base}/notes/${candidate.id}`,'PATCH',{version:candidate.version,content:'CHANGED_PERSONAL_SYNTHETIC'});
  const before=wire.calls.length;await approve(source.id,changed,f.a,409);assert.equal(wire.calls.length,before);
  if(mode==='legacy') {
   await note('Sensitive',{sensitivity:'sensitive'});await note('Disabled',{agent_enabled:false});
   const safe=await preview(source.id);assert.ok(!JSON.stringify(safe.scope).includes('PERSONAL_SYNTHETIC_Sensitive'));assert.ok(!JSON.stringify(safe.scope).includes('PERSONAL_SYNTHETIC_Disabled'));
  }
  const revoked=await preview(source.id);await r(f.a,`${base}/notes/${source.id}/cloud-preview`,'DELETE',{token:revoked.token});await approve(source.id,revoked,f.a,409);
  const exact=await preview(source.id);await note('NotApprovedCandidate');const beforeExact=wire.calls.length;await approve(source.id,exact);
  assert.ok(wire.calls.slice(beforeExact).filter(c=>c.path==='/embeddings').every(c=>!JSON.stringify(c.body).includes('PERSONAL_SYNTHETIC_NotApprovedCandidate')));
  const held=await preview(source.id),victim=held.scope.inputs.find(i=>i.role==='candidate'&&i.title==='Candidate');
  wire.gate.catalogHold=Promise.withResolvers();const catalog=once(wire.events,'catalog',{signal:AbortSignal.timeout(10000)});
  const failedApproval=approve(source.id,held,f.a,409);await catalog;
  await r(f.a,`${base}/notes/${victim.id}`,'PATCH',{version:mode==='legacy'?Number(victim.version):victim.version,content:'REVOKED_DURING_CATALOG'});
  const beforeDispatch=wire.calls.filter(c=>c.path==='/embeddings').length;wire.gate.catalogHold.resolve();await failedApproval;wire.gate.catalogHold=null;
  assert.equal(wire.calls.filter(c=>c.path==='/embeddings').length,beforeDispatch);
  const modelChanged=await preview(source.id);process.env.ORBITFLOW_VAULT_OPENROUTER_EMBEDDING_MODEL='different-model';await approve(source.id,modelChanged,f.a,409);process.env.ORBITFLOW_VAULT_OPENROUTER_EMBEDDING_MODEL='synthetic-embedding';
  const savedShared=env.openrouterApiKey;env.openrouterApiKey='';await r(f.a,`${base}/notes/${source.id}/cloud-preview`,'POST',{},503);env.openrouterApiKey=savedShared;
  const registered=await r(f.a,root+'/sources','POST',{kind:'record',origin_kind:'note',origin_id:source.id,version:source.version},201);
  const request={operation:'query',question:'PERSONAL_SYNTHETIC',retrieval:{raw:true,published_wiki:false,source_revision_ids:[registered.current_revision_id]}};
  const wp=await r(f.a,root+'/jobs/cloud-preview','POST',request);const calls=wire.calls.length;
  assert.ok(wp.scope.inputs.some(i=>i.classification==='personal'));assert.equal(wire.calls.length,calls);
  const headers={'Content-Type':'application/json',Authorization:`Bearer ${f.a.token}`,'X-Org-Id':f.a.orgId,'Idempotency-Key':randomUUID()};
  const response=await fetch(f.api.baseUrl+root+'/jobs',{method:'POST',headers,body:JSON.stringify({...request,cloud_consent:{token:wp.token,confirmed:true}}),signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,202);const job=await response.json();
  const {wikiContext}=await import('../src/services/knowledge-wiki-store.service.js');
  const context=wikiContext({...f.context,scope:'personal'});
  const jobs=await import('../src/services/knowledge-wiki-jobs.service.js');await jobs.runWikiJob(context,job.id);
  const finished=await r(f.a,root+'/jobs/'+job.id);assert.equal(finished.state,'succeeded');assert.equal(finished.result.review_state,'unreviewed');assert.equal(finished.result.citation_validation,'anchors_valid');assert.equal(finished.result.provenance.consent.scope_hash,wp.scope_hash);
  assert.equal((await r(f.a,root+'/pages')).items.length,0);assert.equal((await r(f.a,base+'/notes/'+source.id)).content,source.content??'PERSONAL_SYNTHETIC_Source');
  const cancelledPreview=await r(f.a,root+'/jobs/cloud-preview','POST',request);
  await r(f.a,root+'/jobs/cloud-preview','DELETE',{token:cancelledPreview.token});
  await assert.rejects(()=>jobs.admitWikiJob(context,{...request,cloud_consent:{token:cancelledPreview.token,confirmed:true}},randomUUID()),e=>e.code==='CONSENT_EXPIRED');
  const altered=await r(f.a,root+'/jobs/cloud-preview','POST',request);
  await assert.rejects(()=>jobs.admitWikiJob(context,{...request,question:'not approved',cloud_consent:{token:altered.token,confirmed:true}},randomUUID()),e=>e.code==='CONSENT_SCOPE_CHANGED');
  if(mode==='legacy'){
   const sensitive=await note('WikiSensitive',{sensitivity:'sensitive'});
   const reg=await r(f.a,root+'/sources','POST',{kind:'record',origin_kind:'note',origin_id:sensitive.id,version:sensitive.version},201);
   await r(f.a,root+'/jobs/cloud-preview','POST',{operation:'ingest',source_revision_ids:[reg.current_revision_id]},403);
   const disabled=await note('WikiDisabled',{agent_enabled:false});
   const disabledReg=await r(f.a,root+'/sources','POST',{kind:'record',origin_kind:'note',origin_id:disabled.id,version:disabled.version},201);
   await r(f.a,root+'/jobs/cloud-preview','POST',{operation:'ingest',source_revision_ids:[disabledReg.current_revision_id]},409);
  }
  const mutable=await note('QueuedMutable');
  const mutableReg=await r(f.a,root+'/sources','POST',{kind:'record',origin_kind:'note',origin_id:mutable.id,version:mutable.version},201);
  const mutableRequest={operation:'ingest',source_revision_ids:[mutableReg.current_revision_id]};
  const queuedPreview=await r(f.a,root+'/jobs/cloud-preview','POST',mutableRequest);
  const queued=(await jobs.admitWikiJob(context,{...mutableRequest,cloud_consent:{token:queuedPreview.token,confirmed:true}},randomUUID())).job;
  await r(f.a,`${base}/notes/${mutable.id}`,'PATCH',{version:mutable.version,content:'CHANGED_AFTER_APPROVAL'});
  const queuedCalls=wire.calls.length;assert.equal(await jobs.runWikiJob(context,queued.id),null);await assert.rejects(()=>jobs.getWikiJob(context,queued.id),e=>e.code==='SOURCE_REVOKED');assert.equal(wire.calls.length,queuedCalls);
  assert.notEqual((await f.tx(context,{},function*(tx){return yield* tx.get('job',queued.id);})).state,'queued');
  assert.ok(wire.calls.filter(c=>c.path==='/chat/completions').every(c=>c.authorization==='Bearer synthetic-shared'));
  const local=(await jobs.admitWikiJob(context,request,randomUUID())).job;
  await assert.rejects(()=>jobs.runWikiJob(context,local.id),e=>e.code==='MODEL_UNAVAILABLE');
  await surface?.({f,wire,base,root,source});
  console.log(JSON.stringify({mode,personalConsent:'explicit exact-version graph+Wiki',sharedOnly:true,noAutoTransfer:true}));
 }finally{Object.assign(env,old);delete process.env.ORBITFLOW_VAULT_OPENROUTER_EMBEDDING_MODEL;await wire.close();await f.close({personalCloud:true});}
}
