import type { CreateReservationDto } from './reservation.schema';

// 날짜 유틸 (외부 라이브러리 없이 순수 구현)

export const addDays = (date: Date, days: number): Date => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

export const addWeeks = (date: Date, weeks: number): Date =>
  addDays(date, weeks * 7);

export const addMonths = (date: Date, months: number): Date => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
};

export const startOfWeek = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay(); // 0=일
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
};

export const format = (date: Date): string =>
  date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

export function calcRecurrenceDates(
  startDate: Date,
  rule: NonNullable<CreateReservationDto['recurrence']>,
): Date[] {
  const dates: Date[] = [];
  const maxCount = rule.maxOccurrences ?? 365;
  const interval = rule.interval ?? 1;

  if (rule.frequency === 'DAILY' || rule.frequency === 'MONTHLY') {
    let current = new Date(startDate);
    while (dates.length < maxCount && (!rule.endDate || current <= rule.endDate)) {
      dates.push(new Date(current));
      current = rule.frequency === 'DAILY' ? addDays(current, interval) : addMonths(current, interval);
    }
    return dates;
  }

  if (!rule.daysOfWeek?.length) {
    let current = new Date(startDate);
    while (dates.length < maxCount && (!rule.endDate || current <= rule.endDate)) {
      dates.push(new Date(current));
      current = addWeeks(current, interval);
    }
    return dates;
  }

  const weekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
  let weekStart = startOfWeek(startDate);
  while (dates.length < maxCount && (!rule.endDate || weekStart <= rule.endDate)) {
    for (let index = 0; index < weekdays.length && dates.length < maxCount; index++) {
      const day = addDays(weekStart, index);
      if (day >= startDate && (!rule.endDate || day <= rule.endDate) && rule.daysOfWeek.includes(weekdays[index])) dates.push(day);
    }
    weekStart = addWeeks(weekStart, interval);
  }
  return dates;
}
