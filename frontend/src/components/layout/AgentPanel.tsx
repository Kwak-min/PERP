import { useCallback } from "react";
import { Link } from "react-router-dom";

import { useAppContext } from "../../context/AppContext";
import { useSession } from "../../store/session";
import { useModalFocus } from "../../hooks/useModalFocus";
import { Button } from "../ui/Button";

export function AgentPanel() {
  const { agentOpen, setAgentOpen } = useAppContext();
  const session = useSession();
  const userName = session?.name ?? "사용자";
  const close = useCallback((): void => setAgentOpen(false), [setAgentOpen]);
  const panelRef = useModalFocus<HTMLElement>(close, agentOpen);


  return (
    <aside ref={panelRef} className={`agent-panel ${agentOpen ? "agent-panel--open" : ""}`} aria-label="AI Agent" role="dialog" aria-modal="true"
      {...(agentOpen ? {} : { "aria-hidden": true, inert: true })}>
      <div className="agent-panel__header"><div><span className="eyebrow eyebrow--ai">ORBITFLOW AI</span><h2>{userName}님, 무엇을 도와드릴까요?</h2></div>
        <Button tone="neutral" size="small" onClick={close} aria-label="Agent 패널 닫기">닫기</Button></div>
      <div className="agent-panel__body">
        <div className="state-card state-card--warning" role="status"><span className="state-card__icon" aria-hidden="true">!</span><strong>대화 기능을 현재 사용할 수 없습니다</strong>
          <p>서버 대화 API가 개인 Vault 제외 설정을 아직 지원하지 않아, 근거 범위를 정확히 보장할 때까지 전송을 막았습니다.</p></div>
        <div className="prompt-list"><Link to="/agent/brief" onClick={() => setAgentOpen(false)}>오늘 브리핑 보기</Link><Link to="/approvals" onClick={() => setAgentOpen(false)}>결재 대기 항목 보기</Link><Link to="/agent/memory" onClick={() => setAgentOpen(false)}>AI 기억 관리</Link></div>
      </div>
      <form className="agent-compose"><label htmlFor="agent-message">Agent에게 요청</label><textarea id="agent-message" rows={3} disabled placeholder="대화 API 계약 정비 후 사용할 수 있습니다" />
        <Button tone="ai" type="button" disabled>전송 사용 불가</Button></form>
    </aside>
  );
}
