import type { ApprovalRole, Workspace } from "@/lib/types";

import { PRIOR_APPROVAL_ROLES } from "@/lib/api/release";

// Lane D (#23): read-only projections of server state for the review view. Nothing here
// decides a gate: release readiness is WorkspaceResponse.release_gate.status only.


export function latestApproval(workspace: Workspace, role: ApprovalRole) {
  return [...workspace.approvals].reverse().find((item) => item.role === role) ?? null;
}

export function priorApprovalsRecorded(workspace: Workspace): boolean {
  return PRIOR_APPROVAL_ROLES.every((role) => latestApproval(workspace, role) !== null);
}

export function stageStatus(workspace: Workspace, stageId: string): string | null {
  return workspace.journey.stages.find((stage) => stage.stage_id === stageId)?.status ?? null;
}

/** Server-recorded export time when no receipt is in memory (e.g. after a reload). */
export function exportedAtFromJourney(workspace: Workspace): string | null {
  const stage = workspace.journey.stages.find((item) => item.stage_id === "review-export");
  return stage?.status === "complete" ? (stage.finished_at ?? null) : null;
}

/**
 * DH-7 (#68): package ids whose qualification was skipped when the pinned run was frozen with
 * the demo flag. Mirrors backend qualification.demo_packages_of: the run_requested event of a
 * demo-frozen run carries the ids under "demo_unqualified_packages". A strict run returns [].
 */
export function demoFrozenPackages(workspace: Workspace): string[] {
  const requested = workspace.pinned_run?.event_history.find((event) => event.event === "run_requested");
  const value = requested?.details?.demo_unqualified_packages;
  return typeof value === "string" ? value.split(",").filter(Boolean) : [];
}

/** DH-7/DH-8: true for a run frozen with the demo flag. The server refuses its export, replay and downloads. */
export function isDemoFrozen(workspace: Workspace): boolean {
  return demoFrozenPackages(workspace).length > 0;
}

/** DH-7/DH-8: the one visible reason shown wherever an export affordance is withheld on a demo-frozen run. */
export const DEMO_EXPORT_REASON =
  "Export is refused for this run. It was frozen with the demo flag, so its section packages have no passing qualification.";

/** DH-8 (#79): short state for exported files and hashes the server no longer serves (409 demo_not_qualified). */
export const DEMO_NOT_AVAILABLE = "Not available: demo not qualified";

/**
 * DH-8 (#79): the legacy journey card for the "export" stage carries server copy that claims an
 * approved release package. On a demo-frozen run that claim is false (export is refused), so the
 * card shows neutral copy instead. Qualified runs keep the server copy (returns null).
 */
export function demoExportStageCopy(
  workspace: Workspace,
  stage: Workspace["stages"][number],
): { input_title: string; output_detail: string; boundary: string } | null {
  if (stage.stage_id !== "export" || !isDemoFrozen(workspace)) return null;
  return {
    input_title: "Release package (demo run, not qualified)",
    output_detail: DEMO_NOT_AVAILABLE,
    boundary: DEMO_EXPORT_REASON,
  };
}
