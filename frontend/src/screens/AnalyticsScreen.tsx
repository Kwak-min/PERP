import { useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../components/ui/Icon";
import { expenseByAccount, orgDepts, orgMonthly } from "./mockup/demo";
import { HBars, Meter, MonthlyChart, PageHead, pct } from "./mockup/lib";

type Report = {
  key: string;
  name: string;
  def: string;
  formula: string;
  body: ReactNode;
};

const REPORTS: Report[] = [
  {
    key: "monthly",
    name: "월별 수지 보고서",
    def: "월별 확정 수입·지출과 차액.",
    formula: "sum(confirmed.income) − sum(confirmed.expense) group by month",
    body: <MonthlyChart data={orgMonthly} />,
  },
  {
    key: "expense",
    name: "계정별 지출 분석",
    def: "회계연도 누계 계정별 지출 구성.",
    formula: "sum(confirmed.expense) group by account order by desc",
    body: <HBars rows={expenseByAccount} />,
  },
  {
    key: "dept",
    name: "부서별 업무 완료율",
    def: "부서별 완료 업무 ÷ 전체 업무.",
    formula: "count(status=done) / count(*) group by dept",
    body: (
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>부서</th>
              <th className="num">인원</th>
              <th className="num">완료</th>
              <th>완료율</th>
            </tr>
          </thead>
          <tbody>
            {orgDepts.map((d) => {
              const total = d.active + d.done;
              return (
                <tr key={d.name}>
                  <td className="t-title">{d.name}</td>
                  <td className="num">{d.people}</td>
                  <td className="num">{d.done}</td>
                  <td style={{ minWidth: 160 }}>
                    <div className="row">
                      <Meter p={pct(d.done, total)} />
                      <span className="xs num">{pct(d.done, total)}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    ),
  },
];

// ANL-001 분석·보고서 — 목업 analytics 이식
export function AnalyticsScreen() {
  const [selKey, setSelKey] = useState("monthly");
  const rep = REPORTS.find((r) => r.key === selKey) ?? REPORTS[0]!;

  return (
    <>
      <PageHead
        title="분석·보고서"
        id="ANL-001"
        fr="SFR-028"
        desc="모든 보고서에 정의·산식·갱신 시각을 표시합니다. 보고서마다 필요한 권한을 다시 확인합니다."
      />
      <div className="grid" style={{ gridTemplateColumns: "minmax(0,240px) minmax(0,1fr)" }}>
        <section className="panel" style={{ alignSelf: "start" }}>
          <div className="panel-h">
            <h2>카탈로그</h2>
          </div>
          <div className="list">
            {REPORTS.map((r) => (
              <button
                type="button"
                key={r.key}
                className={`li pop-i${r.key === rep.key ? " on" : ""}`}
                onClick={() => setSelKey(r.key)}
              >
                <span className="li-t">
                  <b>{r.name}</b>
                  <small>{r.def}</small>
                </span>
              </button>
            ))}
          </div>
        </section>
        <div className="stack">
          <section className="panel">
            <div className="panel-h">
              <h2>{rep.name}</h2>
              <div className="row">
                <button type="button" className="btn btn-sm">
                  <Icon name="download" />
                  CSV
                </button>
                <button type="button" className="btn btn-sm">
                  예약 발송
                </button>
              </div>
            </div>
            <div className="panel-b stack">
              <dl className="kv">
                <dt>정의</dt>
                <dd>{rep.def}</dd>
                <dt>산식</dt>
                <dd className="mono sm">{rep.formula}</dd>
                <dt>갱신</dt>
                <dd>조회 시점 실시간</dd>
              </dl>
              <div>{rep.body}</div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
