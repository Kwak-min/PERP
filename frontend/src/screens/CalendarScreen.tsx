import { useState } from "react";

import { Icon } from "../components/ui/Icon";
import { demoEvents, type DemoEvent } from "./mockup/demo";
import { Av, Empty, PageHead, fmtDate, todayStr } from "./mockup/lib";

const WD = ["일", "월", "화", "수", "목", "금", "토"];
const SCOPE_LABEL: Record<string, string> = {
  org: "조직 일정",
  project: "프로젝트 일정",
  personal: "개인 일정",
};

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (iso: string) => iso.slice(11, 16);
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// CAL-001 통합 캘린더 — 목업 calendar 이식
export function CalendarScreen() {
  const [ym, setYm] = useState(todayStr.slice(0, 7));
  const [view, setView] = useState<"month" | "list">("month");
  const [scopes, setScopes] = useState({ org: true, project: true, personal: true });

  const evs = demoEvents.filter((e) => scopes[e.scope]);
  const [year, month] = ym.split("-").map(Number) as [number, number];
  const first = new Date(year, month - 1, 1);
  const startOff = first.getDay();
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(year, month - 1, 1 + i - startOff);
    return d;
  });

  const shiftMonth = (delta: number) => {
    if (delta === 0) return setYm(todayStr.slice(0, 7));
    const d = new Date(year, month - 1 + delta, 1);
    setYm(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  };

  return (
    <>
      <PageHead
        title="통합 캘린더"
        id="CAL-001"
        fr="SFR-009 · SIR-001"
        desc="개인·조직·프로젝트 일정을 한 화면에서 봅니다. 날짜 칸을 누르면 새 일정을 만듭니다."
        actions={
          <button type="button" className="btn btn-primary">
            <Icon name="plus" />
            새 일정
          </button>
        }
      />
      <div className="filters">
        <button type="button" className="icon-btn" onClick={() => shiftMonth(-1)} aria-label="이전 달">
          <Icon name="left" />
        </button>
        <b style={{ minWidth: 110, textAlign: "center" }}>
          {year}년 {month}월
        </b>
        <button type="button" className="icon-btn" onClick={() => shiftMonth(1)} aria-label="다음 달">
          <Icon name="right" />
        </button>
        <button type="button" className="btn btn-sm" onClick={() => shiftMonth(0)}>
          오늘
        </button>
        <div className="seg">
          {(["month", "list"] as const).map((k) => (
            <button
              type="button"
              key={k}
              className={view === k ? "on" : ""}
              onClick={() => setView(k)}
            >
              {k === "month" ? "월" : "목록"}
            </button>
          ))}
        </div>
        {(["org", "project", "personal"] as const).map((k) => (
          <label className="check" key={k}>
            <input
              type="checkbox"
              checked={scopes[k]}
              onChange={(e) => setScopes((s) => ({ ...s, [k]: e.target.checked }))}
            />{" "}
            {SCOPE_LABEL[k]}
          </label>
        ))}
        <span className="grow" />
        <span className="muted xs">Google Calendar 미연결</span>
      </div>

      {view === "month" ? (
        <div className="cal">
          {WD.map((d) => (
            <div className="cal-h" key={d}>
              {d}
            </div>
          ))}
          {cells.map((d, i) => {
            const key = ymd(d);
            const out = d.getMonth() + 1 !== month;
            const de = evs
              .filter((e) => e.start.slice(0, 10) === key)
              .sort((a, b) => a.start.localeCompare(b.start));
            return (
              <div
                className={`cal-d${out ? " out" : ""}${key === todayStr ? " today" : ""}`}
                key={i}
                aria-label={`${key} 일정 ${de.length}건`}
              >
                <span className="cal-n">{d.getDate()}</span>
                {de.slice(0, 3).map((e) => (
                  <button type="button" className={`ev ${e.scope}`} key={e.id} title={e.title}>
                    <span className="t">{hm(e.start)}</span>
                    {e.title}
                  </button>
                ))}
                {de.length > 3 && <span className="xs muted">+{de.length - 3}건</span>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="panel">
          <div className="list agenda">
            {evs.filter((e) => e.start.slice(0, 7) === ym).length ? (
              evs
                .filter((e) => e.start.slice(0, 7) === ym)
                .sort((a, b) => a.start.localeCompare(b.start))
                .map((e: DemoEvent) => (
                  <button type="button" className="li pop-i" key={e.id}>
                    <span className="agenda-time">
                      {fmtDate(e.start.slice(0, 10))}
                      <br />
                      {hm(e.start)}–{hm(e.end)}
                    </span>
                    <span className="li-t">
                      <b>{e.title}</b>
                      <small>
                        {SCOPE_LABEL[e.scope]}
                        {e.location ? ` · ${e.location}` : ""}
                      </small>
                    </span>
                    <span className="av-stack">
                      {e.attendees.slice(0, 4).map((a) => (
                        <Av key={a} name={a} size="sm" />
                      ))}
                    </span>
                  </button>
                ))
            ) : (
              <Empty title="이 달에 일정이 없습니다" />
            )}
          </div>
        </div>
      )}

      <div className="legend" style={{ marginTop: 10 }}>
        <span>
          <i style={{ background: "var(--primary-soft)" }} />
          조직
        </span>
        <span>
          <i style={{ background: "color-mix(in srgb,var(--chart-1) 14%,transparent)" }} />
          프로젝트
        </span>
        <span>
          <i
            style={{
              background: "var(--surface-2)",
              boxShadow: "inset 0 0 0 1px var(--of-border)",
            }}
          />
          개인
        </span>
      </div>
    </>
  );
}
