"use client";

import type { JourneyStage, WorkbenchJourney } from "@/lib/types";

import { StageRail, type StageRailNode } from "../ui";

// Lane A (#19): renders the backend-owned nine-stage projection (`workspace.journey`)
// on the shared StageRail. One server stage becomes one node: there is no merge table,
// no local progress, and no timer. Only the selected reached view is local.

export const JOURNEY_STAGE_COUNT = 9;

export class JourneyShapeError extends Error {}

/** Refuse any stage array that is not exactly the nine-stage projection (e.g. legacy ten). */
export function assertNineStageJourney(stages: readonly unknown[]): asserts stages is JourneyStage[] {
  if (stages.length !== JOURNEY_STAGE_COUNT) {
    throw new JourneyShapeError(
      `The progress bar needs the nine-stage journey projection; received ${stages.length} stages.`,
    );
  }
  for (const stage of stages) {
    if (typeof stage !== "object" || stage === null || !("kind" in stage) || !("selectable" in stage)) {
      throw new JourneyShapeError("The progress bar received a legacy stage without journey projection fields.");
    }
  }
}

export function statusLabel(stage: JourneyStage, running: boolean): string {
  const gate = stage.kind === "human_gate";
  switch (stage.status) {
    case "complete":
      return gate ? "Approved" : "Done";
    case "current":
      return gate ? "Awaiting you" : running ? "Agent running" : "Ready to run";
    case "paused":
      return "Paused";
    case "blocked":
      return "Blocked";
    default:
      return gate ? "Human gate" : "Agent";
  }
}

/** A server run event says this agent stage is in flight (started, not yet finished). */
export function isStageRunning(journey: WorkbenchJourney, stage: JourneyStage): boolean {
  const event = journey.latest_event;
  if (!event || stage.kind !== "agent_step" || stage.status !== "current") return false;
  return event.stage_id === stage.stage_id && (event.type === "stage_started" || event.type === "action_started");
}

export function toRailNodes(journey: WorkbenchJourney): StageRailNode[] {
  assertNineStageJourney(journey.stages);
  return journey.stages.map((stage) => {
    const running = isStageRunning(journey, stage);
    const reachedNotDone = stage.status === "current" || stage.status === "paused" || stage.status === "blocked";
    return {
      key: stage.stage_id,
      shortLabel: stage.short_label,
      name: stage.name,
      kind: stage.kind === "human_gate" ? "gate" : "agent",
      state: stage.status === "complete" ? "done" : reachedNotDone && stage.stage_id === journey.current_stage_id ? "current" : "pending",
      running,
      statusLabel: statusLabel(stage, running),
      disabled: !stage.selectable,
    };
  });
}

export function ProgressBar({
  journey,
  selectedStageId,
  onSelect,
}: {
  journey: WorkbenchJourney;
  selectedStageId: string | null;
  onSelect: (stageId: string) => void;
}) {
  let nodes: StageRailNode[];
  try {
    nodes = toRailNodes(journey);
  } catch (cause) {
    if (!(cause instanceof JourneyShapeError)) throw cause;
    // A contract failure is shown, never silently remapped onto nine nodes.
    return (
      <div className="hx-notice t-block" role="alert" data-testid="journey-contract-error">
        <span>{cause.message}</span>
      </div>
    );
  }
  return (
    <div data-testid="journey-progress" data-current-stage={journey.current_stage_id ?? "complete"}>
      <StageRail stages={nodes} selectedKey={selectedStageId ?? undefined} onSelect={onSelect} />
    </div>
  );
}
