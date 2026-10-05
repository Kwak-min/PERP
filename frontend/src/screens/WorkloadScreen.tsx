import { demoWorkload } from "./mockup/demo";
import { Av, PageHead, todayStr } from "./mockup/lib";

const WD = ["일", "월", "화", "수", "목", "금", "토"];

function next14(): { d: number; wd: string }[] {
  const base = new Date(todayStr);
  return Array.from({ length: 14 }, (_, i) => {
    const dt = new Date(base);
    dt.setDate(base.getDate() + i);
    return { d: dt.getDate(), wd: WD[dt.getDay()] ?? "" };
  });
}

const loadCls = (c: number) => (c < 0 ? "" : c >= 3 ? "l3" : c === 2 ? "l2" : c === 1 ? "l1" : "");

// TSK-005 업무량·자원배정 — 목업 workload 이식
export function WorkloadScreen() {
  const days = next14();
  return (
    <>
      <PageHead
        title="업무량·자원배정"
        id="TSK-005"
        fr="SFR-008"
        desc="앞으로 2주 동안 날짜별로 겹치는 미완료 업무 수입니다. 3건 이상이면 과부하로 표시하고, 승인된 휴가·불참일은 반영됩니다."
      />
      <div className="panel tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>구성원</th>
              {days.map((d, i) => (
                <th key={i} className="num" style={{ padding: "6px 4px" }}>
                  {d.d}
                  <span className="sub">{d.wd}</span>
                </th>
              ))}
              <th className="num">합계</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {demoWorkload.map((u) => {
              const peak = Math.max(...u.cells);
              return (
                <tr key={u.name}>
                  <td className="nowrap">
                    <Av name={u.name} size="sm" /> {u.name}
                    <span className="sub">{u.title}</span>
                  </td>
                  {u.cells.map((c, i) => (
                    <td key={i} style={{ padding: "4px 2px" }}>
                      <div
                        className={`load-cell ${loadCls(c)}`}
                        title={`${u.name} · ${c < 0 ? "휴가/불참" : `${c}건`}`}
                      >
                        {c < 0 ? "휴" : c || ""}
                      </div>
                    </td>
                  ))}
                  <td className="num b">{u.total}</td>
                  <td>
                    {peak >= 3 && (
                      <button type="button" className="btn btn-xs">
                        재배정
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="legend" style={{ marginTop: 10 }}>
        <span>
          <i style={{ background: "color-mix(in srgb,var(--chart-1) 16%,transparent)" }} />
          1건
        </span>
        <span>
          <i style={{ background: "color-mix(in srgb,var(--chart-1) 34%,transparent)" }} />
          2건
        </span>
        <span>
          <i style={{ background: "var(--of-danger)" }} />
          3건 이상 · 과부하
        </span>
        <span>
          <b>휴</b> 승인된 휴가·불참
        </span>
      </div>
    </>
  );
}
