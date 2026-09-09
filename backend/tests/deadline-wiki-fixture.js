import assert from "node:assert/strict";
export async function exerciseSources(api, prefix = '', suffix = 'sqlite') {
  const request = (...args) => api.request(...args);
  async function company(name) {
    const signup = await request(null, `${prefix}/auth/signup`, 'POST', { name, email: `${name}@example.invalid`, password: 'password-1234' }, 201);
    const actor = { token: signup.access_token ?? signup.token, userId: String(signup.user.id) };
    const created = await request(actor, prefix ? '/pg/companies' : '/tenants', 'POST', { name, ...(prefix ? {} : {type:'custom'}), modules: ['documents', 'agent', 'projects'], features: [], departments: [] }, 201);
    actor.orgId = created.org_id;
    return actor;
  }
  const a = await company(`wiki-a-${suffix}`), b = await company(`wiki-b-${suffix}`);
  const root = `${prefix}/vault/wiki`, docRoot = `${prefix}/documents/wiki`;
  assert.deepEqual((await request(a, `${root}/pages`)).items, []);
  assert.equal((await request(a,root)).wiki,null,'empty GET does not create wiki rows');
  const text = '한글😀\r\n같은 구절\r\n같은 구절';
  const note = await request(a, `${prefix}/vault/notes`, 'POST', { title: '원본', content: text }, 201);
  const barrier = Promise.withResolvers();
  const attempts = Array.from({length:4},async () => {
    await barrier.promise;
    const response = await fetch(api.baseUrl + `${root}/sources`, { method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${a.token}`,'X-Org-Id':a.orgId},body:JSON.stringify({kind:'record',origin_kind:'note',origin_id:note.id,version:note.version}),signal:AbortSignal.timeout(10000) });
    const body = await response.json();
    api.http.push({method:'POST',route:`${root}/sources`,actor:a.userId,status:response.status,body});
    return {status:response.status,body};
  });
  barrier.resolve();
  const registered = await Promise.all(attempts);
  assert.deepEqual(registered.map(r=>r.status).sort(),[200,200,200,201],JSON.stringify(registered));
  const source = registered.find(r=>r.status===201).body;
  assert.ok(registered.every(r=>r.body.id===source.id));
  const exact = `${root}/sources/${source.id}/revisions/${source.current_revision_id}`;
  assert.equal((await request(a, exact)).content, text);
  await request(b, `${root}/sources/${source.id}/revisions/${source.current_revision_id}`, 'GET', undefined, 404);
  await request(a, `${docRoot}/sources/${source.id}/revisions/${source.current_revision_id}`, 'GET', undefined, 404);
  await request(a, `${root}/sources`, 'POST', { kind: 'record', origin_kind: 'note', origin_id: note.id, version: note.version, owner_id: b.userId }, 400);
  const duplicates = await Promise.all(Array.from({ length: 4 }, () => request(a, `${root}/sources`, 'POST', { kind: 'record', origin_kind: 'note', origin_id: note.id, version: note.version }, 200)));
  assert.ok(duplicates.every(x => x.id === source.id));
  const updated = await request(a, `${prefix}/vault/notes/${note.id}`, 'PATCH', { version: note.version, title: '이름 변경', content: text + '\r\n개정' });
  const historic = await request(a, exact);
  assert.equal(historic.content, text); assert.equal(historic.freshness, 'stale');
  await request(a, `${root}/sources/${source.id}/revisions`, 'POST', { expected_version: source.version, version: note.version }, 409);
  const recaptured = await request(a, `${root}/sources/${source.id}/revisions`, 'POST', { expected_version: source.version, version: updated.version }, 201);
  assert.notEqual(recaptured.current_revision_id, source.current_revision_id);
  await request(a, `${root}/sources/${source.id}`, 'DELETE', { expected_version: source.version }, 409);
  await request(a, `${root}/sources/${source.id}`, 'DELETE', { expected_version: recaptured.version });
  await request(a, exact, 'GET', undefined, 404);
  assert.equal((await request(a, `${prefix}/vault/notes/${note.id}`)).content, text + '\r\n개정');
  const upload = await request(a, `${docRoot}/sources`, 'POST', { kind: 'upload', filename: '지식.md', mime: 'text/markdown', content_base64: Buffer.from(text).toString('base64') }, 201);
  assert.equal((await request(a, `${docRoot}/sources/${upload.id}/revisions/${upload.current_revision_id}`)).origin_version, null);
  await request(b, `${docRoot}/sources/${upload.id}/revisions/${upload.current_revision_id}`, 'GET', undefined, 404);
  await request(a, `${docRoot}/sources`, 'POST', { kind: 'upload', filename: 'x.txt', mime: 'text/plain', content_base64: '/w==' }, 400);
  await request(a, `${docRoot}/sources`, 'POST', { kind: 'upload', filename: 'x.txt', mime: 'text/plain', content_base64: Buffer.alloc(1000001, 65).toString('base64') }, 413);
  const bom = await request(a,`${root}/sources`,'POST',{kind:'upload',filename:'bom.txt',mime:'text/plain',content_base64:Buffer.from('\ufeffBOM').toString('base64')},201);
  const bomRevision = await request(a,`${root}/sources/${bom.id}/revisions/${bom.current_revision_id}`);
  assert.equal(bomRevision.content,'BOM'); assert.notEqual(bomRevision.original_sha256,bomRevision.content_sha256);
  const me = await request(a,prefix ? '/pg/auth/workspace' : '/auth/me');
  const tenantId = prefix ? null : me.organizations.find(o => o.id === a.orgId || o.org_id === a.orgId)?.tenant_id;
  return { a, b, note, source, upload, tenantId };
}

export async function exerciseRetrieval(api, fixture, prefix = '') {
  const {wikiContext,withKnowledgeTransaction,retrieveKnowledge} = await import('../src/services/knowledge-wiki-store.service.js');
  const {sha256,canonical,citationFor} = await import('../src/services/knowledge-wiki-contract.service.js');
  const {a,b,upload} = fixture, root = `${prefix}/documents/wiki`;
  let tenantId = fixture.tenantId;
  if (!prefix && !tenantId) {
    const {db} = await import('../src/config/db.js');
    tenantId = db().prepare('SELECT tenant_id FROM organization WHERE id=?').get(a.orgId).tenant_id;
  }
  const context = wikiContext({store:prefix ? 'pg' : 'legacy',scope:'company',actorId:a.userId,companyId:prefix ? a.orgId.slice(3) : a.orgId,tenantId});
  const raw = await retrieveKnowledge(context,{question:'같은',retrieval:{raw:true,published_wiki:true}});
  assert.equal(raw.items.length,1); assert.equal(raw.items[0].id,upload.current_revision_id);
  assert.equal(raw.items[0].citation.start_byte,0);
  const r = raw.items[0];
  const proof = await withKnowledgeTransaction(context,{write:true},function*(tx) {
    const inputs = [
      {kind:'source_revision',revision_id:r.id,supplied_text:r.content,classification:'internal'},
      {kind:'catalog',supplied_text:'모델에 전달한 전체 catalog',classification:'internal',source_revision_ids:[r.id]},
      {kind:'question',supplied_text:'같은 구절은?',classification:'personal'},
      {kind:'schema_revision',revision_id:tx.wiki.active_schema_id,supplied_text:(yield* tx.get('schema_revision',tx.wiki.active_schema_id)).rules_md,classification:'public'},
    ];
    const manifest = yield* tx.manifest(inputs);
    const created = new Date().toISOString();
    const job = yield* tx.insert('job',{operation:'query',request_json:'{}',request_hash:sha256('{}'),actor_id:a.userId,idempotency_key:'fixture-only',state:'running',fence:1,source_vector_json:canonical([r.id]),target_vector_json:'[]',schema_revision_id:tx.wiki.active_schema_id,config_version:'fixture-only',created_at:created,updated_at:created});
    const attempt = yield* tx.insert('job_attempt',{job_id:job.id,ordinal:1,fence:1,lease_owner:'fixture-only',model_version:'fixture-only-not-inference',config_json:'{}',input_manifest_hash:manifest.hash,started_at:created});
    yield* tx.persistInputs(job.id,attempt.id,manifest);
    const quote = yield* tx.validateCitation(citationFor(r),manifest);
    assert.equal(quote.quote,r.content);
    const second = yield* tx.validateCitation(citationFor(r,Buffer.byteLength('한글😀\r\n같은 구절\r\n'),Buffer.byteLength(r.content)),manifest);
    assert.equal(second.quote,'같은 구절');
    const page = yield* tx.insert('page',{kind:'concept',created_at:created});
    const pageRevision = yield* tx.insert('page_revision',{page_id:page.id,title:'누적 지식',markdown:'같은 구절의 게시 자료',index_entry:'- 누적 지식',content_sha256:sha256('같은 구절의 게시 자료'),citations_json:canonical([citationFor(r)]),links_json:'[]',provenance_json:canonical({origin:'test-published-storage-fixture'}),input_manifest_hash:manifest.hash,schema_revision_id:tx.wiki.active_schema_id,actor_id:a.userId,created_at:created});
    yield* tx.insert('dependency',{dependent_page_revision_id:pageRevision.id,source_revision_id:r.id,relation:'transitive'});
    const change = yield* tx.insert('change_set',{actor_id:a.userId,state:'published',proposed_revisions_json:canonical([pageRevision.id]),expected_heads_json:'[]',lineage_json:canonical([r.id]),schema_revision_id:tx.wiki.active_schema_id,input_manifest_hash:manifest.hash,manifest_hash:sha256(pageRevision.id),created_at:created});
    yield* tx.insert('publication',{change_set_id:change.id,actor_id:a.userId,idempotency_key:'fixture-publication',manifest_hash:change.manifest_hash,result_json:canonical({page_revision_ids:[pageRevision.id]}),created_at:created});
    yield* tx.update('page',page.id,{state:'published',published_head_id:pageRevision.id});
    const saved = yield* tx.all('job_input',{where:{job_id:job.id},orderBy:['ordinal']});
    assert.deepEqual(saved.map(i=>i.kind),inputs.map(i=>i.kind));
    assert.equal(saved.length,4);
    assert.ok(saved.every(i=>i.supplied_sha256===sha256(i.supplied_text)));
    return {page,pageRevision,job,manifest};
  });
  api.http.push({kind:'storage-retrieval-receipt',store:context.store,source_revision_sha256:r.content_sha256,original_sha256:r.original_sha256,extraction_revision_id:r.extraction_revision_id,manifest_hash:proof.manifest.hash,input_hashes:proof.manifest.inputs.map(i=>({kind:i.kind,ordinal:i.ordinal,hash:i.supplied_sha256,raw_closure:i.source_revision_ids}))});
  const foreign = await api.request(b,`${root}/sources`,'POST',{kind:'upload',filename:'foreign.md',mime:'text/markdown',content_base64:Buffer.from('foreign').toString('base64')},201);
  await assert.rejects(async () => withKnowledgeTransaction(context,{write:true},function*(tx) {
    yield* tx.insert('dependency',{dependent_page_revision_id:proof.pageRevision.id,source_revision_id:foreign.current_revision_id,relation:'transitive'});
  }),/foreign key/i);
  await assert.rejects(async () => withKnowledgeTransaction(context,{write:true},function*(tx) {
    yield* tx.update('page_revision',proof.pageRevision.id,{markdown:'overwrite'});
  }),/immutable/);
  await assert.rejects(async () => withKnowledgeTransaction(context,{write:true},function*(tx) {
    const other = yield* tx.insert('page',{kind:'page',created_at:new Date().toISOString()});
    yield* tx.update('page',other.id,{state:'published',published_head_id:proof.pageRevision.id});
  }),/foreign key/i);
  await withKnowledgeTransaction(context,{write:true},function*(tx) {
    assert.match(yield* tx.clock(),/^\d{4}-\d{2}-\d{2}T/);
    const inputs = [...proof.manifest.inputs,{kind:'page_revision',revision_id:proof.pageRevision.id,supplied_text:proof.pageRevision.markdown,classification:'public'}];
    const nextManifest = yield* tx.manifest(inputs);
    assert.equal(nextManifest.inputs.length,5);
    assert.deepEqual(nextManifest.inputs[4].source_revision_ids,[r.id]);
    assert.equal(nextManifest.inputs[4].classification,'internal');
    const attempt = yield* tx.insert('job_attempt',{job_id:proof.job.id,ordinal:2,fence:2,lease_owner:'fixture-only',model_version:'fixture-only-not-inference',config_json:'{}',input_manifest_hash:nextManifest.hash,started_at:yield* tx.clock()});
    yield* tx.update('job',proof.job.id,{fence:2,current_attempt_id:attempt.id});
    yield* tx.persistInputs(proof.job.id,attempt.id,nextManifest);
    assert.deepEqual((yield* tx.all('job_input',{where:{attempt_id:attempt.id},orderBy:['ordinal']})).map(i=>i.kind),['source_revision','catalog','question','schema_revision','page_revision']);
    assert.equal((yield* tx.validateCitation(citationFor({...proof.pageRevision,artifact_kind:'page_revision'}),nextManifest)).quote,proof.pageRevision.markdown);
    api.http.push({kind:'full-page-dispatch-receipt',store:context.store,manifest_hash:nextManifest.hash,inputs:nextManifest.inputs.map(i=>({kind:i.kind,ordinal:i.ordinal,hash:i.supplied_sha256,raw_closure:i.source_revision_ids}))});
  });
  assert.equal((await api.request(a,`${root}/pages`)).items.length,1);
  assert.equal((await retrieveKnowledge(context,{question:'같은',retrieval:{raw:true,published_wiki:true}})).items.length,2);
  const next = await api.request(a,`${root}/sources/${upload.id}/revisions`,'POST',{expected_version:upload.version,filename:'개정.md',mime:'text/markdown',content_base64:Buffer.from('같은 최신 원문').toString('base64')},201);
  assert.equal((await api.request(a,`${root}/pages`)).items.length,0);
  const history = await api.request(a,`${root}/pages/${proof.page.id}?revision=${proof.pageRevision.id}`);
  assert.equal(history.freshness,'stale');
  const after = await retrieveKnowledge(context,{question:'같은',retrieval:{raw:true,published_wiki:true}});
  assert.deepEqual(after.items.map(i=>i.id),[next.current_revision_id]);
  await assert.rejects(async () => retrieveKnowledge(context,{question:'같은',retrieval:{raw:true,published_wiki:false,source_revision_ids:[r.id]}}),/SOURCE_STALE/);
  await api.request(b,`${root}/pages/${proof.page.id}?revision=${proof.pageRevision.id}`,'GET',undefined,404);
  const bad = {...proof.manifest.inputs[0],revision_id:next.current_revision_id};
  await assert.rejects(async () => withKnowledgeTransaction(context,{},function*(tx) { return yield* tx.manifest([bad]); }),/SOURCE_REVOKED/);
  await api.request(a,`${root}/sources/${upload.id}`,'DELETE',{expected_version:next.version});
  await api.request(a,`${root}/pages/${proof.page.id}?revision=${proof.pageRevision.id}`,'GET',undefined,404);
  return {context,proof};
}
