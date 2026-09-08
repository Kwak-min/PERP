// datetime-local fields are business wall time, never the browser's timezone.
export function toDatetimeLocal(instant: string): string {
  const date = new Date(instant);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
  const minute = `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
  return `${minute}${date.getUTCSeconds() || date.getUTCMilliseconds() ? `:${part("second")}` : ""}${date.getUTCMilliseconds() ? `.${String(date.getUTCMilliseconds()).padStart(3, "0")}` : ""}`;
}

export function fromDatetimeLocal(value: string): string {
  return new Date(`${value}+09:00`).toISOString();
}
