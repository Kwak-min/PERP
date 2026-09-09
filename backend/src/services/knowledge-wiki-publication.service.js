import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withKnowledgeTransaction } from './knowledge-wiki-store.service.js';
import { canonical, sha256, citationSchema, freezeManifest, restoreSpan, WIKI_CONTRACT, wikiError } from './knowledge-wiki-contract.service.js';

const fail = (code, status = 409) => { throw wikiError(code,status); };
const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const publishSchema = z.object({manifest_hash:digest,confirmed:z.literal(true)}).strict();
export const rejectSchema = z.object({manifest_hash:digest}).strict();
export const manualEditSchema = z.object({expected_version:z.number().int().positive(),title:z.string().trim().min(1).max(1000),markdown:z.string().max(WIKI_CONTRACT.limits.outputBytes)}).strict();
const linkSchema = z.object({id,type:z.enum(['manual','ai_derived']),target_page_id:id,predicate:z.enum(['related','supports','contradicts','supersedes']),direction:z.enum(['directed','undirected']),origin:z.enum(['human','compiler']),citations:z.array(citationSchema)}).strict();
// Validate frozen bytes without transforming them before digest verification.
const proposalSchema = z.array(z.object({page_id:id,kind:z.enum(['page','entity','concept']),title:z.string().min(1).max(1000).refine(value=>value.trim().length>0),markdown:z.string(),index_entry:z.string(),citations:z.array(citationSchema),links:z.array(linkSchema),provenance:z.record(z.string(),z.unknown())}).strict()).min(1).max(WIKI_CONTRACT.limits.pages);
const headsSchema = z.array(z.object({page_id:id,version:z.number().int().positive().nullable(),published_head_id:id.nullable()}).strict());

export function changeSetDigest(fields) {
  const {wiki_id,actor_id,job_id=null,proposed_revisions,expected_heads,lineage,schema_revision_id,input_manifest_hash}=fields;
  return sha256(canonical({wiki_id,actor_id,job_id,proposed_revisions,expected_heads,lineage,schema_revision_id,input_manifest_hash}));
}
function decode(row) {
  const value={...row,proposed_revisions:proposalSchema.parse(JSON.parse(row.proposed_revisions_json)),expected_heads:headsSchema.parse(JSON.parse(row.expected_heads_json)),lineage:JSON.parse(row.lineage_json)};
  if (freezeManifest(value.lineage.inputs).hash !== value.lineage.hash || value.lineage.hash !== row.input_manifest_hash || changeSetDigest(value)!==row.manifest_hash) fail('MANIFEST_CONFLICT');
  const ids=value.proposed_revisions.map(p=>p.page_id), heads=value.expected_heads;
  if (new Set(ids).size!==ids.length || heads.length!==ids.length || new Set(heads.map(h=>h.page_id)).size!==ids.length || heads.some(h=>!ids.includes(h.page_id)||(h.version===null)!==(h.published_head_id===null))) fail('MANIFEST_CONFLICT');
  const links=value.proposed_revisions.flatMap(p=>p.links);
  if (new Set(links.map(l=>l.id)).size!==links.length) fail('INVALID_RELATION',400);
  if (links.length+value.proposed_revisions.reduce((n,p)=>n+p.citations.length,0)>WIKI_CONTRACT.limits.edges || Buffer.byteLength(canonical(value.proposed_revisions))>WIKI_CONTRACT.limits.outputBytes) fail('PAYLOAD_TOO_LARGE',413);
  return value;
}
function* owned(tx,id,lock=false) {
  const row=yield* tx.get('change_set',id,lock);
  if (!row || row.actor_id!==tx.context.actorId) fail('NOT_FOUND',404);
  if (row.job_id) {
    const job=yield* tx.get('job',row.job_id,lock);
    if (!job || job.actor_id!==tx.context.actorId) fail('NOT_FOUND',404);
  }
  return decode(row);
}
// 읽기에도 모든 입력을 검사한다. stale은 명시한 이력에서만 허용하고 revoked는 본문까지 숨긴다.
export function* authorizeLineage(tx,lineage,{current=false}={}) {
  let freshness='current';
  for (const input of lineage.inputs) {
    if (['source_revision','page_revision'].includes(input.kind)) {
      const revision=input.kind==='source_revision' ? yield* tx.sourceRevision(input.revision_id) : yield* tx.pageRevision(input.revision_id,{current:false});
      if (!revision || revision.content!==input.supplied_text) fail('NOT_FOUND',404);
      if (revision.freshness!=='current') freshness='stale';
    }
    for (const raw of input.source_revision_ids ?? []) {
      const revision=yield* tx.sourceRevision(raw);
      if (!revision) fail('NOT_FOUND',404);
      if (revision.freshness!=='current') freshness='stale';
    }
  }
  if (current && freshness!=='current') fail('SOURCE_STALE');
  return freshness;
}
function* dependencies(tx,lineage,dependent,replacedHeads=new Set()) {
  const raw=new Set(lineage.inputs.flatMap(i=>i.source_revision_ids ?? []));
  const pending=new Set(lineage.inputs.filter(i=>i.kind==='page_revision').map(i=>i.revision_id)), pages=new Set();
  // Only exact heads replaced by this validated atomic publication are ancestry.
  // Keep their immutable input/citation bytes in the change set; carry their entire
  // dependency frontier forward, not circular claims against the new bundle text.
  // External revisions remain live, including uncited context and inherited inputs.
  for (const pageId of pending) {
    if (!replacedHeads.has(pageId)) { pages.add(pageId); continue; }
    for (const dep of yield* tx.all('dependency',{where:{dependent_page_revision_id:pageId}})) {
      if (dep.page_revision_id) pending.add(dep.page_revision_id);
      if (dep.source_revision_id) raw.add(dep.source_revision_id);
    }
  }
  for (const source_revision_id of raw) yield* tx.insert('dependency',{...dependent,source_revision_id,relation:'transitive'});
  for (const page_revision_id of pages) yield* tx.insert('dependency',{...dependent,page_revision_id,relation:'direct'});
}
function* publishedChange(tx,revisionId) {
  const publication=(yield* tx.all('publication')).find(p=>JSON.parse(p.result_json).page_revision_ids.includes(revisionId));
  return decode(yield* tx.get('change_set',publication.change_set_id));
}
function* validatePublicationCitation(tx,citation,checked,inherited) {
  if (!inherited.has(canonical(citation))) return yield* tx.validateCitation(citation,checked);
  // A human may retain an already published exact anchor, not relabel it as a
  // citation to changed text. Current parent lineage was checked in full below.
  const revision=citation.artifact_kind==='source_revision' ? yield* tx.sourceRevision(citation.revision_id,{current:true}) : yield* tx.pageRevision(citation.revision_id,{current:false});
  if (!revision) fail('SOURCE_REVOKED');
  restoreSpan(revision,citation);
}
function* validateProposal(tx,change) {
  if (tx.wiki.active_schema_id!==change.schema_revision_id) fail('SCHEMA_CONFLICT');
  const checked=yield* tx.manifest(change.lineage.inputs);
  if (checked.hash!==change.input_manifest_hash) fail('MANIFEST_CONFLICT');
  if (new Set(checked.inputs.flatMap(i=>i.source_revision_ids)).size>WIKI_CONTRACT.limits.sources || checked.inputs.filter(i=>i.kind==='page_revision').length>WIKI_CONTRACT.limits.pages) fail('CONTEXT_LIMIT',422);
  const suppliedPages=new Set();
  for (const input of checked.inputs.filter(i=>i.kind==='page_revision')) suppliedPages.add((yield* tx.get('page_revision',input.revision_id)).page_id);
  const bundle=new Set(change.proposed_revisions.map(p=>p.page_id));
  for (const proposal of change.proposed_revisions) {
    const expected=change.expected_heads.find(h=>h.page_id===proposal.page_id);
    const page=yield* tx.get('page',proposal.page_id,true);
    if (expected.version===null ? page!==null : !page || page.version!==expected.version || page.published_head_id!==expected.published_head_id) fail('VERSION_CONFLICT');
    if (page && page.kind!==proposal.kind) fail('INVALID_PAGE_KIND',400);
    // compiler의 새 근거 전용 rebuild는 이전 본문을 읽지 않는다. 이전 문맥을 공급하면 manifest가 다시 검사한다.
    // 수동 텍스트 변경만으로는 기존 lineage를 줄일 수 없다.
    const inherited=new Set();
    if (page && proposal.provenance.origin==='human') {
      if (!(yield* tx.pageRevision(page.published_head_id))) fail('NOT_FOUND',404);
      if (proposal.provenance.previous_revision_id===page.published_head_id) {
        const original=yield* publishedChange(tx,page.published_head_id), old=original.proposed_revisions.find(p=>p.page_id===page.id);
        for (const citation of [...old.citations,...old.links.flatMap(l=>l.citations)]) inherited.add(canonical(citation));
      }
      for (const dep of yield* tx.all('dependency',{where:{dependent_page_revision_id:page.published_head_id}})) {
        const has=dep.source_revision_id ? checked.inputs.some(i=>i.source_revision_ids.includes(dep.source_revision_id)) : checked.inputs.some(i=>i.kind==='page_revision' && i.revision_id===dep.page_revision_id);
        if (!has) fail('INCOMPLETE_LINEAGE',400);
      }
    }
    for (const citation of proposal.citations) yield* validatePublicationCitation(tx,citation,checked,inherited);
    for (const link of proposal.links) {
      if (link.type==='ai_derived' && (link.origin!=='compiler' || !link.citations.length)) fail('INVALID_RELATION',400);
      if (link.type==='manual' && link.origin!=='human') fail('INVALID_RELATION',400);
      if (!bundle.has(link.target_page_id) && !suppliedPages.has(link.target_page_id)) fail('INVALID_RELATION',400);
      for (const citation of link.citations) yield* validatePublicationCitation(tx,citation,checked,inherited);
    }
  }
  return checked;
}
function receipt(row) { return {...row,result_json:JSON.parse(row.result_json)}; }
function notice(context,wikiId) { process.emit('orbitflow:wiki-changed',{store:context.store,wiki_id:wikiId}); }
export async function publishChangeSet(context,id,input,idempotencyKey) {
  const body=publishSchema.parse(input);
  if (typeof idempotencyKey!=='string' || !idempotencyKey.trim() || idempotencyKey.length>200) fail('VALIDATION_ERROR',400);
  const result=await withKnowledgeTransaction(context,{write:true},function*(tx) {
    const change=yield* owned(tx,id,true);
    if (body.manifest_hash!==change.manifest_hash) fail('MANIFEST_CONFLICT');
    const prior=(yield* tx.all('publication',{where:{idempotency_key:idempotencyKey}}))[0];
    if (prior && (prior.change_set_id!==id || prior.manifest_hash!==body.manifest_hash || prior.actor_id!==context.actorId)) fail('IDEMPOTENCY_CONFLICT');
    if (prior) {
      // 재시도는 head를 다시 쓰지 않는다. 원본과 외부 페이지의 현재 권한/버전을 다시 검사한다.
      if (tx.wiki.active_schema_id!==change.schema_revision_id) fail('SCHEMA_CONFLICT');
      const ownPages=new Set(JSON.parse(prior.result_json).page_ids);
      for (const input of change.lineage.inputs.filter(i=>i.kind==='page_revision')) {
        const revision=yield* tx.get('page_revision',input.revision_id);
        if (!revision || (!ownPages.has(revision.page_id) && !(yield* tx.pageRevision(input.revision_id)))) fail('SOURCE_REVOKED');
      }
      for (const raw of new Set(change.lineage.inputs.flatMap(i=>i.source_revision_ids ?? []))) if (!(yield* tx.sourceRevision(raw,{current:true}))) fail('SOURCE_REVOKED');
      yield* authorizeLineage(tx,change.lineage);
      for (const revisionId of JSON.parse(prior.result_json).page_revision_ids) if (!(yield* tx.pageRevision(revisionId,{current:false}))) fail('NOT_FOUND',404);
      return receipt(prior);
    }
    if (change.state!=='draft') fail('CHANGE_SET_STATE');
    const checked=yield* validateProposal(tx,change), created_at=yield* tx.clock();
    const replacedHeads=new Set(change.expected_heads.map(h=>h.published_head_id).filter(Boolean));
    const pages=[],revisionIds=new Map(change.proposed_revisions.map(p=>[p.page_id,randomUUID()]));
    for (const input of checked.inputs.filter(i=>i.kind==='page_revision')) {
      const revision=yield* tx.get('page_revision',input.revision_id);
      if (!revisionIds.has(revision.page_id)) revisionIds.set(revision.page_id,revision.id);
    }
    for (const proposal of change.proposed_revisions) {
      const expected=change.expected_heads.find(h=>h.page_id===proposal.page_id);
      if (expected.version===null) yield* tx.insert('page',{id:proposal.page_id,kind:proposal.kind,version:1,created_at});
      const revision=yield* tx.insert('page_revision',{id:revisionIds.get(proposal.page_id),page_id:proposal.page_id,title:proposal.title,markdown:proposal.markdown,index_entry:proposal.index_entry,content_sha256:sha256(proposal.markdown),citations_json:canonical(proposal.citations),links_json:canonical(proposal.links.map(link=>({...link,target_revision_id:revisionIds.get(link.target_page_id)}))),provenance_json:canonical(proposal.provenance),input_manifest_hash:checked.hash,schema_revision_id:change.schema_revision_id,actor_id:context.actorId,created_at});
      yield* dependencies(tx,checked,{dependent_page_revision_id:revision.id},replacedHeads);
      const version=expected.version===null ? 1 : expected.version+1;
      yield* tx.update('page',proposal.page_id,{published_head_id:revision.id,version,state:'published'});
      pages.push({id:proposal.page_id,revision_id:revision.id,version});
    }
    const publication=yield* tx.insert('publication',{change_set_id:id,actor_id:context.actorId,idempotency_key:idempotencyKey,manifest_hash:body.manifest_hash,result_json:canonical({page_revision_ids:pages.map(p=>p.revision_id),page_ids:pages.map(p=>p.id),pages}),created_at});
    // An external dependency can itself depend on a replaced head. Do not erase
    // that cross-publication contract or commit a bundle that invalidates itself.
    for (const page of pages) if (!(yield* tx.pageRevision(page.revision_id))) fail('SOURCE_STALE');
    yield* tx.update('change_set',id,{state:'published'});
    yield* tx.updateWiki({generation:tx.wiki.generation+1});
    for (const page of pages) yield* tx.event('page.published',{page_revision_id:page.revision_id});
    yield* tx.event('change_set.published',{change_set_id:id});
    return receipt(publication);
  });
  notice(context,result.wiki_id); return result;
}
export function inspectChangeSet(context,id) {
  return withKnowledgeTransaction(context,{},function*(tx) {
    const change=yield* owned(tx,id), freshness=yield* authorizeLineage(tx,change.lineage),diff=[];
    for (const proposal of change.proposed_revisions) {
      const head=change.expected_heads.find(h=>h.page_id===proposal.page_id);
      const before=head.published_head_id ? yield* tx.pageRevision(head.published_head_id,{current:false}) : null;
      diff.push({page_id:proposal.page_id,before:before ? {revision_id:before.id,title:before.title,markdown:before.markdown} : null,before_state:before?.freshness ?? (head.published_head_id ? 'unavailable' : 'absent'),after:proposal});
    }
    const {proposed_revisions_json,expected_heads_json,lineage_json,...dto}=change;
    return {...dto,freshness,diff};
  });
}
export async function rejectChangeSet(context,id,input) {
  const body=rejectSchema.parse(input);
  const result=await withKnowledgeTransaction(context,{write:true},function*(tx) {
    const change=yield* owned(tx,id,true);
    yield* authorizeLineage(tx,change.lineage);
    if (body.manifest_hash!==change.manifest_hash) fail('MANIFEST_CONFLICT');
    if (change.state==='published') fail('CHANGE_SET_STATE');
    if (change.state==='draft') {
      yield* tx.update('change_set',id,{state:'rejected'});
      yield* tx.event('change_set.rejected',{change_set_id:id});
    }
    return {id,wiki_id:tx.wiki.id,state:'rejected',manifest_hash:change.manifest_hash};
  });
  notice(context,result.wiki_id); return result;
}
export async function createManualChangeSet(context,pageId,input) {
  const body=manualEditSchema.parse(input);
  const result=await withKnowledgeTransaction(context,{write:true},function*(tx) {
    const page=yield* tx.get('page',pageId,true), revision=page && (yield* tx.pageRevision(page.published_head_id));
    if (!revision) fail('NOT_FOUND',404);
    if (body.expected_version!==page.version) fail('VERSION_CONFLICT');
    const original=yield* publishedChange(tx,revision.id);
    // Keep exact replaced-head context as historical evidence; the current parent
    // and its live frontier authorize a new edit. Never substitute new text at an
    // old citation or discard private/uncited inputs from the original manifest.
    const ancestry=new Set(original.expected_heads.map(h=>h.published_head_id).filter(Boolean));
    const inputs=original.lineage.inputs.map(input=>input.kind==='page_revision' && ancestry.has(input.revision_id)
      ? {...input,kind:'prior_result',provenance:{...input.provenance,artifact_kind:'page_revision'}} : input);
    for (const revisionId of new Set([revision.id,...(yield* tx.all('dependency',{where:{dependent_page_revision_id:revision.id}})).map(d=>d.page_revision_id).filter(Boolean)])) {
      if (inputs.some(i=>i.kind==='page_revision' && i.revision_id===revisionId)) continue;
      const current=yield* tx.pageRevision(revisionId);
      if (!current) fail('SOURCE_REVOKED');
      inputs.push({kind:'page_revision',revision_id:current.id,supplied_text:current.markdown,classification:'public'});
    }
    const old=original.proposed_revisions.find(p=>p.page_id===pageId);
    for (const link of old.links) {
      const target=yield* tx.get('page',link.target_page_id);
      const targetRevision=target && (yield* tx.pageRevision(target.published_head_id));
      if (!targetRevision) fail('NOT_FOUND',404);
      if (!inputs.some(i=>i.kind==='page_revision' && i.revision_id===targetRevision.id)) inputs.push({kind:'page_revision',revision_id:targetRevision.id,supplied_text:targetRevision.markdown,classification:'public'});
    }
    const lineage=yield* tx.manifest(inputs);
    const proposed_revisions=[{...old,title:body.title,markdown:body.markdown,index_entry:`- ${body.title.replace(/[\r\n]/g,' ')}`,links:old.links.map(l=>({...l,id:randomUUID()})),provenance:{...old.provenance,origin:'human',previous_revision_id:revision.id}}];
    const expected_heads=[{page_id:pageId,version:page.version,published_head_id:revision.id}];
    const fields={wiki_id:tx.wiki.id,actor_id:context.actorId,job_id:null,proposed_revisions,expected_heads,lineage,schema_revision_id:tx.wiki.active_schema_id,input_manifest_hash:lineage.hash};
    const row=yield* tx.insert('change_set',{actor_id:context.actorId,job_id:null,state:'draft',proposed_revisions_json:canonical(proposed_revisions),expected_heads_json:canonical(expected_heads),lineage_json:canonical(lineage),schema_revision_id:fields.schema_revision_id,input_manifest_hash:lineage.hash,manifest_hash:changeSetDigest(fields),created_at:yield* tx.clock()});
    yield* dependencies(tx,lineage,{dependent_change_set_id:row.id});
    yield* tx.event('change_set.created',{change_set_id:row.id});
    return row;
  });
  notice(context,result.wiki_id); return result;
}
export function pageHistory(context,pageId) {
  return withKnowledgeTransaction(context,{},function*(tx) {
    const page=yield* tx.get('page',pageId);
    if (!page || !(yield* tx.pageRevision(page.published_head_id,{current:false}))) fail('NOT_FOUND',404);
    const items=[];
    for (const candidate of yield* tx.all('page_revision',{where:{page_id:pageId},orderBy:['created_at','id']})) {
      const revision=yield* tx.pageRevision(candidate.id,{current:false});
      if (revision) items.push(revision);
    }
    return {items};
  });
}
const typed=(kind,id)=>`${kind}:${id}`;
export function* graphProjection(tx) {
  const nodes=[],edges=[],revisions=new Map();
  for (const page of yield* tx.pages()) {
    const node={id:typed(page.kind,page.page_id),kind:page.kind,page_id:page.page_id,revision_id:page.id,title:page.title,version:page.version,freshness:page.freshness};
    nodes.push(node); revisions.set(page.id,node);
  }
  for (const source of yield* tx.all('source')) {
    const revision=yield* tx.sourceRevision(source.current_revision_id,{current:true});
    if (!revision) continue;
    const node={id:typed('source',source.id),kind:'source',source_id:source.id,revision_id:revision.id,title:revision.title,freshness:revision.freshness};
    nodes.push(node);revisions.set(revision.id,node);
  }
  for (const node of [...nodes].filter(n=>n.page_id)) {
    const page=yield* tx.pageRevision(node.revision_id);
    for (const [ordinal,citation] of JSON.parse(page.citations_json).entries()) {
      let target=revisions.get(citation.revision_id);
      if (!target && citation.artifact_kind==='page_revision') {
        const historical=yield* tx.pageRevision(citation.revision_id,{current:false});
        if (historical) target=nodes.find(n=>n.page_id===historical.page_id);
      }
      if (target) edges.push({id:`citation:${page.id}:${ordinal}`,type:'citation',origin:'citation',direction:'directed',source:node.id,target:target.id,citation,source_revision_id:page.id,target_revision_id:citation.revision_id,review_state:'published'});
    }
    for (const link of JSON.parse(page.links_json)) {
      const target=nodes.find(n=>n.page_id===link.target_page_id);
      if (target) edges.push({...link,source:node.id,target:target.id,source_revision_id:page.id,target_revision_id:link.target_revision_id ?? target.revision_id,review_state:'published'});
    }
  }
  return {nodes,edges,counts:{nodes:nodes.length,edges:edges.length}};
}
export function wikiGraph(context) {return withKnowledgeTransaction(context,{},graphProjection);}

// 저장된 metadata를 전달하지 않는다. 현재 인가된 참조만 허용 목록으로 재구성한다.
export function* eventProjection(tx,cursor=0) {
  const items=[];
  for (const event of yield* tx.all('event',{orderBy:['sequence']})) {
    if (event.sequence<=cursor) continue;
    try {
      if (event.source_revision_id && !(yield* tx.sourceRevision(event.source_revision_id,{current:true}))) continue;
      if (event.page_revision_id && !(yield* tx.pageRevision(event.page_revision_id))) continue;
      if (event.change_set_id) {const change=yield* owned(tx,event.change_set_id);yield* authorizeLineage(tx,change.lineage,{current:true});}
      if (event.job_id) {
        const job=yield* tx.get('job',event.job_id);
        if (!job || job.actor_id!==tx.context.actorId) continue;
        for (const dep of yield* tx.all('dependency',{where:{dependent_job_id:job.id}})) {
          const r=dep.source_revision_id ? yield* tx.sourceRevision(dep.source_revision_id,{current:true}) : yield* tx.pageRevision(dep.page_revision_id);
          if (!r) fail('NOT_FOUND',404);
        }
        if (job.current_attempt_id) yield* authorizeLineage(tx,yield* tx.storedManifest(job.id,job.current_attempt_id),{current:true});
      }
    } catch(error) {if ([404,409].includes(error.status)) continue;throw error;}
    items.push({sequence:event.sequence,kind:event.kind,created_at:event.created_at,...(event.page_revision_id ? {page_revision_id:event.page_revision_id}:{}),...(event.source_revision_id ? {source_revision_id:event.source_revision_id}:{}),...(event.job_id ? {job_id:event.job_id}:{}),...(event.change_set_id ? {change_set_id:event.change_set_id}:{})});
  }
  return {items,next_cursor:items.at(-1)?.sequence ?? cursor};
}
export function wikiEvents(context,cursor=0) {
  if (!Number.isSafeInteger(cursor)||cursor<0) fail('VALIDATION_ERROR',400);
  return withKnowledgeTransaction(context,{},function*(tx){return yield* eventProjection(tx,cursor);});
}
