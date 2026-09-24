import type { ReactNode } from "react";

import { HelixLogo, PersonIcon } from "../icons";

// v1 shell header (HANDOFF section 5.1). OWNER: step 0 (shell layout).
// Brand, study identity, the synthetic badge, the server-owned release pill,
// and the synthetic demo identity. Lanes must not edit the shell.

export const SYNTHETIC_BADGE = "Synthetic data \u00b7 Not for submission";

export type ShellHeaderProps = {
  studyId: string;
  descriptor: string;
  /** True when the descriptor came from the workspace (adds test ids). */
  loaded: boolean;
  title?: string;
  releasePill?: ReactNode;
};

export function ShellHeader({ studyId, descriptor, loaded, title, releasePill }: ShellHeaderProps) {
  return (
    <header className="hx-top" data-testid="shell-header">
      <div className="hx-brand">
        <div className="hx-logo">
          <HelixLogo />
          <span>HELIX</span>
        </div>
        <div className="hx-vr" aria-hidden="true" />
        {loaded ? (
          <div className="hx-study" data-testid="study-identity" title={title}>
            <strong className="hx-study-id" data-testid="study-id">
              {studyId}
            </strong>
            <span data-testid="study-descriptor">{descriptor}</span>
          </div>
        ) : (
          <div className="hx-study">
            <strong className="hx-study-id">{studyId}</strong>
            <span>{descriptor}</span>
          </div>
        )}
      </div>
      <div className="hx-top-meta">
        <span className="hx-synthetic" data-testid="synthetic-badge">
          {SYNTHETIC_BADGE}
        </span>
        {releasePill}
        {/* Documented deviation (#27): synthetic identity, not the reference initials. */}
        <span
          className="hx-avatar"
          role="img"
          aria-label="Synthetic demo identity. Not an authenticated user or signer."
          title="Synthetic demo identity (not authenticated)"
          data-testid="demo-avatar"
        >
          <PersonIcon size={16} />
        </span>
      </div>
    </header>
  );
}
