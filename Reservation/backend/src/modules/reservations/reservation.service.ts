import { prisma } from '../../lib/prisma';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors';
import type { Principal } from '../../auth/principal';
import { CreateReservationDto, UpdateReservationDto } from './reservation.schema';
import { emailService } from '../../notification/email.service';
import { addDays, calcRecurrenceDates, format } from './reservation.utils';
import { waitlistService } from '../waitlist/waitlist.service';

export const reservationService = {
  // ── 목록 조회 ─────────────────────────────────────────────────────────────
  findMany: (principal: Principal, spaceId?: number, from?: Date, to?: Date, mine = false) => {
    const fromDate = from ?? new Date(new Date().setHours(0, 0, 0, 0));
    const toDate = to ?? addDays(fromDate, 30);

    return prisma.reservation.findMany({
      where: {
        tenantId: principal.tenantId,
        orgId: principal.orgId,
        status: 'CONFIRMED',
        ...(spaceId && { spaceId }),
        ...(mine && { ownerId: principal.userId }),
        startTime: { gte: fromDate, lt: toDate },
      },
      include: { space: true },
      orderBy: { startTime: 'asc' },
    });
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
    const dayStart = new Date(`${date}T08:00:00`);
    const dayEnd = new Date(`${date}T22:00:00`);

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
          ? { startTime: cursor.toISOString(), endTime: slotEnd.toISOString(), available: false, isMine: matched.ownerId === principal.userId, reservation: matched }
          : { startTime: cursor.toISOString(), endTime: slotEnd.toISOString(), available: true, isMine: false, reservation: null },
      );
      cursor = slotEnd;
    }
    return { spaceId, date, slots };
  },

  // ── 예약 생성 (단일 / 반복) ───────────────────────────────────────────────
  create: async (dto: CreateReservationDto, principal: Principal) => {
    const scope = { tenantId: principal.tenantId, orgId: principal.orgId };
    const space = await prisma.space.findFirst({ where: { id: dto.spaceId, ...scope, isActive: true } });
    if (!space) throw new NotFoundError('공간을 찾을 수 없습니다.');

    if (!dto.recurrence) {
      // 단일 예약
      await checkConflict(principal, dto.spaceId, dto.startTime, dto.endTime);
      const reservation = await prisma.reservation.create({
        data: {
          ...scope, ownerId: principal.userId, spaceId: dto.spaceId,
          title: dto.title, description: dto.description,
          startTime: dto.startTime, endTime: dto.endTime,
        },
        include: { space: true },
      });
      if (dto.attendees && dto.attendees.length > 0) {
        for (const a of dto.attendees) {
          const attendee = await prisma.attendee.create({
            data: {
              reservationId: reservation.id,
              name: a.name,
              email: a.email,
              department: a.department,
            },
            include: { reservation: { include: { space: true } } },
          });
          emailService.sendAttendeeInvite(attendee).catch(console.error);
        }
      }

      return [reservation];
    }

    // 반복 예약
    return createRecurring(dto, space, principal);
  },

  // ── 수정 ──────────────────────────────────────────────────────────────────
  update: async (id: number, principal: Principal, dto: UpdateReservationDto) => {
    const reservation = await reservationService.findById(id, principal);
    if (reservation.ownerId !== principal.userId) throw new ForbiddenError('본인의 예약만 수정할 수 있습니다.');

    const newStart = dto.startTime ?? reservation.startTime;
    const newEnd = dto.endTime ?? reservation.endTime;
    if (dto.startTime || dto.endTime) {
      await checkConflict(principal, reservation.spaceId, newStart, newEnd, id);
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

// ── helpers ──────────────────────────────────────────────────────────────────

async function checkConflict(principal: Principal, spaceId: number, startTime: Date, endTime: Date, excludeId?: number) {
  const conflict = await prisma.reservation.findFirst({
    where: {
      tenantId: principal.tenantId,
      orgId: principal.orgId,
      spaceId,
      status: 'CONFIRMED',
      startTime: { lt: endTime },
      endTime: { gt: startTime },
      ...(excludeId && { id: { not: excludeId } }),
    },
  });
  if (conflict) {
    throw new ConflictError(
      `해당 시간대(${format(startTime)} ~ ${format(endTime)})에 이미 예약이 존재합니다.`,
    );
  }
}
async function createRecurring(dto: CreateReservationDto, space: { id: number; name: string }, principal: Principal) {
  const rec = dto.recurrence!;
  const rule = await prisma.recurrenceRule.create({
    data: {
      tenantId: principal.tenantId,
      orgId: principal.orgId,
      frequency: rec.frequency,
      interval: rec.interval,
      daysOfWeek: rec.daysOfWeek ?? [],
      endDate: rec.endDate,
      maxOccurrences: rec.maxOccurrences,
    },
  });

  const dates = calcRecurrenceDates(dto.startTime, rec);
  const durationMs = dto.endTime.getTime() - dto.startTime.getTime();
  const created = [];
  const skipped = [];

  for (const date of dates) {
    const start = new Date(date);
    start.setHours(dto.startTime.getHours(), dto.startTime.getMinutes(), 0, 0);
    const end = new Date(start.getTime() + durationMs);
    try {
      await checkConflict(principal, dto.spaceId, start, end);
      const r = await prisma.reservation.create({
        data: {
          tenantId: principal.tenantId, orgId: principal.orgId, ownerId: principal.userId, spaceId: dto.spaceId,
          title: dto.title, description: dto.description,
          startTime: start, endTime: end,
          recurrenceRuleId: rule.id,
        },
        include: { space: true },
      });
      created.push(r);
    } catch {
      skipped.push(format(start));
    }
  }

  if (skipped.length > 0) console.warn('[반복예약] 중복 스킵된 날짜:', skipped);
  return created;
}
