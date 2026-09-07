import { z } from "zod";
import type { CalendarEvent } from "./MonthCalendar";

// 일정은 절대 시각으로 받아 브라우저 시간대의 날짜에 배치한다. 종료 시각은 미포함이다.
const instant = z.iso.datetime({ offset: true });
const id = z.union([z.string().min(1), z.number().int()]).transform(String);
export const calendarRecordSchema = z.object({
  id: z.string().min(1), title: z.string(), start_at: instant, end_at: instant, location: z.string().nullable(),
}).refine(event => Date.parse(event.end_at) >= Date.parse(event.start_at), "일정 기간이 올바르지 않습니다");
export type CalendarRecord = Readonly<z.infer<typeof calendarRecordSchema>>;
const pgRecordSchema = z.object({ __id: id, 일정: z.string(), 시작: instant, 종료: instant, 장소: z.string().nullable() })
  .transform(event => ({ id: event.__id, title: event.일정, start_at: event.시작, end_at: event.종료, location: event.장소 }))
  .pipe(calendarRecordSchema);

export function parseCalendarRecords(payload: unknown, pg: boolean): readonly CalendarRecord[] {
  return z.object({ items: z.array(pg ? pgRecordSchema : calendarRecordSchema) }).parse(payload).items;
}

export function monthWindow(shown: Date): Readonly<{ from: string; to: string }> {
  return { from: new Date(shown.getFullYear(), shown.getMonth(), 1).toISOString(), to: new Date(shown.getFullYear(), shown.getMonth() + 1, 1).toISOString() };
}

export function calendarCells(records: readonly CalendarRecord[], shown: Date): readonly CalendarEvent[] {
  const cells: CalendarEvent[] = [];
  const year = shown.getFullYear(), month = shown.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  for (const event of [...records].sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at) || a.id.localeCompare(b.id))) {
    const start = new Date(event.start_at), end = new Date(event.end_at);
    for (let day = 1; day <= days; day += 1) {
      const dayStart = new Date(year, month, day), dayEnd = new Date(year, month, day + 1);
      if (start >= dayEnd || (end <= dayStart && !(start.getTime() === end.getTime() && start >= dayStart))) continue;
      cells.push({ id: event.id, day, title: event.title, href: `/calendar/${encodeURIComponent(event.id)}`,
        time: start >= dayStart ? start.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }) : "계속" });
    }
  }
  return cells;
}

export const calendarInputSchema = z.object({
  title: z.string().trim().min(1, "제목을 입력해 주세요").max(200),
  start: z.string().min(1).transform(value => new Date(value)).refine(value => Number.isFinite(value.getTime()), "시작 일시를 확인해 주세요"),
  end: z.string().min(1).transform(value => new Date(value)).refine(value => Number.isFinite(value.getTime()), "종료 일시를 확인해 주세요"),
  location: z.string().trim(),
}).refine(value => value.end > value.start, "종료는 시작보다 늦어야 합니다");

export function localDateInput(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
