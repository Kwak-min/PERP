import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { adaptWikiGraph, wikiGraphSchema, verifiedSpan, manualDraftSchema, publicationSchema, pageRevisionSchema, jobSchema } from '../src/screens/knowledge/wikiModel.ts';
import { prepareKnowledgeGraph, relationClass } from '../src/components/data/knowledgeGraphStageModel.ts';
const hash=value=>createHash('sha256').update(value).digest('hex');
const scope={store:'pg',scope:'personal',company_id:null,owner_id:'owner-28'};
const source={id:'source:opaque',source_id:'opaque',kind:'source',revision_id:'source-revision',title:'source',freshness:'current'};
const page={id:'page:opaque',page_id:'opaque',kind:'page',revision_id:'page-revision',title:'page',freshness:'current',version:1};
const citation={artifact_kind:'source_revision',revision_id:'source-revision',revision_sha256:hash('abc'),start_byte:0,end_byte:3,span_sha256:hash('abc')};
const common={source:page.id,target:source.id,source_revision_id:page.revision_id,target_revision_id:source.revision_id,review_state:'published'};
const graph={nodes:[source,page],edges:[{...common,id:'citation:1',type:'citation',origin:'citation',direction:'directed',citation},{...common,id:'citation:2',type:'citation',origin:'citation',direction:'directed',citation:{...citation,start_byte:1}},{...common,id:'derived:1',type:'ai_derived',target_page_id:'opaque',predicate:'supports',direction:'directed',origin:'compiler',citations:[citation]},{...common,id:'manual:1',type:'manual',target_page_id:'opaque',predicate:'related',direction:'undirected',origin:'human',citations:[]}],counts:{nodes:2,edges:4}};
test('Wiki identity namespaces and all parallel direction/provenance survive without similarity relabeling',()=>{
 const parsed=wikiGraphSchema.parse(graph), snapshot=structuredClone(parsed), stage=adaptWikiGraph(parsed,scope),prepared=prepareKnowledgeGraph(stage);
 assert.notEqual(stage.nodes[0].renderer_id,stage.nodes[1].renderer_id);
 assert.deepEqual(stage.nodes.map(n=>n.identity),[{store:'pg',company:null,owner:'owner-28',kind:'source',opaque_id:'opaque'},{store:'pg',company:null,owner:'owner-28',kind:'page',opaque_id:'opaque'}]);
 assert.deepEqual(stage.edges.map(e=>[e.kind,e.direction,relationClass(e.kind)]),[['citation','directed','citation'],['citation','directed','citation'],['ai_derived','directed','derived'],['manual','undirected','wiki']]);
 assert.deepEqual(prepared.links.map(e=>e.provenance),graph.edges);
 assert.equal(new Set(prepared.links.map(e=>e.curvature)).size,4);
 prepared.nodes[0].x=42;prepared.links[0].render_source=prepared.nodes[1];prepared.links[0].provenance.citation.start_byte=999;
 assert.deepEqual(parsed,snapshot);assert.equal(prepared.identityMap.get(stage.nodes[0].renderer_id),stage.nodes[0]);
});
test('unauthorized/misbound/duplicate typed graph IDs fail at adapter boundary',()=>{
 assert.throws(()=>wikiGraphSchema.parse({...graph,edges:[{...graph.edges[0],target:'private:absent'}],counts:{nodes:2,edges:1}}));
 assert.throws(()=>wikiGraphSchema.parse({...graph,nodes:[source,{...page,id:source.id}]}));
 assert.throws(()=>adaptWikiGraph(graph,null));
 assert.deepEqual(adaptWikiGraph({nodes:[],edges:[],counts:{nodes:0,edges:0}},null),{nodes:[],edges:[]});
});
for(const count of [0,1,1000])test(`Wiki ${count} nodes preserve source/page/entity/concept and distinct scoped identity`,()=>{
 const nodes=Array.from({length:count},(_,i)=>i%4===0?{...source,id:`source:${i}`,source_id:String(i)}:{...page,id:`${['page','entity','concept'][i%3]}:${i}`,page_id:String(i),kind:['page','entity','concept'][i%3]});
 const parsed=wikiGraphSchema.parse({nodes,edges:[],counts:{nodes:count,edges:0}}),stage=adaptWikiGraph(parsed,scope);
 assert.equal(prepareKnowledgeGraph(stage).nodes.length,count);assert.equal(new Set(stage.nodes.map(n=>n.renderer_id)).size,count);
 const other=adaptWikiGraph(parsed,{...scope,owner_id:'different-owner'});if(count)assert.notEqual(stage.nodes[0].renderer_id,other.nodes[0].renderer_id);
});
test('Korean/emoji/CRLF repeated quote is restored from the exact revision UTF8 bytes',async()=>{
 const before='한글😀\r\n같은 구절\r\n',quote='같은 구절',content=before+quote;
 const revision={id:'fixed-old',artifact_kind:'source_revision',content};
 const anchor={artifact_kind:'source_revision',revision_id:revision.id,revision_sha256:hash(content),start_byte:Buffer.byteLength(before),end_byte:Buffer.byteLength(content),span_sha256:hash(quote)};
 assert.deepEqual(await verifiedSpan(revision,anchor),{before,quote,after:''});
 await assert.rejects(()=>verifiedSpan({...revision,id:'latest'},anchor));
 await assert.rejects(()=>verifiedSpan({...revision,content:content+'changed'},anchor));
 await assert.rejects(()=>verifiedSpan(revision,{...anchor,start_byte:before.length}));
 const split={...anchor,start_byte:1,end_byte:3,span_sha256:hash(Buffer.from(content).subarray(1,3))};await assert.rejects(()=>verifiedSpan(revision,split));
});
test('ingest/lint use null retrieval coverage, unlike raw-first queries',()=>{
 const result={result_revision_id:'r',operation:'ingest',review_state:'unreviewed',answer_md:null,citations:[citation],citation_validation:'anchors_valid',freshness:'current',input_manifest_hash:hash('m'),provenance:{},uncertainty:[],retrieval_coverage:null,change_set_id:'d',issues:[]};
 const job={id:'j',operation:'ingest',state:'succeeded',failure_code:null,attempts:[],result};
 assert.equal(jobSchema.parse(job).result.retrieval_coverage,null);
 assert.equal(jobSchema.parse({...job,result:{...result,operation:'lint'}}).result.operation,'lint');
 assert.throws(()=>jobSchema.parse({...job,result:{...result,operation:'query'}}));
 assert.deepEqual(jobSchema.parse({...job,result:{...result,operation:'query',retrieval_coverage:{raw:true}}}).result.retrieval_coverage,{raw:true});
});
test('manual POST keeps JSON strings while publication result_json is parsed',()=>{
 const draft={id:'d',manifest_hash:hash('d'),proposed_revisions_json:'[]',expected_heads_json:'[]',lineage_json:'{}'};
 assert.equal(manualDraftSchema.parse(draft).proposed_revisions_json,'[]');assert.throws(()=>manualDraftSchema.parse({...draft,proposed_revisions_json:[]}));
 const receipt={id:'r',manifest_hash:hash('d'),result_json:{page_revision_ids:['r'],page_ids:['p'],pages:[{id:'p',revision_id:'r',version:1}]}};
 assert.equal(publicationSchema.parse(receipt).result_json.pages[0].version,1);assert.throws(()=>publicationSchema.parse({...receipt,result_json:JSON.stringify(receipt.result_json)}));
 const revision={id:'r',page_id:'p',artifact_kind:'page_revision',title:'t',content:'body',markdown:'body',content_sha256:hash('body'),citations_json:'[]',links_json:'[]',provenance_json:'{}',input_manifest_hash:hash('manifest'),version:1,kind:'page',freshness:'current'};
 assert.equal(pageRevisionSchema.parse(revision).citations_json,'[]');assert.throws(()=>pageRevisionSchema.parse({...revision,citations_json:[]}));
});
