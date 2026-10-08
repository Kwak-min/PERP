import { useState } from "react";

import { Icon } from "../components/ui/Icon";
import { closeChecks, closePeriods, closeReport } from "./mockup/demo";
import { PageHead, Pill, fmtYM, won } from "./mockup/lib";

// FIN-006 결산·재무보고 — 목업 close 이식
export function CloseScreen() {
  const [sel, setSel] = useState("2026-09");
  const inc = closeReport.filter((r) => r.type === "수입").reduce((a, r) => a + r.v, 0);
  const exp = closeReport.filter((r) => r.type === "지출").reduce((a, r) => a + r.v, 0);
  const cur = closePeriods.find((p) => p.ym === sel);

  return (
    <>
      <PageHead
        title="결산·재무보고"
        id="FIN-006"
        fr="SFR-010"
        desc="마감한 기간의 전표는 수정할 수 없습니다 (fiscal_period_lock). 수정이 필요하면 재오픈 결재를 받아야 합니다."
      />
      <div className="grid g-main">
        <div className="stack">
          <section className="panel">
            <div className="panel-h">
              <h2>
                <Icon name="clipboard" />
                {fmtYM(sel)} 마감 체크리스트
              </h2>
              {cur?.locked ? <Pill tone="muted">마감됨</Pill> : <Pill tone="info">열림</Pill>}
            </div>
            <div className="list">
              {closeChecks.map((c, i) => (
                <div className="li" key={i}>
                  <span className={`pill ${c.ok ? "ok" : "warn"}`}>
                    <Icon name={c.ok ? "check" : "alert"} />
                    {c.ok ? "충족" : "확인 필요"}
                  </span>
                  <span className="li-t">
                    <b>{c.t}</b>
                    <small>{c.s}</small>
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="panel-h">
              <h2>
                <Icon name="file" />
                {fmtYM(sel)} 수지 보고서
              </h2>
              <div className="row">
                <button type="button" className="btn btn-sm">
                  CSV
                </button>
                <button type="button" className="btn btn-sm">
                  XLSX
                </button>
                <button type="button" className="btn btn-sm">
                  PDF
                </button>
              </div>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>계정과목</th>
                    <th>구분</th>
                    <th className="num">당월 확정</th>
                    <th className="num">예산 대비 (누계)</th>
                  </tr>
                </thead>
                <tbody>
                  {closeReport.map((r) => (
                    <tr key={r.name}>
                      <td>{r.name}</td>
                      <td>{r.type}</td>
                      <td className="num">{won(r.v)}</td>
                      <td className="num">{r.rate}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>
                      수지 (수입 {won(inc)} − 지출 {won(exp)})
                    </td>
                    <td className="num">{won(inc - exp)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </div>
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="lock" />
              회계기간
            </h2>
          </div>
          <div className="list">
            {closePeriods.map((p) => (
              <div
                className={`li${p.ym === sel ? " on" : ""}`}
                key={p.ym}
                style={p.ym === sel ? { background: "var(--primary-soft)" } : undefined}
              >
                <button
                  type="button"
                  className="link-btn b"
                  style={{ width: 96, textAlign: "left" }}
                  onClick={() => setSel(p.ym)}
                >
                  {fmtYM(p.ym)}
                </button>
                <span className="li-t">
                  <small>{p.note}</small>
                </span>
                {p.locked ? (
                  p.pendingReopen ? (
                    <Pill tone="warn">재오픈 결재 대기</Pill>
                  ) : (
                    <button type="button" className="btn btn-xs">
                      재오픈 요청
                    </button>
                  )
                ) : (
                  <button type="button" className="btn btn-xs btn-primary">
                    마감
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
