import { Empty, Meter, PageHead, Pill, StatTile, pct, won } from "./mockup/lib";
import { useApi } from "./mockup/useApi";

type Budget = {
  id: string;
  name: string;
  amount_minor: number;
  spent_minor: number;
  execution_rate: number;
  over: boolean;
};

const toneOf = (r: number) => (r >= 100 ? "bad" : r >= 90 ? "warn" : "ok");

// FIN-003 예산 편성·집행 — 실제 백엔드(/finance/budgets) 연동
export function BudgetsScreen() {
  const res = useApi<{ items: Budget[] }>("/finance/budgets");
  const rows = (res.data?.items ?? []).map((b) => ({
    ...b,
    rate: b.execution_rate ?? pct(b.spent_minor, b.amount_minor),
  }));
  const total = rows.reduce((a, r) => a + r.amount_minor, 0);
  const used = rows.reduce((a, r) => a + r.spent_minor, 0);
  const rate = pct(used, total);
  const warnCount = rows.filter((r) => r.rate >= 90).length;

  return (
    <>
      <PageHead
        title="예산 편성·집행"
        id="FIN-003"
        fr="SFR-011"
        desc="집행률 = 확정 지출 ÷ 승인 예산. 90% 이상은 주의, 100% 이상은 초과로 표시합니다."
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
        <StatTile label="주의·초과 계정" value={`${warnCount}개`} tone={warnCount ? "warn" : ""} />
      </div>
      {res.loading ? (
        <div className="panel">
          <Empty title="불러오는 중…" icon="clock" />
        </div>
      ) : res.error ? (
        <div className="panel">
          <Empty title="예산을 불러오지 못했습니다" desc={res.error} icon="alert" />
        </div>
      ) : (
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
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td className="t-title">{r.name}</td>
                    <td className="num">{won(r.amount_minor)}</td>
                    <td className="num">{won(r.spent_minor)}</td>
                    <td className={`num ${r.amount_minor - r.spent_minor < 0 ? "ink-bad" : ""}`}>
                      {won(r.amount_minor - r.spent_minor)}
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
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6}>
                    <Empty title="편성된 예산이 없습니다" />
                  </td>
                </tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr>
                  <td>합계</td>
                  <td className="num">{won(total)}</td>
                  <td className="num">{won(used)}</td>
                  <td className="num">{won(total - used)}</td>
                  <td colSpan={2}>{rate}%</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </>
  );
}
