import { preparePersonalConsent, approvePersonalConsent, assertPersonalReceipt } from './personal-cloud-consent.service.js';
import { prepareKnowledge, validatePreparedKnowledge, preparedKnowledgeRequestHash } from './agent-knowledge-prepare.service.js';
import { contextIdentity, evidenceView, hashKnowledge, strongestClassification, containsCredentials, failKnowledge } from './agent-knowledge-policy.service.js';

const issuedReceipts = new WeakMap();
function consentContext(context) {return {...contextIdentity(context),scope:'personal'};}
function dispatchScope(context,scope) {
  const history = scope.history ?? [];
  if (history.length > 100 || Buffer.byteLength(JSON.stringify(history)) > 200000) failKnowledge('KNOWLEDGE_LIMIT_EXCEEDED',413);
  if ([...scope.prepared.evidence,...history].some(row => !['personal','company'].includes(row.scope))) failKnowledge('KNOWLEDGE_SCOPE_CHANGED',409);
  if (context.knowledgeMode === 'company' && [...scope.prepared.evidence,...history].some(row => row.scope !== 'company')) failKnowledge('KNOWLEDGE_MODE_MISMATCH',409);
  if (!scope.provider || !scope.model || typeof scope.message !== 'string') failKnowledge('VALIDATION_ERROR');
  const sources = [...scope.prepared.evidence,...history].filter(row => row.scope === 'personal');
  if (context.knowledgeMode === 'personal') sources.push(evidenceView({id:'current',kind:'user',scope:'personal',title:'Current message',text:scope.message,version:'1',classification:scope.prepared.classification}));
  return {identity:contextIdentity(context),provider:scope.provider,model:scope.model,conversation_id:scope.conversation_id ?? null,
    request_hash:preparedKnowledgeRequestHash(scope.prepared),sources:sources.map(({id,kind,title,version,content_hash,text}) => ({id,kind,title,version,content_hash,dispatch_hash:hashKnowledge(text)}))};
}

export async function previewKnowledgeConsent(context,input) {
  if (context.knowledgeMode !== 'personal') failKnowledge('PERSONAL_SCOPE_REQUIRED');
  const {provider,model,conversation_id,history,...request} = input;
  const prepared = await prepareKnowledge(context,request);
  const scope = {prepared,...request,provider,model,conversation_id,history};
  assertExternalClassification(scope);
  const binding = dispatchScope(context,scope), preview = preparePersonalConsent(consentContext(context),binding);
  return {token:preview.token,expires_at:preview.expires_at,scope_hash:preview.scope_hash,provider,model,knowledge_mode:'personal',sources:binding.sources.map(({dispatch_hash,...source}) => source)};
}
export async function approveKnowledgeConsent(context,approval,scope) {
  await validatePreparedKnowledge(context,scope.prepared,scope.message);
  assertExternalClassification(scope);
  const binding = dispatchScope(context,scope), receipt = approvePersonalConsent(consentContext(context),approval,binding);
  issuedReceipts.set(receipt,hashKnowledge(binding));
  return receipt;
}
function assertExternalClassification(scope) {
  const history = scope.history ?? [];
  const classification = strongestClassification([scope.prepared.classification,...history.map(row => row.classification),
    containsCredentials(scope.message) || history.some(row => containsCredentials(row.text)) ? 'sensitive' : 'public']);
  if (!['public','internal','personal'].includes(classification)) failKnowledge('EXTERNAL_KNOWLEDGE_FORBIDDEN',403);
}
export async function assertKnowledgeDispatch(context,scope) {
  if(typeof scope.external!=='boolean') failKnowledge('KNOWLEDGE_INTEGRATION_REQUIRED',503);
  await validatePreparedKnowledge(context,scope.prepared,scope.message);
  const binding = dispatchScope(context,scope);
  if (!scope.external) return;
  assertExternalClassification(scope);
  if (binding.sources.length) {
    assertPersonalReceipt(consentContext(context),scope.receipt);
    if (issuedReceipts.get(scope.receipt) !== hashKnowledge(binding)) failKnowledge('CLOUD_CONSENT_REQUIRED',403);
  }
}
