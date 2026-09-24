// Study ID selection helpers shared by the server page and the client
// StudyProvider (UI step 0 study-selection seam).

export const DEFAULT_STUDY_ID = "STUDY-HLX-028";
const STUDY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Returns a safe study ID from a query value, or the seeded synthetic study. */
export function normalizeStudyId(value: string | string[] | undefined | null): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && STUDY_ID_PATTERN.test(raw) ? raw : DEFAULT_STUDY_ID;
}
