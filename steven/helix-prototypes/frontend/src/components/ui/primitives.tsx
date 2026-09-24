import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode } from "react";

// HELIX v1 shared primitives (UI step 0). Visuals come only from
// src/styles/helix-v1.css; these components add no colors of their own.
// OWNER: step 0. Lanes consume them and must not edit this file
// (docs/ui-lanes-ownership.md).

export type Tone = "pass" | "warn" | "block" | "block-solid" | "info" | "muted" | "accent";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function toneClass(tone: Tone): string {
  return `t-${tone}`;
}

/** CSS color for a tone's foreground, for icons and inline status text. */
export function toneColor(tone: Exclude<Tone, "block-solid" | "muted">): string {
  return `var(--hx-${tone})`;
}

type CardTag = "section" | "aside" | "article" | "div" | "nav";

export type CardProps = HTMLAttributes<HTMLElement> & {
  as?: CardTag;
  /** Adds the 18px vertical stack used by most reference cards. */
  stack?: boolean;
};

export function Card({ as: Tag = "section", stack, className, children, ...rest }: CardProps) {
  return (
    <Tag className={cx("hx-card", stack && "stack", className)} {...rest}>
      {children}
    </Tag>
  );
}

export type KickerProps = HTMLAttributes<HTMLDivElement> & { size?: "md" | "sm" };

export function Kicker({ size = "md", className, children, ...rest }: KickerProps) {
  return (
    <div className={cx("hx-kicker", size === "sm" && "sm", className)} {...rest}>
      {children}
    </div>
  );
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary";
  /** `sm` (40px) is only for banners; everything else keeps the 44px target. */
  size?: "md" | "sm";
};

export function Button({
  variant = "default",
  size = "md",
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx("hx-btn", variant === "primary" && "primary", size === "sm" && "sm", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export type ChipProps = HTMLAttributes<HTMLSpanElement> & {
  tone: Tone;
  size?: "xs" | "md" | "lg";
};

/** Badge/chip. Always carries text, so status is never color alone. */
export function Chip({ tone, size = "md", className, children, ...rest }: ChipProps) {
  return (
    <span className={cx("hx-chip", toneClass(tone), size !== "md" && size, className)} {...rest}>
      {children}
    </span>
  );
}

export type PillProps = HTMLAttributes<HTMLSpanElement> & { tone: Tone };

/** Header status pill with the leading dot (release pill). */
export function Pill({ tone, className, children, ...rest }: PillProps) {
  return (
    <span className={cx("hx-pill", toneClass(tone), className)} {...rest}>
      {children}
    </span>
  );
}

export function Spinner({ onFill, size = "md", className }: { onFill?: boolean; size?: "md" | "lg"; className?: string }) {
  return <span className={cx("hx-spin", onFill && "on-fill", size === "lg" && "lg", className)} aria-hidden="true" />;
}

export function StatusDot({ color }: { color: string }) {
  const style: CSSProperties = { color };
  return <span className="hx-dot" style={style} aria-hidden="true" />;
}

export type ListRowProps = {
  icon?: ReactNode;
  /** Token color for the icon, e.g. toneColor("pass"). */
  iconColor?: string;
  meta?: ReactNode;
  metaColor?: string;
  children: ReactNode;
  className?: string;
};

/** 40px divider row used by checklists and sign-offs. */
export function ListRow({ icon, iconColor, meta, metaColor, children, className }: ListRowProps) {
  return (
    <div className={cx("hx-list-row", className)}>
      {icon && <span style={iconColor ? { color: iconColor } : undefined}>{icon}</span>}
      {meta === undefined ? children : <span className="grow">{children}</span>}
      {meta !== undefined && (
        <span className="meta" style={metaColor ? { color: metaColor } : undefined}>
          {meta}
        </span>
      )}
    </div>
  );
}
