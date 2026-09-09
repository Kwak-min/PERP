import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {setupJobs} from './deadline-wiki-jobs-fixture.js';

// Explicit safe fixture argument, never inherited private provider/.env configuration.
const configuration=JSON.parse(process.argv[2] ?? 'null');
assert.equal(configuration?.base_url,'http://127.0.0.1:12345');
assert.equal(configuration?.model,'perp-task32-smoke');
assert.equal(configuration?.context_tokens,8192);
const f=await setupJobs('legacy'),evidence={kind:'actual-loaded-local-model-synthetic-Korean-only',configuration,results:[],dispatch_manifests:[]};
try {
  const {createLocalWikiCompiler,compilerRequest}=await import('../src/services/knowledge-wiki-compiler.service.js');
  const {admitWikiJob,runWikiJob,getWikiJob,draftWikiQuery}=await import('../src/services/knowledge-wiki-jobs.service.js');
  evidence.loaded=await createLocalWikiCompiler(configuration).inspect();
  const source=await f.upload('합성 한글 검증 자료입니다. 가상 동아리의 화요일 모임 장소는 가상 회의실 가입니다. 이 자료는 실제 조직이나 문서가 아닙니다.');
  const before=await f.api.request(f.a,`${f.root}/sources/${source.id}/revisions/${source.current_revision_id}`);
  for(const request of [{operation:'ingest',source_revision_ids:[source.current_revision_id],target_base_versions:[]},{operation:'query',question:'화요일 모임 장소는?',retrieval:{raw:true,published_wiki:true,source_revision_ids:[source.current_revision_id]}}]) {
    const admitted=await admitWikiJob(f.context,request,'real-smoke-'+request.operation,configuration);
    const result=await runWikiJob(f.context,admitted.job.id);
    const job=await getWikiJob(f.context,admitted.job.id);
    const manifest=await f.tx(f.context,{},function*(tx){return yield* tx.storedManifest(job.id,job.current_attempt_id);});
    evidence.dispatch_manifests.push({job_id:job.id,manifest,request:compilerRequest(manifest,configuration)});
    assert.equal(job.state,'succeeded');assert.equal(job.attempts[0].model_version,'perp-task32-smoke');
    assert.equal(job.attempts[0].configuration.loaded_context_tokens,8192);
    assert.equal(result.review_state,'unreviewed');assert.equal(result.citation_validation,'anchors_valid');
    assert.ok(result.provenance.accounting.actual_prompt_tokens>0);
    if(request.operation==='ingest')assert.ok(result.change_set_id);
    else assert.ok((await draftWikiQuery(f.context,admitted.job.id)).change_set_id);
    assert.equal((await f.api.request(f.a,f.root+'/pages')).items.length,0);
    evidence.results.push({request,job,result});
  }
  assert.deepEqual(await f.api.request(f.a,`${f.root}/sources/${source.id}/revisions/${source.current_revision_id}`),before);
  evidence.source_unchanged=true;evidence.published_pages=0;
} catch(error) {evidence.failure={code:error.code ?? null,message:error.message};throw error;}
finally {
  await f.close({smoke:true});
  const dir=new URL('../../.omo/evidence/task-32-deadline-erp-redesign/',import.meta.url);await mkdir(dir,{recursive:true});
  await writeFile(new URL('real-model-smoke.json',dir),JSON.stringify(evidence,null,2));
}
console.log(JSON.stringify({real_model:configuration.model,context:8192,operations:evidence.results.map(r=>r.request.operation),published_pages:0}));
