"use client";

import { useState, type ReactNode } from "react";

import { ApiError, exportPackage, recordApproval, recordFinalStudyApproval } from "@/lib/api";
import { APPROVAL_POLICY } from "@/lib/api/release";
import type { ApprovalRole, Workspace } from "@/lib/types";

import { Card, Chip, GateBanner } from "../ui";
import { DraftCanvas } from "./DraftCanvas";
import { Downloads } from "./Downloads";
import { ExportPanel, type ExportState } from "./ExportPanel";
import { SectionList } from "./SectionList";
import { SignOffs } from "./SignOffs";
import { demoFrozenPackages, stageStatus } from "./reviewState";

// Lane D (#23): Human Gate 3, Review and export. Three columns (section list | document canvas |
// sign-offs), then downloads. Every state shown comes from WorkspaceResponse; the view never
// passes a gate, derives release readiness, or advances progress locally.

export function ReviewStageView({
  workspace,
  onWorkspace,
  onRefresh,
  draftsBody,
}: {
  workspace: Workspace;
  /** Render a workspace returned by a command. */
  onWorkspace: (workspace: Workspace) => void;
  onRefresh: () => Promise<void>;
  /**
   * DH-4 phase 1: the HITL per-section drafts (legacy ReportAssembly + ChatDock) rendered as part
   * of the Gate 3 body. Placement only: the workbench owns the element and its handlers.
   */
  draftsBody?: ReactNode;
}) {
  const studyId = workspace.study.study_id;
  const sections = workspace.report.sections;
  const [selectedId, setSelectedId] = useState<string>(
    sections.find((item) => item.blocks.some((block) => block.kind === "review_marker"))?.section_id ??
      sections[0]?.section_id ??
      "",
  );
  const [busy, setBusy] = useState<string | null>(null);
  // Successes are announced politely; refusals render next to the control that caused them.
  const [announcement, setAnnouncement] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [exportState, setExportState] = useState<ExportState>({ kind: "idle" });

  const section = sections.find((item) => item.section_id === selectedId) ?? sections[0];
  const gateStatus = stageStatus(workspace, "review-export");
  const passed = gateStatus === "complete";
  const hint = passed
    ? "Export recorded. Journey complete."
    : gateStatus === "pending"
      ? "Opens after the traceability gate."
      : "Record sign-offs, then export.";
  // DH-7 (#68): a small status label for a demo-frozen run only. The server refuses its export.
  const notQualified = demoFrozenPackages(workspace).length > 0;

  async function approve(role: ApprovalRole) {
    setBusy(role);
    setAnnouncement("");
    setErrors({});
    try {
      // Records exactly one role. Never exports.
      onWorkspace(await recordApproval(studyId, role));
      setAnnouncement(`${APPROVAL_POLICY[role].label} signed.`);
    } catch (cause) {
      setErrors({ [role]: messageFrom(cause) });
    } finally {
      setBusy(null);
    }
  }

  async function approveFinalStudy() {
    setBusy("final-study-approval");
    setAnnouncement("");
    setErrors({});
    try {
      const key = `workbench-${studyId}-fsa-${workspace.release_candidate?.content_hash?.slice(-12) ?? "pending"}`;
      onWorkspace(await recordFinalStudyApproval(studyId, key));
      setAnnouncement("Final Study Approval signed for the files listed.");
    } catch (cause) {
      setErrors({ "final-study-approval": messageFrom(cause) });
    } finally {
      setBusy(null);
    }
  }

  async function performExport() {
    setExportState({ kind: "loading" });
    setAnnouncement("");
    setErrors({});
    try {
      const receipt = await exportPackage(studyId);
      setExportState({ kind: "success", receipt });
      await onRefresh();
    } catch (cause) {
      setExportState({ kind: "error", message: messageFrom(cause) });
    }
  }

  return (
    <div className="stack" data-testid="review-stage" data-gate-status={gateStatus ?? undefined}>
      <GateBanner
        gateNumber={3}
        passed={passed}
        title="Review sections, sign and export"
        right={
          notQualified ? (
            <>
              <Chip
                tone="warn"
                size="xs"
                data-testid="run-not-qualified"
                title="This run was frozen without a passing qualification for some section packages. Export is refused."
              >
                Not qualified
              </Chip>
              {hint}
            </>
          ) : (
            hint
          )
        }
        data-testid="review-gate-banner"
      />
      <p className="hx-visually-hidden" aria-live="polite" data-testid="review-message">
        {announcement}
      </p>
      {/* Empty report content renders as an empty column inside this view; the sign-offs stay. */}
      <div className="g-review">
        <SectionList workspace={workspace} selectedId={section?.section_id ?? ""} onSelect={setSelectedId} />
        {section ? (
          <DraftCanvas workspace={workspace} section={section} />
        ) : (
          <Card as="article" className="hx-doc" aria-label="Draft" data-testid="draft-canvas" />
        )}
        <Card as="aside" className="stack" aria-labelledby="hx-so-h">
          <SignOffs
            workspace={workspace}
            busy={busy ?? (exportState.kind === "loading" ? "export" : null)}
            onApprove={(role) => void approve(role)}
            onFinalStudyApproval={() => void approveFinalStudy()}
            errors={errors}
          />
          <ExportPanel workspace={workspace} state={exportState} onExport={() => void performExport()} />
        </Card>
      </div>
      <Downloads workspace={workspace} />
      {draftsBody && (
        <section className="hx-review-drafts" aria-label="Section drafts" data-testid="review-drafts-body">
          {draftsBody}
        </section>
      )}
      <p className="hx-sub hx-fine hx-review-disclaimer">
        {/* #30 P2 (critique P2-3): the export panel keeps the reference line "A prepared package is not
            FDA acceptance."; the footer no longer repeats it. */}
        Synthetic data · Not for submission. HELIX makes no regulatory claim.
      </p>
    </div>
  );
}

function messageFrom(cause: unknown): string {
  if (cause instanceof ApiError || cause instanceof Error) return cause.message;
  return "Something went wrong. Nothing was signed. Try again.";
}
