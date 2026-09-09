import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setupJobs,localProviderFixture} from './deadline-wiki-jobs-fixture.js';

export async function integrationContract(mode,t) {
  const f=await setupJobs(mode),p=await localProviderFixture(),checks=[];
  const jobs=await import('../src/services/knowledge-wiki-jobs.service.js');
  const publication=await import('../src/services/knowledge-wiki-publication.service.js');
  const {createLocalWikiCompiler}=await import('../src/services/knowledge-wiki-compiler.service.js');
  const compiler=createLocalWikiCompiler(p.config),model=await compiler.inspect();
  try {
    const source=await f.upload();
    async function candidate() {
      const {job}=await jobs.admitWikiJob(f.context,{operation:'ingest',source_revision_ids:[source.current_revision_id]},randomUUID(),p.config);
      const lease=await jobs.claimWikiJob(f.context,job.id,'contract',model);
      const manifest=await f.tx(f.context,{},function*(tx){return yield* tx.storedManifest(job.id,lease.attempt_id);});
      const envelope=structuredClone(await compiler.compile(manifest));
      return {job,lease,envelope};
    }
    await t.test('frozen compiler title bytes survive publication decoder and exact digest',async()=>{
      const {job,lease,envelope}=await candidate();envelope.output.pages[0].title='  frozen title  ';
      const result=await jobs.acceptWikiResult(f.context,job.id,lease,envelope);
      const change=await publication.inspectChangeSet(f.context,result.change_set_id);
      assert.equal(change.proposed_revisions[0].title,envelope.output.pages[0].title);
      const receipt=await publication.publishChangeSet(f.context,change.id,{manifest_hash:change.manifest_hash,confirmed:true},randomUUID());
      assert.equal((await publication.pageHistory(f.context,receipt.result_json.pages[0].id)).items[0].title,envelope.output.pages[0].title);
      checks.push('frozen title bytes and digest published without decoder mutation');
    });
    for(const defect of ['blank-title','aggregate-edges']) await t.test(`acceptance rejects ${defect} before freezing an unpublishable result`,async()=>{
      const {job,lease,envelope}=await candidate(),page=envelope.output.pages[0];
      if(defect==='blank-title')page.title='   ';
      else {page.citations=Array(200).fill(0);page.links=[{target:page.key,predicate:'related',direction:'directed',citations:[0]}];}
      const snapshot=()=>f.tx(f.context,{},function*(tx){const rows={};for(const table of ['job','job_attempt','change_set','dependency','event'])rows[table]=yield* tx.all(table,{orderBy:['id']});return rows;});
      const before=await snapshot();
      await assert.rejects(()=>jobs.acceptWikiResult(f.context,job.id,lease,envelope),e=>e.code===(defect==='blank-title'?'MODEL_OUTPUT_INVALID':'MODEL_OUTPUT_LIMIT'));
      assert.deepEqual(await snapshot(),before);
      checks.push(defect+' rejects atomically before durable result/draft');
    });
    await t.test('aggregate 200-edge limit is accepted and actually published',async()=>{
      const {job,lease,envelope}=await candidate(),page=envelope.output.pages[0];
      page.citations=Array(199).fill(0);page.links=[{target:page.key,predicate:'related',direction:'directed',citations:[0]}];
      const result=await jobs.acceptWikiResult(f.context,job.id,lease,envelope);
      const change=await publication.inspectChangeSet(f.context,result.change_set_id);
      await publication.publishChangeSet(f.context,change.id,{manifest_hash:change.manifest_hash,confirmed:true},randomUUID());
      const graph=await publication.wikiGraph(f.context);
      assert.equal(graph.edges.filter(e=>e.source===`page:${change.proposed_revisions[0].page_id}`).length,200);
      checks.push('200 aggregate parallel citation and AI edges preserved through publication graph');
    });
  } finally {await p.close();await f.close({integrationContract:true,checks});}
}
