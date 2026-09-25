import type { components } from "../api-schema";

// Lane C (#22). Typed disposition command and the server-rejection shape for
// `POST /studies/{study_id}/validation-results/{result_id}/dispositions`.

export type DispositionCommand = components["schemas"]["DispositionCommand"];

export type DispositionField = keyof DispositionCommand;

/**
 * The server rejected a disposition. `fieldErrors` carries FastAPI 422 field messages
 * (`detail[].loc = ["body", field]`); other rejections (e.g. 409 "not allowed for
 * VR-004") keep the server's own message. The server stays authoritative either way.
 */
export class DispositionRejected extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fieldErrors: Partial<Record<DispositionField, string>> = {},
  ) {
    super(message);
    this.name = "DispositionRejected";
  }
}

const FIELDS: readonly DispositionField[] = ["decision", "reason", "reviewer"];

export function dispositionRejection(value: unknown, status: number): DispositionRejected {
  const detail = typeof value === "object" && value !== null ? (value as { detail?: unknown }).detail : undefined;
  if (typeof detail === "string") {
    return new DispositionRejected(detail, status);
  }
  const fieldErrors: Partial<Record<DispositionField, string>> = {};
  const messages: string[] = [];
  if (Array.isArray(detail)) {
    for (const item of detail) {
      if (typeof item !== "object" || item === null) continue;
      const { loc, msg } = item as { loc?: unknown; msg?: unknown };
      const text = typeof msg === "string" ? msg : "Invalid value";
      const field = Array.isArray(loc) ? loc.find((part): part is DispositionField => FIELDS.includes(part as DispositionField)) : undefined;
      if (field && !fieldErrors[field]) fieldErrors[field] = text;
      messages.push(field ? `${field}: ${text}` : text);
    }
  }
  const summary = messages.length > 0 ? messages.join("; ") : "The HELIX API returned an unexpected error.";
  return new DispositionRejected(`The server rejected the disposition (${status}). ${summary}`, status, fieldErrors);
}
