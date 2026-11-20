import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

type Variant = "primary" | "soft" | "ghost" | "danger" | "dangerSoft";

const STYLES: Record<Variant, string> = {
  primary: "bg-plum-600 text-white shadow-[0_8px_18px_-10px_rgba(91,42,82,0.9)] hover:bg-plum-700",
  soft: "bg-plum-100 text-plum-900 hover:bg-plum-200",
  ghost: "border border-line bg-surface text-ink hover:bg-plum-50",
  danger: "bg-danger text-white hover:brightness-95",
  dangerSoft: "text-danger hover:bg-danger/10",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: IconName;
  children?: ReactNode;
}

/** Themed button with a subtle press animation. */
export function Button({ variant = "primary", icon, className = "", children, type = "button", ...rest }: Props) {
  return (
    <button
      type={type}
      className={`inline-flex h-10 select-none items-center justify-center gap-2 rounded-control px-4 text-sm font-medium transition-all duration-200 ease-soft active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 ${STYLES[variant]} ${className}`}
      {...rest}
    >
      {icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}
