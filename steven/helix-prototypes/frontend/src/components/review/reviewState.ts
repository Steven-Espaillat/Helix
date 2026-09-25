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
