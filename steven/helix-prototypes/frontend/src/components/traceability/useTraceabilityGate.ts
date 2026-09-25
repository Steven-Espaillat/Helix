"use client";

import { useCallback, useState } from "react";

import { recordDisposition } from "@/lib/api";
import type { DispositionCommand } from "@/lib/api/traceability";
import type { JourneyStageId, Workspace } from "@/lib/types";

/** A claim the reviewer asked to open in Gate 2 (see `onInspectClaim`). */
export type ClaimRequest = { claimId: string; nonce: number };

type Setters = {
  studyId: string;
  setWorkspace: (workspace: Workspace) => void;
  selectStage: (stageId: JourneyStageId) => void;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
};

/**
 * Lane C (#22) handlers for the Traceability Review gate, kept out of the shared
 * workbench so its stage switch only needs one case block.
 */
export function useTraceabilityGate({ studyId, setWorkspace, selectStage, setNotice, setError }: Setters) {
  // The typed disposition command. Errors are rethrown so the form keeps them (and
  // the reviewer's input) in its own live region.
  const onRecordDisposition = useCallback(
    async (resultId: string, command: DispositionCommand): Promise<Workspace> => {
      setNotice(null);
      setError(null);
      const next = await recordDisposition(studyId, resultId, command);
      // Keep the reviewer on Gate 2 to see the recorded disposition; only Continue
      // (or the Progress Bar) moves the view once the server reports Review reached.
      selectStage("traceability");
      setWorkspace(next);
      setNotice(`Disposition recorded for ${resultId}. The blocker stays listed as a disposition.`);
      return next;
    },
    [studyId, setWorkspace, selectStage, setNotice, setError],
  );

  // Continue changes only the view; the server already decided Review is reachable.
  const onContinue = useCallback(() => selectStage("review-export"), [selectStage]);

  // "Inspect provenance" on a report statement opens Gate 2 on THAT claim. The nonce makes
  // a repeat inspect of the same claim reselect it after the reviewer switched away.
  const [claimRequest, setClaimRequest] = useState<ClaimRequest | null>(null);
  const onInspectClaim = useCallback(
    (claimId: string) => {
      if (claimId) setClaimRequest((previous) => ({ claimId, nonce: (previous?.nonce ?? 0) + 1 }));
      selectStage("traceability");
    },
    [selectStage],
  );

  return { onRecordDisposition, onContinue, onInspectClaim, claimRequest };
}
