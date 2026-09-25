"use client";

import { useId, useRef, useState, type FormEvent } from "react";

import { DispositionRejected } from "@/lib/api/traceability";

import { Button } from "../ui";
import {
  DISPOSITION_DECISIONS,
  REASON_MAX,
  REASON_MIN,
  REVIEWER_MAX,
  REVIEWER_MIN,
  validateDisposition,
  type DispositionCommand,
  type DispositionFieldErrors,
} from "./dispositionRules";

// Lane C (#22). The typed disposition form: decision, reason, reviewer. Client checks
// mirror the backend limits for immediate feedback; the server's 422/409 answer stays
// authoritative and is kept in the form and in its polite live region.

type Props = {
  resultId: string;
  ruleLabel: string;
  onSubmit: (command: DispositionCommand) => Promise<unknown>;
  onCancel: () => void;
};

export function DispositionForm({ resultId, ruleLabel, onSubmit, onCancel }: Props) {
  const id = useId();
  const [decision, setDecision] = useState<string>("");
  const [reason, setReason] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [fieldErrors, setFieldErrors] = useState<DispositionFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const decisionRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const reviewerRef = useRef<HTMLInputElement>(null);

  function focusFirst(errors: DispositionFieldErrors) {
    if (errors.decision) decisionRef.current?.focus();
    else if (errors.reason) reasonRef.current?.focus();
    else if (errors.reviewer) reviewerRef.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const errors = validateDisposition({ decision, reason, reviewer });
    setFormError(null);
    setFieldErrors(errors);
    const count = Object.keys(errors).length;
    if (count > 0) {
      setStatus(`${count} ${count === 1 ? "field needs" : "fields need"} attention: ${Object.values(errors).join(" ")}`);
      focusFirst(errors);
      return;
    }
    setSubmitting(true);
    setStatus(`Recording disposition for ${resultId}…`);
    try {
      await onSubmit({
        decision: decision as DispositionCommand["decision"],
        reason: reason.trim(),
        reviewer: reviewer.trim(),
      });
      setStatus(`Disposition recorded for ${resultId}.`);
    } catch (cause) {
      const serverFields = cause instanceof DispositionRejected ? cause.fieldErrors : {};
      const message = cause instanceof Error ? cause.message : "The disposition could not be recorded.";
      setFieldErrors(serverFields);
      setFormError(message);
      setStatus(`Server rejected the disposition: ${message}`);
      focusFirst(serverFields);
    } finally {
      setSubmitting(false);
    }
  }

  const describe = (field: keyof DispositionFieldErrors, hint?: string) =>
    [hint, fieldErrors[field] ? `${id}-${field}-error` : undefined].filter(Boolean).join(" ") || undefined;

  return (
    <form
      className="hx-disp-form"
      onSubmit={(event) => void submit(event)}
      noValidate
      aria-labelledby={`${id}-title`}
      data-testid={`disposition-form-${resultId}`}
    >
      <div className="hx-disp-title" id={`${id}-title`}>
        Record disposition for <span className="hx-mono">{resultId}</span> · {ruleLabel}
      </div>
      <p className="hx-sub hx-disp-note">
        A disposition keeps the blocker on record. It never turns the rule into a pass.
      </p>

      <fieldset className="hx-disp-field" aria-describedby={describe("decision")} aria-invalid={Boolean(fieldErrors.decision) || undefined}>
        <legend>Decision</legend>
        <div className="hx-disp-options">
          {DISPOSITION_DECISIONS.map((choice, index) => (
            <label key={choice.value} className="hx-disp-option">
              <input
                ref={index === 0 ? decisionRef : undefined}
                type="radio"
                name={`${id}-decision`}
                value={choice.value}
                checked={decision === choice.value}
                onChange={() => setDecision(choice.value)}
              />
              {choice.label}
            </label>
          ))}
        </div>
        {fieldErrors.decision && (
          <p className="hx-disp-error" id={`${id}-decision-error`}>
            {fieldErrors.decision}
          </p>
        )}
      </fieldset>

      <div className="hx-disp-field">
        <label htmlFor={`${id}-reason`}>Reason</label>
        <textarea
          ref={reasonRef}
          id={`${id}-reason`}
          value={reason}
          rows={3}
          maxLength={REASON_MAX}
          onChange={(event) => setReason(event.target.value)}
          aria-invalid={Boolean(fieldErrors.reason) || undefined}
          aria-describedby={describe("reason", `${id}-reason-hint`)}
        />
        <p className="hx-disp-hint" id={`${id}-reason-hint`}>
          {REASON_MIN} to {REASON_MAX} characters · {reason.trim().length}/{REASON_MAX}
        </p>
        {fieldErrors.reason && (
          <p className="hx-disp-error" id={`${id}-reason-error`}>
            {fieldErrors.reason}
          </p>
        )}
      </div>

      <div className="hx-disp-field">
        <label htmlFor={`${id}-reviewer`}>Reviewer</label>
        <input
          ref={reviewerRef}
          id={`${id}-reviewer`}
          type="text"
          value={reviewer}
          maxLength={REVIEWER_MAX}
          autoComplete="name"
          onChange={(event) => setReviewer(event.target.value)}
          aria-invalid={Boolean(fieldErrors.reviewer) || undefined}
          aria-describedby={describe("reviewer", `${id}-reviewer-hint`)}
        />
        <p className="hx-disp-hint" id={`${id}-reviewer-hint`}>
          {REVIEWER_MIN} to {REVIEWER_MAX} characters. Synthetic demo identity; e-signature is out of scope (#27).
        </p>
        {fieldErrors.reviewer && (
          <p className="hx-disp-error" id={`${id}-reviewer-error`}>
            {fieldErrors.reviewer}
          </p>
        )}
      </div>

      {formError && (
        <p className="hx-disp-error hx-disp-server" role="alert" data-testid="disposition-server-error">
          {formError}
        </p>
      )}

      <div className="hx-disp-actions">
        <Button type="submit" variant="primary" disabled={submitting} data-testid="disposition-submit">
          {submitting ? "Recording…" : "Record disposition"}
        </Button>
        <Button onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>

      <div className="hx-sr" role="status" aria-live="polite" data-testid="disposition-live">
        {status}
      </div>
    </form>
  );
}
