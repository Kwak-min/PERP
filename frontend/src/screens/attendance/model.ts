import { z } from "zod";

import type { CalendarEvent } from "../../components/data/MonthCalendar";

export const attendanceRowSchema = z.object({
  id: z.string(),
  member_id: z.string().catch(""),
  on_date: z.string(),
  kind: z.string(),
  hours: z.number().catch(0),
  source: z.string().catch("manual"),
  note: z.string().catch(""),
  check_in_at: z.string().nullable().catch(null),
  check_out_at: z.string().nullable().catch(null),
});

export const attendanceCorrectionSchema = z.object({
  id: z.string(),
  member_id: z.string(),
  on_date: z.string(),
  kind: z.string(),
  hours: z.number().catch(0),
  note: z.string().catch(""),
  status: z.string().catch("pending"),
  comment: z.string().catch(""),
  created_at: z.string().catch(""),
  decided_at: z.string().nullable().catch(null),
});

export const attendanceCorrectionListSchema = z.object({ items: z.array(attendanceCorrectionSchema) });

export const attendanceSchema = z.object({
  items: z.array(attendanceRowSchema),
  summary: z
    .object({
      total_days: z.number().catch(0),
      total_hours: z.number().catch(0),
      by_kind: z.record(z.string(), z.number()).catch({}),
    })
    .catch({ total_days: 0, total_hours: 0, by_kind: {} }),
});

export const balanceSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      granted_days: z.number().catch(0),
      used_days: z.number().catch(0),
      remaining_days: z.number().catch(0),
    }),
  ),
});

export const leaveCalendarSchema = z.object({
  items: z.array(
    z.object({
      leave_id: z.string(),
      member_id: z.string(),
      member_name: z.string(),
      kind: z.string(),
      start_on: z.string(),
      end_on: z.string(),
      status: z.string(),
    }),
  ),
});

export type AttendanceRow = z.infer<typeof attendanceRowSchema>;
export type AttendanceCorrection = z.infer<typeof attendanceCorrectionSchema>;
export type LeaveCalendarItem = z.infer<typeof leaveCalendarSchema>["items"][number];

export const KIND_LABELS: Readonly<Record<string, string>> = {
  present: "출근",
  late: "지각",
  absent: "결근",
  remote: "원격",
  leave: "휴가",
};

export const LEAVE_KIND_LABELS: Readonly<Record<string, string>> = {
  annual: "연차",
  sick: "병가",
  special: "경조사",
  unpaid: "무급",
};

export function isoDay(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function monthRange(year: number, month: number): Readonly<{ from: string; to: string }> {
  const last = new Date(year, month + 1, 0).getDate();
  return { from: isoDay(year, month, 1), to: isoDay(year, month, last) };
}

/** 휴가 기간을 달력 셀 단위 이벤트로 펼친다. */
export function leaveEventsOf(
  items: readonly LeaveCalendarItem[],
  year: number,
  month: number,
): readonly CalendarEvent[] {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const events: CalendarEvent[] = [];
  for (const item of items) {
    const start = new Date(`${item.start_on}T00:00:00`);
    const end = new Date(`${item.end_on}T00:00:00`);
    for (let day = 1; day <= daysInMonth; day += 1) {
      const current = new Date(year, month, day);
      if (current < start || current > end) continue;
      events.push({
        day,
        title: `${item.member_name} · ${LEAVE_KIND_LABELS[item.kind] ?? item.kind}${item.status === "pending" ? " (대기)" : ""}`,
        tone: item.status === "approved" ? "success" : "warning",
      });
    }
  }
  return events;
}
