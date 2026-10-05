export type CalendarEvent = Readonly<{
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

  return (
    <div className="calendar">
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
              className={`calendar__cell${day === null ? " calendar__cell--muted" : ""}${isToday ? " calendar__cell--today" : ""}`}
            >
              {day !== null && (
                <>
                  <span className={`calendar__date${isWeekend ? " calendar__weekend" : ""}`}>{day}</span>
                  <div className="calendar__events">
                    {dayEvents.slice(0, 3).map((event) => (
                      <span
                        key={event.title}
                        className={`calendar__event calendar__event--${event.tone ?? "primary"}`}
                        title={`${event.time ?? ""} ${event.title}`.trim()}
                      >
                        {event.time && <b>{event.time}</b>}
                        {event.title}
                      </span>
                    ))}
                    {dayEvents.length > 3 && (
                      <span className="calendar__more">{dayEvents.length - 3}건 더</span>
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
