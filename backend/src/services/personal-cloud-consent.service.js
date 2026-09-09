import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical, sha256, deepFreeze, wikiError } from './knowledge-wiki-contract.service.js';

// 미승인 미리보기는 5분/프로세스 수명의 일회성 capability다. 브라우저 기본 설정은 동의가 아니다.
const pending=new Map();
export const cloudApprovalSchema=z.object({token:z.string().uuid(),confirmed:z.literal(true)}).strict();
export const cloudRevokeSchema=z.object({token:z.string().uuid()}).strict();
export const personalCloudAllowed=classification=>['public','internal','personal'].includes(classification);
const fail=(code,status=409)=>{throw wikiError(code,status);};
export function preparePersonalConsent(context,scope) {
 if(context.scope!=='personal')fail('PERSONAL_SCOPE_REQUIRED',400);
 for(const [id,item] of pending)if(item.expires<=Date.now())pending.delete(id);
 if(pending.size>=256)fail('CONSENT_QUEUE_FULL',429);
 const token=randomUUID(),expires=Date.now()+300000;
 const entry=deepFreeze({context:structuredClone(context),scope:structuredClone(scope),scope_hash:sha256(canonical(scope)),expires});
 pending.set(token,entry);
 return {token,expires_at:new Date(expires).toISOString(),scope_hash:entry.scope_hash,actor_id:context.actorId,provider:'openrouter',credential_mode:'shared',scope:entry.scope};
}
export function readPersonalConsent(context,token) {
 const entry=pending.get(token);
 if(!entry || entry.expires<=Date.now()) {pending.delete(token);fail('CONSENT_EXPIRED');}
 if(canonical(entry.context)!==canonical(context))fail('CONSENT_ACTOR_MISMATCH',403);
 return entry;
}
export function approvePersonalConsent(context,input,scope) {
 const approval=cloudApprovalSchema.parse(input),entry=readPersonalConsent(context,approval.token);
 // 실패한 승인도 다시 미리보도록 닫는다. 동일 token으로 범위를 바꿔 재시도할 수 없다.
 pending.delete(approval.token);
 if(entry.scope_hash!==sha256(canonical(scope)))fail('CONSENT_SCOPE_CHANGED');
 return deepFreeze({actor_id:context.actorId,context:structuredClone(context),scope_hash:entry.scope_hash,approved_at:new Date().toISOString(),credential_mode:'shared'});
}
export function revokePersonalConsent(context,input) {
 const {token}=cloudRevokeSchema.parse(input);readPersonalConsent(context,token);pending.delete(token);return {revoked:true};
}
export function assertPersonalReceipt(context,receipt) {
 if(!receipt || receipt.actor_id!==context.actorId || canonical(receipt.context)!==canonical(context) || receipt.credential_mode!=='shared')fail('CLOUD_CONSENT_REQUIRED',403);
}
