import { prisma } from '../../lib/prisma';
import { NotFoundError } from '../../common/errors';
import { CreateSpaceDto, UpdateSpaceDto } from './space.schema';
import type { OrganizationScope } from '../../auth/principal';
import { organizationScope } from '../../auth/principal';

export const spaceService = {
  // 전체 목록
  findAll: (principal: OrganizationScope) =>
    prisma.space.findMany({
      where: { ...organizationScope(principal), isActive: true },
      orderBy: { id: 'asc' },
    }),

  // 가용 공간 필터링 (날짜·수용인원)
  findAvailable: async (principal: OrganizationScope, minCapacity?: number, startTime?: Date, endTime?: Date) => {
    const scope = organizationScope(principal);
    const where: Record<string, unknown> = { ...scope, isActive: true };
    if (minCapacity) where.capacity = { gte: minCapacity };

    if (startTime && endTime) {
      // 해당 시간대에 CONFIRMED 예약이 없는 공간만 반환
      return prisma.space.findMany({
        where: {
          ...where,
          reservations: {
            none: {
              ...scope,
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
  findById: async (id: number, principal: OrganizationScope) => {
    const space = await prisma.space.findFirst({ where: { id, ...organizationScope(principal), isActive: true } });
    if (!space) throw new NotFoundError(`공간을 찾을 수 없습니다. id=${id}`);
    return space;
  },

  // 등록
  create: (data: CreateSpaceDto, principal: OrganizationScope) =>
    prisma.space.create({ data: { ...data, ...organizationScope(principal) } }),

  // 수정
  update: async (id: number, data: UpdateSpaceDto, principal: OrganizationScope) => {
    await spaceService.findById(id, principal);
    return prisma.space.update({ where: { id }, data });
  },

  // 삭제 (soft delete)
  delete: async (id: number, principal: OrganizationScope) => {
    await spaceService.findById(id, principal);
    return prisma.space.update({ where: { id }, data: { isActive: false } });
  },
};
