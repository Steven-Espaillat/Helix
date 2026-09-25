// Lane A (#20, #26): Human Gate 1 freeze and upload intake wrappers.
// OWNER: Lane A. See docs/ui-lanes-ownership.md section 3.2.
import type { components } from "../api-schema";
import { API_ROOT, ApiError } from "../api";

export type PinnedRun = components["schemas"]["PinnedRun"];
export type StudyListItem = components["schemas"]["StudyListItem"];

export const FREEZE_CONTRACT_VERSION = "v1";
export const FREEZE_DATA_VALIDATION_FAILED = "data_validation_failed_after_freeze";

/** One server-refused freeze reason (HTTP 422 run-plan evidence). */
export type FreezeRefusal = { code: string; subject: string; message: string };

/** Typed partial result: the manifest froze, but the pinned Data Validation did not run. */
export type FreezeDataValidationFailure = {
  code: typeof FREEZE_DATA_VALIDATION_FAILED;
  message: string;
  study_id: string;
  run_id: string;
  pinned_run_preserved: true;
  reason: string;
  retry: {
    operation: "run_data_validation";
    method: "POST";
    path: string;
    package_id: string;
    idempotency_key: string;
  };
};

export class FreezeError extends ApiError {
  constructor(
    message: string,
    status: number,
    readonly refusals: FreezeRefusal[] = [],
    readonly partial: FreezeDataValidationFailure | null = null,
  ) {
    super(message, status);
  }
}

/**
 * Freeze idempotency key: study, manifest hash, operation, contract version, and one
 * durable authorization action ID. Reuse it after a timeout or unknown result; a changed
 * manifest or a new authorization gets a new action ID and so a new key.
 */
export function freezeIdempotencyKey(studyId: string, manifestHash: string, authorizationId: string): string {
  const digest = manifestHash.replace(/^[a-z0-9]+:/, "").slice(0, 16) || "unhashed";
  return `${studyId}:${digest}:freeze-pinned-run:${FREEZE_CONTRACT_VERSION}:${authorizationId}`.slice(0, 160);
}

export const DATA_VALIDATION_PACKAGE_ID = "validation.body_weight";

/** Run-scoped Data Validation key; mirrors backend ``freeze_data_validation_key``. */
export function freezeDataValidationKey(runId: string): string {
  return `dvp-${runId}-${DATA_VALIDATION_PACKAGE_ID}`;
}

export function newAuthorizationId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `AUTH-${random}`;
}

/** Stable client-side fingerprint of the seeded manifest (the server freezes and hashes it). */
export function manifestFingerprint(entries: { artifact_id: string; version: string; checksum: string }[]): string {
  const text = entries
    .map((entry) => `${entry.artifact_id}@${entry.version}#${entry.checksum}`)
    .sort()
    .join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}`;
}

export async function freezePinnedRun(
  studyId: string,
  command: { actor: string; idempotency_key: string },
): Promise<PinnedRun> {
  const response = await fetch(`${API_ROOT}/studies/${encodeURIComponent(studyId)}/pinned-runs`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw freezeError(value, response.status);
  }
  if (!isObject(value) || typeof value.run_id !== "string" || !isObject(value.run_plan)) {
    throw new ApiError("The HELIX API returned an unexpected Pinned Run.", response.status);
  }
  return value as PinnedRun;
}

/** Retry only the pinned Data Validation for an already-frozen run. It never freezes again. */
export async function retryFreezeDataValidation(
  studyId: string,
  partial: Pick<FreezeDataValidationFailure, "run_id" | "retry">,
  actor: string,
): Promise<void> {
  const response = await fetch(`${API_ROOT}/studies/${encodeURIComponent(studyId)}/data-validation-packages`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actor,
      package_id: partial.retry.package_id,
      idempotency_key: partial.retry.idempotency_key,
    }),
  });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    throw new ApiError(detailText(value) ?? "Data Validation retry failed.", response.status);
  }
}

export async function listStudies(): Promise<StudyListItem[]> {
  const response = await fetch(`${API_ROOT}/studies`, { cache: "no-store" });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(value)) {
    throw new ApiError(detailText(value) ?? "Could not list studies.", response.status);
  }
  return value.filter((item): item is StudyListItem => isObject(item) && typeof item.study_id === "string");
}

// --- Upload intake jobs (existing backend: POST /studies/jobs, GET /studies/jobs/{id}) ---

export type IntakeJobStage = "received" | "expanded" | "classified" | "parsed" | "persisted";
export const INTAKE_JOB_STAGES: IntakeJobStage[] = ["received", "expanded", "classified", "parsed", "persisted"];

export type IntakeJob = {
  job_id: string;
  study_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  stage: string | null;
  stages_completed: number;
  stages_total: number;
  stages: Record<string, Record<string, unknown>> | null;
  metrics: Record<string, unknown> | null;
  receipt: Record<string, unknown> | null;
  error: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type IntakeJobRequest = {
  studyId: string;
  route: string;
  protocolVersion: string;
  authorizedBy: string;
  idempotencyKey: string;
  studyTypeId?: string;
  studyStart?: string;
  files: File[];
};

export async function submitIntakeJob(request: IntakeJobRequest): Promise<IntakeJob> {
  const form = new FormData();
  for (const file of request.files) {
    form.append("files", file, file.name);
  }
  form.append("study_id", request.studyId);
  form.append("route", request.route);
  form.append("protocol_version", request.protocolVersion);
  form.append("authorized_by", request.authorizedBy);
  form.append("idempotency_key", request.idempotencyKey);
  if (request.studyTypeId) form.append("study_type_id", request.studyTypeId);
  if (request.studyStart) form.append("study_start", request.studyStart);
  const response = await fetch(`${API_ROOT}/studies/jobs`, { method: "POST", body: form, cache: "no-store" });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(detailText(value) ?? "The upload was not accepted.", response.status);
  }
  assertIntakeJob(value);
  return value;
}

export async function getIntakeJob(jobId: string): Promise<IntakeJob> {
  const response = await fetch(`${API_ROOT}/studies/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(detailText(value) ?? "Could not read the upload job.", response.status);
  }
  assertIntakeJob(value);
  return value;
}

function assertIntakeJob(value: unknown): asserts value is IntakeJob {
  if (!isObject(value) || typeof value.job_id !== "string" || typeof value.status !== "string") {
    throw new ApiError("The HELIX API returned an unexpected upload job.", 500);
  }
}

function freezeError(value: unknown, status: number): FreezeError {
  const detail = isObject(value) ? value.detail : undefined;
  if (isObject(detail) && detail.code === FREEZE_DATA_VALIDATION_FAILED && typeof detail.run_id === "string") {
    const partial = detail as unknown as FreezeDataValidationFailure;
    return new FreezeError(partial.message, status, [], partial);
  }
  if (Array.isArray(detail)) {
    const refusals = detail
      .filter(isObject)
      .map((item) => ({
        code: String(item.code ?? item.type ?? "rejected"),
        subject: String(item.subject ?? (Array.isArray(item.loc) ? item.loc.join(".") : "")),
        message: String(item.message ?? item.msg ?? "Rejected"),
      }));
    return new FreezeError("The server refused to freeze the manifest.", status, refusals);
  }
  return new FreezeError(typeof detail === "string" ? detail : "The freeze command failed.", status);
}

function detailText(value: unknown): string | null {
  if (!isObject(value)) return null;
  if (typeof value.detail === "string") return value.detail;
  if (Array.isArray(value.detail)) {
    return value.detail
      .filter(isObject)
      .map((item) => String(item.message ?? item.msg ?? ""))
      .filter(Boolean)
      .join("; ");
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
