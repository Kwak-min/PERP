import { z } from "zod";

// ── Space ─────────────────────────────────────────────────────────────────
export const spaceSchema = z.object({
  id: z.number(),
  name: z.string(),
  location: z.string(),
  floor: z.string().nullable(),
  capacity: z.number(),
  amenities: z.array(z.string()).nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Space = z.infer<typeof spaceSchema>;

// ── Attendee ───────────────────────────────────────────────────────────────
export const attendeeStatusSchema = z.enum(["INVITED", "ACCEPTED", "DECLINED"]);
export type AttendeeStatus = z.infer<typeof attendeeStatusSchema>;

export const attendeeSchema = z.object({
  id: z.number(),
  reservationId: z.number(),
  name: z.string(),
  email: z.string(),
  department: z.string().nullable(),
  status: attendeeStatusSchema,
  inviteToken: z.string(),
  createdAt: z.string(),
});
export type Attendee = z.infer<typeof attendeeSchema>;

// ── Reservation ────────────────────────────────────────────────────────────
export const reservationStatusSchema = z.enum(["CONFIRMED", "CANCELLED"]);
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;

export const recurrenceFrequencySchema = z.enum(["DAILY", "WEEKLY", "MONTHLY"]);
export const dayOfWeekSchema = z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);

export const recurrenceRuleSchema = z.object({
  id: z.number(),
  frequency: recurrenceFrequencySchema,
  interval: z.number(),
  daysOfWeek: z.array(dayOfWeekSchema).nullable(),
  endDate: z.string().nullable(),
  maxOccurrences: z.number().nullable(),
});
export type RecurrenceRule = z.infer<typeof recurrenceRuleSchema>;

export const reservationSchema = z.object({
  id: z.number(),
  spaceId: z.number(),
  userId: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  startTime: z.string(),
  endTime: z.string(),
  status: reservationStatusSchema,
  recurrenceRuleId: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  space: spaceSchema.optional(),
  recurrenceRule: recurrenceRuleSchema.nullable().optional(),
  attendees: z.array(attendeeSchema).optional(),
});
export type Reservation = z.infer<typeof reservationSchema>;

// ── Timetable ──────────────────────────────────────────────────────────────
export const timetableSlotSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
  available: z.boolean(),
  reservation: reservationSchema.nullable(),
});
export type TimetableSlot = z.infer<typeof timetableSlotSchema>;

export const timetableSchema = z.object({
  spaceId: z.number(),
  date: z.string(),
  slots: z.array(timetableSlotSchema),
});
export type Timetable = z.infer<typeof timetableSchema>;

// ── Waitlist ───────────────────────────────────────────────────────────────
export const waitlistSchema = z.object({
  id: z.number(),
  spaceId: z.number(),
  userId: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  startTime: z.string(),
  endTime: z.string(),
  createdAt: z.string(),
  position: z.number().optional(),
  space: spaceSchema.optional(),
});
export type Waitlist = z.infer<typeof waitlistSchema>;

// ── Create/Update DTOs ─────────────────────────────────────────────────────
export const recurrenceInputSchema = z.object({
  frequency: recurrenceFrequencySchema,
  interval: z.number().int().min(1).default(1),
  daysOfWeek: z.array(dayOfWeekSchema).optional(),
  endDate: z.string().optional(),
  maxOccurrences: z.number().int().min(1).optional(),
});
export type RecurrenceInput = z.infer<typeof recurrenceInputSchema>;

export const createAttendeeItemSchema = z.object({
  name: z.string().min(1, "이름은 필수입니다."),
  email: z.string().email("유효한 이메일을 입력해주세요."),
  department: z.string().optional(),
});
export type CreateAttendeeItem = z.infer<typeof createAttendeeItemSchema>;

export const createReservationInputSchema = z.object({
  spaceId: z.number(),
  title: z.string().min(1, "제목은 필수입니다."),
  description: z.string().optional(),
  startTime: z.string(),
  endTime: z.string(),
  recurrence: recurrenceInputSchema.optional(),
  attendees: z.array(createAttendeeItemSchema).optional(),
});
export type CreateReservationInput = z.infer<typeof createReservationInputSchema>;

export const updateReservationInputSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
});
export type UpdateReservationInput = z.infer<typeof updateReservationInputSchema>;

export const cancelScopeSchema = z.enum(["THIS", "THIS_AND_FOLLOWING", "ALL"]);
export type CancelScope = z.infer<typeof cancelScopeSchema>;

export const createSpaceInputSchema = z.object({
  name: z.string().min(1, "이름은 필수입니다."),
  location: z.string().min(1, "위치는 필수입니다."),
  floor: z.string().optional(),
  capacity: z.number().int().min(1, "수용인원은 1명 이상이어야 합니다."),
  amenities: z.array(z.string()).optional(),
});
export type CreateSpaceInput = z.infer<typeof createSpaceInputSchema>;

export const addAttendeeInputSchema = z.object({
  name: z.string().min(1, "이름은 필수입니다."),
  email: z.string().email("유효한 이메일을 입력해주세요."),
  department: z.string().optional(),
});
export type AddAttendeeInput = z.infer<typeof addAttendeeInputSchema>;

export const addWaitlistInputSchema = z.object({
  spaceId: z.number(),
  title: z.string().min(1, "제목은 필수입니다."),
  description: z.string().optional(),
  startTime: z.string(),
  endTime: z.string(),
});
export type AddWaitlistInput = z.infer<typeof addWaitlistInputSchema>;

// ── 공통 유틸 ──────────────────────────────────────────────────────────────
export function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

export function formatDateRange(start: string, end: string): string {
  return `${formatDate(start)} ${formatTime(start)} – ${formatTime(end)}`;
}

export const STATUS_LABEL: Record<ReservationStatus, string> = {
  CONFIRMED: "확정",
  CANCELLED: "취소됨",
};

export const ATTENDEE_STATUS_LABEL: Record<AttendeeStatus, string> = {
  INVITED: "초대됨",
  ACCEPTED: "수락",
  DECLINED: "거절",
};

export const FREQUENCY_LABEL: Record<string, string> = {
  DAILY: "매일",
  WEEKLY: "매주",
  MONTHLY: "매월",
};

export function formatRecurrenceRule(rule?: RecurrenceRule | null): string {
  if (!rule) return "";
  const freq = FREQUENCY_LABEL[rule.frequency] ?? rule.frequency;
  const intervalStr = rule.interval > 1 ? `${rule.interval}회 주기` : "";
  const endDateStr = rule.endDate ? `, ${formatDate(rule.endDate)}까지` : "";
  return `${freq}${intervalStr ? ` (${intervalStr})` : ""}${endDateStr}`;
}
