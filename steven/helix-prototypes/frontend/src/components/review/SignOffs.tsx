"use client";

import { Fragment, useState } from "react";

import { APPROVAL_ORDER, APPROVAL_POLICY, artifactLabel } from "@/lib/api/release";
import type { ApprovalRole, Workspace } from "@/lib/types";

import { CheckIcon, ClockIcon } from "../icons";
import { Button, Kicker, ListRow, toneColor } from "../ui";
import { latestApproval, priorApprovalsRecorded, stageStatus } from "./reviewState";

// Lane D (#23): one control per role. Pathologist, peer reviewer, and QAU in any order; the
// study director stays disabled until all three exist, and the server enforces the rule too.
// Approval handlers only record approvals; they never export.

export function SignOffs({
  workspace,
  busy,
  onApprove,
  onFinalStudyApproval,
  errors = {},
}: {
  workspace: Workspace;
  busy: string | null;
  /** Server refusals keyed by role (or "final-study-approval"), shown next to that control. */
  errors?: Record<string, string>;
  onApprove: (role: ApprovalRole) => void;
  onFinalStudyApproval: () => void;
}) {
  const traceabilityPassed = stageStatus(workspace, "traceability") === "complete";
  const priorsDone = priorApprovalsRecorded(workspace);
  const directorRecorded = latestApproval(workspace, "study_director") !== null;
  const fsaCurrent = workspace.approval_current;
  // Hashes the approval binds: the recorded approval's copy once it exists, else the candidate's.
  const approvedArtifacts =
    workspace.final_study_approval?.included_artifact_hashes ?? workspace.release_candidate?.included_artifacts ?? [];
  const fsaHint =
    fsaCurrent || !workspace.release_candidate
      ? null
      : !directorRecorded
        ? "Unlocks after the study director signs."
        : null;
  return (
    <div className="stack" data-testid="sign-offs">
      <div>
        <Kicker>Release controls</Kicker>
        <h2 id="hx-so-h" className="hx-so-title">
          Sign-offs
        </h2>
      </div>
      <div>
        <ListRow
          icon={traceabilityPassed ? <CheckIcon /> : <ClockIcon />}
          iconColor={toneColor(traceabilityPassed ? "pass" : "warn")}
          meta={traceabilityPassed ? "Approved" : "Pending"}
          metaColor={toneColor(traceabilityPassed ? "pass" : "warn")}
        >
          Traceability gate passed
        </ListRow>
        {APPROVAL_ORDER.map((role) => {
          const policy = APPROVAL_POLICY[role];
          const approval = latestApproval(workspace, role);
          const blockedByOrder = role === "study_director" && !priorsDone;
          return (
            <div className="hx-signoff" key={role} data-testid={`signoff-${role}`} data-signed={approval ? "true" : "false"}>
              <ListRow
                icon={approval ? <CheckIcon /> : <ClockIcon />}
                iconColor={toneColor(approval ? "pass" : "warn")}
                meta={approval ? "Signed" : "Pending"}
                metaColor={toneColor(approval ? "pass" : "warn")}
              >
                {policy.label}
              </ListRow>
              <div className="hx-signoff-detail">
                <span className="hx-sub">
                  {approval
                    ? `Signed by ${approval.reviewer} (demo): “${approval.meaning}”`
                    : `Signs as ${policy.reviewer} (demo): “${policy.meaning}”`}
                </span>
                {!approval && (
                  <Button
                    size="sm"
                    disabled={busy !== null || blockedByOrder}
                    aria-describedby={blockedByOrder ? `hx-hint-${role}` : undefined}
                    onClick={() => onApprove(role)}
                    data-testid={`approve-${role}`}
                  >
                    {busy === role ? "Signing…" : policy.buttonLabel}
                  </Button>
                )}
              </div>
              {!approval && blockedByOrder && (
                <p id={`hx-hint-${role}`} className="hx-sub hx-signoff-hint" data-testid={`signoff-hint-${role}`}>
                  Unlocks after the three sign-offs above.
                </p>
              )}
              {errors[role] && (
                <p className="hx-notice t-block hx-signoff-error" role="alert" data-testid={`signoff-error-${role}`}>
                  {errors[role]}
                </p>
              )}
            </div>
          );
        })}
        <div className="hx-signoff" data-testid="signoff-final-study-approval" data-signed={fsaCurrent ? "true" : "false"}>
          <ListRow
            icon={fsaCurrent ? <CheckIcon /> : <ClockIcon />}
            iconColor={toneColor(fsaCurrent ? "pass" : "warn")}
            meta={fsaCurrent ? "Signed" : workspace.final_study_approval ? "Out of date" : "Pending"}
            metaColor={toneColor(fsaCurrent ? "pass" : "warn")}
          >
            Final Study Approval
          </ListRow>
          <div className="hx-signoff-detail">
            <span className="hx-sub" data-testid="fsa-manifest-hash">
              {workspace.release_candidate
                ? "You approve exactly these files. Any change needs a new approval."
                : "Nothing to approve yet."}
            </span>
            {!fsaCurrent && (
              <Button
                size="sm"
                disabled={busy !== null || !directorRecorded || !workspace.release_candidate}
                aria-describedby={fsaHint ? "hx-hint-final-study-approval" : undefined}
                onClick={onFinalStudyApproval}
                data-testid="approve-final-study"
              >
                {busy === "final-study-approval" ? "Signing…" : "Sign Final Study Approval"}
              </Button>
            )}
          </div>
          {fsaHint && (
            <p id="hx-hint-final-study-approval" className="hx-sub hx-signoff-hint" data-testid="signoff-hint-final-study-approval">
              {fsaHint}
            </p>
          )}
          {errors["final-study-approval"] && (
            <p className="hx-notice t-block hx-signoff-error" role="alert" data-testid="signoff-error-final-study-approval">
              {errors["final-study-approval"]}
            </p>
          )}
          {workspace.release_candidate && (
            // Scope of the hash-bound record: the exact release-candidate manifest and artifact
            // hashes (the recorded approval's copy once it exists). The list is collapsed by
            // default; every full hash stays in the DOM and in its copy button when expanded.
            <div className="hx-fsa-scope" data-testid="review-fsa-scope">
              <div className="hx-fsa-head">
                <span className="hx-fsa-kicker">What you are approving</span>
                <span
                  className="hx-fsa-status"
                  data-testid="review-approval-current"
                  data-state={fsaCurrent ? "current" : workspace.final_study_approval ? "stale" : "ready"}
                >
                  {fsaCurrent ? "Signed" : workspace.final_study_approval ? "Out of date: files changed, sign again" : "Ready to sign"}
                </span>
              </div>
              <details className="hx-fsa-details" data-testid="approval-hashes">
                <summary data-testid="approval-hashes-toggle">
                  File fingerprints ({1 + approvedArtifacts.length})
                </summary>
                <dl>
                  <HashRow
                    label="Package fingerprint"
                    value={workspace.final_study_approval?.manifest_hash ?? workspace.release_candidate.content_hash}
                    testId="review-approval-manifest-hash"
                  />
                  {approvedArtifacts.map((item) => (
                    <HashRow
                      key={item.artifact_id}
                      label={labelFor(workspace, item.artifact_id)}
                      detail={item.artifact_id}
                      value={item.content_hash}
                      testId={`review-approval-artifact-${item.artifact_id}`}
                    />
                  ))}
                </dl>
              </details>
            </div>
          )}
        </div>
      </div>
      <p className="hx-sub hx-fine">
        Demo names only. These are not real e-signatures.
      </p>
    </div>
  );
}

function labelFor(workspace: Workspace, artifactId: string): string {
  const kind = workspace.release_candidate?.included_artifacts.find((item) => item.artifact_id === artifactId)?.kind;
  return kind ? artifactLabel(kind) : artifactId;
}

/** One approved hash: friendly label, visually truncated full hash, and a copy button. */
function HashRow({ label, detail, value, testId }: { label: string; detail?: string; value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Fragment>
      <dt>
        {label}
        {detail && <span className="hx-mono hx-fsa-id"> · {detail}</span>}
      </dt>
      <dd className="hx-fsa-hash">
        <span className="hx-mono hx-hash" title={value} data-testid={testId}>
          {value}
        </span>
        <button type="button" className="hx-hash-copy" onClick={() => void copy()} aria-label={`Copy full hash: ${label}`}>
          {copied ? "Copied" : "Copy"}
        </button>
      </dd>
    </Fragment>
  );
}
