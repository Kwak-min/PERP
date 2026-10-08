import { useState } from "react";

import { Icon } from "../components/ui/Icon";
import { useSession } from "../store/session";
import { Empty, PageHead } from "./mockup/lib";

const SUGGEST = [
  "오늘 브리핑 해줘",
  "학생회비 얼마야?",
  "회비 미납자 알려줘",
  "이번 달 초안 전표 확정해줘",
  "남은 예산 알려줘",
];

type Msg = { role: "user" | "ai"; text: string };
type Sess = { id: number; title: string; at: string; count: number };

// AI-001 개인 Agent 채팅 — 목업 agent page 이식
export function AgentPage() {
  const session = useSession();
  const [sessions] = useState<Sess[]>([
    { id: 1, title: "예산 위험 요약", at: "9.11 18:12", count: 4 },
    { id: 2, title: "회비 미납자 확인", at: "9.10 10:40", count: 2 },
  ]);
  const [selId, setSelId] = useState(0);
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
        text: `"${t}" — 권한 선필터 → 검색 → 재검증 → 라우팅을 거쳐 조직 데이터 안에서 확인했습니다. 변경 작업은 실행 전 미리보기와 승인이 필요합니다. (데모 응답)`,
      },
    ]);
    setQ("");
  }

  return (
    <>
      <PageHead
        title="개인 Agent"
        id="AI-001"
        fr="SFR-021 · SIR-005/006"
        desc="권한 선필터 → 검색 → 재검증 → 데이터 등급별 모델 라우팅. 모든 답변은 결론·근거·관련 데이터·불확실성·추천 행동·실행 가능 여부·필요 승인 형식을 따릅니다."
        actions={
          <button type="button" className="btn" onClick={() => setMsgs([])}>
            <Icon name="plus" />새 대화
          </button>
        }
      />
      <div className="agent-layout">
        <section className="panel">
          <div className="panel-h">
            <h2>대화</h2>
          </div>
          <div className="list" style={{ overflowY: "auto" }}>
            {sessions.length ? (
              sessions.map((x) => (
                <div
                  className={`li${selId === x.id ? " on" : ""}`}
                  key={x.id}
                  style={selId === x.id ? { background: "var(--ai-soft)" } : undefined}
                >
                  <button
                    type="button"
                    className="link-btn li-t"
                    style={{ textAlign: "left", color: "inherit" }}
                    onClick={() => setSelId(x.id)}
                  >
                    <b>{x.title}</b>
                    <small>
                      {x.at} · {x.count}개
                    </small>
                  </button>
                  <button type="button" className="icon-btn sm" aria-label="대화 삭제">
                    <Icon name="trash" />
                  </button>
                </div>
              ))
            ) : (
              <Empty title="대화가 없습니다" />
            )}
          </div>
        </section>
        <section className="panel" style={{ borderColor: "var(--ai-line)" }}>
          <div className="ap-body" id="chat-page">
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
              <label className="sr" htmlFor="agent-q-page">
                Agent에게 질문
              </label>
              <textarea
                id="agent-q-page"
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
          </div>
        </section>
      </div>
    </>
  );
}
