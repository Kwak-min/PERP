import { z } from 'zod';

const businessDateSchema = z.string().date();
const instantSchema = z.string().datetime({ offset: true })
  .regex(/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/)
  .transform(value => new Date(value));
// 날짜 필터/반복 종료일은 서울 업무 날짜, 예약 시각은 반드시 offset/Z instant다.
const dateBoundarySchema = z.union([
  businessDateSchema.transform(value => new Date(`${value}T00:00:00+09:00`)),
  instantSchema,
]);
export const cancelQuerySchema = z.object({
  cancelScope: z.enum(['THIS', 'THIS_AND_FOLLOWING', 'ALL']).default('THIS'),
});

const recurrenceSchema = z.object({
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  interval: z.number().int().positive().safe().default(1),
  daysOfWeek: z.array(z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])).optional(),
  endDate: dateBoundarySchema.optional(),
  maxOccurrences: z.number().int().min(1).max(366).optional(),
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
  startTime: instantSchema,
  endTime: instantSchema,
  recurrence: recurrenceSchema.optional(),
  attendees: z.array(createAttendeeInputSchema).optional(),
}).strict().refine((d) => d.endTime > d.startTime, {
  message: '종료 시간은 시작 시간 이후여야 합니다.',
  path: ['endTime'],
});

export const updateReservationSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  startTime: instantSchema.optional(),
  endTime: instantSchema.optional(),
}).strict().refine((d) => {
  if (d.startTime && d.endTime) return d.endTime > d.startTime;
  return true;
}, { message: '종료 시간은 시작 시간 이후여야 합니다.', path: ['endTime'] });

export const timetableQuerySchema = z.object({
  spaceId: z.coerce.number().int().positive('공간 ID는 필수입니다.'),
  date: businessDateSchema,
  slotMinutes: z.coerce
    .number()
    .int()
    .refine((v) => [15, 30, 60].includes(v), '슬롯 단위는 15, 30, 60 중 하나여야 합니다.')
    .default(60),
});

export const listQuerySchema = z.object({
  spaceId: z.coerce.number().int().positive().optional(),
  from: dateBoundarySchema.optional(),
  to: dateBoundarySchema.optional(),
  mine: z.enum(['true', 'false']).optional(),
  status: z.enum(['CONFIRMED', 'CANCELLED', 'ALL']).default('CONFIRMED'),
}).refine(d => !d.from || !d.to || d.from < d.to, {
  message: '조회 종료는 시작 이후여야 합니다.', path: ['to'],
});

export type ListReservationQuery = z.infer<typeof listQuerySchema>;

export type CreateReservationDto = z.infer<typeof createReservationSchema>;
export type UpdateReservationDto = z.infer<typeof updateReservationSchema>;
