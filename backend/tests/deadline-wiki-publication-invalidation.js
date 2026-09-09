import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function invalidationScenarios(api,fixture,prefix='',native=null) {
  const {ctx,actor,root,draft,publish,tx,publication}=fixture;
  const {canonical,sha256,citationFor}=await import('../src/services/knowledge-wiki-contract.service.js');
  const {retrieveKnowledge}=await import('../src/services/knowledge-wiki-store.service.js');
  const {db}=await import('../src/config/db.js');
  let project;
  if(prefix) project=await api.request(actor,'/pg/projects','POST',{name:'cascade-parent'},201);
  async function origin(name='source',visibility='org') {
    const doc=await api.request(actor,`${prefix}/documents`,'POST',{title:name,content:'private uncited source',...(prefix ? {project_id:project.id}:{visibility})},201);
    const detail=await api.request(actor,`${prefix}/documents/${doc.id}`);
    const source=await api.request(actor,`${root}/sources`,'POST',{kind:'record',origin_kind:'document',origin_id:doc.id,version:detail.version},201);
    const revision=await tx(false,function*(t){return yield* t.sourceRevision(source.current_revision_id);});
    return {doc:detail,source,revision};
  }
  async function chain(raw) {
    const inputs=[{kind:'source_revision',revision_id:raw.id,supplied_text:raw.content,classification:'internal'},
      {kind:'catalog',supplied_text:'uncited catalog summary',classification:'internal',source_revision_ids:[raw.id]},
      {kind:'prior_result',supplied_text:'previous answer',classification:'internal',source_revision_ids:[raw.id]}];
    const b=await draft({inputs,title:'B secret title'});const br=await publish(b);
    const bRevision=await tx(false,function*(t){return yield* t.pageRevision(br.result_json.page_revision_ids[0]);});
    const pageInput={kind:'page_revision',revision_id:bRevision.id,supplied_text:bRevision.markdown,classification:'internal'};
    const c=await draft({inputs:[pageInput],title:'C transitive title'});const cr=await publish(c);
    const running=await tx(true,function*(t){
      const manifest=yield* t.manifest([pageInput]);const now=yield* t.clock();
      const job=yield* t.insert('job',{operation:'lint',request_json:'{}',request_hash:sha256('{}'),actor_id:ctx.actorId,idempotency_key:randomUUID(),state:'running',fence:1,lease_owner:'synthetic-worker',lease_until:'2999-01-01T00:00:00.000Z',source_vector_json:canonical([raw.id]),target_vector_json:'[]',schema_revision_id:t.wiki.active_schema_id,config_version:'synthetic-not-inference',created_at:now,updated_at:now});
      const attempt=yield* t.insert('job_attempt',{job_id:job.id,ordinal:1,fence:1,lease_owner:'synthetic-worker',model_version:'synthetic-not-inference',config_json:'{}',input_manifest_hash:manifest.hash,started_at:now});
      yield* t.persistInputs(job.id,attempt.id,manifest);yield* t.update('job',job.id,{current_attempt_id:attempt.id,input_manifest_hash:manifest.hash});
      return job;
    });
    return {b,br,c,cr,running,inputs};
  }
  const first=await origin();const bundle=await chain(first.revision);
  const graph=await publication.wikiGraph(ctx);assert.equal(graph.nodes.filter(n=>n.page_id).length,2);
  const frozen=await tx(false,function*(t){return yield* t.get('page_revision',bundle.cr.result_json.page_revision_ids[0]);});
  // Generic PATCH is a different caller from the dedicated document editor.
  const patchPath=prefix ? `/pg/records/documents/${first.doc.id}` : `/documents/${first.doc.id}`;
  let signalGate,stopSignal,signalTimeout;
  if(native){
    const {subscribeWikiChanges}=await import('../src/services/knowledge-wiki-signals.service.js');
    signalGate=Promise.withResolvers();signalTimeout=AbortSignal.timeout(10000);
    const abort=()=>signalGate.reject(signalTimeout.reason);signalTimeout.addEventListener('abort',abort,{once:true});
    stopSignal=await subscribeWikiChanges(ctx,signal=>signalGate.resolve(signal),error=>signalGate.reject(error));
    signalGate.promise.finally(()=>signalTimeout.removeEventListener('abort',abort)).catch(()=>{});
  }
  await api.request(actor,patchPath,'PATCH',{title:'edited source',content:'changed bytes',version:first.doc.version});
  if(native){const signal=await signalGate.promise;assert.equal(signal.wiki_id,(await api.request(actor,root)).wiki.id);stopSignal();}
  const fenced=await tx(false,function*(t){return yield* t.get('job',bundle.running.id);});
  assert.equal(fenced.state,'unavailable');assert.ok(fenced.fence>bundle.running.fence);assert.equal(fenced.failure_code,'SOURCE_REVOKED');
  assert.equal((await publication.wikiGraph(ctx)).nodes.filter(n=>n.page_id).length,0);
  assert.equal((await retrieveKnowledge(ctx,{question:'private',retrieval:{raw:true,published_wiki:true}})).items.length,0);
  for(const input of bundle.inputs) await assert.rejects(async()=>tx(false,function*(t){return yield* t.manifest([input]);}),/SOURCE_REVOKED/);
  assert.equal((await tx(false,function*(t){return yield* t.get('page_revision',frozen.id);})).markdown,frozen.markdown);
  if(!prefix) {
    await api.request(actor,`/documents/${first.doc.id}/restore/1`,'POST',{});
    assert.equal((await publication.wikiGraph(ctx)).nodes.filter(n=>n.page_id).length,0,'restore never makes old revision current again');
  }
  if(!prefix) {
    const agentOrigin=await origin('agent restore');
    const {execute,rollback}=await import('../src/services/agent-executor.service.js');
    const {resolvePrincipal}=await import('../src/middleware/auth.js');
    const principal=resolvePrincipal({get:name=>name.toLowerCase()==='authorization'?`Bearer ${actor.token}`:name.toLowerCase()==='x-org-id'?actor.orgId:undefined});
    const action={id:randomUUID(),tool:'delete.document',input_json:JSON.stringify({document_id:agentOrigin.doc.id})};
    const [,rollbackRef]=execute(principal,action,'task33-agent');
    assert.equal(await tx(false,function*(t){return yield* t.sourceRevision(agentOrigin.revision.id);}),null);
    rollback(principal,{...action,rollback_ref:JSON.stringify(rollbackRef)},'task33-agent-restore');
    const restored=await tx(false,function*(t){return yield* t.sourceRevision(agentOrigin.revision.id);});
    assert.equal(restored.freshness,'stale','unversioned Agent restore cannot revive an old source vector');
  }
  const second=await origin('delete source');const revoked=await chain(second.revision);
  if(prefix) {
    await api.request(actor,`/pg/records/projects/${project.id}`,'DELETE',undefined,409);
    await native.pool.query('DELETE FROM project.projects WHERE id=$1',[project.id]);
    api.http.push({kind:'native-PG-cascade',parent_project_id:project.id,origin_document_id:second.doc.id});
  } else await api.request(actor,`/documents/${second.doc.id}`,'DELETE');
  await assert.rejects(async()=>publication.pageHistory(ctx,revoked.cr.result_json.pages[0].id),/NOT_FOUND/);
  assert.equal((await tx(false,function*(t){return yield* t.get('job',revoked.running.id);})).state,'unavailable');
  await assert.rejects(async()=>publication.inspectChangeSet(ctx,revoked.b.id),/NOT_FOUND/);
  await assert.rejects(async()=>publish(revoked.b),/CHANGE_SET_STATE|NOT_FOUND|SOURCE_REVOKED/);
  const clean=await api.request(actor,`${root}/sources`,'POST',{kind:'upload',filename:'clean-rebuild.md',mime:'text/markdown',content_base64:Buffer.from('fresh public rebuild evidence').toString('base64')},201);
  const cleanRaw=await tx(false,function*(t){return yield* t.sourceRevision(clean.current_revision_id);});
  const rebuild=await draft({ids:[revoked.br.result_json.pages[0].id],inputs:[{kind:'source_revision',revision_id:cleanRaw.id,supplied_text:cleanRaw.content,classification:'internal'}],title:'clean rebuild'});
  const review=await publication.inspectChangeSet(ctx,rebuild.id);assert.equal(review.diff[0].before,null);assert.equal(review.diff[0].before_state,'unavailable');
  const rebuilt=await publish(rebuild);assert.equal(rebuilt.result_json.pages[0].version,2);
  const rebuiltDeps=await tx(false,function*(t){return yield* t.all('dependency',{where:{dependent_page_revision_id:rebuilt.result_json.page_revision_ids[0]}});});
  assert.deepEqual(rebuiltDeps.map(d=>d.source_revision_id),[cleanRaw.id]);
  assert.equal(await tx(false,function*(t){return yield* t.pageRevision(revoked.cr.result_json.page_revision_ids[0]);}),null,'old transitive C is not revived by a clean B rebuild');
  // Missed optimizer event: mutate without the invalidation trigger. Read checks are authoritative.
  if(prefix) project=await api.request(actor,'/pg/projects','POST',{name:'missed-event-parent'},201);
  const missed=await origin('missed event');const missedBundle=await chain(missed.revision);
  if(native) {
    await native.pool.query('ALTER TABLE project.documents DISABLE TRIGGER wiki_origin_invalidation');
    try{await native.pool.query('UPDATE project.documents SET content_md=$2 WHERE id=$1',[missed.doc.id,'missed raw change']);}
    finally{await native.pool.query('ALTER TABLE project.documents ENABLE TRIGGER wiki_origin_invalidation');}
  } else {
    const trigger=db().prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='wiki_document_update'").get().sql;
    db().exec('DROP TRIGGER wiki_document_update');
    try{db().prepare('UPDATE document SET content=? WHERE id=?').run('missed raw change',missed.doc.id);}
    finally{db().exec(trigger);}
  }
  assert.deepEqual((await publication.wikiGraph(ctx)).nodes.filter(n=>n.page_id).map(n=>n.page_id),[rebuilt.result_json.pages[0].id]);
  await assert.rejects(async()=>tx(false,function*(t){const saved=yield* t.storedManifest(missedBundle.running.id,(yield* t.get('job',missedBundle.running.id)).current_attempt_id);return yield* t.manifest(saved.inputs);}),/SOURCE_REVOKED/);
  api.http.push({kind:'transitive-invalidation',store:ctx.store,fence_before:bundle.running.fence,fence_after:fenced.fence,reason:fenced.failure_code,missed_event_read_gate:true,original_revision_hash:sha256(frozen.markdown)});
  return {origin,chain};
}
