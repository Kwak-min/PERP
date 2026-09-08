import assert from 'node:assert/strict';

export async function exerciseAuthorization(api, fixture, prefix = '') {
  const {a,b} = fixture, root = `${prefix}/documents/wiki`, request = (...args) => api.request(...args);
  const {wikiContext,withKnowledgeTransaction,retrieveKnowledge} = await import('../src/services/knowledge-wiki-store.service.js');
  const {canonical,sha256} = await import('../src/services/knowledge-wiki-contract.service.js');
  const email = `wiki-reader-${prefix ? 'pg' : 'legacy'}@example.invalid`;
  const role = await request(a,'/settings/roles','POST',{name:'wiki-reader',scope:'all',permissions:['menu.documents','document.read','document.write']},201);
  let member;
  if (prefix) {
    const created = await request(a,'/pg/members','POST',{email,name:'Wiki reader',password:'password-1234'},201);
    const login = await request(null,'/pg/auth/login','POST',{email,password:'password-1234'});
    member = {userId:String(created.id),token:login.token,orgId:a.orgId};
  } else {
    const invite = await request(a,'/members/invites','POST',{email,roles:[role.key]},201);
    const signup = await request(null,'/auth/signup','POST',{email,name:'Wiki reader',password:'password-1234',invitation_token:invite.token},201);
    member = {userId:signup.user.id,token:signup.access_token,orgId:a.orgId};
  }
  const getMembership = async () => (await request(a,'/settings/members')).items.find(m=>m.user_id===member.userId);
  let membership = await getMembership();
  await request(a,`/settings/members/${membership.membership_id}/roles`,'PUT',{roles:[role.key],expected_roles_version:membership.roles_version});
  const upload = await request(a,`${root}/sources`,'POST',{kind:'upload',filename:'visible.md',mime:'text/markdown',content_base64:Buffer.from('유일 검색 근거').toString('base64')},201);
  await request(member,`${root}/sources/${upload.id}/revisions/${upload.current_revision_id}`);
  const company = await request(a,`${root}`);
  const scope = company.wiki;
  const ctx = actor => wikiContext({store:prefix ? 'pg' : 'legacy',scope:'company',actorId:actor.userId,tenantId:scope.tenant_id,companyId:scope.company_id});
  const memberContext = ctx(member);
  assert.equal((await retrieveKnowledge(memberContext,{question:'유일',retrieval:{raw:true,published_wiki:true}})).items.length,1);
  // 기존 문서 API의 원본을 등록한다. company/private는 기존 저장소가 지원하는 경우만 사용한다.
  let project;
  if (prefix) project = await request(a,'/pg/projects','POST',{name:'Wiki document origin'},201);
  const document = await request(a,`${prefix}/documents`,'POST',{title:'원본 문서',content:'유일 비공개 catalog',...(prefix ? {project_id:project.id} : {visibility:'private'})},201);
  const detail = await request(a,`${prefix}/documents/${document.id}`);
  const source = await request(a,`${root}/sources`,'POST',{kind:'record',origin_kind:'document',origin_id:document.id,version:detail.version},201);
  if (!prefix) {
    await request(member,`${root}/sources/${source.id}/revisions/${source.current_revision_id}`,'GET',undefined,404);
    const publicOnly = await retrieveKnowledge(memberContext,{question:'유일',retrieval:{raw:true,published_wiki:true}});
    assert.deepEqual(publicOnly.items.map(i=>i.id),[upload.current_revision_id]);
    assert.equal(publicOnly.coverage.authorized_candidates,1,'private candidates excluded before ranking and coverage counts');
    const page = await withKnowledgeTransaction(ctx(a),{write:true},function*(tx) {
      const created = new Date().toISOString();
      const p = yield* tx.insert('page',{kind:'entity',created_at:created});
      const rev = yield* tx.insert('page_revision',{page_id:p.id,title:'유일 비밀 파생 제목',markdown:'유일 비밀 파생 본문',index_entry:'비밀 index',content_sha256:sha256('유일 비밀 파생 본문'),citations_json:'[]',links_json:'[]',provenance_json:'{}',input_manifest_hash:sha256('uncited catalog'),schema_revision_id:tx.wiki.active_schema_id,actor_id:a.userId,created_at:created});
      yield* tx.insert('dependency',{dependent_page_revision_id:rev.id,source_revision_id:source.current_revision_id,relation:'transitive'});
      const cs = yield* tx.insert('change_set',{actor_id:a.userId,state:'published',proposed_revisions_json:canonical([rev.id]),expected_heads_json:'[]',lineage_json:canonical([source.current_revision_id]),schema_revision_id:tx.wiki.active_schema_id,input_manifest_hash:rev.input_manifest_hash,manifest_hash:sha256(rev.id),created_at:created});
      yield* tx.insert('publication',{change_set_id:cs.id,actor_id:a.userId,idempotency_key:'private-fixture',manifest_hash:cs.manifest_hash,result_json:canonical({page_revision_ids:[rev.id]}),created_at:created});
      yield* tx.update('page',p.id,{state:'published',published_head_id:rev.id});
      return {p,rev};
    });
    assert.equal((await request(a,`${root}/pages`)).items.length,1);
    assert.equal((await request(member,`${root}/pages`)).items.length,0);
    for (const projection of ['index.md','log.md','schema.md']) {
      const response = await fetch(api.baseUrl + `${root}/${projection}`,{headers:{Authorization:`Bearer ${member.token}`,'X-Org-Id':member.orgId},signal:AbortSignal.timeout(10000)});
      const body = await response.text();
      assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'private, no-store');
      if (projection === 'index.md') assert.equal(body,'');
      assert.ok(!body.includes(page.rev.title));
      api.http.push({method:'GET',route:`${root}/${projection}`,actor:member.userId,status:response.status,body});
    }
    await request(member,`${root}/pages/${page.p.id}?revision=${page.rev.id}`,'GET',undefined,404);
    assert.equal((await retrieveKnowledge(memberContext,{question:'유일',retrieval:{raw:true,published_wiki:true}})).items.length,1,'uncited private input hides published output');
    const changed = await request(a,`/documents/${document.id}`,'PATCH',{version:detail.version,visibility:'org'});
    await request(member,`${root}/sources/${source.id}/revisions/${source.current_revision_id}`,'GET',undefined,404,'old private revision remains restricted');
    assert.ok(changed.version>detail.version);
  }
  // 원본 삭제는 등록 철회 여부와 무관하게 현재 원본 인가로 거절한다.
  await request(a,prefix ? `/pg/records/documents/${document.id}` : `/documents/${document.id}`,'DELETE');
  await request(a,`${root}/sources/${source.id}/revisions/${source.current_revision_id}`,'GET',undefined,404);
  await request(b,`${root}/sources/${upload.id}/revisions/${upload.current_revision_id}`,'GET',undefined,404);
  membership = await getMembership();
  await request(a,`/settings/members/${membership.membership_id}/roles`,'PUT',{roles:[],expected_roles_version:membership.roles_version});
  await request(member,`${root}/sources`,'GET',undefined,403);
  await assert.rejects(async () => retrieveKnowledge(memberContext,{question:'유일',retrieval:{raw:true,published_wiki:true}}),/PERMISSION_DENIED/);
  membership = await getMembership();
  await request(a,`/settings/members/${membership.membership_id}/roles`,'PUT',{roles:[role.key],expected_roles_version:membership.roles_version});
  await request(member,`${root}/sources`);
  await request(a,`/settings/roles/${role.key}`,'DELETE',{expected_version:role.version},204);
  await request(member,`${root}/sources`,'GET',undefined,403);
  await assert.rejects(async () => retrieveKnowledge(memberContext,{question:'유일',retrieval:{raw:true,published_wiki:true}}),/PERMISSION_DENIED/);
  await withKnowledgeTransaction(ctx(a),{write:true},function*(tx) {
    for (let i=0;i<21;i++) yield* tx.register({kind:'upload',filename:`limit-${i}.txt`,mime:'text/plain',content_base64:Buffer.from('overflow-marker-unique').toString('base64')});
  });
  await assert.rejects(async () => retrieveKnowledge(ctx(a),{question:'overflow-marker-unique',retrieval:{raw:true,published_wiki:false}}),/CONTEXT_LIMIT/);
  await assert.rejects(async () => retrieveKnowledge(ctx(a),{question:'유일',retrieval:{raw:false,published_wiki:false}}),/VALIDATION_ERROR/);
}
