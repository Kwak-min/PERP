import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { analysisSchema, type NoteAnalysis } from "./model";

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
  useEffect(() => {
    setAnalysis(null); void load();
    return () => { request.current?.abort(); request.current = null; };
  }, [load, version]);
  return <section className="vault-analysis" aria-label="AI 의미 연결" data-analysis-state={analysis?.state ?? "pending"}>
    <p role="status">{analysis ? labels[analysis.state] : labels.pending}</p>
    <p>로컬 AI만 사용 · 외부 전송 없음 · 최근 내 노트 최대 32개와 비교 · 상위 5개 연결 · 본문 앞 6,000자</p>
    <p>저장한 API 키는 이 분석에 사용하지 않습니다. 키 등록은 노트 외부 전송 동의가 아닙니다.</p>
    {analysis?.model && <small>모델: {analysis.model}{analysis.candidates !== undefined ? ` · 비교 ${analysis.candidates}개` : ""}{analysis.truncated ? " · 긴 본문 일부 분석" : ""}</small>}
    {analysis?.reason && <p>{reasons[analysis.reason] ?? "분석 상태를 확인하고 다시 시도하세요."}</p>}
    {error && <p role="alert">{error}</p>}
    <Button tone="neutral" size="small" disabled={busy} onClick={() => void load(true)}>AI 연결 다시 분석</Button>
  </section>;
}
