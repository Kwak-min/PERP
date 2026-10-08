import { useState } from "react";
import { Link } from "react-router-dom";

import { useAppContext } from "../../context/AppContext";
import { useSession } from "../../store/session";
import { Icon } from "../ui/Icon";

const SUGGEST = [
  "오늘 브리핑 해줘",
  "학생회비 얼마야?",
  "회비 미납자 알려줘",
  "이번 달 초안 전표 확정해줘",
  "내일까지 '부스 배치도 검토' 업무 만들어줘",
  "남은 예산 알려줘",
];

type Msg = { role: "user" | "ai"; text: string };

// 목업 agentPanel() 이식 — .ap-h / .ap-body / .ap-foot
export function AgentPanel() {
  const { setAgentOpen } = useAppContext();
  const session = useSession();
  const [q, setQ] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);

  function ask(text: string) {
    const t = text.trim();
    if (!t) return;
    setMsgs((cur) => [
      ...cur,
      { role: "user", text: t },
      {
        role: "ai",
        text: `"${t}" — 권한이 허용하는 조직 문서·업무 안에서 확인했습니다. 변경 작업은 실행 전 미리보기로 보여드립니다. (데모 응답)`,
      },
    ]);
    setQ("");
  }

  return (
    <aside className="agent-panel" aria-label="AI Agent 패널">
      <div className="ap-h">
        <b>
          <Icon name="sparkles" />
          Agent
        </b>
        <span className="pill ai" title="외부 LLM 정책">
          로컬 전용
        </span>
        <Link className="icon-btn sm" to="/agent" aria-label="Agent 전체 화면">
          <Icon name="right" />
        </Link>
        <button
          type="button"
          className="icon-btn sm"
          onClick={() => setAgentOpen(false)}
          aria-label="패널 닫기"
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="ap-body" id="chat-panel">
        {msgs.length === 0 ? (
          <div className="stack">
            <div className="ai-block">
              <div className="ai-head">
                <span className="ai-tag">
                  <Icon name="sparkles" />
                  {session?.name ?? "개인"} Agent
                </span>
              </div>
              <p className="sm">
                권한이 허용하는 데이터 안에서만 답합니다. 답변마다 근거·데이터 등급·사용한 모델을 표시하고,
                금전·권한·발송·삭제·회계확정은 승인과 재인증 없이는 실행하지 않습니다.
              </p>
            </div>
            <div className="chips">
              {SUGGEST.map((s) => (
                <button type="button" className="chip-btn" key={s} onClick={() => ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          msgs.map((m, i) =>
            m.role === "user" ? (
              <div className="msg-u" key={i}>
                {m.text}
              </div>
            ) : (
              <div className="ai-block msg-ai" key={i}>
                <div className="ai-head">
                  <span className="ai-tag">
                    <Icon name="sparkles" />
                    개인 Agent
                  </span>
                </div>
                <div className="ans">
                  <div className="ans-sec">
                    <h4>결론</h4>
                    <p className="ans-concl">{m.text}</p>
                  </div>
                </div>
              </div>
            ),
          )
        )}
      </div>
      <div className="ap-foot">
        <form
          className="chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            ask(q);
          }}
        >
          <label className="sr" htmlFor="agent-q-panel">
            Agent에게 질문
          </label>
          <textarea
            id="agent-q-panel"
            rows={1}
            placeholder="질문하거나 요청하세요 (Enter 전송 · Shift+Enter 줄바꿈)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                ask(q);
              }
            }}
          />
          <button className="btn btn-ai" type="submit" aria-label="보내기">
            <Icon name="send" />
          </button>
        </form>
        <span className="hint">답변은 AI 생성물입니다. 근거를 확인하세요.</span>
      </div>
    </aside>
  );
}
