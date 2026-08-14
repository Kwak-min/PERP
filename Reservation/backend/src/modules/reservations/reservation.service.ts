import { prisma } from '../../lib/prisma';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors';
import { CreateReservationDto, UpdateReservationDto } from './reservation.schema';
import { emailService } from '../../notification/email.service';
import { addDays, addWeeks, addMonths, startOfWeek, format } from './reservation.utils';

export const reservationService = {
  // ── 목록 조회 ─────────────────────────────────────────────────────────────
  findMany: (spaceId?: number, from?: Date, to?: Date, userId?: number) => {
    const fromDate = from ?? new Date(new Date().setHours(0, 0, 0, 0));
    const toDate = to ?? addDays(fromDate, 30);

    return prisma.reservation.findMany({
      where: {
        status: 'CONFIRMED',
        ...(spaceId && { spaceId }),
        ...(userId && { userId }),
        startTime: { gte: fromDate, lt: toDate },
      },
      include: { space: true, attendees: true },
      orderBy: { startTime: 'asc' },
    });
  },

  // ── 단건 조회 ─────────────────────────────────────────────────────────────
  findById: async (id: number) => {
    const r = await prisma.reservation.findUnique({
      where: { id },
      include: { space: true, attendees: true, recurrenceRule: true },
    });
    if (!r) throw new NotFoundError(`예약을 찾을 수 없습니다. id=${id}`);
    return r;
  },

  // ── 타임테이블 조회 (1시간 단위 슬롯) ────────────────────────────────────
  getTimetable: async (spaceId: number, date: string) => {
    const dayStart = new Date(`${date}T08:00:00`);
    const dayEnd = new Date(`${date}T22:00:00`);

    const reservations = await prisma.reservation.findMany({
      where: {
        spaceId,
        status: 'CONFIRMED',
        startTime: { lt: dayEnd },
        endTime: { gt: dayStart },
      },
      orderBy: { startTime: 'asc' },
    });

    const slots = [];
    let cursor = new Date(dayStart);

    while (cursor < dayEnd) {
      const slotEnd = new Date(cursor.getTime() + 60 * 60 * 1000);
      const matched = reservations.find(
        (r: { startTime: Date; endTime: Date; id: number; title: string }) =>
          r.startTime < slotEnd && r.endTime > cursor,
      );

      slots.push(
        matched
          ? { startTime: cursor.toISOString(), endTime: slotEnd.toISOString(), status: 'CONFIRMED', reservationId: matched.id, title: matched.title }
          : { startTime: cursor.toISOString(), endTime: slotEnd.toISOString(), status: 'AVAILABLE' },
      );
      cursor = slotEnd;
    }
    return slots;
  },

  // ── 예약 생성 (단일 / 반복) ───────────────────────────────────────────────
  create: async (dto: CreateReservationDto) => {
    const space = await prisma.space.findFirst({ where: { id: dto.spaceId, isActive: true } });
    if (!space) throw new NotFoundError('공간을 찾을 수 없습니다.');

    if (!dto.recurrence) {
      // 단일 예약
      await checkConflict(dto.spaceId, dto.startTime, dto.endTime);
      const reservation = await prisma.reservation.create({
        data: {
          spaceId: dto.spaceId, userId: dto.userId,
          title: dto.title, description: dto.description,
          startTime: dto.startTime, endTime: dto.endTime,
        },
        include: { space: true },
      });
      emailService.sendReservationConfirmed(reservation).catch(console.error);
      return [reservation];
    }

    // 반복 예약
    return createRecurring(dto, space);
  },

  // ── 수정 ──────────────────────────────────────────────────────────────────
  update: async (id: number, userId: number, dto: UpdateReservationDto) => {
    const reservation = await reservationService.findById(id);
    if (reservation.userId !== userId) throw new ForbiddenError('본인의 예약만 수정할 수 있습니다.');

    const newStart = dto.startTime ?? reservation.startTime;
    const newEnd = dto.endTime ?? reservation.endTime;
    if (dto.startTime || dto.endTime) {
      await checkConflict(reservation.spaceId, newStart, newEnd, id);
    }

    return prisma.reservation.update({
      where: { id },
      data: { title: dto.title, description: dto.description, startTime: newStart, endTime: newEnd },
      include: { space: true },
    });
  },

  // ── 취소 ──────────────────────────────────────────────────────────────────
  cancel: async (id: number, userId: number) => {
    const reservation = await reservationService.findById(id);
    if (reservation.userId !== userId) throw new ForbiddenError('본인의 예약만 취소할 수 있습니다.');

    const cancelled = await prisma.reservation.update({
      where: { id },
      data: { status: 'CANCELLED' },
      include: { space: true, attendees: true },
    });
    emailService.sendReservationCancelled(cancelled).catch(console.error);
    return cancelled;
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────

async function checkConflict(spaceId: number, startTime: Date, endTime: Date, excludeId?: number) {
  const conflict = await prisma.reservation.findFirst({
    where: {
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

async function createRecurring(dto: CreateReservationDto, space: { id: number; name: string }) {
  const rec = dto.recurrence!;
  const rule = await prisma.recurrenceRule.create({
    data: {
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
      await checkConflict(dto.spaceId, start, end);
      const r = await prisma.reservation.create({
        data: {
          spaceId: dto.spaceId, userId: dto.userId,
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
  if (created.length > 0) emailService.sendReservationConfirmed(created[0]).catch(console.error);
  return created;
}

function calcRecurrenceDates(
  startDate: Date,
  rule: NonNullable<CreateReservationDto['recurrence']>,
): Date[] {
  const dates: Date[] = [];
  const maxCount = rule.maxOccurrences ?? 365;
  const interval = rule.interval ?? 1;

  if (rule.frequency === 'DAILY') {
    let cur = new Date(startDate);
    while (dates.length < maxCount) {
      if (rule.endDate && cur > rule.endDate) break;
      dates.push(new Date(cur));
      cur = addDays(cur, interval);
    }
  } else if (rule.frequency === 'WEEKLY') {
    if (!rule.daysOfWeek || rule.daysOfWeek.length === 0) {
      let cur = new Date(startDate);
      while (dates.length < maxCount) {
        if (rule.endDate && cur > rule.endDate) break;
        dates.push(new Date(cur));
        cur = addWeeks(cur, interval);
      }
    } else {

      let weekStart = startOfWeek(startDate);
      while (dates.length < maxCount) {
        if (rule.endDate && weekStart > rule.endDate) break;
        for (let i = 0; i < 7 && dates.length < maxCount; i++) {
          const day = addDays(weekStart, i);
          if (day < startDate) continue;
          if (rule.endDate && day > rule.endDate) break;
          const dow = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][day.getDay()];
          if (rule.daysOfWeek.includes(dow as never)) dates.push(new Date(day));
        }
        weekStart = addWeeks(weekStart, interval);
      }
    }
  } else if (rule.frequency === 'MONTHLY') {
    let cur = new Date(startDate);
    while (dates.length < maxCount) {
      if (rule.endDate && cur > rule.endDate) break;
      dates.push(new Date(cur));
      cur = addMonths(cur, interval);
    }
  }

  return dates;
}
