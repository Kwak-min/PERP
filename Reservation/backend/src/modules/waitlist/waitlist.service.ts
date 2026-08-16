import { prisma } from '../../lib/prisma';
import { NotFoundError, BadRequestError, ForbiddenError } from '../../common/errors';
import { AddWaitlistDto } from './waitlist.schema';
import { emailService } from '../../notification/email.service';

export const waitlistService = {
  // ── 대기 등록 ──────────────────────────────────────────────────────────────
  add: async (dto: AddWaitlistDto) => {
    const space = await prisma.space.findFirst({ where: { id: dto.spaceId, isActive: true } });
    if (!space) throw new NotFoundError('공간을 찾을 수 없습니다.');

    // 해당 시간대에 실제로 예약이 있어야 대기 등록 가능
    const conflict = await prisma.reservation.findFirst({
      where: {
        spaceId: dto.spaceId,
        status: 'CONFIRMED',
        startTime: { lt: dto.endTime },
        endTime: { gt: dto.startTime },
      },
    });
    if (!conflict) {
      throw new BadRequestError('해당 시간대에 예약이 없습니다. 바로 예약을 생성해주세요.');
    }

    // 이미 같은 사용자가 같은 시간대 대기 중인지 확인
    const duplicate = await prisma.waitlist.findFirst({
      where: {
        userId: dto.userId,
        spaceId: dto.spaceId,
        startTime: dto.startTime,
        endTime: dto.endTime,
      },
    });
    if (duplicate) throw new BadRequestError('이미 해당 시간대에 대기 신청이 되어 있습니다.');

    const entry = await prisma.waitlist.create({
      data: dto,
      include: { space: true },
    });

    // 대기 순번 계산 (같은 공간+시간대에서 몇 번째인지)
    const position = await prisma.waitlist.count({
      where: {
        spaceId: dto.spaceId,
        startTime: dto.startTime,
        endTime: dto.endTime,
        createdAt: { lte: entry.createdAt },
      },
    });

    emailService.sendWaitlistConfirmed(entry, position).catch(console.error);
    return { ...entry, position };
  },

  // ── 내 대기 목록 조회 ────────────────────────────────────────────────────
  findByUser: (userId: number) =>
    prisma.waitlist.findMany({
      where: { userId },
      include: { space: true },
      orderBy: { createdAt: 'asc' },
    }),

  // ── 대기 취소 ──────────────────────────────────────────────────────────────
  cancel: async (id: number, userId: number) => {
    const entry = await prisma.waitlist.findUnique({ where: { id } });
    if (!entry) throw new NotFoundError('대기 항목을 찾을 수 없습니다.');
    if (entry.userId !== userId) throw new ForbiddenError('본인의 대기만 취소할 수 있습니다.');
    return prisma.waitlist.delete({ where: { id } });
  },

  // ── 자동 승격 (예약 취소 시 호출) ───────────────────────────────────────
  promote: async (spaceId: number, startTime: Date, endTime: Date) => {
    // 해당 시간대에 겹치는 대기 항목 중 가장 오래된 것 조회
    const candidate = await prisma.waitlist.findFirst({
      where: {
        spaceId,
        startTime: { lt: endTime },
        endTime: { gt: startTime },
      },
      orderBy: { createdAt: 'asc' },
      include: { space: true },
    });

    if (!candidate) return null; // 대기자 없음

    // 트랜잭션: Waitlist 삭제 + Reservation 생성 원자적 처리
    const [, promoted] = await prisma.$transaction([
      prisma.waitlist.delete({ where: { id: candidate.id } }),
      prisma.reservation.create({
        data: {
          spaceId: candidate.spaceId,
          userId: candidate.userId,
          title: candidate.title,
          description: candidate.description,
          startTime: candidate.startTime,
          endTime: candidate.endTime,
        },
        include: { space: true },
      }),
    ]);

    emailService.sendWaitlistPromoted(promoted, candidate).catch(console.error);
    console.log(`[Waitlist] userId=${candidate.userId} 승격 완료 → reservationId=${promoted.id}`);
    return promoted;
  },
};
