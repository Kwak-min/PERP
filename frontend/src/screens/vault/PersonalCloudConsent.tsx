import {useState} from 'react';
import {z} from 'zod';
import {Button} from '../../components/ui/Button';
import './personal-cloud-consent.css';
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
const INPUT_KINDS: Readonly<Record<string,string>> = {
 source: '원본 노트', candidate: '비교 후보 노트', source_revision: '고정 원본', page_revision: '위키 고정 판',
 instruction: '컴파일 지침', schema_revision: '위키 작성 규칙', catalog: '근거 목록', question: '질문', prior_result: '이전 결과',
};
const CLASSIFICATIONS: Readonly<Record<string,string>> = { public: '공개', internal: '내부', personal: '개인', sensitive: '민감', confidential: '고기밀' };

export function PersonalCloudConsent({preview,busy,onApprove,onCancel}:{preview:PersonalCloudPreview;busy:boolean;onApprove:()=>void;onCancel:()=>void}) {
 const [confirmed,setConfirmed]=useState(false);
 return <section className="personal-cloud-consent" aria-label="개인 자료 클라우드 전송 확인" data-consent-hash={preview.scope_hash}>
  <header><h4>개인 자료 외부 전송 승인</h4><p>OpenRouter · 서버 공용 키 · <strong>{preview.scope.model}</strong></p></header>
  <dl className="personal-cloud-consent__metadata"><dt>승인 사용자</dt><dd>{preview.actor_id}</dd><dt>만료</dt><dd><time dateTime={preview.expires_at}>{preview.expires_at}</time></dd></dl>
  <p>아래 원본·후보와 판으로 이번 분석/작업만 실행합니다. 위키 재시도도 같은 범위에서 별도 버튼으로만 실행합니다. 새 노트는 추가하지 않습니다. 수정·삭제·참고 허용 해제·권한 변경 시 다시 확인해야 합니다. 민감·고기밀 자료는 클라우드로 보내지 않습니다.</p>
  <h5>전송 범위 · 입력 {preview.scope.inputs.length}개</h5>
  <ol className="personal-cloud-consent__inputs">{preview.scope.inputs.map((input,index)=>{
   const kind=typeof input.kind==='string'?input.kind:typeof input.role==='string'?input.role:'unknown';
   const classification=typeof input.classification==='string'?input.classification:'unknown';
   const provenance=input.provenance;
   const title=typeof input.title==='string'?input.title:provenance && typeof provenance==='object' && 'title' in provenance && typeof provenance.title==='string'?provenance.title:null;
   const version=typeof input.version==='string'||typeof input.version==='number'?String(input.version):null;
   const revision=typeof input.revision_id==='string'?input.revision_id:null;
   return <li key={index} data-consent-input={index} data-input-kind={kind} data-input-classification={classification} data-input-version={version} data-input-revision={revision}>
    <strong>{title ?? INPUT_KINDS[kind] ?? '전송 입력'}</strong>
    <div className="personal-cloud-consent__input-meta"><span>{INPUT_KINDS[kind] ?? kind}</span><span>{CLASSIFICATIONS[classification] ?? '등급 미제공'}</span>{version!==null && <span>원본 판 {version}</span>}</div>
    {revision && <div className="personal-cloud-consent__revision">고정 판 <code>{revision}</code></div>}
   </li>;
  })}</ol>
  <details className="personal-cloud-consent__exact" data-consent-exact><summary>실제로 전송할 전체 입력 ({preview.scope.inputs.length}개)</summary><pre>{JSON.stringify(preview.scope,null,2)}</pre></details>
  <div className="personal-cloud-consent__hash">검토 범위 해시 <code>{preview.scope_hash}</code></div>
  <p>외부 전송 동의와 위키 게시 승인은 별개입니다.</p>
  <label className="personal-cloud-consent__confirmation"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/>이 정확한 개인 자료 범위를 OpenRouter로 전송하는 데 동의합니다</label>
  <div className="personal-cloud-consent__actions"><Button disabled={busy||!confirmed} onClick={onApprove}>동의한 범위만 클라우드 실행</Button><Button tone="neutral" disabled={busy} onClick={onCancel}>전송 승인 취소</Button></div>
 </section>;
}
