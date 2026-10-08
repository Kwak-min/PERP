import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { apiRequest, ApiError, userMessageOf, type ApiSession } from "../../services/api";
import { analysisSchema, type NoteAnalysis } from "./model";
import {PersonalCloudConsent,PERSONAL_CLOUD_ERRORS,personalCloudPreviewSchema,type PersonalCloudPreview} from './PersonalCloudConsent';

const labels = {
  pending: "AI 연결 분석 중 (노트는 저장됨)", ready: "AI 연결 분석 완료", unavailable: "AI 연결 분석 불가",
  error: "AI 연결 분석 실패", not_analyzed: "아직 AI 연결을 분석하지 않았습니다",
};
const reasons: Record<string, string> = {
  model_not_configured: "서버에 ORBITFLOW_VAULT_EMBEDDING_MODEL 설정과 로컬 Ollama 임베딩 모델이 필요합니다.",
  local_endpoint_required: "OLLAMA_BASE_URL은 로컬 loopback HTTP 주소여야 합니다.",
  queue_full: "분석 대기열이 가득 찼습니다. 다시 분석할 수 있습니다.",
  note_ai_disabled: "이 노트의 AI 참고 허용이 꺼져 있어 연결 분석에서도 제외됩니다.",
  inference_unavailable: "로컬 모델 응답을 받지 못했습니다. Ollama 실행과 모델 설치를 확인하세요.",
  invalid_embeddings: "모델 응답 형식이 올바르지 않습니다. 임베딩 모델 설정을 확인하세요.",
  cache_empty: "분석 캐시는 서버 재시작 시 초기화됩니다. 이 노트만 다시 분석할 수 있습니다.",
};
export function NoteAnalysisPanel({ noteId, version, base, session, onSettled }: Readonly<{
  noteId: string; version: string | number; base: string; session: ApiSession;
  onSettled?: () => Promise<void>;
}>) {
  const [analysis, setAnalysis] = useState<NoteAnalysis | null>(null);
  const [preview,setPreview]=useState<PersonalCloudPreview|null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (retry = false): Promise<void> => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    try {
      const result = analysisSchema.parse(await apiRequest(`${base}/notes/${noteId}/analysis?wait=1`, {
        method: retry ? "POST" : "GET", session, signal: controller.signal,
      }));
      if (controller.signal.aborted) return;
      if (retry && result.state !== "pending") await onSettled?.();
      if (!controller.signal.aborted) setAnalysis(result);
    } catch (caught) {
      if (!controller.signal.aborted) setError(userMessageOf(caught));
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }, [base, noteId, session, onSettled]);
  async function cloud(action:'preview'|'approve'|'cancel') {
    request.current?.abort();const controller=new AbortController();request.current=controller;setBusy(true);setError(null);
    try {
      if(action==='preview'){
        const value=personalCloudPreviewSchema.parse(await apiRequest(`${base}/notes/${noteId}/cloud-preview`,{method:'POST',body:{},session,signal:controller.signal}));
        if(!controller.signal.aborted)setPreview(value);
      } else if(preview){
        const value=await apiRequest(`${base}/notes/${noteId}/${action==='approve'?'cloud-analyze':'cloud-preview'}`,{method:action==='approve'?'POST':'DELETE',body:{token:preview.token,...(action==='approve'?{confirmed:true}:{})},session,signal:controller.signal});
        if(controller.signal.aborted)return;
        setPreview(null);
        if(action==='approve'){setAnalysis(analysisSchema.parse(value));await onSettled?.();}
      }
    }catch(caught){if(!controller.signal.aborted){setPreview(null);setError(caught instanceof ApiError ? PERSONAL_CLOUD_ERRORS[caught.code] ?? userMessageOf(caught) : userMessageOf(caught));}}
    finally{if(request.current===controller){request.current=null;setBusy(false);}}
  }
  useEffect(() => {
    setPreview(null);setAnalysis(null); void load();
    return () => { request.current?.abort(); request.current = null; };
  }, [load, version]);
  return <section className="vault-analysis" aria-label="AI 의미 연결" data-analysis-state={analysis?.state ?? "pending"}>
    <p role="status">{analysis ? labels[analysis.state] : labels.pending}</p>
    <p>{analysis?.local_only===false?'승인한 개인 자료만 OpenRouter로 분석':'자동 분석은 로컬 전용'} · 후보 최대 32개 · 상위 5개 연결 · 입력 앞 6,000자</p>
    <p>키 등록이나 AI 참고 허용은 외부 전송 동의가 아닙니다. 클라우드는 매번 실제 입력 범위를 확인하고 별도로 승인합니다.</p>
    {analysis?.model && <small>모델: {analysis.model}{analysis.candidates !== undefined ? ` · 비교 ${analysis.candidates}개` : ""}{analysis.truncated ? " · 긴 본문 일부 분석" : ""}</small>}
    {analysis?.reason && <p>{reasons[analysis.reason] ?? "분석 상태를 확인하고 다시 시도하세요."}</p>}
    {error && <p role="alert">{error}</p>}
    <Button tone="neutral" size="small" disabled={busy} onClick={() => void load(true)}>AI 연결 다시 분석</Button><Button disabled={busy} onClick={()=>void cloud('preview')}>개인 연결 클라우드 범위 확인</Button>
    {preview && <PersonalCloudConsent key={preview.token} preview={preview} busy={busy} onApprove={()=>void cloud('approve')} onCancel={()=>void cloud('cancel')}/>}
  </section>;
}
