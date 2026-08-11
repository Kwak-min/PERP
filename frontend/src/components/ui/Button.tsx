import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  Readonly<{
    children: ReactNode;
    tone?: "primary" | "neutral" | "danger" | "ai" | "ghost";
    size?: "small" | "medium";
  }>;

export function Button({
  children,
  className = "",
  tone = "primary",
  size = "medium",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`button button--${tone} button--${size} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
