import { useState } from "react";

import { Icon } from "../components/ui/Icon";
import { PageHead, Pill } from "./mockup/lib";

type AuditEvent = {
  seq: number;
  at: string;
  actor: string;
  action: string;
  resource: string;
  ai?: boolean;
  requestId: string;
  hash: string;
};

const EVENTS: AuditEvent[] = [
  { seq: 128, at: "9.12 16:22", actor: "이서연", action: "doc.update", resource: "doc:12 · 2026 정기총회 안건", requestId: "req_9f2a1c", hash: "a1b2c3d4e5" },
  { seq: 127, at: "9.12 14:05", actor: "김경준", action: "finance.entry.confirm", resource: "entry:41 · 회비수입 1,200,000원", requestId: "req_7d3b90", hash: "b2c3d4e5f6" },
  { seq: 126, at: "9.12 10:40", actor: "정하늘", action: "dues.record", resource: "dues:9월 회비 · 박*", requestId: "req_3e8a22", hash: "c3d4e5f6a7" },
  { seq: 125, at: "9.11 18:12", actor: "AI Agent", action: "agent.answer.review", resource: "session:6 · 예산 위험 요약", ai: true, requestId: "req_1a0c44", hash: "d4e5f6a7b8" },
  { seq: 124, at: "9.11 09:30", actor: "김경준", action: "role.permission.update", resource: "role:treasurer · v3→v4", requestId: "req_88b1de", hash: "e5f6a7b8c9" },
  { seq: 123, at: "9.10 15:48", actor: "박준호", action: "settlement.submit", resource: "settlement:2 · 부스 소품 88,000원", requestId: "req_5c9f01", hash: "f6a7b8c9d0" },
  { seq: 122, at: "9.10 11:02", actor: "이서연", action: "approval.approve", resource: "approval:3 · 정기총회 대관료", requestId: "req_2b7e88", hash: "a7b8c9d0e1" },
];

// ADM-002 감사 로그 — 목업 audit 이식
export function AuditScreen() {
  const [q, setQ] = useState("");
  const [ai, setAi] = useState("");
  const list = EVENTS.filter(
    (e) =>
      (!q || `${e.action} ${e.resource}`.includes(q)) &&
      (!ai || String(!!e.ai) === ai),
  );

  return (
    <>
      <PageHead
        title="감사 로그"
        id="ADM-002"
        fr="SFR-029 · DAR-007"
        desc="모든 상태 변경을 누가·언제·무엇을·전후값·요청ID·AI 여부와 함께 append-only로 기록합니다. 각 이벤트는 이전 이벤트의 해시를 품어 체인을 이루므로, 관리자도 몰래 고치거나 지울 수 없습니다."
        actions={
          <>
            <button type="button" className="btn btn-primary">
              <Icon name="shield" />
              무결성 검증
            </button>
            <button type="button" className="btn btn-ghost">
              변조 시뮬레이션
            </button>
            <button type="button" className="btn">
              <Icon name="download" />
              CSV
            </button>
          </>
        }
      />
      <div className="callout ok" style={{ marginBottom: 12 }}>
        <Icon name="check" />
        <div>
          <b className="mono">GET /api/v1/integrations/audit/verify → {"{"}"valid":true{"}"}</b>
          <br />
          전체 {EVENTS.length}개 이벤트의 해시체인이 온전합니다. head{" "}
          <span className="hash">a1b2c3d4e5f6a7b8…</span>{" "}
          <span className="muted xs">· 9.12 16:25 검증</span>
        </div>
      </div>
      <div className="filters">
        <input
          type="search"
          placeholder="행동·대상 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="검색"
        />
        <select value={ai} onChange={(e) => setAi(e.target.value)} aria-label="AI 여부">
          <option value="">AI 포함 전체</option>
          <option value="true">AI 실행만</option>
          <option value="false">사람만</option>
        </select>
        <span className="muted xs">
          {list.length}건 · 감사 읽기와 내보내기 권한은 분리되어 있습니다
        </span>
      </div>
      <div className="panel tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>시각</th>
              <th>사용자</th>
              <th>행동</th>
              <th>대상</th>
              <th>AI</th>
              <th>request_id</th>
              <th>hash</th>
            </tr>
          </thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.seq}>
                <td className="num mono xs">{e.seq}</td>
                <td className="nowrap muted">{e.at}</td>
                <td className="nowrap">{e.actor}</td>
                <td>
                  <a href="#" className="mono xs" onClick={(ev) => ev.preventDefault()}>
                    {e.action}
                  </a>
                </td>
                <td className="xs" style={{ maxWidth: 220, overflowWrap: "anywhere" }}>
                  {e.resource}
                </td>
                <td>{e.ai && <Pill tone="ai">AI</Pill>}</td>
                <td className="mono xs">{e.requestId}</td>
                <td className="hash">{e.hash}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
