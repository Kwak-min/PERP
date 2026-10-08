import { db } from '../config/db.js';
import { env } from '../config/env.js';
import { openRouterForKey } from './ai-provider.service.js';
import { assertPersonalReceipt } from './personal-cloud-consent.service.js';
import { keyMetadata, resolveOwnerProvider } from './ai-key.service.js';
import { wikiError } from './knowledge-wiki-contract.service.js';

// 회사 문서에만 현재 명시적 클라우드 정책을 적용한다. 개인 Vault는 별도 동의 계약이다.
export const knowledgeCloudAllowed = classification => ['public','internal'].includes(classification);

// PG 설정 키는 외부 사용자 번호가 아닌 기존 auth_identity의 운영 사용자에 귀속된다.
// 호출자는 회사 소속/자료 접근 권한을 먼저 검증한다. 개인 Wiki에는 회사 키를 추측하지 않는다.
export function knowledgeKeyScope(context) {
  if (context.scope === 'personal') return null;
  if (context.store !== 'pg') return {tenantId:context.tenantId,orgId:context.companyId,userId:context.actorId};
  const identity=db().prepare("SELECT user_id FROM auth_identity WHERE provider='perp_db' AND subject=?").get(String(context.actorId));
  return identity ? {tenantId:`pg:${context.companyId}`,orgId:`pg:${context.companyId}`,userId:identity.user_id} : null;
}
export function knowledgeKeyConfigured(context) {
  const scope=knowledgeKeyScope(context);
  return scope ? keyMetadata(scope).configured : false;
}

// 비밀값/공급자 오류 본문은 외부로 반환하거나 저장하지 않는다. 리다이렉트는 금지한다.
export function personalCloudConfigured() { return Boolean(env.openrouterApiKey); }
export async function knowledgeOpenRouterJson(context, path, {body,signal,consent,timeoutMs=60000,maxBytes=4000000}={}) {
  if(context.scope==='personal')assertPersonalReceipt(context,consent);
  // 개인 소유 범위에서는 회사별 사용자 키를 추측하지 않는다. 명시적 동의를 받은 서버 공용 정책만 적용한다.
  const scope=knowledgeKeyScope(context), provider=context.scope==='personal' ? (env.openrouterApiKey ? openRouterForKey(env.openrouterApiKey) : null) : scope ? resolveOwnerProvider(scope) : null;
  if (!provider) throw wikiError('OPENROUTER_KEY_REQUIRED',503);
  const bounded=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
  try {
    const response=await fetch(provider.baseUrl+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:bounded,
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${provider.apiKey}`},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if (!response.ok) {await response.body?.cancel();throw wikiError('OPENROUTER_UNAVAILABLE',503);}
    const reader=response.body.getReader();let size=0;const chunks=[];
    try {for (;;) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw wikiError('MODEL_OUTPUT_LIMIT',502);chunks.push(Buffer.from(value));}}
    finally {await reader.cancel();reader.releaseLock();}
    try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
    catch {throw wikiError('MODEL_OUTPUT_INVALID',502);}
  } catch(error) {
    if (error.code && error.status) throw error;
    throw wikiError(signal?.aborted?'MODEL_ABORTED':'OPENROUTER_UNAVAILABLE',503);
  }
}
