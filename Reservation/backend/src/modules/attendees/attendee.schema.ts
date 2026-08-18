import { z } from 'zod';

export const addAttendeeSchema = z.object({
  name: z.string().min(1, '이름은 필수입니다.'),
  email: z.string().email('올바른 이메일 형식이 아닙니다.'),
  department: z.string().optional(),
});

export const respondSchema = z.object({
  accept: z.coerce.boolean(),
});

export type AddAttendeeDto = z.infer<typeof addAttendeeSchema>;
