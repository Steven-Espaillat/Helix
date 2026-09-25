"use client";

import { useCallback, useEffect, useState } from "react";

import type { JourneyStageId, WorkbenchJourney } from "@/lib/types";

// Lane A (#19). The ONLY local journey state is which reached stage the user is viewing.
// Selecting never calls a command and never changes the server stage. A selection that
// is not (or no longer) selectable falls back to the server's current stage.
//
// DH-1: while an agent command is in flight (`follow.active`), the view follows the
// server's `current_stage_id` and any manual pick is dropped, so the run ends showing the
// stage the server is on. When idle, a manual pick holds. `followServer()` drops the
// manual pick (used right after a freeze).

export type StageFollow = { active: boolean };

export function defaultStageId(journey: WorkbenchJourney): JourneyStageId {
  return journey.current_stage_id ?? journey.stages[journey.stages.length - 1].stage_id;
}

export function useSelectedStage(journey: WorkbenchJourney | null | undefined, follow?: StageFollow) {
  const [picked, setPicked] = useState<JourneyStageId | null>(null);

  const following = Boolean(journey && follow?.active);
  const selectable = Boolean(
    picked && journey?.stages.some((stage) => stage.stage_id === picked && stage.selectable),
  );
  const selectedStageId: JourneyStageId | null = !journey
    ? null
    : !following && selectable
      ? (picked as JourneyStageId)
      : defaultStageId(journey);

  useEffect(() => {
    if (following) setPicked(null);
  }, [following]);

  const select = useCallback(
    (id: string) => {
      if (journey?.stages.some((stage) => stage.stage_id === id && stage.selectable)) {
        setPicked(id as JourneyStageId);
      }
    },
    [journey],
  );

  const followServer = useCallback(() => setPicked(null), []);

  return { selectedStageId, select, followServer };
}
