import type { ReactNode } from "react";

export function SectionCard({
  title,
  subtitle,
  action,
  foot,
  padded = false,
  className = "",
  children,
}: Readonly<{
  title: string;
  subtitle?: string;
  action?: ReactNode;
  foot?: string;
  padded?: boolean;
  className?: string;
  children: ReactNode;
}>) {
  return (
    <section className={`section-card ${className}`}>
      <header className="section-card__header">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className={padded ? "section-card__body section-card__body--pad" : "section-card__body"}>
        {children}
      </div>
      {foot && <footer className="section-card__foot">{foot}</footer>}
    </section>
  );
}
