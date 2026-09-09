import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {sqliteProcessRace,nativeSourcePublicationBarrier} from './deadline-wiki-publication-concurrency.js';

// 합성 compiler 초안만 준비한다. 게시 동작은 실제 서비스/HTTP를 통과한다.
export async function publicationScenarios(api, prefix = '', native = null) {
  const { wikiContext, withKnowledgeTransaction } = await import('../src/services/knowledge-wiki-store.service.js');
  const { canonical, sha256, citationFor } = await import('../src/services/knowledge-wiki-contract.service.js');
  const publication = await import('../src/services/knowledge-wiki-publication.service.js');
  const signup = await api.request(null, `${prefix}/auth/signup`, 'POST', {name:'publisher',email:`publisher-${prefix ? 'pg' : 'sqlite'}@example.invalid`,password:'password-1234'},201);
  const actor = {token:signup.access_token ?? signup.token,userId:String(signup.user.id)};
  const company = await api.request(actor,prefix ? '/pg/companies' : '/tenants','POST',{name:'publication',...(prefix ? {} : {type:'custom'}),modules:['documents','agent','projects'],features:[],departments:[]},201);
  actor.orgId = company.org_id;
  const root = `${prefix}/documents/wiki`;
  const source = await api.request(actor,`${root}/sources`,'POST',{kind:'upload',filename:'raw.md',mime:'text/markdown',content_base64:Buffer.from('한글😀\r\n반복 근거\r\n반복 근거').toString('base64')},201);
  const wiki = (await api.request(actor,root)).wiki;
  const ctx = wikiContext({store:prefix ? 'pg' : 'legacy',scope:'company',actorId:actor.userId,tenantId:wiki.tenant_id,companyId:wiki.company_id});
  const tx = (write,work) => withKnowledgeTransaction(ctx,{write},work);
  async function draft({ids=[randomUUID()], inputs, title='review', links=[], provenanceOrigin='compiler'}={}) {
    return tx(true,function*(t) {
      const raw = yield* t.sourceRevision(source.current_revision_id,{current:true});
      const lineage = yield* t.manifest(inputs ?? [{kind:'source_revision',revision_id:raw.id,supplied_text:raw.content,classification:'internal'}]);
      const proposed_revisions = [], expected_heads = [];
      for (const page_id of ids) {
        const page = yield* t.get('page',page_id);
        expected_heads.push({page_id,version:page?.version ?? null,published_head_id:page?.published_head_id ?? null});
        proposed_revisions.push({page_id,kind:page?.kind ?? 'concept',title,markdown:'검토 게시 본문',index_entry:'- review',citations:raw ? [citationFor(raw)] : [],links,provenance:{origin:provenanceOrigin,fixture:true}});
      }
      const fields = {wiki_id:t.wiki.id,actor_id:ctx.actorId,job_id:null,proposed_revisions,expected_heads,lineage,schema_revision_id:t.wiki.active_schema_id,input_manifest_hash:lineage.hash};
      return yield* t.insert('change_set',{actor_id:ctx.actorId,job_id:null,state:'draft',proposed_revisions_json:canonical(proposed_revisions),expected_heads_json:canonical(expected_heads),lineage_json:canonical(lineage),schema_revision_id:fields.schema_revision_id,input_manifest_hash:lineage.hash,manifest_hash:sha256(canonical(fields)),created_at:yield* t.clock()});
    });
  }
  const publish = (d,key=randomUUID(),hash=d.manifest_hash) => publication.publishChangeSet(ctx,d.id,{manifest_hash:hash,confirmed:true},key);
  const snapshot = () => tx(false,function*(t) {
    const result = {};
    for (const table of ['page','page_revision','dependency','publication','event','change_set']) result[table] = yield* t.all(table);
    result.wiki = t.wiki; return result;
  });
  const first = await draft({ids:[randomUUID(),randomUUID()]});
  assert.equal((await publication.inspectChangeSet(ctx,first.id)).manifest_hash,first.manifest_hash);
  await assert.rejects(async()=>publish(first,randomUUID(),'0'.repeat(64)),/MANIFEST_CONFLICT/);
  assert.equal((await tx(false,function*(t){return yield* t.pages();})).length,0);
  const before = await snapshot();
  const receipt = await publish(first,'exact-replay');
  assert.equal(receipt.result_json.page_revision_ids.length,2);
  assert.deepEqual(receipt.result_json.pages.map(p=>p.version),[1,1]);
  assert.deepEqual(await publish(first,'exact-replay'),receipt);
  assert.equal((await snapshot()).publication.length,before.publication.length+1);
  await assert.rejects(async()=>publish(await draft(),'exact-replay'),/IDEMPOTENCY_CONFLICT/);
  const pageId = receipt.result_json.pages[0].id;
  const left = await draft({ids:[pageId]}), right = await draft({ids:[pageId]});
  const barrier = Promise.withResolvers();
  const contenders = [left,right].map(async d=>{await barrier.promise;return publish(d);});
  barrier.resolve();
  const race = await Promise.allSettled(contenders);
  assert.deepEqual(race.map(x=>x.status).sort(),['fulfilled','rejected']);
  assert.match(race.find(x=>x.status==='rejected').reason.message,/VERSION_CONFLICT/);
  const compiled = await draft({ids:[pageId]});
  const human = await publication.createManualChangeSet(ctx,pageId,{expected_version:2,title:'human',markdown:'사람이 작성한 새 본문'});
  const humanReceipt = await publish(human);
  assert.equal(humanReceipt.result_json.pages[0].version,3);
  await assert.rejects(async()=>publish(compiled),/VERSION_CONFLICT/);
  assert.equal((await publication.inspectChangeSet(ctx,compiled.id)).state,'draft');
  assert.equal((await tx(false,function*(t){return yield* t.pageRevision(humanReceipt.result_json.page_revision_ids[0]);})).markdown,'사람이 작성한 새 본문');
  const rejected = await draft();
  await publication.rejectChangeSet(ctx,rejected.id,{manifest_hash:rejected.manifest_hash});
  await assert.rejects(async()=>publish(rejected),/CHANGE_SET_STATE/);
  const schemaDraft=await draft();
  await tx(true,function*(t){yield* t.insert('schema_revision',{id:'test-schema-two',rules_md:'new trusted rules',rules_sha256:sha256('new trusted rules'),compiler_version:'test-v2',created_at:yield* t.clock()});yield* t.updateWiki({active_schema_id:'test-schema-two'});});
  const schemaBefore=await snapshot();await assert.rejects(async()=>publish(schemaDraft),/SCHEMA_CONFLICT/);assert.deepEqual(await snapshot(),schemaBefore);
  await tx(true,function*(t){yield* t.updateWiki({active_schema_id:schemaDraft.schema_revision_id});});
  const tampered=await tx(true,function*(t){const proposals=JSON.parse(schemaDraft.proposed_revisions_json);proposals[0].markdown='changed after digest';return yield* t.insert('change_set',{...schemaDraft,id:randomUUID(),proposed_revisions_json:canonical(proposals)});});
  await assert.rejects(async()=>publish(tampered),/MANIFEST_CONFLICT/);
  const omitted=await draft({ids:[pageId],inputs:[],provenanceOrigin:'human'});await assert.rejects(async()=>publish(omitted),/INCOMPLETE_LINEAGE/);

  // 각 SQL write 직후 실패를 DB trigger로 주입한다. 실제 transaction 전체를 비교한다.
  const {db} = await import('../src/config/db.js');
  const seams = [['page','INSERT',2],['page_revision','INSERT',2],['dependency','INSERT',2],['page','UPDATE',2],['publication','INSERT',1],['change_set','UPDATE',1],['wiki','UPDATE',1],['event','INSERT',3]].flatMap(([table,operation,count])=>Array.from({length:count},(_,i)=>[table,operation,i+1]));
  for (const [table,operation,nth] of seams) {
    const item = await draft({ids:[randomUUID(),randomUUID()]});
    const frozen = await snapshot();
    if (native) {
      await native.pool.query('CREATE TABLE knowledge.test_write_counter(n INTEGER); INSERT INTO knowledge.test_write_counter VALUES(0)');
      await native.pool.query(`CREATE OR REPLACE FUNCTION knowledge.test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n INTEGER; BEGIN UPDATE knowledge.test_write_counter SET n=test_write_counter.n+1 RETURNING test_write_counter.n INTO n; IF n=${nth} THEN RAISE EXCEPTION 'injected-write-failure'; END IF; RETURN NULL; END $$`);
      await native.pool.query(`CREATE TRIGGER test_fail AFTER ${operation} ON knowledge.${table} FOR EACH ROW EXECUTE FUNCTION knowledge.test_fail()`);
    } else {
      db().exec('CREATE TABLE knowledge_test_write_counter(n INTEGER); INSERT INTO knowledge_test_write_counter VALUES(0)');
      db().exec(`CREATE TRIGGER test_fail AFTER ${operation} ON knowledge_${table} BEGIN UPDATE knowledge_test_write_counter SET n=n+1; SELECT CASE WHEN n=${nth} THEN RAISE(ABORT,'injected-write-failure') END FROM knowledge_test_write_counter; END`);
    }
    try { await assert.rejects(async()=>publish(item),/injected-write-failure/); }
    finally {
      if (native) await native.pool.query(`DROP TRIGGER test_fail ON knowledge.${table}; DROP TABLE knowledge.test_write_counter`);
      else db().exec('DROP TRIGGER test_fail; DROP TABLE knowledge_test_write_counter');
    }
    assert.deepEqual(await snapshot(),frozen,`${table} ${operation} #${nth}: atomic rollback`);
  }
  const deferred=await draft({ids:[randomUUID(),randomUUID()]});const deferredBefore=await snapshot();
  if(native) await native.pool.query("CREATE CONSTRAINT TRIGGER test_fail AFTER INSERT ON knowledge.event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row()");
  else db().exec(`CREATE TRIGGER test_fail AFTER INSERT ON knowledge_event WHEN NEW.page_revision_id IS NOT NULL BEGIN INSERT INTO knowledge_dependency(wiki_id,id,dependent_page_revision_id,source_revision_id,relation) VALUES(NEW.wiki_id,lower(hex(randomblob(16))),NEW.page_revision_id,'missing-source','transitive'); END`);
  try{await assert.rejects(async()=>publish(deferred),/immutable|constraint|foreign key/i);}
  finally{if(native)await native.pool.query('DROP TRIGGER test_fail ON knowledge.event');else db().exec('DROP TRIGGER test_fail');}
  assert.deepEqual(await snapshot(),deferredBefore,'deferred COMMIT failure rolls back every write');
  if (native) for (const code of ['40001','40P01']) {
    const item=await draft();const frozen=await snapshot();
    await native.pool.query(`CREATE OR REPLACE FUNCTION knowledge.test_conflict() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'transaction conflict' USING ERRCODE='${code}'; END $$; CREATE TRIGGER test_conflict AFTER INSERT ON knowledge.page_revision FOR EACH ROW EXECUTE FUNCTION knowledge.test_conflict()`);
    try{await assert.rejects(async()=>publish(item),error=>error.status===409 && error.code==='VERSION_CONFLICT');}
    finally{await native.pool.query('DROP TRIGGER test_conflict ON knowledge.page_revision');}
    assert.deepEqual(await snapshot(),frozen);
  }
  if (!native) await sqliteProcessRace(api,{draft,publish,actor});
  else await nativeSourcePublicationBarrier(api,{draft,publish,actor,tx,source,root},native);
  const next = await api.request(actor,`${root}/sources/${source.id}/revisions`,'POST',{expected_version:source.version,filename:'edited.md',mime:'text/markdown',content_base64:Buffer.from('new raw').toString('base64')},201);
  assert.equal((await tx(false,function*(t){return yield* t.pages();})).length,0);
  await assert.rejects(async()=>publish(first,'exact-replay'),/SOURCE_REVOKED|SOURCE_STALE/);
  await assert.rejects(async()=>publication.createManualChangeSet(ctx,pageId,{expected_version:3,title:'launder',markdown:'no dependencies'}),/NOT_FOUND|SOURCE_REVOKED/);
  const history = await publication.pageHistory(ctx,pageId);
  assert.equal(history.items.length,3); assert.ok(history.items.every(i=>i.freshness==='stale'));
  await api.request(actor,`${root}/sources/${source.id}`,'DELETE',{expected_version:next.version});
  await assert.rejects(async()=>publication.pageHistory(ctx,pageId),/NOT_FOUND/);
  assert.equal((await publication.wikiGraph(ctx)).nodes.length,0);
  api.http.push({kind:'actual-publication-receipt',store:ctx.store,receipt,race:race.map(x=>({status:x.status,code:x.reason?.code})),failure_seams:seams});
  return {ctx,actor,root,source,draft,publish,tx,snapshot,publication};
}
