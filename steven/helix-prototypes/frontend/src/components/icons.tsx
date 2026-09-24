import type { ReactNode } from "react";

// Inline stroke icons ported from research/helix-e2e-workbench-v1.html.
// 2px stroke, currentColor, decorative (aria-hidden). Status must also be
// conveyed by text next to the icon; never by the icon or color alone.

type IconProps = {
  size?: number;
  strokeWidth?: number;
  className?: string;
};

function StrokeIcon({
  size = 18,
  strokeWidth = 2,
  className,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className ? `hx-icon ${className}` : "hx-icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <StrokeIcon strokeWidth={2.5} {...props}>
      <polyline points="20 6 9 17 4 12" />
    </StrokeIcon>
  );
}

export function PersonIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
    </StrokeIcon>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />
    </StrokeIcon>
  );
}

export function WarnIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M12 3l10 18H2z" />
      <line x1="12" y1="10" x2="12" y2="14" />
      <line x1="12" y1="17.5" x2="12" y2="17.6" />
    </StrokeIcon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </StrokeIcon>
  );
}

export function ArrowIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </StrokeIcon>
  );
}

export function RetryIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <polyline points="20 4 20 10 14 10" />
      <path d="M20 10a8 8 0 1 0 1 5" />
    </StrokeIcon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </StrokeIcon>
  );
}

// Brand mark from the reference header. Fill and stroke read tokens so the
// mark follows light and dark themes without copying reference hex values.
export function HelixLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="26" height="26" rx="7" fill="var(--hx-accent)" />
      <path
        d="M9 7v14M19 7v14M9 14h10"
        stroke="var(--hx-on-accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
