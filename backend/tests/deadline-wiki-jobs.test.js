import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exerciseJobs, localProviderFixture } from './deadline-wiki-jobs-fixture.js';

test('strict Wiki compiler and durable job seams exist without generic fallback', async () => {
  const adapter = await import('../src/services/knowledge-wiki-compiler.service.js');
  const jobs = await import('../src/services/knowledge-wiki-jobs.service.js');
  assert.throws(() => adapter.localModelConfiguration({base_url:'https://example.invalid',model:'bad',context_tokens:8192,output_tokens:1024}), /LOCAL_MODEL_CONFIG/);
  for (const name of ['admitWikiJob','getWikiJob','claimWikiJob','heartbeatWikiJob','acceptWikiResult','retryWikiJob','cancelWikiJob','draftWikiQuery','runWikiJob']) assert.equal(typeof jobs[name], 'function', name);
});

test('SQLite durable local Wiki jobs, event barriers and real HTTP', {timeout:120000}, async()=>{await exerciseJobs('legacy');});

test('strict local transport rejects capability/configuration escape and aborts bounded inference', {timeout:30000}, async()=>{
  const {localModelConfiguration,createLocalWikiCompiler,contextAccounting,compilerInstructions}=await import('../src/services/knowledge-wiki-compiler.service.js');
  const {freezeManifest}=await import('../src/services/knowledge-wiki-contract.service.js');
  const provider=await localProviderFixture();
  try {
    for(const base_url of ['https://127.0.0.1','http://localhost:12345','http://user:secret@127.0.0.1:12345','http://127.0.0.1:12345/path','http://127.0.0.1:12345/?key=secret','http://example.invalid']) assert.throws(()=>localModelConfiguration({...provider.config,base_url}),e=>e.code==='LOCAL_MODEL_CONFIG');
    assert.throws(()=>localModelConfiguration({...provider.config,api_key:'must-not-record'}),e=>e.code==='LOCAL_MODEL_CONFIG');
    const manifest=freezeManifest([{kind:'instruction',classification:'public',authorization:{actor_id:'fixture',wiki_id:'fixture'},supplied_text:compilerInstructions('query')},{kind:'catalog',classification:'public',authorization:{actor_id:'fixture',wiki_id:'fixture'},source_revision_ids:[],supplied_text:JSON.stringify({operation:'query',evidence:[],targets:[]})}]);
    assert.throws(()=>contextAccounting(manifest,{...provider.config,context_tokens:2049}),e=>e.code==='CONTEXT_LIMIT');
    const compiler=createLocalWikiCompiler(provider.config),controller=new AbortController();
    const ambientFetch=globalThis.fetch;
    globalThis.fetch=()=>{throw new Error('ambient fetch dispatcher must not receive model bytes');};
    try {assert.equal((await compiler.inspect()).model_version,provider.config.model);}finally{globalThis.fetch=ambientFetch;}
    provider.gate.hold=Promise.withResolvers();const entered=provider.dispatched();
    const outcome=compiler.compile(manifest,controller.signal).then(v=>({v}),e=>({e}));await entered;controller.abort();
    assert.equal((await outcome).e.code,'MODEL_ABORTED');provider.gate.hold.resolve();provider.gate.hold=null;
    const mismatch=createLocalWikiCompiler({...provider.config,context_tokens:8192});await assert.rejects(()=>mismatch.inspect(),e=>e.code==='MODEL_CONTEXT_MISMATCH');
    provider.gate.hold=Promise.withResolvers();
    // Time itself is under test: the adapter deadline terminates an otherwise event-held response.
    const timeoutCompiler=createLocalWikiCompiler({...provider.config,timeout_ms:100});
    await assert.rejects(()=>timeoutCompiler.compile(manifest),e=>e.code==='MODEL_TIMEOUT');
    provider.gate.hold.resolve();provider.gate.hold=null;
  }finally{await provider.close();}
});
