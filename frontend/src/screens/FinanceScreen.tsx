import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { expenseByAccount, finKpi, finPeriods, orgMonthly } from "./mockup/demo";
import {
  HBars,
  MonthlyChart,
  PageHead,
  Pill,
  StatTile,
  fmtYM,
  won,
} from "./mockup/lib";

// FIN-001 재무 대시보드 — 목업 finance dashboard 이식
export function FinanceScreen() {
  const k = finKpi;
  return (
    <>
      <PageHead
        title="재무 대시보드"
        id="FIN-001"
        fr="SFR-010 · SFR-011"
        desc="확정 전표만 집계합니다. 회계연도 시작 2026-03-01"
        actions={
          <>
            <button type="button" className="btn btn-primary">
              <Icon name="plus" />
              전표 초안
            </button>
            <Link className="btn" to="/finance/transactions">
              거래·전표
            </Link>
          </>
        }
      />
      <div className="stats" style={{ marginBottom: 16 }}>
        <StatTile label="이번 달 수입" value={won(k.inc)} sub="2026년 9월 확정" />
        <StatTile label="이번 달 지출" value={won(k.exp)} sub={`${k.expCount}건`} />
        <StatTile label="누적 잔액" value={won(k.balance)} sub="확정 수입 − 확정 지출" />
        <StatTile
          label="확정 대기 초안"
          value={`${k.drafts}건`}
          sub={`${won(k.draftSum)} · 합계 미반영`}
          tone={k.drafts ? "warn" : ""}
        />
        <StatTile
          label="예산 집행률"
          value={`${k.budgetRate}%`}
          sub={`${won(k.budgetUsed)} / ${won(k.budgetTotal)}`}
          tone={k.budgetRate >= 90 ? "warn" : ""}
        />
      </div>

      <div className="grid g-main">
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="chart" />
              월별 수입·지출
            </h2>
          </div>
          <div className="panel-b">
            <MonthlyChart data={orgMonthly} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="pie" />
              계정별 지출
            </h2>
            <span className="muted xs">회계연도 누계</span>
          </div>
          <div className="panel-b">
            <HBars rows={expenseByAccount} />
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h">
          <h2>
            <Icon name="lock" />
            결산 상태
          </h2>
          <Link className="xs" to="/finance/close">
            결산 화면
          </Link>
        </div>
        <div className="list">
          {finPeriods.map((p) => (
            <div className="li" key={p.ym}>
              <b style={{ width: 110 }}>{fmtYM(p.ym)}</b>
              {p.locked ? <Pill tone="muted">마감</Pill> : <Pill tone="info">열림</Pill>}
              <span className="li-t">
                <small>{p.note}</small>
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
