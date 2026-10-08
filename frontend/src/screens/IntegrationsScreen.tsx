import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { PageHead, Pill } from "./mockup/lib";

type Integ = { key: string; name: string; fr: string; rtm: string; connected?: boolean; account?: string };

const INTEG: Integ[] = [
  { key: "google", name: "Google Calendar", fr: "SIR-001", rtm: "⚠ 부분 (스키마·연결 슬롯)", connected: true, account: "scnu.sw.council@gmail.com" },
  { key: "microsoft", name: "Microsoft 365 캘린더", fr: "SIR-002", rtm: "⏳ 진행" },
  { key: "slack", name: "Slack", fr: "SIR-003", rtm: "⏳ 진행" },
  { key: "discord", name: "Discord", fr: "SIR-003", rtm: "⏳ 진행", connected: true, account: "webhook://discord/스카웃" },
  { key: "drive", name: "Google Drive", fr: "SIR-004", rtm: "⏳ 진행" },
  { key: "s3", name: "S3 호환 스토리지", fr: "SIR-004", rtm: "⏳ 진행" },
  { key: "webhook", name: "Webhook", fr: "SIR-008", rtm: "⚠ 부분 (서명검증·백오프)" },
  { key: "apikey", name: "공개 REST API 키", fr: "SIR-007", rtm: "⚠ 부분 (route catalog)" },
];

// INT-001 연동 센터 — 목업 integrations 이식
export function IntegrationsScreen() {
  return (
    <>
      <PageHead
        title="연동 센터"
        id="INT-001"
        fr="SIR-001~008"
        desc="OAuth는 범위를 보여 준 뒤 사용자가 직접 허용해야 연결됩니다(자동 수락 없음). 토큰 원문은 저장하지 않고 참조값(*_ref)만 둡니다."
      />
      <div className="callout warn" style={{ marginBottom: 16 }}>
        <Icon name="alert" />
        <div>
          이 목업은 외부와 통신하지 않습니다. 연결·테스트는 시뮬레이션이며, 각 카드에 실제 구현 상태를 함께
          표기했습니다.
        </div>
      </div>
      <div className="grid g3">
        {INTEG.map((it) => (
          <section
            className="panel"
            key={it.key}
            style={{ padding: 16, display: "grid", gap: 10, alignContent: "start" }}
          >
            <div className="row between">
              <b style={{ fontSize: 15 }}>{it.name}</b>
              <Pill tone={it.connected ? "ok" : "muted"}>{it.connected ? "연결됨" : "연결 안 됨"}</Pill>
            </div>
            <div className="row">
              <span className="trace-fr">{it.fr}</span>
              <span className="muted xs">{it.rtm}</span>
            </div>
            {it.connected && it.account && (
              <span className="sm mono muted" style={{ overflowWrap: "anywhere" }}>
                {it.account}
              </span>
            )}
            <div className="row">
              {it.connected ? (
                <>
                  <button type="button" className="btn btn-sm">
                    연결 테스트
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost">
                    토큰 폐기
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-sm btn-primary">
                  연결
                </button>
              )}
            </div>
          </section>
        ))}
        <section
          className="panel"
          style={{ padding: 16, display: "grid", gap: 10, alignContent: "start" }}
        >
          <div className="row between">
            <b style={{ fontSize: 15 }}>OpenRouter · 로컬 LLM</b>
            <Pill tone="ai">로컬 전용</Pill>
          </div>
          <div className="row">
            <span className="trace-fr">SIR-005/006</span>
            <span className="muted xs">✅ 구현</span>
          </div>
          <span className="sm muted">openrouter/auto · 로컬 OCR·요약</span>
          <Link className="btn btn-sm" to="/admin/ai-policy">
            AI 정책에서 관리
          </Link>
        </section>
      </div>
    </>
  );
}
