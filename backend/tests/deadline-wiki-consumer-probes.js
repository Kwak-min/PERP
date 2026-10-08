import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Internal successor consumer probes; all writes use real transactions, not SQL mocks.
export async function exerciseConsumerBoundary(t, api, prefix = '') {
  const {wikiContext,withKnowledgeTransaction:txn} = await import('../src/services/knowledge-wiki-store.service.js');
  const {canonical,sha256,freezeManifest} = await import('../src/services/knowledge-wiki-contract.service.js');
  const {db} = await import('../src/config/db.js');
  async function company(name) {
    const signup = await api.request(null,`${prefix}/auth/signup`,'POST',{name,email:`consumer-${name}@example.invalid`,password:'password-1234'},201);
    const actor = {token:signup.access_token ?? signup.token,userId:String(signup.user.id)};
    const created = await api.request(actor,prefix ? '/pg/companies' : '/tenants','POST',{name,...(prefix ? {} : {type:'custom'}),modules:['documents','agent'],features:[],departments:[]},201);
    actor.orgId = created.org_id;
    return actor;
  }
  const a = await company('A'), b = await company('B');
  const context = actor => wikiContext({store:prefix ? 'pg' : 'legacy',scope:'company',actorId:actor.userId,companyId:prefix ? actor.orgId.slice(3) : actor.orgId,tenantId:prefix ? null : db().prepare('SELECT tenant_id FROM organization WHERE id=?').get(actor.orgId).tenant_id});
  const ca = context(a), cb = context(b);
  const upload = (actor,text) => api.request(actor,`${prefix}/documents/wiki/sources`,'POST',{kind:'upload',filename:'same.md',mime:'text/markdown',content_base64:Buffer.from(text).toString('base64')},201);
  const sources = [await upload(a,'ANCHOR Korean 한글😀\r\nrepeat\r\nrepeat'),await upload(a,'UNCITED catalog'),await upload(a,'UNCITED instruction')];
  const foreign = await upload(b,'FOREIGN');
  const read = (ctx,table,id) => txn(ctx,{},function*(tx) { return yield* tx.get(table,id); });
  const failure = async work => { try { await work(); return null; } catch(error) { return error; } };

  await t.test('a rejecting final Promise must roll back writes before COMMIT', async () => {
    const id = randomUUID(), entered = Promise.withResolvers(), finish = Promise.withResolvers();
    const late = finish.promise.catch(error => error.message); // subscribe before rejection
    const pending = failure(() => txn(ca,{write:true},function*(tx) {
      yield* tx.insert('page',{id,kind:'page',created_at:yield* tx.clock()});
      entered.resolve();
      return finish.promise;
    }));
    await entered.promise;
    finish.reject(new Error('late failure'));
    assert.equal(await late,'late failure');
    const error = await pending;
    const row = await read(ca,'page',id);
    assert.equal(row,null,'Promise-returning generator must not commit failed operation');
    assert.equal(error?.code,'ASYNC_TRANSACTION_CALLBACK');
  });

  await t.test('async callbacks are rejected without invocation', async () => {
    let invoked = false;
    for (const work of [async () => { invoked = true; },async function*() { invoked = true; }]) {
      const error = await failure(() => txn(ca,{write:true},work));
      assert.equal(error?.code,'ASYNC_TRANSACTION_CALLBACK');
    }
    assert.equal(invoked,false);
  });

  await t.test('yielded thenables and resolving final thenables roll back', async () => {
    for (const final of [false,true]) for (const native of [false,true]) {
      const id = randomUUID();
      let assimilated = false;
      const error = await failure(() => txn(ca,{write:true},function*(tx) {
        yield* tx.insert('page',{id,kind:'page',created_at:yield* tx.clock()});
        const thenable = native ? Promise.resolve('not a database operation') : {then(resolve) { assimilated = true; resolve('not a database operation'); }};
        if (final) return thenable;
        yield thenable;
      }));
      assert.equal(assimilated,false);
      assert.equal(await read(ca,'page',id),null);
      assert.equal(error?.code,'ASYNC_TRANSACTION_CALLBACK');
    }
  });

  await t.test('expired facade and suspended iterators cannot continue or cross transactions', async () => {
    let saved, iterator;
    await txn(ca,{},function*(tx) { saved = tx; iterator = tx.clock(); return yield* tx.clock(); });
    assert.throws(() => iterator.next(),error => error.code === 'TRANSACTION_EXPIRED');
    assert.throws(() => saved.get('source',sources[0].id).next(),error => error.code === 'TRANSACTION_EXPIRED');
    const error = await failure(() => txn(cb,{},function*() { return yield* saved.clock(); }));
    assert.equal(error?.code,'TRANSACTION_EXPIRED');
  });

  await t.test('rejected asynchronous continuation cannot use an expired write transaction', async () => {
    const gate = Promise.withResolvers();
    let continuation;
    const error = await failure(() => txn(ca,{write:true},function*(tx) {
      continuation = gate.promise.then(() => tx.insert('page',{kind:'page',created_at:'forbidden'}).next());
      return continuation;
    }));
    assert.equal(error?.code,'ASYNC_TRANSACTION_CALLBACK');
    const observed = failure(() => continuation);
    gate.resolve();
    assert.equal((await observed)?.code,'TRANSACTION_EXPIRED');
  });

  await t.test('read-only A cannot UPDATE B through the old raw SQL primitive', async () => {
    const before = await read(cb,'source',foreign.id);
    const error = await failure(() => txn(ca,{},function*(tx) {
      yield* tx.rows('UPDATE knowledge_source SET version=version+1 WHERE id=?',[foreign.id]);
    }));
    assert.equal((await read(cb,'source',foreign.id)).version,before.version);
    assert.ok(error,'unrestricted SQL must not be a consumer capability');
  });

  await t.test('write A is also scope-owned; facade and query arguments cannot escape', async () => {
    const before = await read(cb,'source',foreign.id);
    const rawError = await failure(() => txn(ca,{write:true},function*(tx) {
      yield* tx.rows('UPDATE knowledge_source SET version=version+1 WHERE id=?',[foreign.id]);
    }));
    assert.ok(rawError);
    await txn(ca,{write:true},function*(tx) {
      assert.equal(yield* tx.update('source',foreign.id,{version:99}),null);
      assert.throws(() => { tx.wiki.id = before.wiki_id; },TypeError);
      assert.throws(() => { tx.write = true; },TypeError);
      assert.equal(tx.rows,undefined); assert.equal(tx.one,undefined); assert.equal(tx.capture,undefined);
    });
    for (const work of [
      function*(tx) { yield* tx.all('source','OR 1=1'); },
      function*(tx) { yield* tx.all('source',{where:{'id) OR 1=1 --':foreign.id}}); },
      function*(tx) { yield* tx.update('source',sources[0].id,{'version=99 WHERE 1=1 --':2}); },
      function*(tx) { yield* tx.insert('page',{wiki_id:before.wiki_id,kind:'page',created_at:yield* tx.clock()}); },
      function*(tx) { yield {sql:'UPDATE knowledge_source SET version=99',params:[]}; },
      function*(tx) { yield* tx.update('wiki',before.wiki_id,{generation:99}); },
    ]) assert.ok(await failure(() => txn(ca,{write:true},work)));
    assert.equal((await read(cb,'source',foreign.id)).version,before.version);
  });

  await t.test('read-only domain operations cannot write own rows', async () => {
    const before = await read(ca,'source',sources[0].id);
    for (const work of [
      function*(tx) { yield* tx.update('source',before.id,{version:99}); },
      function*(tx) { yield* tx.insert('page',{kind:'page',created_at:yield* tx.clock()}); },
      function*(tx) { yield* tx.event('must-not-write'); },
    ]) assert.ok(await failure(() => txn(ca,{},work)));
    assert.equal((await read(ca,'source',before.id)).version,before.version);
    if (!prefix) {
      const error = await failure(() => txn(ca,{},function*() { db().exec('UPDATE knowledge_source SET version=99'); }));
      assert.match(error?.message ?? '',/readonly/i);
    }
  });

  if (prefix) await t.test('native read-only enforcement and one-client transaction identity', async () => {
    const {pgPool} = await import('../src/config/pg.js');
    const originalConnect = pgPool.connect;
    let denyWrite = true;
    const traces = [];
    // Instrument, never substitute, the actual client's query method. The forbidden
    // UPDATE is issued on that same native transaction to test PostgreSQL enforcement.
    pgPool.connect = async function() {
      const client = await originalConnect.call(this), query = client.query, release = client.release;
      const trace = []; traces.push(trace);
      client.query = async function(sql,...args) {
        const result = await query.call(this,sql,...args);
        if (/knowledge\.|clock_timestamp/.test(sql)) {
          trace.push((await query.call(this,"SELECT pg_backend_pid() AS pid,txid_current()::text AS txid,current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation")).rows[0]);
          if (denyWrite) await query.call(this,'UPDATE knowledge.source SET version=version+1 WHERE id=$1',[foreign.id]);
        }
        return result;
      };
      client.release = function(...args) { client.query = query; client.release = release; return release.apply(this,args); };
      return client;
    };
    try {
      const error = await failure(() => read(ca,'source',sources[0].id));
      assert.equal(error?.code,'25006');
      assert.equal(traces[0][0].read_only,'on');
      assert.equal(traces[0][0].isolation,'repeatable read');
      denyWrite = false;
      await txn(ca,{write:true},function*(tx) { yield* tx.clock(); yield* tx.event('consumer.client-proof'); yield* tx.clock(); });
      const writeTrace = traces[1];
      assert.ok(writeTrace.length >= 4);
      assert.ok(writeTrace.every(row => row.pid === writeTrace[0].pid && row.txid === writeTrace[0].txid && row.read_only === 'off'));
      api.http.push({kind:'native-transaction-proof',traces});
    } finally { pgPool.connect = originalConnect; }
  });

  await t.test('scoped successor primitives support locked CAS and Wiki generation', async () => {
    const before = await read(ca,'source',sources[0].id);
    const update = expected => txn(ca,{write:true},function*(tx) {
      const row = yield* tx.get('source',before.id,true);
      if (row.version !== expected) return false;
      yield* tx.update('source',row.id,{version:row.version+1});
      const generation = tx.wiki.generation;
      yield* tx.updateWiki({generation:generation+1});
      assert.equal(tx.wiki.generation,generation+1);
      assert.deepEqual((yield* tx.all('source',{where:{id:row.id,withdrawn_at:null},orderBy:['id'],limit:1})).map(r => r.id),[row.id]);
      return true;
    });
    const gate = Promise.withResolvers();
    const contenders = [0,1].map(async () => { await gate.promise; return update(before.version); });
    gate.resolve();
    assert.deepEqual((await Promise.all(contenders)).sort(),[false,true]);
    assert.equal((await read(ca,'source',before.id)).version,before.version+1);
  });

  await t.test('non-JSON provenance is rejected before dispatch', async () => {
    const cyclic = {}; cyclic.self = cyclic;
    for (const provenance of [undefined,NaN,Infinity,new Date(),new Map(),new Set(),()=>{},1n,cyclic,[,1],{value:undefined}]) {
      assert.ok(await failure(() => txn(ca,{},function*(tx) { return yield* tx.manifest([{kind:'catalog',supplied_text:'context',classification:'internal',source_revision_ids:[],provenance}]); })));
    }
  });

  await t.test('all six canonical inputs including provenance round-trip from durable rows', async () => {
    const proof = await txn(ca,{write:true},function*(tx) {
      const raw = yield* tx.sourceRevision(sources[0].current_revision_id);
      const manifest = yield* tx.manifest([
        {kind:'source_revision',revision_id:raw.id,supplied_text:raw.content,classification:'internal'},
        {kind:'catalog',supplied_text:'full uncited catalog',classification:'internal',source_revision_ids:[sources[1].current_revision_id],provenance:{catalog_version:'catalog-review-v1',ordered:['b','a']}},
        {kind:'instruction',supplied_text:'instruction context',classification:'internal',source_revision_ids:[sources[2].current_revision_id]},
        {kind:'question',supplied_text:'question not evidence',classification:'personal'},
        {kind:'schema_revision',revision_id:tx.wiki.active_schema_id,supplied_text:(yield* tx.get('schema_revision',tx.wiki.active_schema_id)).rules_md,classification:'public'},
        {kind:'prior_result',supplied_text:'prior full result',classification:'internal',source_revision_ids:[sources[1].current_revision_id],provenance:{result_revision_id:'previous-result-fixture'},extension:{nested:[null,true,1,'한글']}},
      ]);
      const created = yield* tx.clock();
      const job = yield* tx.insert('job',{operation:'query',request_json:'{}',request_hash:sha256('{}'),actor_id:a.userId,idempotency_key:'consumer-lineage',state:'running',fence:1,source_vector_json:'[]',target_vector_json:'[]',schema_revision_id:tx.wiki.active_schema_id,config_version:'fixture',created_at:created,updated_at:created});
      const attempt = yield* tx.insert('job_attempt',{job_id:job.id,ordinal:1,fence:1,lease_owner:'consumer',model_version:'storage-fixture-only',config_json:'{}',input_manifest_hash:manifest.hash,started_at:created});
      yield* tx.persistInputs(job.id,attempt.id,manifest);
      return {job,attempt,manifest};
    });
    // Reopen the transaction: no in-memory manifest is used to rebuild saved inputs.
    const stored = await txn(ca,{},function*(tx) { return {rows:(yield* tx.all('job_input')).filter(r => r.attempt_id === proof.attempt.id).sort((a,b) => a.ordinal-b.ordinal),deps:(yield* tx.all('dependency')).filter(r => r.dependent_job_id === proof.job.id)}; });
    const restored = stored.rows.map(r => r.input_json ? JSON.parse(r.input_json) : ({kind:r.kind,...(r.source_revision_id || r.page_revision_id || r.schema_revision_id ? {revision_id:r.source_revision_id ?? r.page_revision_id ?? r.schema_revision_id} : {}),supplied_text:r.supplied_text,classification:r.classification,source_revision_ids:JSON.parse(r.raw_closure_json),authorization:JSON.parse(r.authorization_json)}));
    assert.equal(freezeManifest(restored).hash,proof.manifest.hash);
    assert.deepEqual(restored,proof.manifest.inputs);
    assert.deepEqual(stored.deps.map(d => d.source_revision_id).sort(),sources.map(s => s.current_revision_id).sort());
    assert.ok(stored.rows.every(r => r.input_json === canonical(JSON.parse(r.input_json))));
    const loaded = await txn(ca,{},function*(tx) { return yield* tx.storedManifest(proof.job.id,proof.attempt.id); });
    assert.deepEqual(loaded,proof.manifest);
    assert.ok(await failure(() => txn(cb,{},function*(tx) { return yield* tx.storedManifest(proof.job.id,proof.attempt.id); })));
    assert.ok(await failure(() => txn(ca,{write:true},function*(tx) { yield* tx.persistInputs(proof.job.id,proof.attempt.id,proof.manifest); })));
    assert.ok(await failure(() => txn(ca,{write:true},function*(tx) { yield* tx.update('job_input',stored.rows[0].id,{input_json:'{}'}); })));
    api.http.push({kind:'consumer-roundtrip',store:ca.store,acceptedHash:proof.manifest.hash,restoredHash:freezeManifest(restored).hash,inputs:restored,rows:stored.rows});
  });
}
