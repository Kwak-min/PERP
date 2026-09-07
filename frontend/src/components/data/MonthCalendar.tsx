import { Link } from "react-router-dom";

export type CalendarEvent = Readonly<{
  id?: string;
  href?: string;
  day: number;
  time?: string;
  title: string;
  tone?: "primary" | "success" | "warning" | "danger" | "ai";
}>;

const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"] as const;

function buildGrid(year: number, month: number): readonly (number | null)[] {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const offset = (first.getDay() + 6) % 7;
  const cells: (number | null)[] = [];
  for (let i = 0; i < offset; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function MonthCalendar({
  year,
  month,
  events,
  today,
}: Readonly<{
  year: number;
  month: number;
  events: readonly CalendarEvent[];
  today?: number;
}>) {
  const cells = buildGrid(year, month);
  const byDay = new Map<number, CalendarEvent[]>();
  for (const event of events) {
    byDay.set(event.day, [...(byDay.get(event.day) ?? []), event]);
  }

  function renderEvent(event: CalendarEvent, index: number) {
    const content = <>{event.time && <b>{event.time}</b>}{event.title}</>;
    const props = {
      className: `calendar__event calendar__event--${event.tone ?? "primary"}`,
      title: `${event.time ?? ""} ${event.title}`.trim(),
      "aria-label": `${event.day}일 ${event.time ?? ""} ${event.title}`.trim(),
    };
    return event.href ? <Link key={event.id ?? index} to={event.href} {...props}>{content}</Link>
      : <span key={event.id ?? index} {...props}>{content}</span>;
  }

  return (
    <div className="calendar" role="region" aria-label={`${year}년 ${month + 1}월 달력`}>
      <div className="calendar__head">
        {WEEKDAYS.map((label) => (
          <span key={label} className={label === "토" || label === "일" ? "calendar__weekend" : ""}>
            {label}
          </span>
        ))}
      </div>
      <div className="calendar__grid">
        {cells.map((day, index) => {
          const dayEvents = day ? (byDay.get(day) ?? []) : [];
          const isWeekend = index % 7 >= 5;
          const isToday = day !== null && day === today;
          return (
            <div
              key={index}
              data-date={day === null ? undefined : `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`}
              aria-current={isToday ? "date" : undefined}
              className={`calendar__cell${day === null ? " calendar__cell--muted" : ""}${isToday ? " calendar__cell--today" : ""}`}
            >
              {day !== null && (
                <>
                  <span className={`calendar__date${isWeekend ? " calendar__weekend" : ""}`}>{day}</span>
                  <div className="calendar__events">
                    {dayEvents.slice(0, 3).map(renderEvent)}
                    {dayEvents.length > 3 && (
                      <details className="calendar__overflow"><summary className="calendar__more">{dayEvents.length - 3}건 더</summary>
                        {dayEvents.slice(3).map(renderEvent)}
                      </details>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
