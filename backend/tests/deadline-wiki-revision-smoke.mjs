// Independent-review reproduction adapted only to the revised consumer signatures.
// Storage publication fixtures below are not Task32/33 workflow evidence.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startDeadlineServer } from './deadline-fixture.js';
import { startOrgPostgres } from './pg-org-native-fixture.js';

const mode = process.argv[2];
assert.ok(['legacy','pg'].includes(mode));
const prefix = mode === 'pg' ? '/pg' : '';
const api = await startDeadlineServer();
let native, nativeData;
const checks = [], observations = {};
function check(name, actual, expected) {
  let pass = true;
  try { assert.deepEqual(actual, expected); } catch { pass = false; }
  checks.push({name, actual, expected, pass});
  console.log(`${pass ? 'PASS' : 'NEEDS_FIX'} ${name}: ${JSON.stringify(actual)}`);
}
const rejects = async fn => { try { await fn(); return null; } catch(error) { return {code:error.code ?? null,status:error.status ?? error.statusCode ?? null,message:error.message}; } };
try {
  if (mode === 'pg') {
    native = await startOrgPostgres();
    const {pgPool} = await import('../src/config/pg.js');
    Object.assign(pgPool.options,{host:'127.0.0.1',port:Number(process.env.PG_PORT),database:'postgres',user:'org_test',password:'',connectionTimeoutMillis:5000});
    for (const file of ['perp_additions_v11_deadline_roles.sql','perp_additions_v9_daily_corrections.sql','perp_additions_v15_knowledge_wiki.sql']) await native.pool.query(await readFile(new URL(`../../db/${file}`,import.meta.url),'utf8'));
    observations.engine = (await native.pool.query('SELECT version()')).rows[0].version;
    nativeData = (await native.pool.query('SHOW data_directory')).rows[0].data_directory;
  }
  const {wikiContext,withKnowledgeTransaction:txn,retrieveKnowledge:retrieve} = await import('../src/services/knowledge-wiki-store.service.js');
  const {sha256,canonical,citationFor,freezeManifest} = await import('../src/services/knowledge-wiki-contract.service.js');
  const {db} = await import('../src/config/db.js');
  const request = api.request;
  async function company(name) {
    const signup = await request(null,`${prefix}/auth/signup`,'POST',{name,email:`review-${name}-${mode}@example.invalid`,password:'password-1234'},201);
    const actor = {token:signup.access_token ?? signup.token,userId:String(signup.user.id)};
    const created = await request(actor, prefix ? '/pg/companies' : '/tenants','POST',{name,...(prefix ? {} : {type:'custom'}),modules:['documents','agent','projects'],features:[],departments:[]},201);
    actor.orgId = created.org_id;
    return actor;
  }
  const a = await company('A'), b = await company('B');
  const root = `${prefix}/documents/wiki`, personal = `${prefix}/vault/wiki`;
  const context = actor => wikiContext({store:mode,scope:'company',actorId:actor.userId,companyId:prefix ? actor.orgId.slice(3) : actor.orgId,tenantId:prefix ? null : db().prepare('SELECT tenant_id FROM organization WHERE id=?').get(actor.orgId).tenant_id});
  const ca = context(a), cb = context(b);
  const upload = (actor,text,filename='same.md') => request(actor,`${root}/sources`,'POST',{kind:'upload',filename,mime:'text/markdown',content_base64:Buffer.from(text).toString('base64')},201);
  check('empty HTTP root stays unmaterialized',(await request(a,root)).wiki,null);
  const s1 = await upload(a,'ANCHOR Korean 한글😀\r\nrepeat\r\nrepeat');
  const s2 = await upload(a,'UNCITED catalog contribution');
  const s3 = await upload(a,'UNCITED instruction contribution');
  const foreign = await upload(b,'FOREIGN body');
  check('same-name distinct uploads do not overwrite identities',new Set([s1.id,s2.id,s3.id]).size,3);
  const emptyRaw = await retrieve(ca,{question:'ANCHOR',retrieval:{raw:true,published_wiki:true}});
  check('raw-first no published pages',[emptyRaw.items.length,(await request(a,`${root}/pages`)).items.length],[1,0]);
  const raw = emptyRaw.items[0];
  const note = await request(a,`${prefix}/vault/notes`,'POST',{title:'manual same',content:'manual never rewritten 한글'},201);
  const beforeNote = await request(a,`${prefix}/vault/notes/${note.id}`);
  await request(a,`${personal}/sources`,'POST',{kind:'record',origin_kind:'note',origin_id:note.id,version:note.version},201);
  check('manual title body version preserved',await request(a,`${prefix}/vault/notes/${note.id}`),beforeNote);
  const otherNote = await request(a,`${prefix}/vault/notes`,'POST',{title:'manual same',folder:'/second',content:'second identity'},prefix ? 201 : 409);
  if (prefix) check('same-title manual record identity is distinct',otherNote.id !== note.id,true);
  else check('legacy same-title conflict leaves original intact',await request(a,`${prefix}/vault/notes/${note.id}`),beforeNote);
  for (const path of [`${root}/sources/${s2.id}/revisions/${s1.current_revision_id}`,`${root}/sources/${foreign.id}/revisions/${foreign.current_revision_id}`,`${root}/sources/%00/revisions/not-an-id`,`${root}/pages/not-an-id?revision[]=bad`]) await request(a,path,'GET',undefined,404);
  for (const id of [foreign.current_revision_id,'missing']) {
    const error = await rejects(()=>retrieve(ca,{question:'FOREIGN',retrieval:{raw:true,published_wiki:true,source_revision_ids:[id]}}));
    check(`foreign/unavailable selected id rejected ${id=== 'missing' ? 'malformed' : 'foreign'}`,error?.message,'NOT_FOUND');
  }
  const manifest = await txn(ca,{},function*(tx) { return yield* tx.manifest([
    {kind:'source_revision',revision_id:raw.id,supplied_text:raw.content,classification:'internal'},
    {kind:'catalog',supplied_text:'full supplied uncited catalog',classification:'internal',source_revision_ids:[s2.current_revision_id],provenance:{catalog_version:'catalog-review-v1'}},
    {kind:'instruction',supplied_text:'instruction context from input 3',classification:'internal',source_revision_ids:[s3.current_revision_id]},
    {kind:'question',supplied_text:'question not evidence',classification:'personal'},
    {kind:'schema_revision',revision_id:tx.wiki.active_schema_id,supplied_text:(yield* tx.get('schema_revision',tx.wiki.active_schema_id)).rules_md,classification:'public'},
    {kind:'prior_result',supplied_text:'prior full result',classification:'internal',source_revision_ids:[s2.current_revision_id],provenance:{result_revision_id:'previous-result-fixture'}},
  ]); });
  const badCitations = [
    {...citationFor(raw),revision_id:foreign.current_revision_id},
    {...citationFor(raw),start_byte:Buffer.byteLength('ANCHOR Korean ')+1},
    {...citationFor(raw),end_byte:999999},
    {...citationFor(raw),revision_sha256:'0'.repeat(64)},
    {...citationFor(raw),span_sha256:'0'.repeat(64)},
    {...citationFor(raw),artifact_kind:'other'},
  ];
  for (let i=0;i<badCitations.length;i++) check(`malformed/foreign citation ${i} rejected`,Boolean(await rejects(()=>txn(ca,{},function*(tx){return yield* tx.validateCitation(badCitations[i],manifest);}))),true);
  for (const input of [
    {kind:'catalog',supplied_text:'foreign',classification:'internal',source_revision_ids:[foreign.current_revision_id]},
    {kind:'page_revision',revision_id:'foreign-page',supplied_text:'foreign',classification:'internal'},
    {kind:'schema_revision',revision_id:'foreign-schema',supplied_text:'foreign',classification:'internal'},
    {kind:'catalog',supplied_text:'missing closure',classification:'internal'},
  ]) check(`malformed/foreign context ${input.kind} rejected`,Boolean(await rejects(()=>txn(ca,{},function*(tx){return yield* tx.manifest([input]);}))),true);
  const stored = await txn(ca,{write:true},function*(tx) {
    const created = yield* tx.clock();
    const job = yield* tx.insert('job',{operation:'query',request_json:'{}',request_hash:sha256('{}'),actor_id:a.userId,idempotency_key:'review-lineage',state:'running',fence:1,source_vector_json:'[]',target_vector_json:'[]',schema_revision_id:tx.wiki.active_schema_id,config_version:'fixture',created_at:created,updated_at:created});
    const attempt = yield* tx.insert('job_attempt',{job_id:job.id,ordinal:1,fence:1,lease_owner:'review',model_version:'storage-fixture-only',config_json:'{}',input_manifest_hash:manifest.hash,started_at:created});
    yield* tx.persistInputs(job.id,attempt.id,manifest);
    const rows = yield* tx.all('job_input',{where:{attempt_id:attempt.id},orderBy:['ordinal']});
    const deps = yield* tx.all('dependency',{where:{dependent_job_id:job.id}});
    function* published(label,dependencyIds) {
      const p = yield* tx.insert('page',{kind:'concept',created_at:created});
      const rev = yield* tx.insert('page_revision',{page_id:p.id,title:label,markdown:`ANCHOR ${label}`,index_entry:`- ${label} secret-alias`,content_sha256:sha256(`ANCHOR ${label}`),citations_json:canonical([citationFor(raw)]),links_json:'[]',provenance_json:'{"fixture":true}',input_manifest_hash:manifest.hash,schema_revision_id:tx.wiki.active_schema_id,actor_id:a.userId,created_at:created});
      for (const dep of dependencyIds) yield* tx.insert('dependency',{dependent_page_revision_id:rev.id,...dep,relation:'transitive'});
      const cs = yield* tx.insert('change_set',{actor_id:a.userId,state:'published',proposed_revisions_json:canonical([rev.id]),expected_heads_json:'[]',lineage_json:'[]',schema_revision_id:tx.wiki.active_schema_id,input_manifest_hash:manifest.hash,manifest_hash:sha256(rev.id),created_at:created});
      yield* tx.insert('publication',{change_set_id:cs.id,actor_id:a.userId,idempotency_key:randomUUID(),manifest_hash:cs.manifest_hash,result_json:canonical({page_revision_ids:[rev.id]}),created_at:created});
      yield* tx.update('page',p.id,{state:'published',published_head_id:rev.id});
      yield* tx.event('page.fixture',{page_revision_id:rev.id});
      return {p,rev};
    }
    const first = yield* published('DERIVED-1',deps.map(d=>({source_revision_id:d.source_revision_id})));
    const second = yield* published('DERIVED-2',[{page_revision_id:first.rev.id}]);
    // Explicitly no receipt: head-only must remain unpublished to readers.
    const draft = yield* tx.insert('page',{kind:'page',created_at:created});
    const draftRev = yield* tx.insert('page_revision',{page_id:draft.id,title:'HEAD-ONLY-DRAFT',markdown:'not published',index_entry:'draft',content_sha256:sha256('not published'),citations_json:'[]',links_json:'[]',provenance_json:'{}',input_manifest_hash:manifest.hash,schema_revision_id:tx.wiki.active_schema_id,actor_id:a.userId,created_at:created});
    yield* tx.update('page',draft.id,{state:'published',published_head_id:draftRev.id});
    return {rows,deps,first,second,draft,draftRev};
  });
  check('all six supplied inputs persist in order',stored.rows.map(r=>r.kind),manifest.inputs.map(i=>i.kind));
  check('uncited catalog/instruction/prior inputs all contribute raw dependencies',stored.deps.map(d=>d.source_revision_id).sort(),[s1.current_revision_id,s2.current_revision_id,s3.current_revision_id].sort());
  const restored = stored.rows.map(r=>JSON.parse(r.input_json));
  check('complete manifest including supplied provenance is recoverable after persistence',freezeManifest(restored).hash,manifest.hash);
  check('head alone does not fabricate published state',(await request(a,`${root}/pages`)).items.length,2);
  await request(a,`${root}/pages/${stored.draft.id}?revision=${stored.draftRev.id}`,'GET',undefined,404);
  await request(a,`${root}/sources/${s2.id}`,'DELETE',{expected_version:s2.version});
  check('uncited dependency withdrawal hides two transitive pages',(await request(a,`${root}/pages`)).items.length,0);
  for (const p of [stored.first,stored.second]) await request(a,`${root}/pages/${p.p.id}?revision=${p.rev.id}`,'GET',undefined,404);
  for (const projection of ['index.md','log.md','schema.md']) {
    const response = await fetch(api.baseUrl+`${root}/${projection}`,{headers:{Authorization:`Bearer ${a.token}`,'X-Org-Id':a.orgId},signal:AbortSignal.timeout(10000)});
    const body = await response.text();
    check(`${projection} no unavailable title/alias leak`,/DERIVED-|secret-alias/.test(body),false);
    api.http.push({method:'GET',route:`${root}/${projection}`,status:response.status,body});
  }
  const retrieval = await retrieve(ca,{question:'ANCHOR',retrieval:{raw:true,published_wiki:true}});
  check('unavailable page excluded from retrieval and counts',[retrieval.items.length,retrieval.coverage.authorized_candidates],[1,2]);
  const casSource = await upload(a,'CAS original','cas.md');
  const gate = Promise.withResolvers();
  const attempts = [1,2].map(async n=>{await gate.promise;const response=await fetch(api.baseUrl+`${root}/sources/${casSource.id}/revisions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${a.token}`,'X-Org-Id':a.orgId},body:JSON.stringify({expected_version:casSource.version,filename:'cas.md',mime:'text/markdown',content_base64:Buffer.from(`CAS ${n}`).toString('base64')}),signal:AbortSignal.timeout(10000)});const body=await response.json();api.http.push({method:'POST',route:`${root}/sources/${casSource.id}/revisions`,status:response.status,body});return response.status;});
  gate.resolve();
  check('concurrent source recapture one winner one conflict',(await Promise.all(attempts)).sort(),[201,409]);
  const rollbackId = randomUUID();
  const rollbackError = await rejects(()=>txn(ca,{write:true},function*(tx){yield* tx.insert('page',{id:rollbackId,kind:'page',created_at:yield* tx.clock()});throw new Error('review-sync-rollback');}));
  check('sync exception rollback',[rollbackError.message,await txn(ca,{},function*(tx){return yield* tx.get('page',rollbackId);})],['review-sync-rollback',null]);
  if (mode === 'pg') {
    const {pgPool} = await import('../src/config/pg.js');
    const connect = pgPool.connect, identities = {};
    pgPool.connect = async function() {
      const client = await connect.call(this), query = client.query, release = client.release;
      client.query = async function(sql,...args) {
        if (!sql.startsWith('INSERT INTO knowledge.event')) return query.call(this,sql,...args);
        identities.before = (await query.call(this,'SELECT pg_backend_pid() AS pid,txid_current()::text AS txid')).rows[0];
        const result = await query.call(this,sql,...args);
        identities.after = (await query.call(this,'SELECT pg_backend_pid() AS pid,txid_current()::text AS txid')).rows[0];
        return result;
      };
      client.release = function(...args) { client.query=query; client.release=release; return release.apply(this,args); };
      return client;
    };
    try { await txn(ca,{write:true},function*(tx){yield* tx.event('review.client-check');}); }
    finally { pgPool.connect = connect; }
    assert.ok(identities.before && identities.after);
    check('native operations same actual client and transaction',identities.before,identities.after);
    observations.nativeIdentities = identities;
  }
  // The exact old escape now fails at the public capability boundary.
  const foreignBefore = await txn(cb,{},function*(tx){return yield* tx.get('source',foreign.id);});
  const sqlError = await rejects(()=>txn(ca,{},function*(tx){yield* tx.rows('UPDATE knowledge_source SET version=version+1 WHERE id=?',[foreign.id]);}));
  check('unrestricted raw SQL is not exposed',Boolean(sqlError),true);
  const foreignAfter = await txn(cb,{},function*(tx){return yield* tx.get('source',foreign.id);});
  check('read-only A transaction cannot write foreign B rows',foreignAfter.version,foreignBefore.version);
  // A final Promise is rejected before COMMIT, independent of its late failure.
  const asyncId = randomUUID(), entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const late = rejects(()=>finish.promise);
  const rejected = rejects(()=>txn(ca,{write:true},function*(tx){yield* tx.insert('page',{id:asyncId,kind:'page',created_at:yield* tx.clock()});entered.resolve();return finish.promise;}));
  await entered.promise;
  finish.reject(new Error('review-late-rejection'));
  check('late rejection remains observable',(await late)?.message,'review-late-rejection');
  check('asynchronous result rejected before commit',(await rejected)?.code,'ASYNC_TRANSACTION_CALLBACK');
  const asyncRow = await txn(ca,{},function*(tx){return yield* tx.get('page',asyncId);});
  check('Promise-returning generator must not commit failed operation',asyncRow === null,true);
  observations.persistedManifest = {inputs:manifest.inputs,hash:manifest.hash,restoredHash:freezeManifest(restored).hash,jobInputs:stored.rows};
} finally {
  await api.close();
  if(native) await native.close();
  const evidence = new URL(`../../.omo/evidence/task-31-revision/smoke-${process.env.DEADLINE_RUN_ID}/`,import.meta.url);
  await mkdir(evidence,{recursive:true});
  await writeFile(new URL(`${mode}.json`,evidence),JSON.stringify({mode,checks,observations,http:api.http,cleanup:{...api.resource,nativeRemoved:nativeData ? !existsSync(nativeData) : null}},null,2));
}
process.exitCode = checks.some(c=>!c.pass) ? 1 : 0;
