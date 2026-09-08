import { z } from "zod";
import { reservationSchema } from "./model";

const intervalSchema = z.object({
  id: z.number(), spaceId: z.number(),
  startTime: z.string().datetime({ offset: true }),
  endTime: z.string().datetime({ offset: true }),
  status: z.enum(["CONFIRMED", "CANCELLED"]),
});
// 타인 예약에는 상세 필드를 요구하지 않고, 응답에 있어도 버린다.
export const occupancySchema = z.discriminatedUnion("isMine", [
  reservationSchema.extend({ ...intervalSchema.shape, isMine: z.literal(true) }),
  intervalSchema.extend({ isMine: z.literal(false) }),
]);
export type Occupancy = z.infer<typeof occupancySchema>;
export const occupancyListSchema = z.array(occupancySchema);
export const completeTimetableSchema = z.object({
  spaceId: z.number(), date: z.string(), reservations: occupancyListSchema,
});
export type FreeInterval = Readonly<{ startTime: string; endTime: string }>;

const DAY_MS = 86_400_000;
export function seoulDay(instant = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}
export function shiftDay(day: string, amount: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + amount * DAY_MS).toISOString().slice(0, 10);
}
export function shiftMonth(month: string, amount: number): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 7);
}
export function dayBounds(day: string) {
  const start = Date.parse(`${day}T00:00:00+09:00`);
  return { start, end: start + DAY_MS };
}
export function overlaps(row: FreeInterval, bounds: Readonly<{ start: number; end: number }>): boolean {
  return Date.parse(row.startTime) < bounds.end && Date.parse(row.endTime) > bounds.start;
}
export function dayOccupancy(rows: readonly Occupancy[], day: string): Occupancy[] {
  return rows.filter(row => row.status === "CONFIRMED" && overlaps(row, dayBounds(day)))
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || a.id - b.id);
}
export function freeIntervals(rows: readonly Occupancy[], bounds: Readonly<{ start: number; end: number }>): FreeInterval[] {
  const gaps: FreeInterval[] = [];
  let cursor = bounds.start;
  const sorted = rows.filter(row => row.status === "CONFIRMED" && overlaps(row, bounds))
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  for (const row of sorted) {
    const start = Math.max(bounds.start, Date.parse(row.startTime));
    if (start > cursor) gaps.push({ startTime: new Date(cursor).toISOString(), endTime: new Date(start).toISOString() });
    cursor = Math.max(cursor, Math.min(bounds.end, Date.parse(row.endTime)));
  }
  if (cursor < bounds.end) gaps.push({ startTime: new Date(cursor).toISOString(), endTime: new Date(bounds.end).toISOString() });
  return gaps;
}
export function intervalLabel(interval: FreeInterval, day: string): string {
  const format = (instant: string) => {
    const date = new Date(instant);
    const localDay = seoulDay(date);
    const time = new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      ...(date.getUTCSeconds() || date.getUTCMilliseconds() ? { second: "2-digit" } : {}),
      ...(date.getUTCMilliseconds() ? { fractionalSecondDigits: 3 } : {}),
    }).format(date);
    return `${localDay === day ? "" : `${localDay.slice(5)} `}${time}`;
  };
  return `${format(interval.startTime)} – ${format(interval.endTime)}`;
}
