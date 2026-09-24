"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { DEFAULT_STUDY_ID, normalizeStudyId } from "./studyId";

// Study-selection seam (UI step 0). OWNER: step 0 (shell). Lane A (#26) fills
// it in: the upload form calls `selectStudy(newStudyId)` after an intake job
// completes, and a study picker can call it too. The shell reads
// `useStudySelection().studyId` instead of a hard-wired study ID.
//
// Today: the initial study comes from `?study=<id>` (validated) or falls back
// to the seeded synthetic study. `selectStudy` updates state and the URL
// (history.replaceState) without a full reload.

type StudySelection = {
  studyId: string;
  selectStudy: (studyId: string) => void;
};

const StudyContext = createContext<StudySelection | null>(null);

export function StudyProvider({ initialStudyId, children }: { initialStudyId: string; children: ReactNode }) {
  const [studyId, setStudyId] = useState(() => normalizeStudyId(initialStudyId));
  const selectStudy = useCallback((next: string) => {
    const normalized = normalizeStudyId(next);
    setStudyId(normalized);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (normalized === DEFAULT_STUDY_ID) {
        url.searchParams.delete("study");
      } else {
        url.searchParams.set("study", normalized);
      }
      window.history.replaceState(window.history.state, "", url);
    }
  }, []);
  const value = useMemo(() => ({ studyId, selectStudy }), [studyId, selectStudy]);
  return <StudyContext.Provider value={value}>{children}</StudyContext.Provider>;
}

export function useStudySelection(): StudySelection {
  const value = useContext(StudyContext);
  if (!value) {
    throw new Error("useStudySelection must be used inside <StudyProvider>.");
  }
  return value;
}
