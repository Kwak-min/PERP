import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { BadRequestError, ConflictError } from '../../common/errors';
import type { Principal } from '../../auth/principal';
import type { CreateReservationDto } from './reservation.schema';
import { calcRecurrenceDates, format } from './reservation.utils';
import { emailService } from '../../notification/email.service';

type BookingPeriod = Readonly<{ spaceId: number; startTime: Date; endTime: Date; excludeId?: number }>;

export function isOccupancyConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2004') {
    return typeof error.meta?.database_error === 'string' &&
      /violates exclusion constraint ["\\]+no_overlap_reservation_org["\\]+/.test(error.meta.database_error);
  }
  // Prisma 5.22의 native PG 경로는 EXCLUDE도 UnknownRequestError로 반환한다.
  return error instanceof Prisma.PrismaClientUnknownRequestError &&
    /PostgresError \{ code: "23P01", message: "conflicting key value violates exclusion constraint \\"no_overlap_reservation_org\\""/.test(error.message);
}

export async function checkConflict(principal: Principal, period: BookingPeriod, db: Prisma.TransactionClient = prisma) {
  const conflict = await db.reservation.findFirst({
    where: {
      tenantId: principal.tenantId, orgId: principal.orgId,
      spaceId: period.spaceId, status: 'CONFIRMED',
      startTime: { lt: period.endTime }, endTime: { gt: period.startTime },
      ...(period.excludeId && { id: { not: period.excludeId } }),
    },
  });
  if (conflict) throw new ConflictError(`해당 시간대(${format(period.startTime)} ~ ${format(period.endTime)})에 이미 예약이 존재합니다.`);
}

export async function createRecurring(
  dto: CreateReservationDto,
  principal: Principal,
  rec: NonNullable<CreateReservationDto['recurrence']>,
) {
  const dates = calcRecurrenceDates(dto.startTime, rec);
  if (!dates.length) throw new BadRequestError('반복 종료일까지 예약할 날짜가 없습니다.');
  const durationMs = dto.endTime.getTime() - dto.startTime.getTime();
  const result = await prisma.$transaction(async tx => {
    const rule = await tx.recurrenceRule.create({
      data: {
        tenantId: principal.tenantId, orgId: principal.orgId,
        frequency: rec.frequency, interval: rec.interval, daysOfWeek: rec.daysOfWeek ?? [],
        endDate: rec.endDate, maxOccurrences: rec.maxOccurrences,
      },
    });
    const created = [];
    const skipped = [];
    const invitations = [];
    for (const startTime of dates) {
      const endTime = new Date(startTime.getTime() + durationMs);
      // EXCLUDE가 동시 충돌을 감지하면 이 INSERT만 복구한다. 그 밖의 오류는 전체 rollback이다.
      await tx.$executeRaw`SAVEPOINT reservation_occurrence`;
      let reservation;
      try {
        await checkConflict(principal, { spaceId: dto.spaceId, startTime, endTime }, tx);
        reservation = await tx.reservation.create({
          data: {
            tenantId: principal.tenantId, orgId: principal.orgId, ownerId: principal.userId,
            spaceId: dto.spaceId, title: dto.title, description: dto.description,
            startTime, endTime, recurrenceRuleId: rule.id,
          },
          include: { space: true },
        });
      } catch (error) {
        if (!(error instanceof ConflictError) && !isOccupancyConflict(error)) throw error;
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT reservation_occurrence`;
        await tx.$executeRaw`RELEASE SAVEPOINT reservation_occurrence`;
        skipped.push({ startTime: startTime.toISOString(), endTime: endTime.toISOString(), code: 'RESERVATION_CONFLICT' as const });
        continue;
      }
      await tx.$executeRaw`RELEASE SAVEPOINT reservation_occurrence`;
      // 참석자 오류는 점유 충돌로 취급하지 않으며 앞서 쓴 회차까지 모두 되돌린다.
      for (const attendee of dto.attendees ?? []) {
        invitations.push(await tx.attendee.create({
          data: { reservationId: reservation.id, ...attendee },
          include: { reservation: { include: { space: true } } },
        }));
      }
      created.push(reservation);
    }
    return { created, skipped, invitations };
  }, { timeout: 30000 });
  for (const attendee of result.invitations) emailService.sendAttendeeInvite(attendee).catch(console.error);
  return { created: result.created, skipped: result.skipped };
}
