import { useState } from "react";

import { PageHead, Pill, Tabs } from "./mockup/lib";

const ORG_TYPES: Array<[string, string]> = [
  ["student", "학생회"],
  ["club", "동아리"],
  ["lab", "연구실"],
  ["company", "기업"],
];
const CUR_TYPE = "student";

const TERMS: Array<[string, Record<string, string>]> = [
  ["MEMBER_ATTENDANCE", { student: "행사활동", club: "활동 참여", lab: "연구활동", company: "근태" }],
  ["FINANCE", { student: "예산·회계", club: "회비·활동비", lab: "연구비", company: "회계" }],
  ["DUES", { student: "학생회비", club: "회비", lab: "연구비 분담금", company: "청구" }],
  ["LEAVE", { student: "활동 불참", club: "활동 불참", lab: "부재", company: "휴가" }],
];

const MODULES: Array<[string, string]> = [
  ["finance", "재무·회계"],
  ["asset", "자산·예약"],
  ["hr", "인사·근태"],
  ["handover", "인수인계"],
  ["automation", "자동화"],
  ["agent", "AI Agent"],
];

const HISTORY: Array<{ action: string; by: string; at: string; after: string }> = [
  { action: "org.update", by: "김경준", at: "9.6 09:40", after: '{"name":"남부대 학생회","fiscalStart":3}' },
  { action: "org.module.toggle", by: "김경준", at: "8.30 14:10", after: '{"automation":true}' },
];

// ORG-001 조직 설정 — 목업 org settings 이식
export function OrgSettingsScreen() {
  const [tab, setTab] = useState("basic");
  return (
    <>
      <PageHead
        title="조직 설정"
        id="ORG-001"
        fr="SFR-001 · SFR-002"
        desc="조직 유형을 바꾸면 표시 용어와 기본 메뉴 이름이 바뀌지만, 공통 개념 코드는 그대로여서 과거 데이터 조회·보고는 유지됩니다."
      />
      <Tabs
        items={[
          ["basic", "기본 정보"],
          ["type", "유형·용어"],
          ["modules", "모듈"],
          ["history", "변경 이력", HISTORY.length],
        ]}
        cur={tab}
        onChange={setTab}
      />

      {tab === "basic" ? (
        <form className="panel panel-b form-grid" style={{ maxWidth: 720 }} onSubmit={(e) => e.preventDefault()}>
          <div className="field span2">
            <label>조직 이름</label>
            <input defaultValue="남부대 학생회" />
          </div>
          <div className="field">
            <label>규모</label>
            <select defaultValue="11~30명">
              {["1~10명", "11~30명", "31~100명", "100명 이상"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>통화</label>
            <select defaultValue="KRW">
              <option>KRW</option>
              <option>USD</option>
            </select>
          </div>
          <div className="field">
            <label>회계연도 시작 월</label>
            <select defaultValue="3">
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i} value={i + 1}>
                  {i + 1}월
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>연간 휴가 부여일</label>
            <input type="number" min={0} defaultValue={15} />
          </div>
          <div className="span2 row">
            <span className="grow" />
            <button className="btn btn-primary" type="submit">
              저장
            </button>
          </div>
        </form>
      ) : tab === "type" ? (
        <div className="panel panel-b stack" style={{ maxWidth: 820 }}>
          <div className="field" style={{ maxWidth: 280 }}>
            <label>조직 유형</label>
            <select defaultValue={CUR_TYPE}>
              {ORG_TYPES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>공통 개념 코드</th>
                  {ORG_TYPES.map(([k, l]) => (
                    <th key={k} style={k === CUR_TYPE ? { color: "var(--primary-ink)" } : undefined}>
                      {l}
                      {k === CUR_TYPE ? " (현재)" : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TERMS.map(([code, m]) => (
                  <tr key={code}>
                    <td className="mono xs">{code}</td>
                    {ORG_TYPES.map(([k]) => (
                      <td key={k} className={k === CUR_TYPE ? "b" : ""}>
                        {m[k]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : tab === "modules" ? (
        <div className="panel" style={{ maxWidth: 720 }}>
          <div className="list">
            {MODULES.map(([k, l]) => (
              <label className="li check" key={k}>
                <input type="checkbox" defaultChecked />
                <span className="li-t">
                  <b>{l}</b>
                  <small>
                    끄면 메뉴가 숨고, 주소로 들어와도 403 MODULE_DISABLED가 됩니다. 데이터는 삭제되지 않습니다.
                  </small>
                </span>
                <Pill tone="ok">켜짐</Pill>
              </label>
            ))}
          </div>
        </div>
      ) : (
        <div className="panel">
          <div className="list">
            {HISTORY.map((e, i) => (
              <div className="li" key={i}>
                <span className="li-t">
                  <b className="mono xs">{e.action}</b>
                  <small>
                    {e.by} · {e.at} · {e.after}
                  </small>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
