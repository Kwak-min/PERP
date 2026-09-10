import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import { useModalFocus } from "../../hooks/useModalFocus";
import {
  createAgentMemory,
  decidePendingApproval,
  deleteAgentMemory,
  getAgentBrief,
  getAgentMemory,
  getPendingApprovals,
  listAgentOperations,
  sendAgentChat,
  type AgentOperation,
  type AgentTurn,
  type AgentKnowledgeMode,
  type AgentProtectedResult,
  type AgentMemory,
  type PendingApproval,
} from "../../services/agent";
import { userMessageOf, type ApiSession } from "../../services/api";
import { isPgWorkspace } from "../../services/workspace";
import { useSession, type SessionState } from "../../store/session";
import { Button } from "../ui/Button";
import { AgentActionCard } from "./AgentActionCard";
import { AgentAttachments, AgentKnowledgeConsent, AgentKnowledgeReceipts } from "./AgentKnowledgeControls";
import { useAgentKnowledge } from "./useAgentKnowledge";
import type { KnowledgeSave } from "../../services/agent-knowledge";
import { AgentProtectedResults } from "./AgentProtectedResults";
import { createRequestKey } from "../../services/requestKey";

type LogEntry = Readonly<{ id: number; role: "user" | "agent"; text: string; items?: readonly string[]; saves?: readonly KnowledgeSave[]; protected?: readonly AgentProtectedResult[] }>;
type DecisionDraft = Readonly<{ approval: PendingApproval; decision: "approve" | "reject" }>;
const QUICK_INTENTS = new Map<string, "brief" | "approvals" | "memory">([
  ["오늘 브리핑 보여줘", "brief"], ["오늘 브리핑 보기", "brief"],
  ["오늘 우선 처리할 업무를 근거와 함께 알려줘", "brief"],
  ["결재 대기 항목 보여줘", "approvals"], ["결재 대기 항목 보기", "approvals"],
  ["AI 기억 보여줘", "memory"], ["AI 기억 관리", "memory"],
]);

export function AgentPanel() {
  const stored = useSession();
  const [mode, setMode] = useState<AgentKnowledgeMode>("personal");
  return stored ? <AgentPanelWorkspace key={`${stored.token}:${stored.orgId}:${mode}`} stored={stored} mode={mode} setMode={setMode} /> : null;
}

function AgentPanelWorkspace({ stored, mode, setMode }: Readonly<{ stored: SessionState; mode: AgentKnowledgeMode; setMode: (mode: AgentKnowledgeMode) => void }>) {
  const { agentOpen, setAgentOpen } = useAppContext();
  const session = useMemo<ApiSession>(() => ({ token: stored.token, orgId: stored.orgId }), [stored.token, stored.orgId]);
  const knowledge = useAgentKnowledge(session, mode);
  const [message, setMessage] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turn, setTurn] = useState<AgentTurn | null>(null);
  const [actions, setActions] = useState<readonly AgentOperation[]>([]);
  const [log, setLog] = useState<readonly LogEntry[]>([]);
  const [pending, setPending] = useState<readonly PendingApproval[] | null>(null);
  const [memories, setMemories] = useState<readonly AgentMemory[] | null>(null);
  const [memoryLabel, setMemoryLabel] = useState("");
  const [memoryContent, setMemoryContent] = useState("");
  const [decisionDraft, setDecisionDraft] = useState<DecisionDraft | null>(null);
  const [decisionComment, setDecisionComment] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const close = useCallback((): void => setAgentOpen(false), [setAgentOpen]);
  const panelRef = useModalFocus<HTMLElement>(close, agentOpen);
  const decisionRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (decisionDraft && agentOpen) {
      decisionRef.current?.focus();
      decisionRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [decisionDraft, agentOpen]);

  const append = useCallback((entry: Omit<LogEntry, "id">) => {
    setLog(current => [...current, { ...entry, id: ++sequence.current }]);
  }, []);

  useEffect(() => {
    return () => { for (const controller of requests.current) controller.abort(); requests.current.clear(); };
  }, []);

  async function run<T>(key: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    const controller = new AbortController();
    requests.current.add(controller); setBusy(key); setError(null);
    try { return await work(controller.signal); }
    catch (caught) { if (!controller.signal.aborted) setError(userMessageOf(caught)); return null; }
    finally { requests.current.delete(controller); setBusy(current => current === key ? null : current); }
  }

  async function showBrief(): Promise<void> {
    setMemories(null); setPending(null); setDecisionDraft(null);
    const brief = await run("brief", signal => getAgentBrief(session, signal));
    if (!brief) return;
    append({ role: "agent", text: `${brief.preset_label} 오늘 브리핑입니다.`,
      items: brief.items.length ? brief.items.map(item => item.title) : ["오늘 확인할 업무나 결재가 없습니다."] });
  }

  async function showPending(): Promise<void> {
    setMemories(null); setDecisionDraft(null);
    const items = await run("pending", signal => getPendingApprovals(session, signal));
    if (items) {
      setPending(items);
      append({ role: "agent", text: items.length ? `처리할 결재 ${items.length}건을 확인했습니다.` : "처리할 결재가 없습니다." });
    }
  }

  async function showMemory(): Promise<void> {
    if (mode === "company") { setError("회사 모드에서는 개인 AI 기억을 조회하지 않습니다."); return; }
    setPending(null); setDecisionDraft(null);
    const items = await run("memory", signal => getAgentMemory(session, signal));
    if (items) {
      setMemories(items);
      append({ role: "agent", text: items.length ? `저장된 AI 기억 ${items.length}건을 확인했습니다.` : "AI 기억 목록이 비어 있습니다." });
    }
  }

  async function send(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const text = message.trim();
    if (!text || busy || turn || knowledge.busy) return;
    append({ role: "user", text }); setMessage("");
    const intent = QUICK_INTENTS.get(text);
    if (intent === "brief") { await showBrief(); return; }
    if (intent === "approvals") { await showPending(); return; }
    if (intent === "memory") { await showMemory(); return; }
    await submitTurn({ message: text, conversation_id: conversationId, key: createRequestKey(), knowledge_mode: mode,
      attachment_ids: knowledge.attachments.map(item => item.id) });
  }

  async function submitTurn(next: AgentTurn): Promise<void> {
    setTurn(next);
    const response = await run("chat", signal => sendAgentChat(session, next, signal));
    if (!response) return;
    setTurn(null); knowledge.clear();
    setConversationId(response.conversation_id);
    setActions(current => [...current.filter(item => !response.actions.some(action => action.id === item.id)), ...response.actions]);
    append({ role: "agent", text: response.answer.conclusion, saves: response.knowledge_saves, protected: response.protected_results,
      items: [...response.tool_activity.map(item => `${item.stage === "plan" ? "계획" : item.stage === "query" ? "조회 완료" : "작업 제안"}: ${item.summary}`),
        ...response.answer.evidence.map(item => `${item.title ?? item.type}${item.date ? ` · ${item.date.slice(0, 10)}` : ""}`)] });
  }

  function beginDecision(approval: PendingApproval, decision: "approve" | "reject"): void {
    if (approval.blocked) return;
    if (decision === "approve" && !approval.requires_reauth && !approval.confirm_self_decision) {
      void submitDecision({ approval, decision });
      return;
    }
    setDecisionDraft({ approval, decision }); setDecisionComment(""); setPassword("");
  }

  async function submitDecision(draft = decisionDraft, confirmed = false): Promise<void> {
    if (!draft) return;
    const { approval, decision } = draft;
    if (decision === "reject" && !decisionComment.trim()) { setError("반려 사유를 입력하세요."); return; }
    const result = await run(`decision:${approval.id}`, signal => decidePendingApproval(
      session, approval, decision, decisionComment.trim(), password, confirmed, signal,
    ));
    setPassword("");
    if (result === null) return;
    setPending(current => current?.filter(item => item.id !== approval.id) ?? null);
    setDecisionDraft(null); setDecisionComment("");
    append({ role: "agent", text: `${approval.title} 요청을 ${decision === "approve" ? "승인" : "반려"}했습니다.` });
  }

  async function addMemory(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!memoryContent.trim()) return;
    const label = memoryLabel.trim() || "사용자 기억";
    const result = await run("memory-create", signal => createAgentMemory(session, label, memoryContent.trim(), signal));
    if (result === null) return;
    setMemoryLabel(""); setMemoryContent("");
    const items = await run("memory", signal => getAgentMemory(session, signal));
    if (items) setMemories(items);
  }

  async function removeMemory(memory: AgentMemory): Promise<void> {
    const result = await run(`memory-delete:${memory.id}`, signal => deleteAgentMemory(session, memory.id, signal));
    if (result === null) return;
    setMemories(current => current?.filter(item => item.id !== memory.id) ?? null);
  }

  return (
    <aside ref={panelRef} className={`agent-panel ${agentOpen ? "agent-panel--open" : ""}`} aria-label="AI Agent" role="dialog" aria-modal="true"
      {...(agentOpen ? {} : { "aria-hidden": true, inert: true })}>
      <div className="agent-panel__header"><div><span className="eyebrow eyebrow--ai">ORBITFLOW AI</span><h2>{stored.name}님, 무엇을 도와드릴까요?</h2></div>
        <Button tone="neutral" size="small" onClick={close} aria-label="Agent 패널 닫기">닫기</Button></div>
      <div className="agent-panel__body">
        <label className="agent-mode">지식 범위<select aria-label="지식 범위" value={mode} onChange={event => setMode(event.target.value === "company" ? "company" : "personal")}>
          <option value="personal">개인 AI</option><option value="company">회사 AI</option></select></label>
        <p className="agent-hint" data-vault-mode={mode === "personal" ? "on" : "off"}>{mode === "personal"
          ? "내 개인 지식과 접근 가능한 회사 자료를 참고합니다. 개인 자료의 외부 전송은 별도 동의가 필요합니다."
          : "회사 권한 안의 자료만 참고합니다. 개인 노트·대화·첨부는 제외됩니다."}</p>
        {log.length > 0 && <div className="agent-log" aria-live="polite">{log.map(entry => <article key={entry.id} className={`agent-log__${entry.role}`}>
          <p>{entry.text}</p>{entry.items && <ul>{entry.items.map(item => <li key={item}>{item}</li>)}</ul>}
          {entry.saves && entry.saves.length > 0 && <AgentKnowledgeReceipts saves={entry.saves} />}
          {entry.protected && entry.protected.length > 0 && <AgentProtectedResults results={entry.protected} />}
        </article>)}</div>}
        {actions.map(action => <AgentActionCard key={action.id} initial={action} session={session} active={agentOpen} knowledgeMode={mode} />)}
        {turn && !busy && <div className="agent-workflow"><p>완료 여부를 확인하지 못했습니다. 재시도는 같은 요청 키를 사용합니다.</p>
          <Button size="small" disabled={knowledge.busy} onClick={() => void submitTurn(turn)}>같은 대화 요청 재시도</Button>
          {mode === "personal" && <Button size="small" disabled={knowledge.busy} onClick={() => void knowledge.preview(turn)}>개인 자료 전송 범위 확인</Button>}
          <Button size="small" tone="neutral" disabled={knowledge.busy} onClick={() => { setTurn(null); knowledge.cancelConsent(); }}>대기 요청 닫기</Button></div>}
        {knowledge.consent && <AgentKnowledgeConsent key={knowledge.consent.preview.token} preview={knowledge.consent.preview} busy={busy !== null || knowledge.busy}
          onCancel={knowledge.cancelConsent} onApprove={() => {
            const consent = knowledge.consent;
            if (consent) { knowledge.cancelConsent(); void submitTurn({ ...consent.turn, cloud_consent: { token: consent.preview.token, confirmed: true } }); }
          }} />}
        <div className="prompt-list" aria-label="대화형 빠른 작업">
          <Button tone="ghost" onClick={() => void showBrief()} disabled={busy !== null}>오늘 브리핑 보기</Button>
          <Button tone="ghost" onClick={() => void showPending()} disabled={busy !== null}>결재 대기 항목 보기</Button>
          {mode === "personal" && <Button tone="ghost" onClick={() => void showMemory()} disabled={busy !== null}>AI 기억 관리</Button>}
          <Button tone="ghost" disabled={busy !== null} onClick={() => void run("operations", async signal => {
            const items = await listAgentOperations(session, mode, signal);
            if (!signal.aborted) setActions(items);
          })}>저장된 작업 보기</Button>
        </div>
        {pending && <section className="agent-workflow" aria-label="결재 대기 항목"><h3>결재 대기 항목</h3>
          {pending.length === 0 ? <p>처리할 결재가 없습니다.</p> : <ul>{pending.map(approval => <li key={approval.id}>
            <b>{approval.title}</b>{approval.blocked && <small>앞선 결재 단계 처리 후 결정할 수 있습니다.</small>}
            <span><Button size="small" aria-label={`${approval.title} 승인`} disabled={approval.blocked || busy !== null} onClick={() => beginDecision(approval, "approve")}>승인</Button>
              <Button size="small" tone="danger" aria-label={`${approval.title} 반려`} disabled={approval.blocked || busy !== null} onClick={() => beginDecision(approval, "reject")}>반려</Button></span>
          </li>)}</ul>}
        </section>}
        {decisionDraft && <section ref={decisionRef} tabIndex={-1} className="agent-decision" aria-label="결재 결정 확인"><h3>{decisionDraft.approval.title}</h3>
          {decisionDraft.decision === "reject" && <label>반려 사유<textarea value={decisionComment} onChange={event => setDecisionComment(event.target.value)} /></label>}
          {decisionDraft.decision === "approve" && decisionDraft.approval.requires_reauth && <label>재인증 비밀번호<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>}
          {decisionDraft.approval.confirm_self_decision && <p>본인 요청에 대한 결정을 명시적으로 확인해 전송합니다.</p>}
          <div><Button size="small" disabled={busy !== null || (decisionDraft.decision === "approve" && decisionDraft.approval.requires_reauth && !password)} onClick={() => void submitDecision(decisionDraft, true)}>결정 전송</Button>
            <Button size="small" tone="neutral" disabled={busy !== null} onClick={() => setDecisionDraft(null)}>취소</Button></div>
        </section>}
        {memories && <section className="agent-workflow" aria-label="AI 기억 관리"><h3>AI 기억 관리</h3>
          {memories.length === 0 ? <p>저장된 AI 기억이 없습니다.</p> : <ul>{memories.map(memory => <li key={memory.id}><span><b>{memory.label}</b><small>{memory.content}</small></span>
            <Button size="small" tone="danger" aria-label={`${memory.content} 삭제`} disabled={busy !== null} onClick={() => void removeMemory(memory)}>삭제</Button></li>)}</ul>}
          <form className="agent-memory-form" onSubmit={addMemory}>
            {isPgWorkspace(session.orgId) && <label>기억 이름<input value={memoryLabel} maxLength={200} onChange={event => setMemoryLabel(event.target.value)} /></label>}
            <label>기억 내용<textarea value={memoryContent} maxLength={2000} onChange={event => setMemoryContent(event.target.value)} /></label>
            <Button size="small" type="submit" disabled={busy !== null || !memoryContent.trim()}>기억 추가</Button>
          </form>
        </section>}
        {busy && <p role="status">서버 데이터를 확인하는 중입니다...</p>}
        {error && <p role="alert">{error}</p>}
        <AgentAttachments knowledge={knowledge} disabled={busy !== null || turn !== null} />
      </div>
      <form className="agent-compose" onSubmit={send}><label htmlFor="agent-message">Agent에게 요청</label><textarea id="agent-message" rows={3}
        placeholder="예: 오늘 우선 처리할 업무를 근거와 함께 알려줘" value={message} onChange={event => setMessage(event.target.value)} disabled={busy === "chat"} />
        <Button tone="ai" type="submit" disabled={busy !== null || turn !== null || knowledge.busy || !message.trim()}>전송</Button></form>
    </aside>
  );
}
