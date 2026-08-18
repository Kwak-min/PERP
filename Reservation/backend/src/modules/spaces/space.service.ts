import { prisma } from '../../lib/prisma';
import { NotFoundError } from '../../common/errors';
import { CreateSpaceDto, UpdateSpaceDto } from './space.schema';

export const spaceService = {
  // 전체 목록
  findAll: () =>
    prisma.space.findMany({
      where: { isActive: true },
      orderBy: { id: 'asc' },
    }),

  // 가용 공간 필터링 (날짜·수용인원)
  findAvailable: async (minCapacity?: number, startTime?: Date, endTime?: Date) => {
    const where: Record<string, unknown> = { isActive: true };
    if (minCapacity) where.capacity = { gte: minCapacity };

    if (startTime && endTime) {
      // 해당 시간대에 CONFIRMED 예약이 없는 공간만 반환
      return prisma.space.findMany({
        where: {
          ...where,
          reservations: {
            none: {
              status: 'CONFIRMED',
              startTime: { lt: endTime },
              endTime: { gt: startTime },
            },
          },
        },
        orderBy: { id: 'asc' },
      });
    }

    return prisma.space.findMany({ where, orderBy: { id: 'asc' } });
  },

  // 단건 조회
  findById: async (id: number) => {
    const space = await prisma.space.findFirst({ where: { id, isActive: true } });
    if (!space) throw new NotFoundError(`공간을 찾을 수 없습니다. id=${id}`);
    return space;
  },

  // 등록
  create: (data: CreateSpaceDto) =>
    prisma.space.create({ data }),

  // 수정
  update: async (id: number, data: UpdateSpaceDto) => {
    await spaceService.findById(id); // 존재 확인
    return prisma.space.update({ where: { id }, data });
  },

  // 삭제 (soft delete)
  delete: async (id: number) => {
    await spaceService.findById(id); // 존재 확인
    return prisma.space.update({ where: { id }, data: { isActive: false } });
  },
};
