import { z } from 'zod';

const recurrenceSchema = z.object({
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  interval: z.number().int().min(1).default(1),
  daysOfWeek: z.array(z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])).optional(),
  endDate: z.coerce.date().optional(),
  maxOccurrences: z.number().int().min(1).optional(),
});

const createAttendeeInputSchema = z.object({
  name: z.string().min(1, '이름은 필수입니다.'),
  email: z.string().email('유효한 이메일을 입력해주세요.'),
  department: z.string().optional(),
});

export const createReservationSchema = z.object({
  spaceId: z.number().int().positive('공간 ID는 필수입니다.'),
  title: z.string().min(1, '제목은 필수입니다.'),
  description: z.string().optional(),
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
  recurrence: recurrenceSchema.optional(),
  attendees: z.array(createAttendeeInputSchema).optional(),
}).strict().refine((d) => d.endTime > d.startTime, {
  message: '종료 시간은 시작 시간 이후여야 합니다.',
  path: ['endTime'],
});

export const updateReservationSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  startTime: z.coerce.date().optional(),
  endTime: z.coerce.date().optional(),
}).refine((d) => {
  if (d.startTime && d.endTime) return d.endTime > d.startTime;
  return true;
}, { message: '종료 시간은 시작 시간 이후여야 합니다.', path: ['endTime'] });

export const timetableQuerySchema = z.object({
  spaceId: z.coerce.number().int().positive('공간 ID는 필수입니다.'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식으로 입력해주세요.'),
  slotMinutes: z.coerce
    .number()
    .int()
    .refine((v) => [15, 30, 60].includes(v), '슬롯 단위는 15, 30, 60 중 하나여야 합니다.')
    .default(60),
});

export const listQuerySchema = z.object({
  spaceId: z.coerce.number().int().positive().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  mine: z.enum(['true', 'false']).optional(),
});

export type CreateReservationDto = z.infer<typeof createReservationSchema>;
export type UpdateReservationDto = z.infer<typeof updateReservationSchema>;
