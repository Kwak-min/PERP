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
  sendAgentChat,
  type AgentMemory,
  type PendingApproval,
} from "../../services/agent";
import { userMessageOf, type ApiSession } from "../../services/api";
import { isPgWorkspace } from "../../services/workspace";
import { useSession, type SessionState } from "../../store/session";
import { Button } from "../ui/Button";

type LogEntry = Readonly<{ id: number; role: "user" | "agent"; text: string; items?: readonly string[] }>;
type DecisionDraft = Readonly<{ approval: PendingApproval; decision: "approve" | "reject" }>;
const QUICK_INTENTS = new Map<string, "brief" | "approvals" | "memory">([
  ["오늘 브리핑 보여줘", "brief"], ["오늘 브리핑 보기", "brief"],
  ["오늘 우선 처리할 업무를 근거와 함께 알려줘", "brief"],
  ["결재 대기 항목 보여줘", "approvals"], ["결재 대기 항목 보기", "approvals"],
  ["AI 기억 보여줘", "memory"], ["AI 기억 관리", "memory"],
]);

export function AgentPanel() {
  const stored = useSession();
  return stored ? <AgentPanelWorkspace key={`${stored.token}:${stored.orgId}`} stored={stored} /> : null;
}

function AgentPanelWorkspace({ stored }: Readonly<{ stored: SessionState }>) {
  const { agentOpen, setAgentOpen } = useAppContext();
  const session = useMemo<ApiSession>(() => ({ token: stored.token, orgId: stored.orgId }), [stored.token, stored.orgId]);
  const [message, setMessage] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
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
    if (!text) return;
    append({ role: "user", text }); setMessage("");
    const intent = QUICK_INTENTS.get(text);
    if (intent === "brief") { await showBrief(); return; }
    if (intent === "approvals") { await showPending(); return; }
    if (intent === "memory") { await showMemory(); return; }
    const response = await run("chat", signal => sendAgentChat(session, text, conversationId, signal));
    if (!response) return;
    setConversationId(response.conversation_id);
    append({ role: "agent", text: response.answer.conclusion,
      items: response.answer.evidence.map(item => `${item.title ?? item.type}${item.date ? ` · ${item.date.slice(0, 10)}` : ""}`) });
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
        <p className="agent-hint" data-vault-mode="off">조직 권한 안의 서버 데이터를 근거로 답합니다. 개인 Vault는 이 대화의 근거에서 제외됩니다.</p>
        {log.length > 0 && <div className="agent-log" aria-live="polite">{log.map(entry => <article key={entry.id} className={`agent-log__${entry.role}`}>
          <p>{entry.text}</p>{entry.items && <ul>{entry.items.map(item => <li key={item}>{item}</li>)}</ul>}
        </article>)}</div>}
        <div className="prompt-list" aria-label="대화형 빠른 작업">
          <Button tone="ghost" onClick={() => void showBrief()} disabled={busy !== null}>오늘 브리핑 보기</Button>
          <Button tone="ghost" onClick={() => void showPending()} disabled={busy !== null}>결재 대기 항목 보기</Button>
          <Button tone="ghost" onClick={() => void showMemory()} disabled={busy !== null}>AI 기억 관리</Button>
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
      </div>
      <form className="agent-compose" onSubmit={send}><label htmlFor="agent-message">Agent에게 요청</label><textarea id="agent-message" rows={3}
        placeholder="예: 오늘 우선 처리할 업무를 근거와 함께 알려줘" value={message} onChange={event => setMessage(event.target.value)} disabled={busy === "chat"} />
        <Button tone="ai" type="submit" disabled={busy !== null || !message.trim()}>전송</Button></form>
    </aside>
  );
}
