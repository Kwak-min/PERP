import type { ReactNode } from "react";

export function ListRow({
  mark,
  time,
  title,
  subtitle,
  meta,
  ai = false,
}: Readonly<{
  mark?: string | undefined;
  time?: string | undefined;
  title: string;
  subtitle?: string | undefined;
  meta?: ReactNode;
  ai?: boolean | undefined;
}>) {
  return (
    <div className="list-row">
      {time && <span className="list-row__time">{time}</span>}
      {mark && (
        <span className={ai ? "list-row__mark list-row__mark--ai" : "list-row__mark"} aria-hidden="true">
          {mark}
        </span>
      )}
      <span className="list-row__body">
        <span className="list-row__title">{title}</span>
        {subtitle && <span className="list-row__sub">{subtitle}</span>}
      </span>
      {meta && <span className="list-row__meta">{meta}</span>}
    </div>
  );
}
