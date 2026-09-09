import {useState} from 'react';
import {z} from 'zod';
import {Button} from '../../components/ui/Button';
export const personalCloudPreviewSchema=z.object({token:z.string().uuid(),expires_at:z.string(),scope_hash:z.string(),actor_id:z.string(),provider:z.literal('openrouter'),credential_mode:z.literal('shared'),scope:z.object({model:z.string(),inputs:z.array(z.record(z.string(),z.unknown()))}).passthrough()});
export type PersonalCloudPreview=z.infer<typeof personalCloudPreviewSchema>;
export const PERSONAL_CLOUD_ERRORS: Readonly<Record<string,string>>={
 PERSONAL_SHARED_KEY_REQUIRED:'개인 자료용 서버 공용 OpenRouter 키가 없습니다. 관리자에게 설정을 요청하세요. 회사별 개인 키를 대신 사용하지 않습니다.',
 PERSONAL_EMBEDDING_MODEL_REQUIRED:'관리자에게 ORBITFLOW_VAULT_OPENROUTER_EMBEDDING_MODEL 설정을 요청하세요.',
 CONSENT_SCOPE_CHANGED:'원본·후보·판·권한 또는 모델이 바뀌었습니다. 전송 범위를 다시 확인하고 승인하세요.',
 CONSENT_EXPIRED:'전송 미리보기가 만료·취소되었거나 이미 사용되었습니다. 다시 확인하세요.',
 EXTERNAL_DATA_BLOCKED:'민감·고기밀 또는 AI 참고 제외 자료는 클라우드로 보낼 수 없습니다. 로컬 전용 분석을 사용하세요.',
 EMBEDDING_MODEL_UNSUPPORTED:'설정된 모델이 OpenRouter 임베딩 모델 목록에 없습니다. 지원 모델을 설정하세요.',
 EMBEDDING_CONTEXT_LIMIT:'임베딩 입력 한도를 초과했습니다. 더 큰 입력을 지원하는 모델을 설정하세요.',
 OPENROUTER_UNAVAILABLE:'OpenRouter 연결·잔액·모델 권한을 확인하세요. 새 전송 범위를 확인한 뒤 다시 승인할 수 있습니다.',
};
export function PersonalCloudConsent({preview,busy,onApprove,onCancel}:{preview:PersonalCloudPreview;busy:boolean;onApprove:()=>void;onCancel:()=>void}) {
 const [confirmed,setConfirmed]=useState(false);
 return <section aria-label="개인 자료 클라우드 전송 확인" data-consent-hash={preview.scope_hash}>
  <h4>개인 자료 외부 전송 승인</h4><p>OpenRouter · 서버 공용 키 · {preview.scope.model}</p>
  <p>승인 사용자: {preview.actor_id} · 만료: {preview.expires_at}</p>
  <p>아래 원본·후보와 판으로 이번 분석/작업만 실행합니다. 위키 재시도도 같은 범위에서 별도 버튼으로만 실행합니다. 새 노트는 추가하지 않습니다. 수정·삭제·참고 허용 해제·권한 변경 시 다시 확인해야 합니다. 민감·고기밀 자료는 클라우드로 보내지 않습니다.</p>
  <details open><summary>실제로 전송할 전체 입력 ({preview.scope.inputs.length}개)</summary><pre style={{maxHeight:320,overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(preview.scope,null,2)}</pre></details>
  <code>{preview.scope_hash}</code><label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/>이 정확한 개인 자료 범위를 OpenRouter로 전송하는 데 동의합니다</label>
  <Button disabled={busy||!confirmed} onClick={onApprove}>동의한 범위만 클라우드 실행</Button><Button tone="neutral" disabled={busy} onClick={onCancel}>전송 승인 취소</Button>
 </section>;
}
