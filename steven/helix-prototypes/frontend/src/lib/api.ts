import type {
  ApprovalRole,
  CandidateEvaluation,
  ChatMessage,
  ChatScope,
  ChatTurn,
  CrossSectionQueryReceipt,
  DataValidationExecution,
  EvidenceChainData,
  ExportReceipt,
  HumanDirectedRevisionReceipt,
  PlannerMode,
  SectionContentDraft,
  SectionDraft,
  SectionListItem,
  SectionRunReceipt,
  ValidationRun,
  Workspace,
} from "./types";
import { APPROVAL_POLICY } from "./api/release";
import { dispositionRejection, type DispositionCommand } from "./api/traceability";

export const API_ROOT = (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000/api/v1").replace(
  /\/$/,
  "",
);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function getWorkspace(studyId: string): Promise<Workspace> {
  const value = await request(`/studies/${encodeURIComponent(studyId)}/workspace`);
  assertWorkspace(value);
  return value;
}

export async function runValidation(
  studyId: string,
  planner: PlannerMode,
): Promise<ValidationRun> {
  const value = await request(`/studies/${encodeURIComponent(studyId)}/validation-runs`, {
    method: "POST",
    body: JSON.stringify({ planner }),
  });
  assertValidationRun(value);
  return value;
}

export async function runDataValidation(
  studyId: string,
  idempotencyKey = `workbench-${studyId}-validation.body_weight-v1`,
): Promise<DataValidationExecution> {
  const value = await request(`/studies/${encodeURIComponent(studyId)}/data-validation-packages`, {
    method: "POST",
    body: JSON.stringify({
      actor: "HELIX workbench",
      package_id: "validation.body_weight",
      idempotency_key: idempotencyKey,
    }),
  });
  assertDataValidationExecution(value);
  return value;
}

export async function reviseSection(
  studyId: string,
  idempotencyKey = `workbench-${studyId}-revise-body-weight-v1`,
): Promise<HumanDirectedRevisionReceipt> {
  const value = await request(`/studies/${encodeURIComponent(studyId)}/section-revisions`, {
    method: "POST",
    body: JSON.stringify({
      section_package_id: "section.5_2_3_body_weight",
      actor: "Dr. Ada Path",
      idempotency_key: idempotencyKey,
    }),
  });
  assertRevisionReceipt(value);
  return value;
}

export async function runSectionAgent(
  studyId: string,
  idempotencyKey = `workbench-${studyId}-body-weight-v1`,
): Promise<SectionRunReceipt> {
  const value = await request(`/studies/${encodeURIComponent(studyId)}/section-runs`, {
    method: "POST",
    body: JSON.stringify({
      section_package_id: "section.5_2_3_body_weight",
      idempotency_key: idempotencyKey,
    }),
  });
  assertSectionRunReceipt(value);
  return value;
}

export async function getSections(studyId: string): Promise<SectionListItem[]> {
  const value = await request(`/studies/${encodeURIComponent(studyId)}/sections`);
  if (!Array.isArray(value)) {
    throw new Error("The sections response does not match the generated API contract.");
  }
  return value as SectionListItem[];
}

export async function getSectionDraft(
  studyId: string,
  sectionId: string,
): Promise<SectionContentDraft | null> {
  const value = await request(
    `/studies/${encodeURIComponent(studyId)}/sections/${encodeURIComponent(sectionId)}/draft`,
  );
  return (value ?? null) as SectionContentDraft | null;
}

export async function getSectionDraftVersion(
  studyId: string,
  sectionId: string,
  version: number,
): Promise<SectionContentDraft> {
  const value = await request(
    `/studies/${encodeURIComponent(studyId)}/sections/${encodeURIComponent(sectionId)}/drafts/${version}`,
  );
  return value as SectionContentDraft;
}

export async function generateSectionDraft(
  studyId: string,
  sectionId: string,
  feedback: string[] = [],
): Promise<SectionContentDraft> {
  const value = await request(
    `/studies/${encodeURIComponent(studyId)}/sections/${encodeURIComponent(sectionId)}/draft`,
    { method: "POST", body: JSON.stringify({ feedback }) },
  );
  return value as SectionContentDraft;
}

export async function reviseSectionDraft(
  studyId: string,
  sectionId: string,
  feedback: string,
): Promise<SectionContentDraft> {
  const value = await request(
    `/studies/${encodeURIComponent(studyId)}/sections/${encodeURIComponent(sectionId)}/revise`,
    { method: "POST", body: JSON.stringify({ feedback }) },
  );
  return value as SectionContentDraft;
}

export async function applySection(
  studyId: string,
  sectionId: string,
  version: number,
): Promise<SectionContentDraft> {
  const value = await request(
    `/studies/${encodeURIComponent(studyId)}/sections/${encodeURIComponent(sectionId)}/apply`,
    { method: "POST", body: JSON.stringify({ version }) },
  );
  return value as SectionContentDraft;
}

export async function discardSection(
  studyId: string,
  sectionId: string,
  version: number,
): Promise<SectionContentDraft> {
  const value = await request(
    `/studies/${encodeURIComponent(studyId)}/sections/${encodeURIComponent(sectionId)}/discard`,
    { method: "POST", body: JSON.stringify({ version }) },
  );
  return value as SectionContentDraft;
}

export async function verifySection(studyId: string, sectionId: string): Promise<SectionContentDraft> {
  const value = await request(
    `/studies/${encodeURIComponent(studyId)}/sections/${encodeURIComponent(sectionId)}/verify`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return value as SectionContentDraft;
}

export async function getChat(studyId: string): Promise<ChatMessage[]> {
  const value = await request(`/studies/${encodeURIComponent(studyId)}/chat`);
  if (!Array.isArray(value)) {
    throw new Error("The chat response does not match the generated API contract.");
  }
  return value as ChatMessage[];
}

export async function sendChat(
  studyId: string,
  message: string,
  scope: ChatScope,
  sectionId: string | null,
): Promise<ChatTurn> {
  const value = await request(`/studies/${encodeURIComponent(studyId)}/chat`, {
    method: "POST",
    body: JSON.stringify({ message, scope, section_id: sectionId }),
  });
  return value as ChatTurn;
}

export async function evaluateCandidate(
  studyId: string,
  runId: string,
  idempotencyKey = `workbench-${studyId}-evaluate-${runId}-v1`,
): Promise<CandidateEvaluation> {
  const value = await request(
    `/studies/${encodeURIComponent(studyId)}/section-runs/${encodeURIComponent(runId)}/evaluations`,
    {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
      }),
    },
  );
  assertCandidateEvaluation(value);
  return value;
}

export async function promoteSectionDraft(
  studyId: string,
  runId: string,
  idempotencyKey = `workbench-${studyId}-promote-${runId}-v1`,
): Promise<SectionDraft> {
  const value = await request(
    `/studies/${encodeURIComponent(studyId)}/section-runs/${encodeURIComponent(runId)}/promotions`,
    {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
      }),
    },
  );
  assertSectionDraft(value);
  return value;
}

export async function queryCrossSection(
  studyId: string,
  runId: string,
  idempotencyKey = `workbench-${studyId}-query-${runId}-v1`,
): Promise<CrossSectionQueryReceipt> {
  const value = await request(
    `/studies/${encodeURIComponent(studyId)}/section-runs/${encodeURIComponent(runId)}/cross-section-queries`,
    {
      method: "POST",
      body: JSON.stringify({
        artifact_ids: ["claim:C-BW-HIGH", "validation.body_weight"],
        idempotency_key: idempotencyKey,
      }),
    },
  );
  assertCrossSectionQuery(value);
  return value;
}

export async function getEvidence(
  studyId: string,
  claimId: string,
): Promise<EvidenceChainData> {
  const value = await request(
    `/studies/${encodeURIComponent(studyId)}/claims/${encodeURIComponent(claimId)}/evidence`,
  );
  assertEvidenceChain(value);
  return value;
}

export async function recordDisposition(
  studyId: string,
  resultId: string,
  command: DispositionCommand,
): Promise<Workspace> {
  // Lane C (#22): the reviewer's typed command is sent verbatim. Rejections keep the
  // server's field messages (422) or conflict text (409) so the form can show them.
  const response = await fetch(
    `${API_ROOT}/studies/${encodeURIComponent(studyId)}/validation-results/${encodeURIComponent(resultId)}/dispositions`,
    {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: command.decision,
        reason: command.reason,
        reviewer: command.reviewer,
      }),
    },
  );
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw dispositionRejection(value, response.status);
  }
  assertWorkspace(value);
  return value;
}

export async function recordApproval(
  studyId: string,
  role: ApprovalRole,
): Promise<Workspace> {
  // Lane D (#23): one role per call with its fixed current meaning (see lib/api/release.ts).
  const { reviewer, meaning } = APPROVAL_POLICY[role];
  const value = await request(`/studies/${encodeURIComponent(studyId)}/approvals`, {
    method: "POST",
    body: JSON.stringify({ role, reviewer, meaning }),
  });
  assertWorkspace(value);
  return value;
}

export async function recordFinalStudyApproval(
  studyId: string,
  idempotencyKey: string,
): Promise<Workspace> {
  const value = await request(`/studies/${encodeURIComponent(studyId)}/final-study-approvals`, {
    method: "POST",
    body: JSON.stringify({
      reviewer: "Dr. Sam Director",
      idempotency_key: idempotencyKey,
    }),
  });
  assertWorkspace(value);
  return value;
}

export function artifactDownloadUrl(studyId: string, artifactId: string): string {
  return `${API_ROOT}/studies/${encodeURIComponent(studyId)}/exports/${encodeURIComponent(artifactId)}`;
}

export async function exportPackage(studyId: string): Promise<ExportReceipt> {
  const value = await request(`/studies/${encodeURIComponent(studyId)}/exports`, {
    method: "POST",
    body: JSON.stringify({
      actor: "Dr. Sam Director",
      idempotency_key: `workbench-${studyId}-export-v1`,
    }),
  });
  assertExportReceipt(value);
  return value;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    throw new ApiError(errorMessage(value), response.status);
  }
  return value;
}

function errorMessage(value: unknown): string {
  if (isObject(value) && typeof value.detail === "string") {
    return value.detail;
  }
  // Typed errors ({ code, message, ... }) still show their message.
  if (isObject(value) && isObject(value.detail) && typeof value.detail.message === "string") {
    return value.detail.message;
  }
  return "The HELIX API returned an unexpected error.";
}

function assertWorkspace(value: unknown): asserts value is Workspace {
  if (
    !isObject(value) ||
    value.label !== "SYNTHETIC / NOT FOR SUBMISSION" ||
    !isObject(value.study) ||
    typeof value.study.study_id !== "string" ||
    !Array.isArray(value.manifest) ||
    !Array.isArray(value.stages) ||
    !Array.isArray(value.validations) ||
    !Array.isArray(value.section_run_eligibility) ||
    !Array.isArray(value.section_runs) ||
    !isObject(value.release_gate) ||
    typeof value.release_gate.status !== "string" ||
    !isObject(value.report) ||
    !isJourney(value.journey)
  ) {
    throw new Error("The workspace response does not match the generated API contract.");
  }
}

function assertValidationRun(value: unknown): asserts value is ValidationRun {
  if (
    !isObject(value) ||
    typeof value.run_id !== "string" ||
    typeof value.llm_used !== "boolean" ||
    !Array.isArray(value.results)
  ) {
    throw new Error("The validation response does not match the generated API contract.");
  }
}

function assertDataValidationExecution(value: unknown): asserts value is DataValidationExecution {
  if (
    !isObject(value) ||
    !isObject(value.receipt) ||
    typeof value.receipt.receipt_id !== "string" ||
    value.receipt.package_id !== "validation.body_weight" ||
    value.receipt.executor_id !== "body-weight-summary" ||
    !Array.isArray(value.claims) ||
    !Array.isArray(value.results) ||
    !Array.isArray(value.section_references)
  ) {
    throw new Error("The data-validation response does not match the generated API contract.");
  }
}

function assertRevisionReceipt(value: unknown): asserts value is HumanDirectedRevisionReceipt {
  if (
    !isObject(value) ||
    !isObject(value.cycle) ||
    typeof value.cycle.cycle_id !== "string" ||
    !Array.isArray(value.stale_disposition_ids) ||
    !Array.isArray(value.stale_approval_ids) ||
    typeof value.review_scaffold_revision !== "number"
  ) {
    throw new Error("The revision response does not match the generated API contract.");
  }
}

function assertSectionRunReceipt(value: unknown): asserts value is SectionRunReceipt {
  if (
    !isObject(value) ||
    value.status !== "candidate_recorded" ||
    value.agent_runtime !== "codex_sdk" ||
    typeof value.candidate_hash !== "string" ||
    typeof value.envelope_hash !== "string" ||
    typeof value.codex_thread_id !== "string" ||
    typeof value.skill_hash !== "string" ||
    typeof value.skill_references_hash !== "string"
  ) {
    throw new Error("The section-run response does not match the generated API contract.");
  }
}

function assertCandidateEvaluation(value: unknown): asserts value is CandidateEvaluation {
  if (
    !isObject(value) ||
    value.schema_version !== "helix.candidate-evaluation/v1" ||
    typeof value.evaluation_id !== "string" ||
    typeof value.candidate_hash !== "string" ||
    !isObject(value.provenance_receipt) ||
    !isObject(value.study_output_evaluation_receipt) ||
    !isObject(value.template_conformance_receipt) ||
    !isObject(value.next_attempt_decision) ||
    !isObject(value.hashes)
  ) {
    throw new Error("The candidate evaluation response does not match the generated API contract.");
  }
}

function assertSectionDraft(value: unknown): asserts value is SectionDraft {
  if (
    !isObject(value) ||
    value.schema_version !== "helix.section-draft/v1" ||
    value.status !== "section_draft" ||
    typeof value.draft_id !== "string" ||
    typeof value.candidate_hash !== "string" ||
    !Array.isArray(value.gate_decision_ids) ||
    !Array.isArray(value.bound_dispositions)
  ) {
    throw new Error("The section draft response does not match the generated API contract.");
  }
}

function assertCrossSectionQuery(value: unknown): asserts value is CrossSectionQueryReceipt {
  if (
    !isObject(value) ||
    value.schema_version !== "helix.cross-section-query-receipt/v1" ||
    typeof value.query_id !== "string" ||
    !Array.isArray(value.requested_artifact_ids) ||
    !Array.isArray(value.returned) ||
    (value.status !== "returned" && value.status !== "rejected")
  ) {
    throw new Error("The cross-section query response does not match the generated API contract.");
  }
}

function assertEvidenceChain(value: unknown): asserts value is EvidenceChainData {
  if (
    !isObject(value) ||
    !isObject(value.claim) ||
    typeof value.claim.claim_id !== "string" ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.validations)
  ) {
    throw new Error("The evidence response does not match the generated API contract.");
  }
}

function assertExportReceipt(value: unknown): asserts value is ExportReceipt {
  if (
    !isObject(value) ||
    value.status !== "exported" ||
    typeof value.exported_at !== "string" ||
    typeof value.approval_id !== "string" ||
    typeof value.manifest_hash !== "string" ||
    !Array.isArray(value.artifacts) ||
    !isObject(value.instrumentation) ||
    value.instrumentation.agent_starts !== 0 ||
    value.instrumentation.calculation_runs !== 0
  ) {
    throw new Error("The export response does not match the generated API contract.");
  }
}

function isJourney(value: unknown): boolean {
  return (
    isObject(value) &&
    value.label === "SYNTHETIC / NOT FOR SUBMISSION" &&
    Array.isArray(value.stages) &&
    value.stages.length === 9 &&
    (value.current_stage_id === null || typeof value.current_stage_id === "string") &&
    (value.run === null || isObject(value.run))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
