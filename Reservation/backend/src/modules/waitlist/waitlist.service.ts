import { prisma } from '../../lib/prisma';
import { NotFoundError, BadRequestError } from '../../common/errors';
import type { Principal } from '../../auth/principal';
import type { AddWaitlistDto } from './waitlist.schema';

export const waitlistService = {
  add: async (dto: AddWaitlistDto, principal: Principal) => {
    const scope = { tenantId: principal.tenantId, orgId: principal.orgId };
    const space = await prisma.space.findFirst({ where: { id: dto.spaceId, ...scope, isActive: true } });
    if (!space) throw new NotFoundError('공간을 찾을 수 없습니다.');

    const conflict = await prisma.reservation.findFirst({
      where: { ...scope, spaceId: dto.spaceId, status: 'CONFIRMED', startTime: { lt: dto.endTime }, endTime: { gt: dto.startTime } },
    });
    if (!conflict) throw new BadRequestError('해당 시간대에 예약이 없습니다. 바로 예약을 생성해주세요.');

    const duplicate = await prisma.waitlist.findFirst({
      where: { ...scope, ownerId: principal.userId, spaceId: dto.spaceId, startTime: dto.startTime, endTime: dto.endTime },
    });
    if (duplicate) throw new BadRequestError('이미 해당 시간대에 대기 신청이 되어 있습니다.');

    const entry = await prisma.waitlist.create({
      data: { ...dto, ...scope, ownerId: principal.userId }, include: { space: true },
    });
    const position = await prisma.waitlist.count({
      where: { ...scope, spaceId: dto.spaceId, startTime: dto.startTime, endTime: dto.endTime, createdAt: { lte: entry.createdAt } },
    });
    return { ...entry, position };
  },

  findByUser: (principal: Principal) => prisma.waitlist.findMany({
    where: { tenantId: principal.tenantId, orgId: principal.orgId, ownerId: principal.userId },
    include: { space: true }, orderBy: { createdAt: 'asc' },
  }),

  cancel: async (id: number, principal: Principal) => {
    const entry = await prisma.waitlist.findFirst({
      where: { id, tenantId: principal.tenantId, orgId: principal.orgId, ownerId: principal.userId },
    });
    if (!entry) throw new NotFoundError('대기 항목을 찾을 수 없습니다.');
    return prisma.waitlist.delete({ where: { id } });
  },

  promote: async (spaceId: number, startTime: Date, endTime: Date, principal: Principal) => {
    const scope = { tenantId: principal.tenantId, orgId: principal.orgId };
    const candidate = await prisma.waitlist.findFirst({
      where: { ...scope, spaceId, startTime: { lt: endTime }, endTime: { gt: startTime } },
      orderBy: { createdAt: 'asc' }, include: { space: true },
    });
    if (!candidate?.ownerId) return null;
    const [, promoted] = await prisma.$transaction([
      prisma.waitlist.delete({ where: { id: candidate.id } }),
      prisma.reservation.create({
        data: { ...scope, ownerId: candidate.ownerId, spaceId: candidate.spaceId, title: candidate.title, description: candidate.description, startTime: candidate.startTime, endTime: candidate.endTime },
        include: { space: true },
      }),
    ]);
    return promoted;
  },
};
