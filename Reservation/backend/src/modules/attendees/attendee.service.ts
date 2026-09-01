import { prisma } from '../../lib/prisma';
import { NotFoundError, BadRequestError } from '../../common/errors';
import { AddAttendeeDto } from './attendee.schema';
import { emailService } from '../../notification/email.service';

export const attendeeService = {
  // 참석자 목록 조회
  findByReservation: (reservationId: number) =>
    prisma.attendee.findMany({
      where: { reservationId },
      orderBy: { createdAt: 'asc' },
    }),

  // 참석자 추가 + 초대 이메일 발송
  add: async (reservationId: number, dto: AddAttendeeDto) => {
    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { space: true },
    });
    if (!reservation) throw new NotFoundError(`예약을 찾을 수 없습니다. id=${reservationId}`);
    if (reservation.status === 'CANCELLED') throw new BadRequestError('취소된 예약에는 참석자를 추가할 수 없습니다.');

    const attendee = await prisma.attendee.create({
      data: { reservationId, ...dto },
      include: { reservation: { include: { space: true } } },
    });

    emailService.sendAttendeeInvite(attendee).catch(console.error);
    return attendee;
  },

  // 참석자 제거
  remove: async (reservationId: number, attendeeId: number) => {
    const attendee = await prisma.attendee.findUnique({ where: { id: attendeeId } });
    if (!attendee) throw new NotFoundError('참석자를 찾을 수 없습니다.');
    if (attendee.reservationId !== reservationId) throw new BadRequestError('해당 예약의 참석자가 아닙니다.');
    return prisma.attendee.delete({ where: { id: attendeeId } });
  },

  // 초대 수락/거절 (토큰 기반)
  respond: async (token: string, accept: boolean) => {
    const attendee = await prisma.attendee.findUnique({
      where: { inviteToken: token },
      include: { reservation: { include: { space: true } } },
    });
    if (!attendee) throw new NotFoundError('유효하지 않은 초대 링크입니다.');

    const updated = await prisma.attendee.update({
      where: { id: attendee.id },
      data: { status: accept ? 'ACCEPTED' : 'DECLINED' },
      include: { reservation: { include: { space: true } } },
    });

    emailService.sendAttendeeResponse(updated).catch(console.error);
    return updated;
  },
};
