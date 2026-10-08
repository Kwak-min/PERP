import { knowledgeTransaction, requireKnowledgeAccess } from './agent-knowledge-store.service.js';
import { contextIdentity, strongestClassification, failKnowledge } from './agent-knowledge-policy.service.js';
import { canReadDocument } from './rag.service.js';

function* readNote(tx,context,metadata) {
  const id = metadata.source_id.slice(metadata.source_id.indexOf(':')+1), personal = context.knowledgeMode === 'personal';
  let row;
  if (tx.pg) {
    if(personal) row=(yield tx.query(`SELECT n.title,n.content_md AS content FROM notes.notes n JOIN notes.vaults v ON v.id=n.vault_id WHERE n.id=? AND v.owner_id=?`,[id,context.actorId]))[0];
    else {const {getPgDocument}=yield import('./pg-documents.service.js');row=yield getPgDocument(tx.client,tx.p,id,{knowledgeMode:context.knowledgeMode});}
  } else {
    row = (yield tx.query(`SELECT * FROM ${personal ? 'vault_note' : 'document'} WHERE id=? AND tenant_id=? AND org_id=? AND deleted_at IS NULL`,[id,tx.p.tenantId,tx.p.orgId]))[0];
    if (row && (personal ? row.owner_id !== context.actorId : row.visibility === 'private' || !canReadDocument(tx.p,row))) row = null;
  }
  if (!row) return null;
  return {id,title:row.title,content:row.content ?? '',classification:strongestClassification([metadata.classification,row.sensitivity ?? 'public']),scope:context.knowledgeMode,
    link:`/${personal ? 'vault' : 'documents'}/${id}`,ai_generated:true,review_status:'unreviewed',provenance:JSON.parse(metadata.provenance_json)};
}
export async function listAgentKnowledgeNotes(context) {
  const c = contextIdentity(context);
  return knowledgeTransaction(context,function*(tx) {
    requireKnowledgeAccess(tx.p,c.knowledgeMode);
    const rows = yield tx.query(`SELECT * FROM agent_knowledge_note_metadata WHERE tenant_id=? AND workspace_id=? AND knowledge_mode=?${c.knowledgeMode === 'personal' ? ' AND actor_id=?' : ''} ORDER BY created_at DESC,source_id LIMIT 100`,
      [c.tenantId,c.workspaceId,c.knowledgeMode,...(c.knowledgeMode === 'personal' ? [c.actorId] : [])]);
    const items = [];
    for (const row of rows) {const note = yield* readNote(tx,context,row); if (note) items.push(note);}
    return {items};
  });
}
export async function getAgentKnowledgeNote(context,id) {
  const c = contextIdentity(context);
  if (typeof id !== 'string' || !(context.source === 'pg' ? /^[1-9]\d{0,18}$/ : /^[0-9a-f-]{36}$/i).test(id)) failKnowledge('NOT_FOUND',404);
  return knowledgeTransaction(context,function*(tx) {
    requireKnowledgeAccess(tx.p,c.knowledgeMode);
    const row = (yield tx.query(`SELECT * FROM agent_knowledge_note_metadata WHERE tenant_id=? AND workspace_id=? AND knowledge_mode=? AND source_id=?${c.knowledgeMode === 'personal' ? ' AND actor_id=?' : ''}`,
      [c.tenantId,c.workspaceId,c.knowledgeMode,`${c.knowledgeMode === 'personal' ? 'note' : 'document'}:${id}`,...(c.knowledgeMode === 'personal' ? [c.actorId] : [])]))[0];
    const note = row ? yield* readNote(tx,context,row) : null;
    if (!note) failKnowledge('NOT_FOUND',404);
    return note;
  });
}
