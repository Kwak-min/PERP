import { z } from 'zod';

export const addWaitlistSchema = z.object({
  spaceId: z.number().int().positive('공간 ID는 필수입니다.'),
  userId: z.number().int().positive('사용자 ID는 필수입니다.'),
  title: z.string().min(1, '제목은 필수입니다.'),
  description: z.string().optional(),
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
}).refine((d) => d.endTime > d.startTime, {
  message: '종료 시간은 시작 시간 이후여야 합니다.',
  path: ['endTime'],
});

export const waitlistQuerySchema = z.object({
  userId: z.coerce.number().int().positive().optional(),
  spaceId: z.coerce.number().int().positive().optional(),
});

export type AddWaitlistDto = z.infer<typeof addWaitlistSchema>;
