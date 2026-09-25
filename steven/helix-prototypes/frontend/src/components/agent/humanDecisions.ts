import { BODY_WEIGHT_SECTION } from "@/lib/api/agentSteps";
import type { Workspace } from "@/lib/types";

// DH-2 (#66). The human decisions the agent sequence stops at on the Draft stage (retry,
// stop for review, a newly opened revision cycle). They were offered only by the legacy
// StudyJourney panel; the Draft stage view now offers them. Availability comes from the
// server Workspace alone, and the idempotency keys match the legacy workbench handlers,
// so a command sent from either surface is the same governed command.

export type HumanDecisionId = "retry" | "revise" | "draft-cycle";

export type HumanDecision = {
  id: HumanDecisionId;
  label: string;
  idempotencyKey: string;
};

/**
 * The legacy StudyJourney retry condition, shared so the Draft stage offers retry exactly when
 * StudyJourney showed "Retry candidate": the latest body-weight run's evaluation asks for a
 * retry and fewer than 3 attempts were used (the legacy cap, not `max_attempts`).
 */
export function canRetryBodyWeight(workspace: Workspace): boolean {
  const latest = workspace.section_runs.filter((item) => item.receipt.section_package_id === BODY_WEIGHT_SECTION).at(-1);
  const evaluation = (workspace.candidate_evaluations ?? []).find((item) => item.run_id === latest?.receipt.run_id);
  return evaluation?.next_attempt_decision.action === "retry" && evaluation.next_attempt_decision.attempt < 3;
}

export function humanDecisions(studyId: string, workspace: Workspace): HumanDecision[] {
  const decisions: HumanDecision[] = [];
  const runs = workspace.section_runs.filter((item) => item.receipt.section_package_id === BODY_WEIGHT_SECTION);
  const latest = runs.at(-1);
  const evaluation = (workspace.candidate_evaluations ?? []).find((item) => item.run_id === latest?.receipt.run_id);
  const decision = evaluation?.next_attempt_decision;
  if (latest && decision && canRetryBodyWeight(workspace)) {
    const cycleId = latest.candidate.drafting_cycle_id ?? "CYCLE-BW-001";
    const attempt = decision.attempt + 1;
    decisions.push({
      id: "retry",
      label: `Retry candidate (attempt ${attempt} of ${decision.max_attempts})`,
      idempotencyKey: `workbench-${studyId}-body-weight-${cycleId}-attempt-${attempt}`,
    });
  }
  const cycles = workspace.drafting_cycles ?? [];
  if (workspace.can_open_revision) {
    const current = cycles.filter((cycle) => cycle.section_package_id === BODY_WEIGHT_SECTION).at(-1);
    decisions.push({
      id: "revise",
      label: "Revise body-weight cycle",
      idempotencyKey: `workbench-${studyId}-revise-${current?.cycle_id ?? "CYCLE-BW-001"}`,
    });
  }
  // A revision cycle a person opened has no attempt yet; the agent sequence still reads the
  // previous cycle's stop, so the first attempt in the new cycle is a person's command.
  const newest = cycles.at(-1);
  const eligible = workspace.section_run_eligibility.find((item) => item.section_package_id === BODY_WEIGHT_SECTION)?.eligible;
  if (
    newest &&
    newest.cycle_id !== "CYCLE-BW-001" &&
    eligible &&
    !runs.some((item) => item.candidate.drafting_cycle_id === newest.cycle_id)
  ) {
    decisions.push({
      id: "draft-cycle",
      label: `Draft attempt 1 in ${newest.cycle_id}`,
      idempotencyKey: `workbench-${studyId}-body-weight-${newest.cycle_id}-attempt-1`,
    });
  }
  return decisions;
}
