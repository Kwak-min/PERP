import type { ReactNode } from "react";

export type Stat = Readonly<{
  label: string;
  value: string;
  unit?: string;
  delta?: string;
  trend?: "up" | "down" | "flat";
  foot?: string;
}>;

export function StatCard({ stat, action }: Readonly<{ stat: Stat; action?: ReactNode }>) {
  const trend = stat.trend ?? "flat";
  const arrow = trend === "up" ? "▲" : trend === "down" ? "▼" : "—";
  return (
    <article className="stat-card">
      <div className="stat-card__top">
        <span className="stat-card__label">{stat.label}</span>
        {action}
      </div>
      <div className="stat-card__value">
        {stat.value}
        {stat.unit && <span className="stat-card__unit">{stat.unit}</span>}
      </div>
      {stat.delta && (
        <span className={`stat-card__delta stat-card__delta--${trend}`}>
          <span aria-hidden="true">{arrow}</span>
          {stat.delta}
        </span>
      )}
      {stat.foot && <span className="stat-card__foot">{stat.foot}</span>}
    </article>
  );
}
