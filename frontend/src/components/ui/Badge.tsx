import type { ReactNode } from "react";

export function Badge({
  children,
  tone = "neutral",
}: Readonly<{
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "ai";
}>) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
