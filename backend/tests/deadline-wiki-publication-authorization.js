import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function authorizationScenarios(api,fixture,prefix='') {
  const {actor,ctx,root,draft,publish,tx,publication}=fixture;
  const {wikiContext,withKnowledgeTransaction,retrieveKnowledge}=await import('../src/services/knowledge-wiki-store.service.js');
  const email=`task33-reader-${prefix?'pg':'sqlite'}@example.invalid`;let reader;
  if(prefix){
    const created=await api.request(actor,'/pg/members','POST',{name:'private draft reader',email,password:'password-1234'},201);
    const login=await api.request(null,'/pg/auth/login','POST',{email,password:'password-1234'});
    reader={userId:String(created.id),token:login.token,orgId:actor.orgId};
  }else{
    const invite=await api.request(actor,'/members/invites','POST',{email,roles:['company_admin']},201);
    const signup=await api.request(null,'/auth/signup','POST',{name:'private draft reader',email,password:'password-1234',invitation_token:invite.token},201);
    reader={userId:signup.user.id,token:signup.access_token,orgId:actor.orgId};
  }
  const membership=async()=>(await api.request(actor,'/settings/members')).items.find(m=>m.user_id===reader.userId);
  let m=await membership();await api.request(actor,`/settings/members/${m.membership_id}/roles`,'PUT',{roles:['company_admin'],expected_roles_version:m.roles_version});
  const rc=wikiContext({...ctx,actorId:reader.userId});
  let project;if(prefix)project=await api.request(actor,'/pg/projects','POST',{name:'ACL source parent'},201);
  const doc=await api.request(actor,`${prefix}/documents`,'POST',{title:'SECRET-UNCITED-TITLE',content:'SECRET-UNCITED-BODY',...(prefix?{project_id:project.id}:{visibility:'org'})},201);
  const detail=await api.request(actor,`${prefix}/documents/${doc.id}`);
  const source=await api.request(actor,`${root}/sources`,'POST',{kind:'record',origin_kind:'document',origin_id:doc.id,version:detail.version},201);
  const revision=await tx(false,function*(t){return yield* t.sourceRevision(source.current_revision_id);});
  const inputs=[{kind:'source_revision',revision_id:revision.id,supplied_text:revision.content,classification:'internal'},{kind:'catalog',supplied_text:'SECRET catalog never cited',classification:'internal',source_revision_ids:[revision.id]}];
  const change=await draft({inputs,title:'SECRET-DERIVED-ALIAS'});
  for(const work of [()=>publication.inspectChangeSet(rc,change.id),()=>publication.rejectChangeSet(rc,change.id,{manifest_hash:change.manifest_hash}),()=>publication.publishChangeSet(rc,change.id,{manifest_hash:change.manifest_hash,confirmed:true},randomUUID())]) await assert.rejects(async()=>work(),/NOT_FOUND/);
  const receipt=await publish(change,'authorization-replay');const page=receipt.result_json.pages[0];
  const shared=await withKnowledgeTransaction(rc,{},function*(t){return yield* t.pageRevision(page.revision_id);});assert.equal(shared.title,'SECRET-DERIVED-ALIAS');assert.equal(shared.citations_json,'[]','uncited input still contributes all permissions');
  const human=await publication.createManualChangeSet(rc,page.id,{expected_version:1,title:'reader human draft',markdown:'reader human body'});
  await assert.rejects(async()=>publication.inspectChangeSet(ctx,human.id),/NOT_FOUND/,'another company admin never inherits private drafts');
  await tx(true,function*(t){yield* t.event('change_set.private',{change_set_id:change.id},{body:'DO-NOT-LEAK',hidden_target_id:'HIDDEN-TARGET'});});
  const events=await publication.wikiEvents(rc);assert.ok(events.items.every(e=>e.change_set_id!==change.id));assert.ok(!JSON.stringify(events).includes('DO-NOT-LEAK'));assert.ok(!JSON.stringify(await publication.wikiEvents(ctx)).includes('HIDDEN-TARGET'));
  if(!prefix){
    await api.request(actor,`/documents/${doc.id}`,'PATCH',{version:detail.version,visibility:'private'});
    await assert.rejects(async()=>publication.inspectChangeSet(rc,human.id),/NOT_FOUND/);
    await assert.rejects(async()=>publication.pageHistory(rc,page.id),/NOT_FOUND/);
    assert.ok(!(await publication.wikiGraph(rc)).nodes.some(n=>n.page_id===page.id));
    assert.ok(!(await publication.wikiEvents(rc)).items.some(e=>e.page_revision_id===page.revision_id));
    const retrieved=await retrieveKnowledge(rc,{question:'SECRET',retrieval:{raw:true,published_wiki:true}});assert.equal(retrieved.items.length,0);
    await assert.rejects(async()=>withKnowledgeTransaction(rc,{},function*(t){return yield* t.manifest([{kind:'prior_result',supplied_text:'old answer',classification:'internal',source_revision_ids:[revision.id]}]);}),/SOURCE_REVOKED/);
    await assert.rejects(async()=>publication.createManualChangeSet(rc,page.id,{expected_version:1,title:'launder',markdown:'erase source'}),/NOT_FOUND/);
    assert.equal((await api.request(actor,`/documents/${doc.id}`)).content,detail.content);
  }else{
    // Native personal inputs cannot be smuggled through company catalogs even by company admin.
    const note=await api.request(actor,'/pg/vault/notes','POST',{title:'private personal',content:'private personal bytes'},201);
    const privateSource=await api.request(actor,'/pg/vault/wiki/sources','POST',{kind:'record',origin_kind:'note',origin_id:note.id,version:note.version},201);
    await assert.rejects(async()=>tx(false,function*(t){return yield* t.manifest([{kind:'catalog',supplied_text:'private previous summary',classification:'internal',source_revision_ids:[privateSource.current_revision_id]}]);}),/SOURCE_REVOKED/);
    assert.equal((await api.request(actor,`/pg/vault/notes/${note.id}`)).content,'private personal bytes');
  }
  m=await membership();await api.request(actor,`/settings/members/${m.membership_id}/roles`,'PUT',{roles:[],expected_roles_version:m.roles_version});
  for(const work of [()=>publication.wikiGraph(rc),()=>publication.pageHistory(rc,page.id),()=>publication.inspectChangeSet(rc,human.id),()=>publication.wikiEvents(rc),()=>publication.publishChangeSet(rc,human.id,{manifest_hash:human.manifest_hash,confirmed:true},'denied-replay')])await assert.rejects(async()=>work(),/PERMISSION_DENIED/);
  api.http.push({kind:'fresh-full-dependency-authorization',store:ctx.store,requesting_actor_only:true,uncited_inputs:inputs.map(i=>i.kind),private_metadata_allowlist:true,revocation_surface_codes:[403,404]});
}
