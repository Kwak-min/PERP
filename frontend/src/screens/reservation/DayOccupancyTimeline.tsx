import { useEffect, useState } from "react";
import { getTimetable } from "../../services/reservationApi";
import type { Reservation } from "./model";
import { completeTimetableSchema, dayBounds, dayOccupancy, freeIntervals, intervalLabel, overlaps, type FreeInterval, type Occupancy } from "./occupancy";

type Props = Readonly<{
  spaceId: number; day: string; revision: number;
  onSelectFree: (interval: FreeInterval) => void;
  onSelectReservation: (reservation: Reservation) => void;
  onSelectBusy: (interval: FreeInterval) => void;
}>;
type LoadState =
  | Readonly<{ key: string; status: "ready"; rows: readonly Occupancy[] }>
  | Readonly<{ key: string; status: "error"; message: string }>;

export function DayOccupancyTimeline({ spaceId, day, revision, onSelectFree, onSelectReservation, onSelectBusy }: Props) {
  const [fullDay, setFullDay] = useState(false);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<LoadState | null>(null);
  const key = `${spaceId}:${day}:${revision}:${retry}`;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const raw = await getTimetable(spaceId, day, 60, controller.signal);
        const timetable = completeTimetableSchema.parse(raw);
        if (timetable.spaceId !== spaceId || timetable.date !== day) throw new Error("선택한 공간/날짜와 응답이 일치하지 않습니다.");
        if (!controller.signal.aborted) setState({ key, status: "ready", rows: dayOccupancy(timetable.reservations, day) });
      } catch (error) {
        if (!controller.signal.aborted) setState({ key, status: "error", message: error instanceof Error ? error.message : "예약 현황을 불러오지 못했습니다." });
      }
    })();
    return () => controller.abort();
  }, [spaceId, day, key]);
  const current = state?.key === key ? state : null;
  const bounds = dayBounds(day);
  const viewport = fullDay ? bounds : { start: bounds.start + 8 * 3_600_000, end: bounds.start + 22 * 3_600_000 };
  const rows = current?.status === "ready" ? current.rows : [];
  const outside = rows.filter(row => Date.parse(row.startTime) < viewport.start || Date.parse(row.endTime) > viewport.end).length;
  const segments = [
    ...rows.filter(row => overlaps(row, viewport)).map(row => ({ kind: "busy" as const, row, start: row.startTime })),
    ...freeIntervals(rows, viewport).map(interval => ({ kind: "free" as const, interval, start: interval.startTime })),
  ].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  return <section className="rsv-day-occupancy" data-day={day} data-state={current?.status ?? "loading"} aria-label={`${day} 예약 현황`}>
    <div className="rsv-calendar-toolbar">
      <div><h3>{day} 예약 현황</h3><p>서울 시간 · {fullDay ? "00:00–24:00" : "08:00–22:00"}</p></div>
      <button className="btn btn-ghost" data-action="full-day" aria-pressed={fullDay} onClick={() => setFullDay(value => !value)}>{fullDay ? "08–22시 보기" : "24시간 보기"}</button>
    </div>
    {!current ? <p role="status">예약 현황을 불러오는 중...</p> : current.status === "error" ?
      <div className="rsv-error-banner" role="alert">{current.message} <button className="btn btn-ghost" onClick={() => setRetry(value => value + 1)}>다시 시도</button></div> : <>
        <p className="rsv-occupancy-summary">전체 {rows.length}건 · 내 예약 / 예약됨 / 예약 가능{!fullDay && outside > 0 ? ` · 표시 범위 밖 예약 ${outside}건 (24시간 보기)` : ""}</p>
        {rows.length === 0 && <p>이 날짜에 예약이 없습니다.</p>}
        <ol className="rsv-intervals">
          {segments.map(segment => segment.kind === "free" ?
            <li key={`free:${segment.start}`} data-free-start={segment.interval.startTime} data-free-end={segment.interval.endTime}>
              <button className="rsv-interval rsv-interval-free" onClick={() => onSelectFree(segment.interval)}>
                <span className="rsv-interval-time">{intervalLabel(segment.interval, day)}</span><span>예약 가능 · 예약하기</span>
              </button>
            </li> :
            <li key={segment.row.id} data-reservation-id={segment.row.id} data-start={segment.row.startTime} data-end={segment.row.endTime}>
              <button className={`rsv-interval ${segment.row.isMine ? "rsv-interval-mine" : "rsv-interval-busy"}`}
                onClick={() => segment.row.isMine ? onSelectReservation(segment.row) : onSelectBusy(segment.row)}>
                <span className="rsv-interval-time">{intervalLabel(segment.row, day)}</span>
                <span>{segment.row.isMine ? `내 예약 · ${segment.row.title}` : "예약됨 · 대기 신청"}</span>
              </button>
            </li>)}
        </ol>
      </>}
  </section>;
}
