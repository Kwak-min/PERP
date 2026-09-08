import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withKnowledgeTransaction, withKnowledgeJobTransaction, withKnowledgeQueryDraftTransaction, retireUnauthorizedWikiJob } from './knowledge-wiki-store.service.js';
import { canonical, sha256, citationFor, wikiError, WIKI_CONTRACT } from './knowledge-wiki-contract.service.js';
import { localModelConfiguration, createLocalWikiCompiler, compilerInstructions, compilerOutputSchema, contextAccounting } from './knowledge-wiki-compiler.service.js';

const fail = (code,status=409) => { throw wikiError(code,status); };
export const WIKI_JOB_POLICY = Object.freeze({attempts:3,lease_ms:120000,heartbeat_ms:30000,queue:20});
const id = z.string().min(1).max(200);
const ids = z.array(id).min(1).max(20).refine(xs => new Set(xs).size === xs.length);
const target = z.object({page_id:id,version:z.number().int().positive(),published_head_id:id}).strict();
export const wikiJobRequestSchema = z.discriminatedUnion('operation',[
  z.object({operation:z.literal('ingest'),source_revision_ids:ids,target_base_versions:z.array(target).max(20).default([])}).strict(),
  z.object({operation:z.literal('query'),question:z.string().trim().min(1).max(4000),retrieval:z.object({raw:z.boolean(),published_wiki:z.boolean(),source_revision_ids:ids.optional()}).strict().refine(r=>r.raw || r.published_wiki)}).strict(),
  z.object({operation:z.literal('lint'),page_revision_ids:ids}).strict(),
]);
const bookkeeping = (context,id,work) => withKnowledgeJobTransaction(context,{jobId:id},work);
const read = (context,work) => withKnowledgeTransaction(context,{},work);
const snapshot = job => JSON.parse(job.source_vector_json);
function* owned(tx,id,lock=false) {
  const job = yield* tx.get('job',id,lock);
  if (!job || job.actor_id !== tx.context.actorId) fail('NOT_FOUND',404);
  return job;
}
function* fresh(tx,job) {
  const saved = snapshot(job).manifest, checked = yield* tx.manifest(saved.inputs);
  if (checked.hash !== saved.hash || tx.wiki.active_schema_id !== job.schema_revision_id) fail('MANIFEST_CONFLICT');
  if (job.current_attempt_id) {
    const stored = yield* tx.storedManifest(job.id,job.current_attempt_id);
    if (stored.hash !== checked.hash || job.input_manifest_hash !== stored.hash) fail('MANIFEST_CONFLICT');
  }
  return checked;
}
function* targetsCurrent(tx,targets) {
  for (const target of targets) {
    const page = yield* tx.get('page',target.page_id,true);
    if (!page || page.version !== target.version || page.published_head_id !== target.published_head_id) fail('TARGET_CONFLICT');
    if (!(yield* tx.pageRevision(page.published_head_id))) fail('SOURCE_REVOKED');
  }
}
function* capacity(tx) {
  const jobs = yield* tx.all('job');
  if (jobs.filter(j=>['queued','running'].includes(j.state)).length >= WIKI_JOB_POLICY.queue) fail('QUEUE_LIMIT',429);
}
function structuralIssues(pages) {
  const issues = [];
  for (const page of pages) {
    if (!page.markdown.trim()) issues.push({kind:'structural',code:'EMPTY_MARKDOWN',page_revision_id:page.id});
    if (!page.title.trim()) issues.push({kind:'structural',code:'EMPTY_TITLE',page_revision_id:page.id});
    if (!page.index_entry.trim()) issues.push({kind:'structural',code:'EMPTY_INDEX_ENTRY',page_revision_id:page.id});
    for (const field of ['citations_json','links_json']) {
      try { if (!Array.isArray(JSON.parse(page[field]))) throw new Error('array'); }
      catch { issues.push({kind:'structural',code:'INVALID_'+field.toUpperCase(),page_revision_id:page.id}); }
    }
  }
  return issues;
}
function* admissionInputs(tx,request) {
  let revisions = [], coverage = null, targets = [], issues = [];
  if (request.operation === 'query') {
    const retrieved = yield* tx.retrieve(request);
    revisions = retrieved.items; coverage = {...retrieved.coverage,selected_spans:retrieved.items.map(r=>r.citation).filter(Boolean)};
  } else if (request.operation === 'ingest') {
    for (const id of request.source_revision_ids) {
      const revision = yield* tx.sourceRevision(id);
      if (!revision) fail('NOT_FOUND',404);
      if (revision.freshness !== 'current') fail('SOURCE_STALE');
      revisions.push(revision);
    }
    targets = request.target_base_versions;
    if (new Set(targets.map(t=>t.page_id)).size !== targets.length) fail('VALIDATION_ERROR',400);
    yield* targetsCurrent(tx,targets);
    for (const target of targets) revisions.push(yield* tx.pageRevision(target.published_head_id));
  } else {
    for (const id of request.page_revision_ids) {
      const revision = yield* tx.pageRevision(id);
      if (!revision) fail('NOT_FOUND',404);
      revisions.push(revision);
      targets.push({page_id:revision.page_id,version:revision.version,published_head_id:revision.id});
    }
    issues = structuralIssues(revisions);
  }
  const schema = yield* tx.get('schema_revision',tx.wiki.active_schema_id);
  const anchors = revisions.filter(r=>(r.content ?? r.markdown).length).map(r=>citationFor(r));
  const raw = new Set();
  for (const revision of revisions) for (const id of yield* tx.rawClosure(revision.artifact_kind,revision.id)) raw.add(id);
  if (raw.size > 20 || revisions.filter(r=>r.artifact_kind==='page_revision').length > 20) fail('CONTEXT_LIMIT',422);
  const catalog = {operation:request.operation,targets,evidence:anchors.map((citation,index)=>{
    const revision = revisions.find(r=>r.id===citation.revision_id);
    return {index,citation,title:revision.title,page_id:revision.page_id ?? null,kind:revision.kind ?? null,source_identity:revision.source_identity ?? null,extraction_revision_id:revision.extraction_revision_id ?? null};
  }),structural_issues:issues};
  const inputs = [
    {kind:'schema_revision',revision_id:schema.id,supplied_text:schema.rules_md,classification:'public'},
    {kind:'instruction',supplied_text:compilerInstructions(request.operation),classification:'public',provenance:{compiler_version:'wiki-local-v1',operation:request.operation}},
    {kind:'catalog',supplied_text:canonical(catalog),classification:'internal',source_revision_ids:[...raw].sort(),provenance:{format:'wiki-evidence-catalog-v1'}},
    ...revisions.map(r=>({kind:r.artifact_kind,revision_id:r.id,supplied_text:r.content ?? r.markdown,classification:'internal',provenance:{title:r.title}})),
    ...(request.operation==='query' ? [{kind:'question',supplied_text:request.question,classification:'personal'}] : []),
  ];
  return {manifest:yield* tx.manifest(inputs),coverage,targets,issues,anchors};
}
function dto(job,attempts=[]) {
  return {id:job.id,operation:job.operation,state:job.state,fence:job.fence,current_attempt_id:job.current_attempt_id,failure_code:job.failure_code,result:job.result_json ? JSON.parse(job.result_json) : null,input_manifest_hash:job.input_manifest_hash,created_at:job.created_at,updated_at:job.updated_at,attempts:attempts.map(a=>({id:a.id,ordinal:a.ordinal,fence:a.fence,model_version:a.model_version,configuration:JSON.parse(a.config_json),input_manifest_hash:a.input_manifest_hash,result_hash:a.result_hash,started_at:a.started_at,finished_at:a.finished_at,failure_code:a.failure_code}))};
}
export async function admitWikiJob(context,input,idempotencyKey,configuration=null) {
  const request = wikiJobRequestSchema.parse(input);
  if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) fail('VALIDATION_ERROR',400);
  const config = configuration === null ? null : localModelConfiguration(configuration), requestHash = sha256(canonical(request));
  return withKnowledgeJobTransaction(context,{operation:request.operation},function*(tx) {
    const old = (yield* tx.all('job',{where:{actor_id:context.actorId,idempotency_key:idempotencyKey}}))[0];
    if (old) { if (old.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT'); yield* fresh(tx,old); return {created:false,job:dto(old)}; }
    yield* capacity(tx);
    const inputs = yield* admissionInputs(tx,request);
    if (config) contextAccounting(inputs.manifest,config);
    const instant = yield* tx.clock();
    const job = yield* tx.insert('job',{operation:request.operation,request_json:canonical(request),request_hash:requestHash,actor_id:context.actorId,idempotency_key:idempotencyKey,state:'queued',fence:0,source_vector_json:canonical({...inputs,configuration:config}),target_vector_json:canonical(inputs.targets),schema_revision_id:tx.wiki.active_schema_id,config_version:sha256(canonical(config)),created_at:instant,updated_at:instant});
    yield* tx.event('job.queued',{job_id:job.id});
    return {created:true,job:dto(yield* tx.get('job',job.id))};
  });
}
export async function getWikiJob(context,id) {
  return read(context,function*(tx) { const job=yield* owned(tx,id); yield* fresh(tx,job); return dto(job,yield* tx.all('job_attempt',{where:{job_id:id},orderBy:['ordinal']})); });
}
function* fenced(tx,id,lease) {
  const job = yield* owned(tx,id,true), instant = yield* tx.clock();
  if (job.state !== 'running' || job.lease_owner !== lease.owner || job.fence !== lease.fence || job.current_attempt_id !== lease.attempt_id || !job.lease_until || job.lease_until <= instant) fail('LEASE_LOST');
  return {job,instant};
}
export async function claimWikiJob(context,id,owner,modelSnapshot) {
  if (typeof owner !== 'string' || !owner || owner.length>200) fail('VALIDATION_ERROR',400);
  return bookkeeping(context,id,function*(tx) {
    const job = yield* owned(tx,id,true), instant = yield* tx.clock();
    if (job.state !== 'queued' && !(job.state === 'running' && job.lease_until <= instant)) return null;
    const manifest = yield* fresh(tx,job), saved=snapshot(job);
    yield* targetsCurrent(tx,JSON.parse(job.target_vector_json));
    const attempts=yield* tx.all('job_attempt',{where:{job_id:id},orderBy:['ordinal']});
    if (job.state === 'running') yield* tx.update('job_attempt',job.current_attempt_id,{finished_at:instant,failure_code:'LEASE_EXPIRED'});
    if (attempts.length>=3) {
      yield* tx.update('job',id,{state:'failed',fence:job.fence+1,failure_code:'ATTEMPTS_EXHAUSTED',lease_owner:null,lease_until:null,updated_at:instant});
      yield* tx.event('job.failed',{job_id:id},{code:'ATTEMPTS_EXHAUSTED'}); return null;
    }
    const config=saved.configuration;
    if (config && (canonical(modelSnapshot.configuration)!==canonical(config) || modelSnapshot.model_version!==config.model)) fail('MODEL_CONFIG_CHANGED');
    const accounting=config ? contextAccounting(manifest,config) : null;
    const attempt=yield* tx.insert('job_attempt',{job_id:id,ordinal:attempts.length+1,fence:job.fence+1,lease_owner:owner,model_version:modelSnapshot.model_version,config_json:canonical({...modelSnapshot,accounting}),input_manifest_hash:manifest.hash,started_at:instant});
    const row=yield* tx.update('job',id,{state:'running',fence:attempt.fence,lease_owner:owner,lease_until:new Date(Date.parse(instant)+WIKI_JOB_POLICY.lease_ms).toISOString(),current_attempt_id:attempt.id,input_manifest_hash:manifest.hash,model_version:modelSnapshot.model_version,failure_code:null,updated_at:instant});
    yield* tx.persistInputs(id,attempt.id,manifest);
    yield* tx.event('job.running',{job_id:id},{attempt:attempt.ordinal,fence:attempt.fence});
    return {job_id:id,owner,fence:row.fence,attempt_id:attempt.id};
  });
}
export async function heartbeatWikiJob(context,id,lease) {
  return bookkeeping(context,id,function*(tx) { const {job}=yield* fenced(tx,id,lease); yield* fresh(tx,job); const {instant}=yield* fenced(tx,id,lease); return yield* tx.update('job',id,{lease_until:new Date(Date.parse(instant)+WIKI_JOB_POLICY.lease_ms).toISOString(),updated_at:instant}); });
}
function* dispatchManifest(tx,id,lease) {
  const {job}=yield* fenced(tx,id,lease); const manifest=yield* fresh(tx,job);
  yield* targetsCurrent(tx,JSON.parse(job.target_vector_json)); yield* fenced(tx,id,lease);
  return manifest;
}
function safeMarkdown(value) {
  if (/!\[|<\s*(?:img|script|iframe|object|embed|svg)\b/i.test(value)) fail('MODEL_OUTPUT_INVALID',502);
  return value;
}
function* validateOutput(tx,job,manifest,envelope) {
  if (Buffer.byteLength(canonical(envelope))>WIKI_CONTRACT.limits.outputBytes) fail('MODEL_OUTPUT_LIMIT',502);
  const parsed=compilerOutputSchema.safeParse(envelope.output);
  if (!parsed.success || envelope.model_version!==job.model_version) fail('MODEL_OUTPUT_INVALID',502);
  const output=parsed.data,saved=snapshot(job), anchors=saved.anchors;
  function* citations(refs) {
    const found=[];
    for (const index of refs) {
      if (!anchors[index]) fail('INVALID_CITATION',502);
      try { found.push((yield* tx.validateCitation(anchors[index],manifest)).citation); }
      catch(error) { if (error.status===400) fail('INVALID_CITATION',502); throw error; }
    }
    return found;
  }
  const resultCitations=yield* citations(output.citations);
  if (job.operation==='query' && (output.pages.length || (anchors.length && (!output.answer_md || !resultCitations.length)))) fail('MODEL_OUTPUT_INVALID',502);
  if (!anchors.length && (output.answer_md || output.pages.length || resultCitations.length)) fail('MODEL_OUTPUT_INVALID',502);
  if (job.operation==='ingest' && !output.pages.length) fail('MODEL_OUTPUT_INVALID',502);
  const targets=JSON.parse(job.target_vector_json), ids=new Map(), existing=new Map();
  for (const target of targets) existing.set(target.page_id,yield* tx.pageRevision(target.published_head_id));
  // A supplied published query/page input may also be an authorized link destination.
  for (const input of manifest.inputs.filter(i=>i.kind==='page_revision')) { const revision=yield* tx.pageRevision(input.revision_id); existing.set(revision.page_id,revision); }
  for (const p of output.pages) {
    if (!p.title.trim() || ids.has(p.key) || (p.target_page_id && !targets.some(t=>t.page_id===p.target_page_id))) fail('MODEL_OUTPUT_INVALID',502);
    ids.set(p.key,p.target_page_id ?? randomUUID());
  }
  if (new Set(ids.values()).size!==ids.size || output.pages.reduce((n,p)=>n+p.links.length+p.citations.length,0)>WIKI_CONTRACT.limits.edges) fail('MODEL_OUTPUT_LIMIT',502);
  const proposed=[],heads=[];
  for (const p of output.pages) {
    const pageId=ids.get(p.key), base=p.target_page_id ? targets.find(t=>t.page_id===pageId) : null;
    if (base && existing.get(pageId).kind!==p.kind) fail('MODEL_OUTPUT_INVALID',502);
    const links=[];
    for (const l of p.links) {
      const targetId=ids.get(l.target) ?? (existing.has(l.target) ? l.target : null);
      if (!targetId) fail('MODEL_OUTPUT_INVALID',502);
      links.push({id:randomUUID(),type:'ai_derived',target_page_id:targetId,predicate:l.predicate,direction:l.direction,origin:'compiler',citations:yield* citations(l.citations)});
    }
    proposed.push({page_id:pageId,kind:p.kind,title:p.title,markdown:safeMarkdown(p.markdown),index_entry:safeMarkdown(p.index_entry),citations:yield* citations(p.citations),links,provenance:{origin:'compiler',review_state:'unreviewed',job_id:job.id,model_version:envelope.model_version,input_manifest_hash:manifest.hash}});
    heads.push(base ?? {page_id:pageId,version:null,published_head_id:null});
  }
  const suggestions=[];
  for (const suggestion of output.suggestions) suggestions.push({kind:'model_suggestion',code:suggestion.code,message:suggestion.message,citations:yield* citations(suggestion.citations)});
  return {proposed,heads,result:{result_revision_id:randomUUID(),operation:job.operation,review_state:'unreviewed',answer_md:output.answer_md ? safeMarkdown(output.answer_md) : null,citations:resultCitations,citation_validation:resultCitations.length || proposed.some(p=>p.citations.length) ? 'anchors_valid' : 'no_evidence',freshness:'current',input_manifest_hash:manifest.hash,provenance:{model_version:envelope.model_version,attempt_id:job.current_attempt_id,compiler_version:'wiki-local-v1',accounting:envelope.accounting ?? null,anchor_meaning:'traceability_not_verified_truth'},uncertainty:output.uncertainty,retrieval_coverage:saved.coverage,change_set_id:null,issues:[...saved.issues,...suggestions]}};
}
function* createDraft(tx,job,manifest,proposed,heads) {
  if (Buffer.byteLength(canonical(proposed))>WIKI_CONTRACT.limits.outputBytes) fail('MODEL_OUTPUT_LIMIT',502);
  const payload={wiki_id:tx.wiki.id,actor_id:job.actor_id,job_id:job.id,proposed_revisions:proposed,expected_heads:heads,lineage:manifest,schema_revision_id:job.schema_revision_id,input_manifest_hash:manifest.hash};
  const change=yield* tx.insert('change_set',{actor_id:job.actor_id,job_id:job.id,state:'draft',proposed_revisions_json:canonical(proposed),expected_heads_json:canonical(heads),lineage_json:canonical(manifest),schema_revision_id:job.schema_revision_id,input_manifest_hash:manifest.hash,manifest_hash:sha256(canonical(payload)),created_at:yield* tx.clock()});
  for (const id of new Set(manifest.inputs.flatMap(i=>i.source_revision_ids))) yield* tx.insert('dependency',{dependent_change_set_id:change.id,source_revision_id:id,relation:'transitive'});
  for (const input of manifest.inputs.filter(i=>i.kind==='page_revision')) yield* tx.insert('dependency',{dependent_change_set_id:change.id,page_revision_id:input.revision_id,relation:'direct'});
  yield* tx.event('change_set.draft',{job_id:job.id,change_set_id:change.id});
  return change;
}
export async function acceptWikiResult(context,id,lease,envelope) {
  return bookkeeping(context,id,function*(tx) {
    const {job}=yield* fenced(tx,id,lease), manifest=yield* fresh(tx,job);
    yield* targetsCurrent(tx,JSON.parse(job.target_vector_json));
    const accepted=yield* validateOutput(tx,job,manifest,envelope);
    if (Buffer.byteLength(canonical(accepted))>WIKI_CONTRACT.limits.outputBytes) fail('MODEL_OUTPUT_LIMIT',502);
    if (accepted.proposed.length) accepted.result.change_set_id=(yield* createDraft(tx,job,manifest,accepted.proposed,accepted.heads)).id;
    // Recheck DB time after all validation/writes; a transaction cannot extend a lease.
    const {instant}=yield* fenced(tx,id,lease), resultJson=canonical(accepted.result), resultHash=sha256(resultJson);
    yield* tx.update('job_attempt',lease.attempt_id,{result_hash:resultHash,finished_at:instant});
    yield* tx.update('job',id,{state:'succeeded',result_json:resultJson,result_hash:resultHash,lease_owner:null,lease_until:null,failure_code:null,updated_at:instant});
    yield* tx.event('job.succeeded',{job_id:id},{result_revision_id:accepted.result.result_revision_id});
    return accepted.result;
  });
}
export async function failWikiJob(context,id,lease,code,status) {
  try {
    return await bookkeeping(context,id,function*(tx) {
      const {instant}=yield* fenced(tx,id,lease);
      yield* tx.update('job_attempt',lease.attempt_id,{failure_code:code,finished_at:instant});
      yield* tx.update('job',id,{state:status===503 ? 'unavailable' : 'failed',failure_code:code,lease_owner:null,lease_until:null,updated_at:instant});
      yield* tx.event('job.failed',{job_id:id},{code});
    });
  } catch(error) {
    if (!['PERMISSION_DENIED','MODULE_DISABLED'].includes(error.code)) throw error;
    if (!(await retireUnauthorizedWikiJob(context,id,lease))) fail('LEASE_LOST');
  }
}
export async function retryWikiJob(context,id) {
  return bookkeeping(context,id,function*(tx) {
    const job=yield* owned(tx,id,true); yield* fresh(tx,job); yield* targetsCurrent(tx,JSON.parse(job.target_vector_json));
    if (job.state==='queued') return dto(job);
    if (!['failed','unavailable'].includes(job.state)) fail('JOB_STATE_CONFLICT');
    if ((yield* tx.all('job_attempt',{where:{job_id:id}})).length>=3) fail('ATTEMPTS_EXHAUSTED');
    yield* capacity(tx);
    const row=yield* tx.update('job',id,{state:'queued',fence:job.fence+1,lease_owner:null,lease_until:null,failure_code:null,updated_at:yield* tx.clock()});
    yield* tx.event('job.retry',{job_id:id}); return dto(row);
  });
}
export async function cancelWikiJob(context,id) {
  return bookkeeping(context,id,function*(tx) {
    // Cancellation discloses no input/result; stale dependencies must not trap queue slots.
    const job=yield* owned(tx,id,true);
    if (job.failure_code==='CANCELLED') return dto(job);
    if (!['queued','running'].includes(job.state)) fail('JOB_STATE_CONFLICT');
    const instant=yield* tx.clock();
    if (job.current_attempt_id && job.state==='running') yield* tx.update('job_attempt',job.current_attempt_id,{failure_code:'CANCELLED',finished_at:instant});
    const row=yield* tx.update('job',id,{state:'failed',failure_code:'CANCELLED',fence:job.fence+1,lease_owner:null,lease_until:null,updated_at:instant});
    yield* tx.event('job.cancelled',{job_id:id}); return dto(row);
  });
}
export async function draftWikiQuery(context,id) {
  return withKnowledgeQueryDraftTransaction(context,function*(tx) {
    const job=yield* owned(tx,id,true),manifest=yield* fresh(tx,job);
    if (job.operation!=='query' || job.state!=='succeeded') fail('JOB_STATE_CONFLICT');
    const result=JSON.parse(job.result_json);
    if (!result.answer_md || result.citation_validation!=='anchors_valid' || !result.citations.length) fail('NO_EVIDENCE');
    const prior=(yield* tx.all('change_set',{where:{job_id:id,actor_id:context.actorId}}))[0];
    if (prior) return {change_set_id:prior.id,manifest_hash:prior.manifest_hash,result_revision_id:result.result_revision_id};
    for (const citation of result.citations) yield* tx.validateCitation(citation,manifest);
    const pageId=randomUUID(), question=JSON.parse(job.request_json).question;
    const proposed=[{page_id:pageId,kind:'page',title:question.slice(0,500),markdown:result.answer_md,index_entry:`- [${pageId}](wiki:${pageId})`,citations:result.citations,links:[],provenance:{...result.provenance,origin:'compiler',review_state:'unreviewed',result_revision_id:result.result_revision_id,exact_result:result}}];
    const change=yield* createDraft(tx,job,manifest,proposed,[{page_id:pageId,version:null,published_head_id:null}]);
    // Successful result bytes never change; the immutable draft embeds that exact result.
    return {change_set_id:change.id,manifest_hash:change.manifest_hash,result_revision_id:result.result_revision_id};
  });
}

export async function runWikiJob(context,id,options={}) {
  try { return await executeWikiJob(context,id,options); }
  catch(error) {
    if (['PERMISSION_DENIED','MODULE_DISABLED'].includes(error.code)) await retireUnauthorizedWikiJob(context,id);
    throw error;
  }
}
async function executeWikiJob(context,id,{signal,owner=randomUUID()}={}) {
  // Fresh operation authority before reading the private dispatch configuration.
  const admitted=await bookkeeping(context,id,function*(tx) {
    const row=yield* owned(tx,id,true),instant=yield* tx.clock();
    if (!['queued','running'].includes(row.state) || (row.state==='running' && row.lease_until>instant)) return {job:null};
    try {yield* fresh(tx,row);yield* targetsCurrent(tx,JSON.parse(row.target_vector_json));}
    catch(error) {
      if (!['SOURCE_REVOKED','MANIFEST_CONFLICT','SCHEMA_CONFLICT','TARGET_CONFLICT'].includes(error.code)) throw error;
      // Authorized maintenance invalidation, not a lease-owner completion or renewal.
      if (row.current_attempt_id && row.state==='running') yield* tx.update('job_attempt',row.current_attempt_id,{failure_code:error.code,finished_at:instant});
      yield* tx.update('job',id,{state:'failed',fence:row.fence+1,failure_code:error.code,lease_owner:null,lease_until:null,updated_at:instant});
      yield* tx.event('job.invalidated',{job_id:id},{code:error.code});return {error};
    }
    return {job:row};
  });
  if (admitted.error) throw admitted.error;
  const job=admitted.job;
  if (!job) return null;
  const saved=snapshot(job),config=saved.configuration, noEvidence=job.operation==='query' && !saved.anchors.length;
  let compiler,modelSnapshot,errorBeforeClaim;
  try {
    if (noEvidence) modelSnapshot={model_version:config?.model ?? 'unconfigured',configuration:config,context_verification:'no_evidence_not_dispatched'};
    else {
      if (!config) fail('MODEL_UNAVAILABLE',503);
      compiler=createLocalWikiCompiler(config); modelSnapshot=await compiler.inspect(signal);
    }
  } catch(error) {
    errorBeforeClaim=error;
    modelSnapshot={model_version:config?.model ?? 'unconfigured',configuration:config,context_verification:'unavailable_not_dispatched'};
  }
  const lease=await claimWikiJob(context,id,owner,modelSnapshot);
  if (!lease) return null;
  const controller=new AbortController(),combined=AbortSignal.any([controller.signal,...(signal ? [signal] : [])]);
  let heartbeatError=null,renewal=Promise.resolve();
  const timer=setInterval(()=>{
    renewal=renewal.then(()=>heartbeatWikiJob(context,id,lease)).catch(error=>{heartbeatError=error;controller.abort();});
  },WIKI_JOB_POLICY.heartbeat_ms);
  timer.unref();
  try {
    if (errorBeforeClaim) throw errorBeforeClaim;
    const manifest=await bookkeeping(context,id,function*(tx) { return yield* dispatchManifest(tx,id,lease); });
    let envelope;
    if (noEvidence) envelope={output:{answer_md:null,citations:[],uncertainty:[],pages:[],suggestions:[]},model_version:modelSnapshot.model_version,accounting:{...(config ? contextAccounting(manifest,config) : {}),actual_prompt_tokens:0,actual_completion_tokens:0,dispatched:false}};
    else envelope=await compiler.compile(manifest,combined);
    if (heartbeatError) throw heartbeatError;
    return await acceptWikiResult(context,id,lease,envelope);
  } catch(error) {
    const failure=heartbeatError ?? error;
    try { await failWikiJob(context,id,lease,failure.code ?? 'MODEL_FAILURE',failure.status ?? 502); }
    catch(terminalError) { if (terminalError.code !== 'LEASE_LOST') throw new AggregateError([failure,terminalError],'Wiki worker terminal write failed'); }
    throw failure;
  } finally { clearInterval(timer);controller.abort();await renewal; }
}
