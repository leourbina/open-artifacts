import type { ComponentProps, ReactNode } from "react";
import s from "./Button.module.css";
import { cx } from "./cx";
import { Spinner } from "./Display";
import { isDev } from "./dev";
import { Tooltip } from "./Tooltip";

export type ButtonProps = {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
} & ComponentProps<"button">;

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(s.btn, s[variant], s[size], className)}
      disabled={disabled || loading}
      {...rest}
      aria-busy={loading || rest["aria-busy"]}
    >
      {loading ? <Spinner decorative /> : icon}
      {children}
    </button>
  );
}

export type IconButtonProps = {
  label: string;
  icon: ReactNode;
} & Omit<ButtonProps, "icon" | "children" | "loading" | "aria-label">;

export function IconButton({
  label,
  icon,
  variant = "ghost",
  className,
  ...rest
}: IconButtonProps) {
  if (isDev() && !label?.trim())
    throw new Error("IconButton requires a non-empty `label`");
  return (
    <Tooltip content={label}>
      <Button
        variant={variant}
        aria-label={label}
        className={cx(s.icon, className)}
        icon={icon}
        {...rest}
      />
    </Tooltip>
  );
}
