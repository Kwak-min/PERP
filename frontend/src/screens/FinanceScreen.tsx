import { useMemo } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import {
  Empty,
  HBars,
  MonthlyChart,
  PageHead,
  Pill,
  StatTile,
  fmtYM,
  won,
  type MonthPoint,
} from "./mockup/lib";
import { useApi } from "./mockup/useApi";

type Summary = {
  income_minor: number;
  expense_minor: number;
  balance_minor: number;
  budget_total_minor: number;
  budget_execution_rate: number;
  unevidenced_count: number;
  transaction_count: number;
};
type Tx = {
  kind: "income" | "expense";
  account_id: string | null;
  amount_minor: number;
  occurred_on: string;
  status: string;
};
type Account = { id: string; name: string; kind: string };
type ClosePeriod = { period: string; locked?: boolean; locked_by?: string };

// FIN-001 재무 대시보드 — 실제 백엔드(/finance/*) 연동
export function FinanceScreen() {
  const sumRes = useApi<Summary>("/finance/reports/summary");
  const txRes = useApi<{ items: Tx[] }>("/finance/transactions");
  const accRes = useApi<{ items: Account[] }>("/finance/accounts");
  const closeRes = useApi<{ items: ClosePeriod[] }>("/finance/close");

  const s = sumRes.data;
  const txs = txRes.data?.items ?? [];
  const confirmed = txs.filter((t) => t.status === "confirmed");
  const drafts = txs.filter((t) => t.status === "draft");

  const monthly: MonthPoint[] = useMemo(() => {
    const m = new Map<string, { inc: number; exp: number }>();
    for (const t of confirmed) {
      const ym = t.occurred_on.slice(0, 7);
      const cur = m.get(ym) ?? { inc: 0, exp: 0 };
      if (t.kind === "income") cur.inc += t.amount_minor;
      else cur.exp += t.amount_minor;
      m.set(ym, cur);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ym, v]) => ({ ym, ...v }));
  }, [confirmed]);

  const expenseByAccount = useMemo(() => {
    const accName = new Map((accRes.data?.items ?? []).map((a) => [a.id, a.name]));
    const m = new Map<string, number>();
    for (const t of confirmed) {
      if (t.kind !== "expense") continue;
      const name = accName.get(t.account_id ?? "") ?? "기타";
      m.set(name, (m.get(name) ?? 0) + t.amount_minor);
    }
    return [...m.entries()].map(([name, v]) => ({ name, v })).sort((a, b) => b.v - a.v);
  }, [confirmed, accRes.data]);

  const budgetRate = s ? Math.round(s.budget_execution_rate) : 0;
  const closePeriods = closeRes.data?.items ?? [];

  return (
    <>
      <PageHead
        title="재무 대시보드"
        id="FIN-001"
        fr="SFR-010 · SFR-011"
        desc="확정 전표만 집계합니다."
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
        <StatTile label="확정 수입" value={won(s?.income_minor ?? 0)} sub="확정 전표 기준" />
        <StatTile
          label="확정 지출"
          value={won(s?.expense_minor ?? 0)}
          sub={`${confirmed.filter((t) => t.kind === "expense").length}건`}
        />
        <StatTile label="누적 잔액" value={won(s?.balance_minor ?? 0)} sub="확정 수입 − 확정 지출" />
        <StatTile
          label="확정 대기 초안"
          value={`${drafts.length}건`}
          sub={`${won(drafts.reduce((a, t) => a + t.amount_minor, 0))} · 합계 미반영`}
          tone={drafts.length ? "warn" : ""}
        />
        <StatTile
          label="예산 집행률"
          value={`${budgetRate}%`}
          sub={`승인예산 ${won(s?.budget_total_minor ?? 0)}`}
          tone={budgetRate >= 90 ? "warn" : ""}
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
            {monthly.length ? (
              <MonthlyChart data={monthly} />
            ) : (
              <Empty title="확정 전표가 없습니다" desc="전표를 확정하면 집계됩니다." />
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="pie" />
              계정별 지출
            </h2>
            <span className="muted xs">확정 기준</span>
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
          {closePeriods.length ? (
            closePeriods.map((p) => (
              <div className="li" key={p.period}>
                <b style={{ width: 110 }}>{fmtYM(p.period)}</b>
                {p.locked ? <Pill tone="muted">마감</Pill> : <Pill tone="info">열림</Pill>}
                <span className="li-t">
                  <small>{p.locked ? `마감 · ${p.locked_by ?? ""}` : "열림"}</small>
                </span>
              </div>
            ))
          ) : monthly.length ? (
            <div className="li">
              <b style={{ width: 110 }}>{fmtYM(monthly[monthly.length - 1]!.ym)}</b>
              <Pill tone="info">열림</Pill>
              <span className="li-t">
                <small>초안 {drafts.length}건</small>
              </span>
            </div>
          ) : (
            <Empty title="마감 이력이 없습니다" />
          )}
        </div>
      </section>
    </>
  );
}
