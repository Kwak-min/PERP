import { Icon } from "../components/ui/Icon";
import { budgetLog, demoBudgets } from "./mockup/demo";
import { Empty, Meter, PageHead, Pill, StatTile, pct, won } from "./mockup/lib";

const toneOf = (r: number) => (r >= 100 ? "bad" : r >= 90 ? "warn" : "ok");

// FIN-003 예산 편성·집행 — 목업 budgets 이식
export function BudgetsScreen() {
  const rows = demoBudgets.map((b) => ({ ...b, rate: pct(b.used, b.amount) }));
  const total = rows.reduce((a, r) => a + r.amount, 0);
  const used = rows.reduce((a, r) => a + r.used, 0);
  const rate = pct(used, total);
  const warnCount = rows.filter((r) => r.rate >= 90).length;

  return (
    <>
      <PageHead
        title="예산 편성·집행"
        id="FIN-003"
        fr="SFR-011"
        desc="집행률 = 확정 지출 ÷ 승인 예산 (회계연도 2026-03-01 ~). 90% 이상은 주의, 100% 이상은 초과로 표시합니다."
        actions={
          <button type="button" className="btn">
            예산 전용
          </button>
        }
      />
      <div className="stats" style={{ marginBottom: 16 }}>
        <StatTile label="승인 예산" value={won(total)} />
        <StatTile label="집행 (확정)" value={won(used)} sub={`${rate}%`} />
        <StatTile label="잔액" value={won(total - used)} />
        <StatTile
          label="주의·초과 계정"
          value={`${warnCount}개`}
          tone={warnCount ? "warn" : ""}
        />
      </div>
      <div className="panel tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>계정과목</th>
              <th className="num">승인 예산</th>
              <th className="num">집행</th>
              <th className="num">잔액</th>
              <th style={{ width: "28%" }}>집행률</th>
              <th>상태</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="t-title">{r.name}</td>
                <td className="num">{won(r.amount)}</td>
                <td className="num">{won(r.used)}</td>
                <td className={`num ${r.amount - r.used < 0 ? "ink-bad" : ""}`}>
                  {won(r.amount - r.used)}
                </td>
                <td>
                  <div className="row" style={{ flexWrap: "nowrap" }}>
                    <Meter p={r.rate} tone={toneOf(r.rate)} />
                    <span className="num xs" style={{ width: 40 }}>
                      {r.rate}%
                    </span>
                  </div>
                </td>
                <td>
                  <Pill tone={toneOf(r.rate)}>
                    {r.rate >= 100 ? "초과" : r.rate >= 90 ? "주의" : "정상"}
                  </Pill>
                </td>
                <td>
                  <button type="button" className="btn btn-xs">
                    조정
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>합계</td>
              <td className="num">{won(total)}</td>
              <td className="num">{won(used)}</td>
              <td className="num">{won(total - used)}</td>
              <td colSpan={3}>{rate}%</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h">
          <h2>
            <Icon name="clock" />
            예산 변경 이력 (버전)
          </h2>
        </div>
        <div className="list">
          {budgetLog.length ? (
            budgetLog.map((l) => (
              <div className="li" key={l.v}>
                <span className="pill muted mono">v{l.v}</span>
                <span className="li-t">
                  <b>{l.text}</b>
                  <small>
                    {l.by} · {l.at}
                  </small>
                </span>
              </div>
            ))
          ) : (
            <Empty title="아직 변경 이력이 없습니다" />
          )}
        </div>
      </section>
    </>
  );
}
