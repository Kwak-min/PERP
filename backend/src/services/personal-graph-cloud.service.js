import {db} from '../config/db.js';
import {pgQuery} from '../config/pg.js';
import {withKnowledgeTransaction} from './knowledge-wiki-store.service.js';
import {sha256,wikiError} from './knowledge-wiki-contract.service.js';
import {preparePersonalConsent,readPersonalConsent,approvePersonalConsent,personalCloudAllowed} from './personal-cloud-consent.service.js';
import {knowledgeOpenRouterJson,personalCloudConfigured} from './knowledge-ai.service.js';
import {normalizeVectors} from './document-semantic.service.js';
import {vaultSemantic,legacyVaultScope,pgVaultScope} from './vault-semantic.service.js';
const fail=(code,status=409)=>{throw wikiError(code,status);};
const cacheScope=c=>c.store==='pg'?pgVaultScope({companyId:null,userId:c.actorId}):legacyVaultScope({tenantId:c.tenantId,orgId:c.companyId,userId:c.actorId});
function item(id,origin,role) {
 return {id,role,title:origin.title,version:origin.version,classification:origin.restrictions.sensitivity,
  content_sha256:sha256(origin.content),text:`${origin.title}\n${origin.content}`.slice(0,6000)};
}
async function validate(context,scope) {
 return withKnowledgeTransaction(context,{},function*(tx){
  for(const saved of scope.inputs){
   const origin=yield* tx.origin('note',saved.id);
   if(!origin || !personalCloudAllowed(origin.restrictions.sensitivity) || origin.restrictions.agent_enabled===false || sha256(origin.content)!==saved.content_sha256 || origin.version!==saved.version || origin.title!==saved.title || origin.restrictions.sensitivity!==saved.classification)fail('CONSENT_SCOPE_CHANGED');
  }
 });
}
export async function previewPersonalGraph(context,id) {
 if(!personalCloudConfigured())fail('PERSONAL_SHARED_KEY_REQUIRED',503);
 const model=process.env.ORBITFLOW_VAULT_OPENROUTER_EMBEDDING_MODEL?.trim();if(!model)fail('PERSONAL_EMBEDDING_MODEL_REQUIRED',503);
 // 최초 권한 확인 뒤 소유자의 후보 ID만 읽는다. 전송 목록은 아래 트랜잭션에서 다시 검증한다.
 await withKnowledgeTransaction(context,{},function*(tx){if(!(yield* tx.origin('note',id)))fail('NOT_FOUND',404);});
 const rows=context.store==='pg'?(await pgQuery('SELECT n.id::text AS id FROM notes.notes n JOIN notes.vaults v ON v.id=n.vault_id WHERE v.owner_id=$1 AND n.id::text<>$2 ORDER BY n.updated_at DESC,n.id LIMIT 32',[context.actorId,id])).rows:
  db().prepare('SELECT id FROM vault_note WHERE tenant_id=? AND org_id=? AND owner_id=? AND id<>? AND deleted_at IS NULL AND agent_enabled=1 ORDER BY updated_at DESC,id LIMIT 32').all(context.tenantId,context.companyId,context.actorId,id);
 const inputs=await withKnowledgeTransaction(context,{},function*(tx){
  const result=[];for(const [index,noteId] of [id,...rows.map(r=>r.id)].entries()){
   const origin=yield* tx.origin('note',noteId);
   const allowed=origin && personalCloudAllowed(origin.restrictions.sensitivity) && origin.restrictions.agent_enabled!==false;
   if(!allowed){if(index===0)fail('EXTERNAL_DATA_BLOCKED',403);continue;}
   result.push(item(noteId,origin,index===0?'source':'candidate'));
  }return result;
 });
 return preparePersonalConsent(context,{kind:'personal_graph',source_id:id,model,inputs});
}
export async function analyzePersonalGraph(context,id,approval) {
 const entry=readPersonalConsent(context,approval.token),scope=entry.scope;
 if(scope.kind!=='personal_graph' || scope.source_id!==id)fail('CONSENT_SCOPE_CHANGED');
 await validate(context,scope);
 if(scope.model!==process.env.ORBITFLOW_VAULT_OPENROUTER_EMBEDDING_MODEL?.trim())fail('CONSENT_SCOPE_CHANGED');
 const consent=approvePersonalConsent(context,approval,scope);
 const metadata=await knowledgeOpenRouterJson(context,'/embeddings/models',{consent});
 const model=metadata.data?.find(m=>m.id===scope.model && m.architecture?.output_modalities?.includes('embeddings'));
 if(!model)fail('EMBEDDING_MODEL_UNSUPPORTED',503);
 if(!Number.isSafeInteger(model.context_length) || scope.inputs.some(i=>Buffer.byteLength(i.text)+32>model.context_length))fail('EMBEDDING_CONTEXT_LIMIT',422);
 await validate(context,scope);
 const response=await knowledgeOpenRouterJson(context,'/embeddings',{consent,body:{model:scope.model,input:scope.inputs.map(i=>i.text),encoding_format:'float'}});
 if(!Array.isArray(response.data) || response.data.length!==scope.inputs.length || new Set(response.data.map(d=>d.index)).size!==scope.inputs.length || response.data.some(d=>!Number.isInteger(d.index)||d.index<0||d.index>=scope.inputs.length))fail('INVALID_EMBEDDINGS',502);
 const vectors=normalizeVectors(response.data.sort((a,b)=>a.index-b.index).map(d=>d.embedding),scope.inputs.length);
 await validate(context,scope);
 return vaultSemantic.acceptCloud(cacheScope(context),scope,vectors,consent);
}
