import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once,EventEmitter} from 'node:events';

export async function nativeSourcePublicationBarrier(api,fixture,native) {
  const {draft,publish,actor,tx,source,root}=fixture;
  const {pgPool}=await import('../src/config/pg.js');
  const project=await api.request(actor,'/pg/projects','POST',{name:'source-publication-barrier'},201);
  const doc=await api.request(actor,'/pg/documents','POST',{project_id:project.id,title:'race source',content:'race raw source'},201);
  const src=await api.request(actor,`${root}/sources`,'POST',{kind:'record',origin_kind:'document',origin_id:doc.id,version:doc.version},201);
  const inputs=await tx(false,function*(t){const raw=yield* t.sourceRevision(src.current_revision_id),original=yield* t.sourceRevision(source.current_revision_id);return [raw,original].map(r=>({kind:'source_revision',revision_id:r.id,supplied_text:r.content,classification:'internal'}));});
  const change=await draft({inputs});const blocker=await native.pool.connect(),editor=await native.pool.connect();
  const events=new EventEmitter(),clients=new Set(),errors=[];
  events.on('error',error=>errors.push(error));
  const signal=AbortSignal.timeout(15000);
  const publicationReady=once(events,'publication-ready',{signal}),sourceReady=once(events,'source-ready',{signal});
  // 관찰 Promise는 실패도 수집한다. trigger notice는 실제 DB write/lock 진입 사건이다.
  const phase=Promise.all([publicationReady,sourceReady]).then(value=>({value}),error=>({error}));
  const notice=message=>{if(message.message==='task33-publication-locked')events.emit('publication-ready');};
  const acquire=client=>{clients.add(client);client.on('notice',notice);};
  const sourceNotice=message=>{if(message.message==='task33-source-update-start')events.emit('source-ready');};
  editor.on('notice',sourceNotice);pgPool.on('acquire',acquire);
  let publishing,editing,locked=false;
  try{
    await blocker.query('BEGIN');locked=true;await blocker.query('SELECT pg_advisory_xact_lock(330033)');
    await native.pool.query("CREATE FUNCTION knowledge.test_publication_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE NOTICE 'task33-publication-locked'; PERFORM pg_advisory_xact_lock(330033); RETURN NULL; END $$; CREATE TRIGGER test_publication_barrier AFTER INSERT ON knowledge.page FOR EACH ROW EXECUTE FUNCTION knowledge.test_publication_barrier()");
    publishing=publish(change).then(value=>({value}),error=>{events.emit('error',error);return {error};});
    await publicationReady;
    editing=editor.query(`DO $$ BEGIN RAISE NOTICE 'task33-source-update-start'; UPDATE project.documents SET content_md='race updated',version=version+1 WHERE id=${Number(doc.id)}; END $$`).then(value=>({value}),error=>{events.emit('error',error);return {error};});
    assert.ifError((await phase).error);await blocker.query('COMMIT');locked=false;
    const [published,edited]=await Promise.all([publishing,editing]);assert.ifError(published.error);assert.ifError(edited.error);assert.deepEqual(errors,[]);
    const revisionId=published.value.result_json.page_revision_ids[0];
    assert.equal(await tx(false,function*(t){return yield* t.pageRevision(revisionId);}),null);
    assert.ok(await tx(false,function*(t){return yield* t.get('page_revision',revisionId);}));
    api.http.push({kind:'native-source-publication-linearization',barriers:['publication-write-after-source-FOR-SHARE','source-update-before-row-lock','release-advisory-lock'],published_revision_id:revisionId,read_after_source_edit:'stale-excluded'});
  }finally{
    if(locked)await blocker.query('ROLLBACK');
    await Promise.all([publishing,editing]);
    pgPool.off('acquire',acquire);for(const client of clients)client.off('notice',notice);editor.off('notice',sourceNotice);
    await native.pool.query('DROP TRIGGER IF EXISTS test_publication_barrier ON knowledge.page; DROP FUNCTION IF EXISTS knowledge.test_publication_barrier()');
    blocker.release();editor.release();
  }
}

export async function sqliteProcessRace(api,fixture) {
  const {draft,publish,actor}=fixture;
  const first=await draft();const receipt=await publish(first);const pageId=receipt.result_json.pages[0].id;
  const changes=await Promise.all([draft({ids:[pageId]}),draft({ids:[pageId]})]);
  const children=[];
  try{
    const endpoints=await Promise.all(changes.map(async()=>{
      const child=fork(new URL('./deadline-wiki-publication-sqlite-server.mjs',import.meta.url),[],{env:{...process.env},stdio:['ignore','pipe','pipe','ipc']});children.push(child);
      let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
      const [message]=await once(child,'message',{signal:AbortSignal.timeout(15000)});assert.equal(message.type,'ready',output);
      return {child,port:message.port};
    }));
    const gate=Promise.withResolvers();
    const requests=endpoints.map(async({port},i)=>{await gate.promise;const response=await fetch(`http://127.0.0.1:${port}/api/v1/documents/wiki/change-sets/${changes[i].id}/publish`,{method:'POST',headers:{Authorization:`Bearer ${actor.token}`,'X-Org-Id':actor.orgId,'Content-Type':'application/json','Idempotency-Key':`process-race-${i}`},body:JSON.stringify({manifest_hash:changes[i].manifest_hash,confirmed:true}),signal:AbortSignal.timeout(15000)});return {status:response.status,body:await response.json()};});
    gate.resolve();const results=await Promise.all(requests);assert.deepEqual(results.map(r=>r.status).sort(),[200,409],JSON.stringify(results));assert.equal(results.find(r=>r.status===409).body.error.code,'VERSION_CONFLICT');
    api.http.push({kind:'SQLite-two-independent-authenticated-API-processes',pids:children.map(c=>c.pid),results});
    const next=await draft({ids:[pageId]});const abort=new AbortController();
    const stream=await fetch(`http://127.0.0.1:${endpoints[0].port}/api/v1/documents/wiki/events`,{headers:{Authorization:`Bearer ${actor.token}`,'X-Org-Id':actor.orgId},signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});
    assert.equal(stream.status,200);const reader=stream.body.getReader(),decoder=new TextDecoder();let buffer='';
    async function frame(){while(true){const split=buffer.indexOf('\n\n');if(split>=0){const value=buffer.slice(0,split);buffer=buffer.slice(split+2);return value;}const chunk=await reader.read();assert.equal(chunk.done,false);buffer+=decoder.decode(chunk.value,{stream:true});}}
    try{
      assert.match(await frame(),/event: state/);
      const changed=(async()=>{while(true){const value=await frame();if(value.includes(next.id)&&value.includes('change_set.published'))return value;}})();
      const outcome=changed.then(value=>({value}),error=>({error}));
      const published=await fetch(`http://127.0.0.1:${endpoints[1].port}/api/v1/documents/wiki/change-sets/${next.id}/publish`,{method:'POST',headers:{Authorization:`Bearer ${actor.token}`,'X-Org-Id':actor.orgId,'Content-Type':'application/json','Idempotency-Key':'cross-process-stream'},body:JSON.stringify({manifest_hash:next.manifest_hash,confirmed:true}),signal:AbortSignal.timeout(10000)});
      assert.equal(published.status,200);await published.body.cancel();assert.ifError((await outcome).error);
      api.http.push({kind:'SQLite-cross-process-SSE',reader_pid:endpoints[0].child.pid,publisher_pid:endpoints[1].child.pid,change_set_id:next.id,observed:true});
    }finally{abort.abort();reader.releaseLock();}
  }finally{
    await Promise.all(children.map(async child=>{const exit=once(child,'exit',{signal:AbortSignal.timeout(15000)});if(child.connected)child.send({type:'close'});const [code]=await exit;assert.equal(code,0);}));
    api.http.push({kind:'SQLite-publisher-process-cleanup',pids:children.map(c=>c.pid),exited:true});
  }
}
