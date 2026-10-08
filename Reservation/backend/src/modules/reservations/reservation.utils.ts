import type { CreateReservationDto } from './reservation.schema';
import { BadRequestError } from '../../common/errors';

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * DAY_MS);

export const businessDate = (date: Date): string =>
  new Date(date.getTime() + SEOUL_OFFSET_MS).toISOString().slice(0, 10);

export const startOfBusinessDay = (date: Date): Date =>
  new Date(`${businessDate(date)}T00:00:00+09:00`);

export const format = (date: Date): string =>
  date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

export function calcRecurrenceDates(
  startDate: Date,
  rule: NonNullable<CreateReservationDto['recurrence']>,
): Date[] {
  const dates: Date[] = [];
  // 종료일이 있으면 367번째까지 계산해 초과를 거절한다. 무기한 기본값은 기존 365회다.
  const maxCount = rule.maxOccurrences ?? (rule.endDate ? 367 : 365);
  const endDay = rule.endDate ? businessDate(rule.endDate) : undefined;
  const localStart = new Date(startDate.getTime() + SEOUL_OFFSET_MS);
  const weekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
  const weekStart = addDays(startDate, -localStart.getUTCDay());
  const append = (date: Date): boolean => {
    if (!Number.isFinite(date.getTime())) throw new BadRequestError('반복 날짜 범위를 벗어났습니다.');
    if (endDay && businessDate(date) > endDay) return false;
    if (date >= startDate) dates.push(date);
    if (dates.length > 366) throw new BadRequestError('반복 예약은 최대 366회입니다.');
    return dates.length < maxCount;
  };

  for (let cycle = 0; ; cycle++) {
    switch (rule.frequency) {
      case 'DAILY':
        if (!append(addDays(startDate, cycle * rule.interval))) return dates;
        break;
      case 'MONTHLY': {
        // 매번 첫 시작일에서 계산하므로 1/31 -> 2월 말 -> 3/31 anchor가 유지된다.
        const local = new Date(localStart);
        local.setUTCDate(1);
        local.setUTCMonth(localStart.getUTCMonth() + cycle * rule.interval);
        const monthEnd = new Date(local);
        monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
        local.setUTCDate(Math.min(localStart.getUTCDate(), monthEnd.getUTCDate()));
        if (!append(new Date(local.getTime() - SEOUL_OFFSET_MS))) return dates;
        break;
      }
      case 'WEEKLY':
        if (!rule.daysOfWeek?.length) {
          if (!append(addDays(startDate, cycle * rule.interval * 7))) return dates;
        } else {
          for (const [index, weekday] of weekdays.entries()) {
            if (rule.daysOfWeek.includes(weekday) &&
                !append(addDays(weekStart, cycle * rule.interval * 7 + index))) return dates;
          }
        }
        break;
      default: {
        const exhaustive: never = rule.frequency;
        return exhaustive;
      }
    }
  }
}
