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

  // 명시적 관리자 동작만 생성한다. 같은 회사의 동시 실행은 DB 트랜잭션 잠금으로 직렬화한다.
  createTestSpaces: (principal: OrganizationScope) => prisma.$transaction(async tx => {
    const scope = organizationScope(principal);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${scope.tenantId}), hashtext(${scope.orgId}))`;
    const names = Array.from({ length: 5 }, (_, index) => `테스트 공간 ${index + 1}`);
    // 비활성 동명 공간도 보존한다. 삭제한 공간을 복구하거나 중복 생성하지 않는다.
    const existing = await tx.space.findMany({ where: { ...scope, name: { in: names } }, orderBy: { id: 'asc' } });
    const spaces = [];
    let createdCount = 0;
    for (const name of names) {
      const found = existing.find(space => space.name === name);
      if (found) spaces.push(found);
      else {
        spaces.push(await tx.space.create({ data: { ...scope, name, location: '테스트용', capacity: 1 } }));
        createdCount++;
      }
    }
    return { spaces, createdCount };
  }),

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
