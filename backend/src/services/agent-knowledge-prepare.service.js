import { z } from 'zod';
import { canReadDocument } from './rag.service.js';
import { knowledgeTransaction, requireKnowledgeAccess, canReadCompanyKnowledge } from './agent-knowledge-store.service.js';
import { readAttachmentRow } from './agent-attachments.service.js';
import { contextIdentity, evidenceView, hashKnowledge, strongestClassification, untrustedKnowledge, containsCredentials, failKnowledge } from './agent-knowledge-policy.service.js';

const preparedInputs = new WeakMap();
export const prepareKnowledgeSchema = z.object({message:z.string().min(1).max(16000),attachment_ids:z.array(z.string().uuid()).max(5).default([]),classification:z.string().max(30).default('internal')}).strict();

export async function prepareKnowledge(context,input) {
  const parsed = prepareKnowledgeSchema.safeParse(input);
  if (!parsed.success) failKnowledge('VALIDATION_ERROR');
  const request = parsed.data, identity = contextIdentity(context);
  const pgDocuments=context.source==='pg'?await import('./pg-documents.service.js'):null;
  const evidence = await knowledgeTransaction(context,function*(tx) {
    const {p} = tx, candidates = [], memories = [];
    if (context.knowledgeMode === 'personal') {
      const rows = tx.pg ? yield tx.query(`SELECT n.id::text,n.title,COALESCE(n.content_md,'') AS content,n.xmin::text AS version
        FROM notes.notes n JOIN notes.vaults v ON v.id=n.vault_id WHERE v.owner_id=? ORDER BY n.updated_at DESC,n.id LIMIT 500`,[p.userId]) :
        p.has('menu.vault') ? yield tx.query(`SELECT * FROM vault_note WHERE tenant_id=? AND org_id=? AND owner_id=? AND agent_enabled=1 AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 500`,[p.tenantId,p.orgId,p.userId]) : [];
      for (const row of rows) candidates.push(evidenceView({id:row.id,kind:'note',scope:'personal',title:row.title,text:row.content,version:row.version,classification:tx.pg ? 'personal' : row.sensitivity,link:`/vault/${row.id}`}));
      // Preserve existing user-global PG memory; company_id is not its ownership key.
      const memoryRows = tx.pg ? yield tx.query(`SELECT id::text,key AS title,COALESCE(value,'') AS content,xmin::text AS version FROM ai.agent_memory WHERE user_id=? ORDER BY id DESC LIMIT 10`,[p.userId]) :
        yield tx.query(`SELECT id,'Personal memory' AS title,content,version,sensitivity FROM agent_memory WHERE tenant_id=? AND org_id=? AND owner_id=? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC,id LIMIT 10`,[p.tenantId,p.orgId,p.userId,new Date().toISOString()]);
      for (const row of memoryRows) memories.push(evidenceView({id:row.id,kind:'memory',scope:'personal',title:row.title,text:row.content.slice(0,2000),version:row.version,
        classification:strongestClassification([tx.pg ? 'personal' : row.sensitivity,containsCredentials(row.title+' '+row.content) ? 'sensitive' : 'public'])}));
    }
    if (canReadCompanyKnowledge(p)) {
      const rows = tx.pg ? yield pgDocuments.listPgDocuments(tx.client,p,{limit:500,knowledgeMode:context.knowledgeMode}) :
        yield tx.query(`SELECT * FROM document WHERE tenant_id=? AND org_id=? AND deleted_at IS NULL AND archived=0 ORDER BY updated_at DESC,id LIMIT 500`,[p.tenantId,p.orgId]);
      for (const row of rows) {
        if (!tx.pg && (!canReadDocument(p,row) || context.knowledgeMode === 'company' && (row.visibility === 'private' || row.sensitivity === 'personal'))) continue;
        candidates.push(evidenceView({id:row.id,kind:'document',scope:row.visibility === 'private' || row.sensitivity === 'personal' ? 'personal' : 'company',title:row.title,text:row.content,version:row.version,classification:row.sensitivity,link:`/documents/${row.id}`}));
      }
    }
    // PG reference capability placeholders are not stored user choices: there is no agent_enabled column.
    const metadata = yield tx.query("SELECT source_id,classification FROM agent_knowledge_note_metadata WHERE tenant_id=? AND (workspace_id=? OR (knowledge_mode='personal' AND actor_id=?))",[identity.tenantId,identity.workspaceId,identity.actorId]);
    const classes = new Map(metadata.map(row => [row.source_id,row.classification]));
    const terms = [...new Set(request.message.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2))].slice(0,80);
    const ranked = candidates.map(row => ({row:{...row,classification:strongestClassification([
      row.classification,classes.get(row.id) ?? 'public',containsCredentials(row.title+' '+row.text) ? 'sensitive' : 'public',
    ])},score:terms.filter(term => `${row.title} ${row.text}`.normalize('NFKC').toLowerCase().includes(term)).length}));
    // 표현이 달라도 최근 지식을 참고할 수 있게 한다. 민감·불명확 자료는 일치 없이 자동 포함하지 않는다.
    const recent = ranked.filter(item => ['public','internal','personal'].includes(item.row.classification));
    let chosen = ranked.filter(item => item.score > 0).sort((a,b) => b.score-a.score || a.row.id.localeCompare(b.row.id)).slice(0,8);
    if (!chosen.length) chosen = recent.slice(0,8);
    if (context.knowledgeMode === 'personal') {
      for (const scope of ['personal','company']) {
        if (chosen.some(item => item.row.scope === scope)) continue;
        const fallback = recent.find(item => item.row.scope === scope);
        if (fallback) chosen = [...chosen.slice(0,7),fallback];
      }
    }
    const selected = chosen.map(({row}) => ({...row,text:row.text.slice(0,6000)}));
    for (const id of [...new Set(request.attachment_ids)]) {
      const row = yield* readAttachmentRow(tx,context,id);
      selected.push(evidenceView({id,kind:'attachment',scope:row.knowledge_mode,title:row.filename,text:row.extracted_text.slice(0,12000),version:row.content_hash,classification:row.classification}));
    }
    return [...selected,...memories];
  });
  const classification = strongestClassification([request.classification,containsCredentials(request.message) ? 'sensitive' : 'public',...evidence.map(row => row.classification)]);
  const prepared = Object.freeze({evidence:Object.freeze(evidence.map(Object.freeze)),classification,context_text:untrustedKnowledge(evidence),manifest_hash:hashKnowledge(evidence)});
  preparedInputs.set(prepared,{identity,request});
  return prepared;
}

export async function validatePreparedKnowledge(context,prepared,message) {
  const entry = preparedInputs.get(prepared);
  if (!entry || hashKnowledge(entry.identity) !== hashKnowledge(contextIdentity(context))) failKnowledge('KNOWLEDGE_SCOPE_CHANGED',409);
  if (message !== undefined && entry.request.message !== message) failKnowledge('KNOWLEDGE_SCOPE_CHANGED',409);
  const fresh = await prepareKnowledge(context,entry.request);
  if (fresh.manifest_hash !== prepared.manifest_hash || fresh.classification !== prepared.classification) failKnowledge('KNOWLEDGE_SCOPE_CHANGED',409);
  return prepared;
}

export function preparedKnowledgeRequestHash(prepared) {
  const entry=preparedInputs.get(prepared);
  if(!entry) failKnowledge('KNOWLEDGE_SCOPE_CHANGED',409);
  return hashKnowledge(entry.request);
}

export async function assertKnowledgeReplaySources(context,sources) {
  return knowledgeTransaction(context,function*(tx) {
    // A stored receipt binds exact sources, not their position in a later search.
    for (const source of sources) {
      const kind=source.id.split(':',1)[0];
      if (!['document','note','memory','attachment'].includes(kind)) failKnowledge('KNOWLEDGE_SCOPE_CHANGED',409);
      yield* assertCurrentKnowledgeSource(tx,context,{...source,kind});
    }
  });
}

// Recheck referenced origins in the SAME transaction as canonical saving. A source
// edit, owner change or reference revocation cannot race the extraction callback.
export function* assertCurrentKnowledgeSource(tx,context,source) {
  if (source.kind==='user') return;
  const id=source.id.slice(source.id.indexOf(':')+1),p=tx.p;
  let row;
  if(source.kind==='attachment') {
    row=yield* readAttachmentRow(tx,context,id);
    if(row.content_hash!==source.version || hashKnowledge({title:row.filename,text:row.extracted_text.slice(0,12000)})!==source.content_hash) failKnowledge('KNOWLEDGE_SCOPE_CHANGED',409);
    return;
  }
  if(source.kind==='document') requireKnowledgeAccess(p,'company');
  if(['note','memory'].includes(source.kind) && context.knowledgeMode!=='personal') failKnowledge('KNOWLEDGE_MODE_MISMATCH',409);
  if(source.kind==='note') requireKnowledgeAccess(p,'personal');
  if(tx.pg) {
    if(source.kind==='note') row=(yield tx.query(`SELECT n.title,COALESCE(n.content_md,'') AS content,n.xmin::text AS version FROM notes.notes n JOIN notes.vaults v ON v.id=n.vault_id WHERE n.id=? AND v.owner_id=? FOR SHARE OF n,v`,[id,p.userId]))[0];
    if(source.kind==='document') {const {getPgDocument}=yield import('./pg-documents.service.js');row=yield getPgDocument(tx.client,p,id,{knowledgeMode:context.knowledgeMode,lock:true});}
    if(source.kind==='memory') row=(yield tx.query("SELECT key AS title,COALESCE(value,'') AS content,xmin::text AS version FROM ai.agent_memory WHERE id=? AND user_id=? FOR SHARE",[id,p.userId]))[0];
  } else {
    const table={note:'vault_note',document:'document',memory:'agent_memory'}[source.kind];
    if(!table) failKnowledge('KNOWLEDGE_SCOPE_CHANGED',409);
    row=(yield tx.query(`SELECT * FROM ${table} WHERE id=? AND tenant_id=? AND org_id=? AND deleted_at IS NULL`,[id,p.tenantId,p.orgId]))[0];
    if(row && (source.kind==='document' ? !canReadDocument(p,row) || context.knowledgeMode==='company' && (row.visibility==='private' || row.sensitivity==='personal') : row.owner_id!==p.userId || source.kind==='note' && !row.agent_enabled || source.kind==='memory' && row.expires_at && row.expires_at<=new Date().toISOString())) row=null;
    if(source.kind==='memory' && row) row={...row,title:'Personal memory'};
  }
  if(!row || String(row.version)!==source.version) failKnowledge('KNOWLEDGE_SCOPE_CHANGED',409);
  const text=source.kind==='memory'?row.content.slice(0,2000):row.content;
  if(hashKnowledge({title:row.title,text})!==source.content_hash) failKnowledge('KNOWLEDGE_SCOPE_CHANGED',409);
}
