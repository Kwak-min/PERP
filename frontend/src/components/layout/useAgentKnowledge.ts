import { useEffect, useRef, useState } from "react";
import { type AgentKnowledgeMode, type AgentTurn } from "../../services/agent";
import {
  deleteAgentAttachment, previewAgentKnowledgeConsent, uploadAgentAttachment,
  type AgentAttachment, type KnowledgeConsentPreview,
} from "../../services/agent-knowledge";
import { ApiError, userMessageOf, type ApiSession } from "../../services/api";

export function useAgentKnowledge(session: ApiSession, mode: AgentKnowledgeMode) {
  const [attachments, setAttachments] = useState<readonly AgentAttachment[]>([]);
  const [consent, setConsent] = useState<Readonly<{ preview: KnowledgeConsentPreview; turn: AgentTurn }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    try { await work(controller.signal); }
    catch (caught) { if (!controller.signal.aborted) setError(userMessageOf(caught)); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  }

  async function upload(file: File) {
    if (file.size === 0 || file.size > 1_000_000) { setError("문서는 1바이트 이상, 1MB 이하여야 합니다."); return; }
    await run(async signal => {
      const item = await uploadAgentAttachment(session, mode, file, signal);
      if (signal.aborted) return;
      if (item.knowledge_mode !== mode) throw new ApiError("첨부의 지식 범위가 다릅니다.", { code: "KNOWLEDGE_SCOPE_MISMATCH", status: 409, requestId: "", details: {} });
      setAttachments(current => [...current, item]); setConsent(null);
    });
  }

  async function remove(id: string) {
    await run(async signal => {
      await deleteAgentAttachment(session, mode, id, signal);
      if (!signal.aborted) { setAttachments(current => current.filter(item => item.id !== id)); setConsent(null); }
    });
  }

  async function preview(turn: AgentTurn) {
    setConsent(null);
    await run(async signal => {
      const result = await previewAgentKnowledgeConsent(session, {
        message: turn.message, knowledge_mode: turn.knowledge_mode, attachment_ids: turn.attachment_ids, conversation_id: turn.conversation_id,
      }, signal);
      if (!signal.aborted) setConsent({ preview: result, turn });
    });
  }

  function clear() { setAttachments([]); setConsent(null); setError(null); }
  return { attachments, consent, busy, error, upload, remove, preview, clear, cancelConsent: () => setConsent(null) };
}
