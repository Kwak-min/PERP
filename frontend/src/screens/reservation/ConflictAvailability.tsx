import { useEffect, useRef, useState } from "react";
import { getTimetable } from "../../services/reservationApi";
import { completeTimetableSchema, intervalLabel, type Occupancy } from "./occupancy";

type Props = Readonly<{ spaceId: number; day: string; onRefresh: () => void }>;
export function ConflictAvailability({ spaceId, day, onRefresh }: Props) {
  const request = useRef<AbortController | null>(null);
  const [rows, setRows] = useState<readonly Occupancy[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const refresh = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    try {
      const data = completeTimetableSchema.parse(await getTimetable(spaceId, day, 60, controller.signal));
      if (!controller.signal.aborted) { setRows(data.reservations); onRefresh(); }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "현황을 불러오지 못했습니다.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <div className="rsv-conflict-availability">
    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void refresh()}>{busy ? "불러오는 중..." : "예약 현황 새로고침"}</button>
    {error && <p role="alert">{error}</p>}
    {rows && <div role="status" data-refreshed-day={day}>
      <p>{day} 점유 현황 · 서울 시간 · {rows.length}건</p>
      <ul>{rows.map(row => <li key={row.id} data-busy-start={row.startTime} data-busy-end={row.endTime}>{intervalLabel(row, day)}</li>)}</ul>
    </div>}
  </div>;
}
