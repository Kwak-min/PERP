import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { useAppContext } from "../../context/AppContext";
import { useSession } from "../../store/session";
import { useVaultPref, vaultPrefStore } from "../../store/vaultPref";
import { Button } from "../ui/Button";

export function AgentPanel() {
  const { agentOpen, setAgentOpen } = useAppContext();
  const session = useSession();
  const useVault = useVaultPref();
  const userName = session?.name ?? "사용자";
  const [message, setMessage] = useState("");
  const [log, setLog] = useState<readonly Readonly<{ role: "user" | "agent"; text: string }>[]>([]);

  useEffect(() => {
    if (!agentOpen) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") setAgentOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agentOpen, setAgentOpen]);

  function send(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = message.trim();
    if (!text) return;
    setLog((current) => [
      ...current,
      { role: "user", text },
      {
        role: "agent",
        text: useVault
          ? `"${text}" 에 대해 조직 문서 2건, 업무 3건과 개인 Vault 노트 2건을 근거로 확인했습니다. 변경 작업은 실행 전 미리보기로 보여드립니다. (데모 응답)`
          : `"${text}" 에 대해 조직 문서 2건과 업무 3건만 근거로 확인했습니다. 개인 Vault는 사용하지 않았습니다. (데모 응답)`,
      },
    ]);
    setMessage("");
  }

  return (
    <aside
      className={`agent-panel ${agentOpen ? "agent-panel--open" : ""}`}
      aria-label="AI Agent"
      role="dialog"
      aria-modal="true"
      {...(agentOpen ? {} : { "aria-hidden": true })}
    >
      <div className="agent-panel__header">
        <div>
          <span className="eyebrow eyebrow--ai">ORBITFLOW AI</span>
          <h2>{userName}님, 무엇을 도와드릴까요?</h2>
        </div>
        <Button tone="neutral" size="small" onClick={() => setAgentOpen(false)} aria-label="Agent 패널 닫기">
          닫기
        </Button>
      </div>
      <div className="agent-panel__body">
        <p className="agent-hint">
          조직 권한 안의 문서와 업무만 근거로 답하고, 변경 작업은 실행 전에 미리 보여드립니다.
        </p>
        <label className="agent-vault-toggle">
          <input
            type="checkbox"
            checked={useVault}
            onChange={(event) => vaultPrefStore.set(event.target.checked)}
          />
          <span>
            <b>개인 Vault 사용</b>
            <small>내 옵시디언형 노트를 답변 근거에 포함합니다. 끄면 조직 데이터만 사용합니다.</small>
          </span>
        </label>
        {log.length > 0 && (
          <div className="agent-log">
            {log.map((entry, index) => (
              <p key={index} className={entry.role === "user" ? "agent-log__user" : "agent-log__agent"}>
                {entry.text}
              </p>
            ))}
          </div>
        )}
        <div className="prompt-list">
          <Link to="/agent/brief" onClick={() => setAgentOpen(false)}>오늘 브리핑 보기</Link>
          <Link to="/approvals" onClick={() => setAgentOpen(false)}>결재 대기 항목 요약</Link>
          <Link to="/agent/memory" onClick={() => setAgentOpen(false)}>AI 기억 관리</Link>
        </div>
      </div>
      <form className="agent-compose" onSubmit={send}>
        <label htmlFor="agent-message">Agent에게 요청</label>
        <textarea
          id="agent-message"
          rows={3}
          placeholder="예: 이번 달 예산 위험 항목을 근거와 함께 알려줘"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <Button tone="ai" type="submit" disabled={!message.trim()}>전송</Button>
      </form>
    </aside>
  );
}
