export type Bar = Readonly<{ label: string; value: number; soft?: boolean }>;
export type Slice = Readonly<{ label: string; value: number; color: string }>;
export type Progress = Readonly<{ label: string; value: number; total: number; tone?: "warning" | "danger" }>;

export function BarChart({ bars }: Readonly<{ bars: readonly Bar[] }>) {
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  return (
    <div
      className="bar-chart"
      role="img"
      aria-label={"막대 차트: " + bars.map((bar) => `${bar.label} ${bar.value}`).join(", ")}
    >
      {bars.map((bar) => (
        <div className="bar-chart__col" key={bar.label}>
          <span
            className={bar.soft ? "bar-chart__bar bar-chart__bar--soft" : "bar-chart__bar"}
            style={{ height: `${Math.round((bar.value / max) * 100)}%` }}
          />
          <span className="bar-chart__label">{bar.label}</span>
        </div>
      ))}
    </div>
  );
}

export function DonutChart({
  slices,
  centerValue,
  centerLabel,
}: Readonly<{ slices: readonly Slice[]; centerValue: string; centerLabel: string }>) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
  let cursor = 0;
  const stops = slices.map((slice) => {
    const start = (cursor / total) * 360;
    cursor += slice.value;
    const end = (cursor / total) * 360;
    return `${slice.color} ${start}deg ${end}deg`;
  });
  return (
    <div
      className="donut"
      role="img"
      aria-label={"도넛 차트: " + slices.map((slice) => `${slice.label} ${slice.value}`).join(", ")}
    >
      <div className="donut__ring" style={{ background: `conic-gradient(${stops.join(", ")})` }}>
        <div className="donut__hole">
          <strong>{centerValue}</strong>
          <small>{centerLabel}</small>
        </div>
      </div>
      <ul className="donut__legend">
        {slices.map((slice) => (
          <li key={slice.label}>
            <i style={{ background: slice.color }} aria-hidden="true" />
            {slice.label}
            <span>{slice.value.toLocaleString("ko-KR")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProgressList({ items }: Readonly<{ items: readonly Progress[] }>) {
  return (
    <div className="progress-list">
      {items.map((item) => {
        const percent = Math.min(100, Math.round((item.value / Math.max(1, item.total)) * 100));
        return (
          <div className="progress-item" key={item.label}>
            <div className="progress-item__top">
              <b>{item.label}</b>
              <span>{percent}%</span>
            </div>
            <div className="progress-track">
              <span
                className={item.tone ? `progress-fill progress-fill--${item.tone}` : "progress-fill"}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Timeline({
  items,
}: Readonly<{ items: readonly Readonly<{ title: string; note: string; done?: boolean }>[] }>) {
  return (
    <div className="timeline">
      {items.map((item) => (
        <div className={item.done ? "timeline__item timeline__item--on" : "timeline__item"} key={item.title}>
          <b>{item.title}</b>
          <span>{item.note}</span>
        </div>
      ))}
    </div>
  );
}
