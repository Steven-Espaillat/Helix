"use client";

import { useEffect, useState } from "react";

import { listStudies, type StudyListItem } from "@/lib/api/intake";

import { useStudySelection } from "../shell/StudyContext";

// Lane A (#26): choose a persisted study from `GET /api/v1/studies`.

export function StudyPicker({ refreshKey = 0 }: { refreshKey?: number }) {
  const { studyId, selectStudy } = useStudySelection();
  const [studies, setStudies] = useState<StudyListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listStudies()
      .then((items) => active && setStudies(items))
      .catch((cause: unknown) => active && setError(cause instanceof Error ? cause.message : "Could not list studies."));
    return () => {
      active = false;
    };
  }, [refreshKey]);

  if (error) {
    return (
      <p className="hx-sub" role="alert" data-testid="study-picker-error">
        {error}
      </p>
    );
  }
  if (!studies) return null;
  return (
    <label className="hx-sub" style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span>Study</span>
      <select data-testid="study-picker" value={studyId} onChange={(event) => selectStudy(event.target.value)}>
        {!studies.some((item) => item.study_id === studyId) && <option value={studyId}>{studyId}</option>}
        {studies.map((item) => (
          <option key={item.study_id} value={item.study_id}>
            {item.study_id}
          </option>
        ))}
      </select>
    </label>
  );
}
