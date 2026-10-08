import { prisma } from '../../lib/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../common/errors';
import type { Reservation } from '@prisma/client';
import type { Principal } from '../../auth/principal';
import type { CreateReservationDto, UpdateReservationDto, ListReservationQuery } from './reservation.schema';
import { emailService } from '../../notification/email.service';
import { addDays, startOfBusinessDay } from './reservation.utils';
import { checkConflict, createRecurring } from './reservation.booking';
import { waitlistService } from '../waitlist/waitlist.service';

export const reservationService = {
  // ── 목록 조회 ─────────────────────────────────────────────────────────────
  findMany: async (principal: Principal, query: ListReservationQuery) => {
    const { spaceId, from, to, mine, status } = query;
    const fromDate = from ?? (status === 'CONFIRMED' && !to ? startOfBusinessDay(new Date()) : undefined);
    const toDate = to ?? (fromDate ? addDays(fromDate, 30) : undefined);

    const rows = await prisma.reservation.findMany({
      where: {
        tenantId: principal.tenantId,
        orgId: principal.orgId,
        ...(status !== 'ALL' && { status }),
        ...(spaceId && { spaceId }),
        ...(mine === 'true' && { ownerId: principal.userId }),
        ...(toDate && { startTime: { lt: toDate } }),
        ...(fromDate && { endTime: { gt: fromDate } }),
      },
      include: { space: true },
      orderBy: { startTime: 'asc' },
    });
    return rows.map(row => readableReservation(row, principal));
  },

  // ── 단건 조회 ─────────────────────────────────────────────────────────────
  findById: async (id: number, principal: Principal) => {
    const r = await prisma.reservation.findFirst({
      where: { id, tenantId: principal.tenantId, orgId: principal.orgId },
      include: { space: true, recurrenceRule: true },
    });
    if (!r) throw new NotFoundError(`예약을 찾을 수 없습니다. id=${id}`);
    return r;
  },

  // ── 타임테이블 조회 (n분 단위 슬롯) ───────────────────────────────────
  getTimetable: async (principal: Principal, spaceId: number, date: string, slotMinutes: number = 60) => {
    const dayStart = new Date(`${date}T00:00:00+09:00`);
    const dayEnd = addDays(dayStart, 1);

    const reservations = await prisma.reservation.findMany({
      where: {
        tenantId: principal.tenantId,
        orgId: principal.orgId,
        spaceId,
        status: 'CONFIRMED',
        startTime: { lt: dayEnd },
        endTime: { gt: dayStart },
      },
      orderBy: { startTime: 'asc' },
    });

    const slots = [];
    const slotMs = slotMinutes * 60 * 1000;
    let cursor = new Date(dayStart);

    while (cursor < dayEnd) {
      const slotEnd = new Date(cursor.getTime() + slotMs);
      const matched = reservations.find(
        (r: { startTime: Date; endTime: Date; id: number; title: string }) =>
          r.startTime < slotEnd && r.endTime > cursor,
      );

      slots.push(
        matched
          ? { startTime: cursor.toISOString(), endTime: slotEnd.toISOString(), available: false, isMine: matched.ownerId === principal.userId, reservation: readableReservation(matched, principal) }
          : { startTime: cursor.toISOString(), endTime: slotEnd.toISOString(), available: true, isMine: false, reservation: null },
      );
      cursor = slotEnd;
    }
    return { spaceId, date, slots, reservations: reservations.map(row => readableReservation(row, principal)) };
  },

  // ── 예약 생성 (단일 / 반복) ───────────────────────────────────────────────
  create: async (dto: CreateReservationDto, principal: Principal) => {
    const scope = { tenantId: principal.tenantId, orgId: principal.orgId };
    const space = await prisma.space.findFirst({ where: { id: dto.spaceId, ...scope, isActive: true } });
    if (!space) throw new NotFoundError('공간을 찾을 수 없습니다.');

    if (!dto.recurrence) {
      // 단일 예약
      await checkConflict(principal, dto);
      const reservation = await prisma.reservation.create({
        data: {
          ...scope, ownerId: principal.userId, spaceId: dto.spaceId,
          title: dto.title, description: dto.description,
          startTime: dto.startTime, endTime: dto.endTime,
          attendees: dto.attendees?.length ? { create: dto.attendees } : undefined,
        },
        include: { space: true, attendees: true },
      });
      // Prisma nested write가 예약/참석자를 함께 commit한 뒤에만 초대를 발송한다.
      if (dto.attendees?.length) {
        for (const attendee of reservation.attendees) {
          emailService.sendAttendeeInvite({ ...attendee, reservation }).catch(console.error);
        }
      }
      const { attendees: _attendees, ...view } = reservation;
      return [view];
    }

    // 반복 예약
    return createRecurring(dto, principal, dto.recurrence);
  },

  // ── 수정 ──────────────────────────────────────────────────────────────────
  update: async (id: number, principal: Principal, dto: UpdateReservationDto) => {
    const reservation = await reservationService.findById(id, principal);
    if (reservation.ownerId !== principal.userId) throw new ForbiddenError('본인의 예약만 수정할 수 있습니다.');

    const newStart = dto.startTime ?? reservation.startTime;
    const newEnd = dto.endTime ?? reservation.endTime;
    if (newStart >= newEnd) throw new BadRequestError('종료 시간은 시작 시간 이후여야 합니다.');
    if (dto.startTime || dto.endTime) {
      await checkConflict(principal, { spaceId: reservation.spaceId, startTime: newStart, endTime: newEnd, excludeId: id });
    }

    return prisma.reservation.update({
      where: { id },
      data: { title: dto.title, description: dto.description, startTime: newStart, endTime: newEnd },
      include: { space: true },
    });
  },

  // ── 취소 ──────────────────────────────────────────────────────────────────
  cancel: async (id: number, principal: Principal, cancelScope: 'THIS' | 'THIS_AND_FOLLOWING' | 'ALL' = 'THIS') => {
    const reservation = await reservationService.findById(id, principal);
    if (reservation.ownerId !== principal.userId) throw new ForbiddenError('본인의 예약만 취소할 수 있습니다.');

    // 단건 취소 (기본)
    if (cancelScope === 'THIS' || !reservation.recurrenceRuleId) {
      const cancelled = await prisma.reservation.update({
        where: { id },
        data: { status: 'CANCELLED' },
        include: { space: true, attendees: { select: { id: true, reservationId: true, name: true, email: true, department: true, status: true, createdAt: true } } },
      });
      emailService.sendReservationCancelled(cancelled).catch(console.error);
      // 같은 시간대 대기자 자동 승격
      waitlistService.promote(cancelled.spaceId, cancelled.startTime, cancelled.endTime, principal).catch(console.error);
      return { cancelled: [cancelled], scope: 'THIS' };
    }

    // 일괄 취소 대상 조회 조건
    const whereClause = {
      tenantId: principal.tenantId,
      orgId: principal.orgId,
      ownerId: principal.userId,
      recurrenceRuleId: reservation.recurrenceRuleId,
      status: 'CONFIRMED' as const,
      ...(cancelScope === 'THIS_AND_FOLLOWING' && {
        startTime: { gte: reservation.startTime },
      }),
    };

    // 이메일 발송을 위해 먼저 조회
    const targets = await prisma.reservation.findMany({
      where: whereClause,
      include: { space: true, attendees: { select: { id: true, reservationId: true, name: true, email: true, department: true, status: true, createdAt: true } } },
    });

    // 일괄 CANCELLED 처리
    await prisma.reservation.updateMany({
      where: whereClause,
      data: { status: 'CANCELLED' },
    });

    // 각 예약 참석자에게 취소 이메일 발송 (병렬)
    await Promise.allSettled(
      targets.map((r: typeof targets[number]) => emailService.sendReservationCancelled(r).catch(console.error)),
    );

    // 취소된 각 예약 시간대에 대해 대기자 자동 승격
    await Promise.allSettled(
      targets.map((r: typeof targets[number]) =>
        waitlistService.promote(r.spaceId, r.startTime, r.endTime, principal).catch(console.error),
      ),
    );

    return { cancelled: targets, scope: cancelScope };
  },
};

// 현재 모델에는 공개 여부 필드가 없으므로 타인의 모든 예약은 busy 정보로 취급한다.
export function readableReservation<T extends Reservation>(row: T, principal: Principal) {
  if (row.ownerId === principal.userId) return { ...row, isMine: true };
  return {
    id: row.id, spaceId: row.spaceId, startTime: row.startTime, endTime: row.endTime,
    status: row.status, isMine: false, title: '예약됨', description: null,
    userId: null, ownerId: null, recurrenceRuleId: null, recurrenceRule: null,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}
