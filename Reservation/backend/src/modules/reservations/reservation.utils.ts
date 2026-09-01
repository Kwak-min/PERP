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
