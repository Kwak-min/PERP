import { z } from 'zod';

export const createSpaceSchema = z.object({
  name: z.string().trim().min(1, '공간 이름은 필수입니다.'),
  location: z.string().trim().min(1, '위치는 필수입니다.'),
  floor: z.string().optional(),
  capacity: z.number().int().min(1, '수용인원은 1명 이상이어야 합니다.'),
  amenities: z.array(z.string()).optional(),
}).strict();

export const createTestSpacesSchema = z.object({}).strict();

export const updateSpaceSchema = z.object({
  name: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
  floor: z.string().optional(),
  capacity: z.number().int().min(1).optional(),
  amenities: z.array(z.string()).optional(),
});

export const spaceAvailabilitySchema = z.object({
  minCapacity: z.coerce.number().int().min(1).optional(),
  startTime: z.coerce.date().optional(),
  endTime: z.coerce.date().optional(),
});

export type CreateSpaceDto = z.infer<typeof createSpaceSchema>;
export type UpdateSpaceDto = z.infer<typeof updateSpaceSchema>;
