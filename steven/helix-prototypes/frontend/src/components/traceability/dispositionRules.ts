import type { DispositionCommand } from "@/lib/api/traceability";

// Lane C (#22). Client-side mirror of the backend DispositionCommand limits. These give
// immediate form feedback only; a server 422 stays authoritative and is always surfaced.

export type { DispositionCommand };
export type DispositionDecisionChoice = DispositionCommand["decision"];

export const DISPOSITION_DECISIONS: ReadonlyArray<{ value: DispositionDecisionChoice; label: string }> = [
  { value: "corrected", label: "Corrected" },
  { value: "explained_in_nsdrg", label: "Explained in nSDRG" },
  { value: "approved_exception", label: "Approved exception" },
];

export const REASON_MIN = 8;
export const REASON_MAX = 500;
export const REVIEWER_MIN = 2;
export const REVIEWER_MAX = 120;

export type DispositionFieldErrors = Partial<Record<keyof DispositionCommand, string>>;

export function validateDisposition(draft: {
  decision: string;
  reason: string;
  reviewer: string;
}): DispositionFieldErrors {
  const errors: DispositionFieldErrors = {};
  if (!DISPOSITION_DECISIONS.some((choice) => choice.value === draft.decision)) {
    errors.decision = "Choose a decision.";
  }
  const reason = draft.reason.trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    errors.reason = `Reason must be ${REASON_MIN} to ${REASON_MAX} characters (now ${reason.length}).`;
  }
  const reviewer = draft.reviewer.trim();
  if (reviewer.length < REVIEWER_MIN || reviewer.length > REVIEWER_MAX) {
    errors.reviewer = `Reviewer must be ${REVIEWER_MIN} to ${REVIEWER_MAX} characters (now ${reviewer.length}).`;
  }
  return errors;
}
