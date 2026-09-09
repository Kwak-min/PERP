import { useEffect, useState } from "react";
import { getReservations } from "../../services/reservationApi";
import { DayOccupancyTimeline } from "./DayOccupancyTimeline";
import type { Reservation, Space } from "./model";
import { dayOccupancy, occupancyListSchema, seoulDay, shiftDay, shiftMonth, type FreeInterval, type Occupancy } from "./occupancy";

type Props = Readonly<{
  space: Space; initialMonth: string; day: string; revision: number;
  onSelectDay: (day: string) => void;
  onSelectFree: (interval: FreeInterval) => void;
  onSelectReservation: (reservation: Reservation) => void;
  onSelectBusy: (interval: FreeInterval) => void;
}>;
type MonthState =
  | Readonly<{ key: string; status: "ready"; rows: readonly Occupancy[] }>
  | Readonly<{ key: string; status: "error"; message: string }>;

export function SpaceMonthCalendar({ space, initialMonth, day, revision, onSelectDay, onSelectFree, onSelectReservation, onSelectBusy }: Props) {
  const [month, setMonth] = useState(initialMonth);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<MonthState | null>(null);
  const key = `${space.id}:${month}:${revision}:${retry}`;
  const first = `${month}-01`;
  const next = `${shiftMonth(month, 1)}-01`;
  const offset = new Date(`${first}T00:00:00Z`).getUTCDay();
  const count = new Date(`${next}T00:00:00Z`).getTime() - new Date(`${first}T00:00:00Z`).getTime();
  const cells = Array.from({ length: Math.ceil((offset + count / 86_400_000) / 7) * 7 }, (_, index) => {
    const date = shiftDay(first, index - offset);
    return date >= first && date < next ? date : null;
  });
  const today = seoulDay();
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const raw = await getReservations({ spaceId: space.id, from: `${first}T00:00:00+09:00`, to: `${next}T00:00:00+09:00`, status: "CONFIRMED" }, controller.signal);
        const rows = occupancyListSchema.parse(raw);
        if (rows.some(row => row.spaceId !== space.id)) throw new Error("선택한 공간과 응답이 일치하지 않습니다.");
        if (!controller.signal.aborted) setState({ key, status: "ready", rows });
      } catch (error) {
        if (!controller.signal.aborted) setState({ key, status: "error", message: error instanceof Error ? error.message : "월 예약 현황을 불러오지 못했습니다." });
      }
    })();
    return () => controller.abort();
  }, [space.id, first, next, key]);
  const current = state?.key === key ? state : null;
  const changeMonth = (value: string) => { setMonth(value); onSelectDay(""); };
  return <div className="rsv-space-calendar">
    <section className="rsv-month-calendar" data-state={current?.status ?? "loading"} aria-label={`${space.name} 월 달력`}>
      <div className="rsv-calendar-toolbar">
        <h2>월별 예약 현황</h2>
        <div className="rsv-month-nav">
          <button className="btn btn-ghost" aria-label="이전 달" onClick={() => changeMonth(shiftMonth(month, -1))}>‹</button>
          <label><span className="rsv-calendar-label">조회 월</span><input type="month" aria-label="조회 월" value={month} onChange={event => { if (event.target.value) changeMonth(event.target.value); }} /></label>
          <button className="btn btn-ghost" aria-label="다음 달" onClick={() => changeMonth(shiftMonth(month, 1))}>›</button>
        </div>
      </div>
      <p className="rsv-calendar-hint">서울 시간 기준 · 날짜를 선택해 예약과 빈 시간을 확인하세요.</p>
      {!current && <p role="status">월 예약 현황을 불러오는 중...</p>}
      {current?.status === "error" && <div className="rsv-error-banner" role="alert">{current.message} <button className="btn btn-ghost" onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}
      <div className="rsv-month-grid">
        {["일", "월", "화", "수", "목", "금", "토"].map(label => <span className="rsv-weekday" key={label}>{label}</span>)}
        {cells.map((date, index) => {
          if (!date) return <span key={`blank:${index}`} />;
          const count = current?.status === "ready" ? dayOccupancy(current.rows, date).length : null;
          return <button key={date} data-day={date} className="rsv-month-day" aria-pressed={date === day} aria-current={date === today ? "date" : undefined}
            aria-label={`${date}${count === null ? "" : ` 예약 ${count}건`}`} onClick={() => onSelectDay(date)}>
            <span>{Number(date.slice(8))}</span>
            {count !== null && <small data-count={count}>{count}건</small>}
          </button>;
        })}
      </div>
    </section>
    {day && <DayOccupancyTimeline key={`${space.id}:${day}`} spaceId={space.id} day={day} revision={revision} onSelectFree={onSelectFree} onSelectReservation={onSelectReservation} onSelectBusy={onSelectBusy} />}
  </div>;
}
