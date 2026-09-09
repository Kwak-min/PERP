import { useEffect, useState } from "react";
import type { ReservationStatus } from "./model";

type Interval = Readonly<{ startTime: string; endTime: string; status: ReservationStatus }>;
export function isCurrentlyBusy(row: Interval, now: number): boolean {
  return row.status === "CONFIRMED" && Date.parse(row.startTime) <= now && now < Date.parse(row.endTime);
}

// Schedule the next actual state transition; no periodic data polling.
export function useOccupancyNow(rows: readonly Interval[]): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const instant = Date.now();
      setNow(instant);
      const next = Math.min(...rows.filter(row => row.status === "CONFIRMED").flatMap(row => [Date.parse(row.startTime), Date.parse(row.endTime)]).filter(time => time > instant));
      if (Number.isFinite(next)) timer = setTimeout(update, Math.min(next - instant, 2_147_483_647));
    };
    update();
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => { clearTimeout(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, [rows]);
  return now;
}
