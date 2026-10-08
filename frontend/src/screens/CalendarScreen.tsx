import { useState } from "react";

import { Icon } from "../components/ui/Icon";
import { Empty, PageHead, fmtDate, todayStr } from "./mockup/lib";
import { useApi } from "./mockup/useApi";

type Scope = "org" | "project" | "personal";
type Ev = {
  id: string;
  calendar: Scope;
  title: string;
  start_at: string;
  end_at: string;
  location: string | null;
};

const WD = ["일", "월", "화", "수", "목", "금", "토"];
const SCOPE_LABEL: Record<string, string> = {
  org: "조직 일정",
  project: "프로젝트 일정",
  personal: "개인 일정",
};

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (iso: string) => iso.slice(11, 16);

// CAL-001 통합 캘린더 — 실제 백엔드(/calendar) 연동
export function CalendarScreen() {
  const [ym, setYm] = useState(todayStr.slice(0, 7));
  const [view, setView] = useState<"month" | "list">("month");
  const [scopes, setScopes] = useState<Record<Scope, boolean>>({
    org: true,
    project: true,
    personal: true,
  });

  const res = useApi<{ items: Ev[] }>("/calendar");
  const evs = (res.data?.items ?? []).filter((e) => scopes[e.calendar] ?? true);

  const [year, month] = ym.split("-").map(Number) as [number, number];
  const first = new Date(year, month - 1, 1);
  const startOff = first.getDay();
  const cells = Array.from({ length: 42 }, (_, i) => new Date(year, month - 1, 1 + i - startOff));

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
      </div>

      {res.loading ? (
        <div className="panel">
          <Empty title="불러오는 중…" icon="clock" />
        </div>
      ) : view === "month" ? (
        <div className="cal">
          {WD.map((d) => (
            <div className="cal-h" key={d}>
              {d}
            </div>
          ))}
          {cells.map((d, i) => {
            const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            const out = d.getMonth() + 1 !== month;
            const de = evs
              .filter((e) => e.start_at.slice(0, 10) === key)
              .sort((a, b) => a.start_at.localeCompare(b.start_at));
            return (
              <div
                className={`cal-d${out ? " out" : ""}${key === todayStr ? " today" : ""}`}
                key={i}
              >
                <span className="cal-n">{d.getDate()}</span>
                {de.slice(0, 3).map((e) => (
                  <button type="button" className={`ev ${e.calendar}`} key={e.id} title={e.title}>
                    <span className="t">{hm(e.start_at)}</span>
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
            {evs.filter((e) => e.start_at.slice(0, 7) === ym).length ? (
              evs
                .filter((e) => e.start_at.slice(0, 7) === ym)
                .sort((a, b) => a.start_at.localeCompare(b.start_at))
                .map((e) => (
                  <div className="li" key={e.id}>
                    <span className="agenda-time">
                      {fmtDate(e.start_at.slice(0, 10))}
                      <br />
                      {hm(e.start_at)}–{hm(e.end_at)}
                    </span>
                    <span className="li-t">
                      <b>{e.title}</b>
                      <small>
                        {SCOPE_LABEL[e.calendar]}
                        {e.location ? ` · ${e.location}` : ""}
                      </small>
                    </span>
                  </div>
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
