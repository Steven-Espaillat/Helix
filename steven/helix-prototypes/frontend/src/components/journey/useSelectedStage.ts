"use client";

import { useCallback, useState } from "react";

import type { JourneyStageId, WorkbenchJourney } from "@/lib/types";

// Lane A (#19). The ONLY local journey state is which reached stage the user is viewing.
// Selecting never calls a command and never changes the server stage. A selection that
// is not (or no longer) selectable falls back to the server's current stage.

export function defaultStageId(journey: WorkbenchJourney): JourneyStageId {
  return journey.current_stage_id ?? journey.stages[journey.stages.length - 1].stage_id;
}

export function useSelectedStage(journey: WorkbenchJourney | null | undefined) {
  const [picked, setPicked] = useState<JourneyStageId | null>(null);

  const selectable = (id: JourneyStageId | null) =>
    Boolean(id && journey?.stages.some((stage) => stage.stage_id === id && stage.selectable));

  const selectedStageId: JourneyStageId | null = journey
    ? selectable(picked)
      ? picked
      : defaultStageId(journey)
    : null;

  const select = useCallback(
    (id: string) => {
      if (journey?.stages.some((stage) => stage.stage_id === id && stage.selectable)) {
        setPicked(id as JourneyStageId);
      }
    },
    [journey],
  );

  return { selectedStageId, select };
}
