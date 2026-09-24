import type { ReactNode } from "react";

import { PersonIcon } from "../icons";
import { Kicker, cx } from "./primitives";

// Gate and run banners from research/helix-e2e-workbench-v1.html (section 5.3).
// OWNER: step 0. Lanes pass copy and actions; they do not restyle banners.

export type BannerTone = "awaiting" | "passed" | "running" | "paused";

export type BannerProps = {
  tone: BannerTone;
  leading: ReactNode;
  kicker: ReactNode;
  title: ReactNode;
  /** Hint text and/or the gate action, right-aligned. */
  right?: ReactNode;
  className?: string;
  "data-testid"?: string;
};

export function Banner({ tone, leading, kicker, title, right, className, ...rest }: BannerProps) {
  return (
    <div className={cx("hx-banner", tone, className)} data-testid={rest["data-testid"]}>
      <div className="hx-banner-left">
        {leading}
        <div>
          <Kicker>{kicker}</Kicker>
          <div className="hx-banner-title">{title}</div>
        </div>
      </div>
      {right !== undefined && <div className="hx-banner-right">{right}</div>}
    </div>
  );
}

export type GateBannerProps = {
  /** 1, 2, or 3. */
  gateNumber: 1 | 2 | 3;
  /** Server-reported: the gate is passed. The client never derives this. */
  passed: boolean;
  title: ReactNode;
  right?: ReactNode;
  "data-testid"?: string;
};

export function GateBanner({ gateNumber, passed, title, right, ...rest }: GateBannerProps) {
  return (
    <Banner
      tone={passed ? "passed" : "awaiting"}
      leading={<PersonIcon size={20} />}
      kicker={`Human gate ${gateNumber} of 3 \u00b7 ${passed ? "Approved" : "Awaiting you"}`}
      title={title}
      right={right}
      data-testid={rest["data-testid"]}
    />
  );
}
