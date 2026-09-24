"use client";

import { HelixWorkbench } from "../HelixWorkbench";
import { useStudySelection } from "./StudyContext";

// Renders the workbench for the selected study. `key` remounts the workbench
// so no state from a previous study leaks into the next one.
export function SelectedStudyWorkbench() {
  const { studyId } = useStudySelection();
  return <HelixWorkbench key={studyId} studyId={studyId} />;
}
