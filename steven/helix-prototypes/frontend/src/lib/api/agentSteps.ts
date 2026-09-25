// Lane B (#21). Governed Agent Step sequence for stages 2-7.
//
// The server is the only authority: every decision below reads a freshly fetched
// Workspace, one command runs at a time, and the sequence stops on the first error,
// blocker, or human decision. Nothing here advances on a timer, and the agent never
// passes Traceability review (Human gate 2).

import {
  ApiError,
  evaluateCandidate,
  promoteSectionDraft,
  queryCrossSection,
  runDataValidation,
  runSectionAgent,
  runValidation,
} from "@/lib/api";
import type {
  CandidateEvaluation,
  CrossSectionQueryReceipt,
  DataValidationExecution,
  JourneyStageId,
  PlannerMode,
  SectionDraft,
  SectionRunReceipt,
  ValidationRun,
  Workspace,
} from "@/lib/types";

export const BODY_WEIGHT_PACKAGE = "validation.body_weight";
export const BODY_WEIGHT_SECTION = "section.5_2_3_body_weight";

export type AgentAction =
  | "data-validation"
  | "validation"
  | "section-run"
  | "cross-section-query"
  | "candidate-evaluation"
  | "section-promotion";

export type AgentStep = {
  action: AgentAction;
  stageId: JourneyStageId;
  label: string;
  /** Section Agent run the command targets (draft-stage commands only). */
  runId?: string;
  /** Data Validation only: the freeze already recorded the execution, so the call is an idempotent replay. */
  replay?: boolean;
};

export type NextStepOptions = {
  /**
   * Pinned Run IDs whose freeze-created Data Validation execution this session has already
   * confirmed through the command (an idempotent replay). Until then, Extract re-addresses
   * the same run-scoped execution instead of silently trusting it.
   */
  confirmedDataValidationRuns?: ReadonlySet<string>;
};

export type AgentStop =
  | { kind: "needs-freeze"; stageId: JourneyStageId; message: string }
  | { kind: "blocker"; stageId: JourneyStageId; message: string }
  | { kind: "human-decision"; stageId: JourneyStageId; message: string }
  | { kind: "gate"; stageId: JourneyStageId; message: string };

export const ACTION_LABELS: Record<AgentAction, string> = {
  "data-validation": "Execute Data Validation Package",
  validation: "Run deterministic and hybrid validation",
  "section-run": "Run governed Section Agent",
  "cross-section-query": "Query declared dependencies",
  "candidate-evaluation": "Evaluate candidate",
  "section-promotion": "Promote governed draft",
};

const ACTION_STAGE: Record<AgentAction, JourneyStageId> = {
  "data-validation": "extract",
  validation: "validate",
  "section-run": "draft",
  "cross-section-query": "draft",
  "candidate-evaluation": "draft",
  "section-promotion": "draft",
};

export const REPLAY_LABEL = "Confirm Data Validation receipt (idempotent replay)";

function step(action: AgentAction, runId?: string): AgentStep {
  return { action, stageId: ACTION_STAGE[action], label: ACTION_LABELS[action], runId };
}

/** Backend `SectionRunService` eligibility reason while no validation run is recorded. */
export const VALIDATION_PENDING_REASON = "Run hybrid validation first";

/** The next governed command, or why the agent must stop, from server state only. */
// Workspace validations also carry the Data Validation Package results, so hybrid
// validation counts as run only when a result exists that no package execution made.
export function hybridValidationCount(workspace: Workspace): number {
  const packageResultIds = new Set(
    workspace.data_validation_executions.flatMap((execution) => execution.results.map((item) => item.result_id)),
  );
  return workspace.validations.filter((item) => !packageResultIds.has(item.result_id)).length;
}

export function nextAgentStep(workspace: Workspace, options: NextStepOptions = {}): AgentStep | AgentStop {
  const pinned = workspace.pinned_run;
  if (!pinned) {
    return {
      kind: "needs-freeze",
      stageId: "upload",
      message: "The agent starts after a person freezes the authorized manifest at Human gate 1.",
    };
  }
  const execution = workspace.data_validation_executions.find(
    (item) => item.receipt.run_id === pinned.run_id && item.receipt.package_id === BODY_WEIGHT_PACKAGE,
  );
  if (!execution) {
    return step("data-validation");
  }
  if (!options.confirmedDataValidationRuns?.has(pinned.run_id)) {
    // Same Pinned Run and package, same run-scoped key as the freeze: the server returns the
    // recorded execution with `idempotent_replay: true` and never runs the package twice.
    return { ...step("data-validation"), label: REPLAY_LABEL, replay: true };
  }
  const eligibility = workspace.section_run_eligibility.find(
    (item) => item.section_package_id === BODY_WEIGHT_SECTION,
  );
  const runs = workspace.section_runs.filter(
    (item) => item.receipt.section_package_id === BODY_WEIGHT_SECTION,
  );
  const run = runs.at(-1)?.receipt;
  // DH-1: seeded studies carry validation results that no run on this Pinned Run made, so
  // the server's own eligibility reason also says when validation has not run yet.
  const validationPending =
    hybridValidationCount(workspace) === 0 || (eligibility?.reasons ?? []).includes(VALIDATION_PENDING_REASON);
  if (!run && !eligibility?.eligible && validationPending) {
    return step("validation");
  }
  if (!run) {
    if (!eligibility?.eligible) {
      return {
        kind: "blocker",
        stageId: "validate",
        message: `The Section Agent is not eligible: ${(eligibility?.reasons ?? ["no eligibility recorded"]).join("; ")}.`,
      };
    }
    return step("section-run");
  }
  if (!(workspace.cross_section_queries ?? []).some((item) => item.run_id === run.run_id)) {
    return step("cross-section-query", run.run_id);
  }
  const evaluation = (workspace.candidate_evaluations ?? []).find((item) => item.run_id === run.run_id);
  if (!evaluation) {
    return step("candidate-evaluation", run.run_id);
  }
  const decision = evaluation.next_attempt_decision;
  if (decision.action === "retry") {
    return {
      kind: "human-decision",
      stageId: "draft",
      message: `Candidate evaluation asks for another attempt (attempt ${decision.attempt} of ${decision.max_attempts}). A person chooses whether to retry.`,
    };
  }
  if (decision.action === "stop_for_review") {
    // Attempt cap reached with blockers: the candidate needs a person's review and has no
    // Section Draft, so the agent stops here and never reports Traceability.
    return {
      kind: "human-decision",
      stageId: "draft",
      message: `Candidate evaluation stopped for review after ${decision.attempt} of ${decision.max_attempts} attempts. A person reviews the blockers; no Section Draft was promoted.`,
    };
  }
  // `hold`: the deterministic gates passed. Traceability is reached only once the server has
  // recorded a promoted Section Draft for this run.
  if ((workspace.section_drafts ?? []).some((item) => item.run_id === run.run_id)) {
    return {
      kind: "gate",
      stageId: "traceability",
      message: "The agent stops at Traceability review. Only a person can pass Human gate 2.",
    };
  }
  // Evaluation always records a promotion decision for the run (backend
  // candidate_evaluations.py -> record_decision_for_evaluation), so its presence says
  // nothing; its outcome does. The latest decision decides whether promotion can run.
  const promotion = (workspace.promotion_decisions ?? []).filter((item) => item.run_id === run.run_id).at(-1);
  if (promotion && !promotion.eligible) {
    return {
      kind: "human-decision",
      stageId: "draft",
      message: `Promotion is not eligible (${promotion.failed_condition_ids.join(", ") || "no condition recorded"}). A person resolves it before a Section Draft can be promoted.`,
    };
  }
  return step("section-promotion", run.run_id);
}

export function isAgentStep(value: AgentStep | AgentStop): value is AgentStep {
  return "action" in value;
}

// #17 idempotency keys. A key is built from the governed resource identity (after freeze:
// the Pinned Run, or the Section Run for commands on a run), the command name, the contract
// or package version, and one durable action ID (`a<n>`). The pending key is persisted
// (sessionStorage) while its result is unknown, so a network or 5xx retry reuses it; a
// definite answer (a receipt, or a 4xx rejection) settles it and the next deliberate
// attempt gets a new action ID. A superseding run has a new run ID, so its keys are new.
//
// Data Validation is the exception by design: the freeze command already executed the
// package under the server's run-scoped key `dvp-<run_id>-validation.body_weight`
// (backend app/manifest_authorization.py `freeze_data_validation_key`). Extract sends that
// same key, so it either replays the freeze-created execution or, when freeze left it
// absent, executes it once. There is one execution per Pinned Run and package.
const STORE_KEY = "helix.agent-action-keys.v2";

/** Contract versions for commands whose request carries no package version. */
export const COMMAND_CONTRACT_VERSION: Record<Exclude<AgentAction, "data-validation" | "validation">, string> = {
  "section-run": "section-run.v1",
  "cross-section-query": "cross-section-query.v1",
  "candidate-evaluation": "candidate-evaluation.v1",
  "section-promotion": "section-promotion.v1",
};

/** Mirrors backend `freeze_data_validation_key(run_id)`: the freeze and every later call share it. */
export function dataValidationKey(pinnedRunId: string): string {
  return `dvp-${pinnedRunId}-${BODY_WEIGHT_PACKAGE}`;
}

type KeyRecord = { attempt: number; pending: string | null };

function readStore(): Record<string, KeyRecord> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(STORE_KEY) ?? "{}");
    return value && typeof value === "object" ? (value as Record<string, KeyRecord>) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, KeyRecord>) {
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify(store));
  }
}

/** Governed resource + command + version: one slot of durable action IDs. */
export function actionSlot(studyId: string, workspace: Workspace, agentStep: AgentStep): string {
  const pinnedRunId = workspace.pinned_run?.run_id ?? "unfrozen";
  const action = agentStep.action as keyof typeof COMMAND_CONTRACT_VERSION;
  if (action === "section-run") {
    const node = workspace.pinned_run?.run_plan.nodes.find((item) => item.node_id === BODY_WEIGHT_SECTION);
    const version = node?.package_version ?? COMMAND_CONTRACT_VERSION[action];
    return `${studyId}:${pinnedRunId}/${BODY_WEIGHT_SECTION}:${action}:${version}`;
  }
  return `${studyId}:${agentStep.runId ?? pinnedRunId}:${action}:${COMMAND_CONTRACT_VERSION[action]}`;
}

export function actionKey(slot: string): string {
  const store = readStore();
  const record = store[slot] ?? { attempt: 0, pending: null };
  if (record.pending) {
    return record.pending;
  }
  const attempt = record.attempt + 1;
  const key = `workbench:${slot}:a${attempt}`;
  store[slot] = { attempt, pending: key };
  writeStore(store);
  return key;
}

export function settleActionKey(slot: string, outcome: "recorded" | "rejected" | "unknown") {
  if (outcome === "unknown") {
    return; // keep the pending key: the retry must reuse it
  }
  const store = readStore();
  if (store[slot]) {
    store[slot] = { ...store[slot], pending: null };
    writeStore(store);
  }
}

export function outcomeOf(cause: unknown): "rejected" | "unknown" {
  return cause instanceof ApiError && cause.status >= 400 && cause.status < 500 ? "rejected" : "unknown";
}

/** What a command returned. Rendered as its receipt; the refreshed Workspace stays the authority. */
export type AgentStepReceipt =
  | { action: "data-validation"; value: DataValidationExecution }
  | { action: "validation"; value: ValidationRun }
  | { action: "section-run"; value: SectionRunReceipt }
  | { action: "cross-section-query"; value: CrossSectionQueryReceipt }
  | { action: "candidate-evaluation"; value: CandidateEvaluation }
  | { action: "section-promotion"; value: SectionDraft };

/** Run one governed command with its #17 key and return its receipt. Callers refresh. */
export async function executeAgentStep(
  studyId: string,
  workspace: Workspace,
  agentStep: AgentStep,
  planner: PlannerMode,
): Promise<AgentStepReceipt> {
  const runId = workspace.pinned_run?.run_id;
  if (!runId) {
    throw new Error("No Pinned Run: a person freezes the manifest at Human gate 1 first.");
  }
  switch (agentStep.action) {
    case "data-validation":
      // One server-defined run-scoped key; retries and replays always reuse it.
      return { action: "data-validation", value: await runDataValidation(studyId, dataValidationKey(runId)) };
    case "validation":
      // ValidationRequest carries only `planner`; the endpoint takes no idempotency key.
      return { action: "validation", value: await runValidation(studyId, planner) };
    default:
      break;
  }
  const slot = actionSlot(studyId, workspace, agentStep);
  const key = actionKey(slot);
  const subject = agentStep.runId ?? "";
  try {
    let receipt: AgentStepReceipt;
    switch (agentStep.action) {
      case "section-run":
        receipt = { action: "section-run", value: await runSectionAgent(studyId, key) };
        break;
      case "cross-section-query":
        receipt = { action: "cross-section-query", value: await queryCrossSection(studyId, subject, key) };
        break;
      case "candidate-evaluation":
        receipt = { action: "candidate-evaluation", value: await evaluateCandidate(studyId, subject, key) };
        break;
      case "section-promotion":
        receipt = { action: "section-promotion", value: await promoteSectionDraft(studyId, subject, key) };
        break;
    }
    settleActionKey(slot, "recorded");
    return receipt;
  } catch (cause) {
    settleActionKey(slot, outcomeOf(cause));
    throw cause;
  }
}

export type SequenceHooks = {
  fetchWorkspace: () => Promise<Workspace>;
  onWorkspace: (workspace: Workspace) => void;
  onStep: (agentStep: AgentStep | null) => void;
  onReceipt?: (agentStep: AgentStep, receipt: AgentStepReceipt, before: Workspace, after: Workspace) => void;
  /** Read before each decision, so a replay confirmed mid-sequence is honoured. */
  options?: () => NextStepOptions;
  /**
   * DH-1: read before each decision. When it returns true the sequence ends before the
   * next governed command; a command already sent to the server is never cancelled.
   */
  shouldStop?: () => boolean;
};

/** DH-1: the operator stopped the sequence between governed commands. */
export type OperatorStop = { kind: "operator-stop"; message: string };

/**
 * DH-1: the sequence never runs past a human gate the server reports as current (Gate 2
 * Traceability, Gate 3 Review and export), whatever the governed records would allow next.
 */
export function serverGateStop(workspace: Workspace): AgentStop | null {
  const journey = workspace.journey;
  const current = journey?.stages.find((stage) => stage.stage_id === journey.current_stage_id);
  if (!current || current.kind !== "human_gate" || (current.gate_number ?? 0) < 2) return null;
  return {
    kind: "gate",
    stageId: current.stage_id,
    message: `The agent stops at Human gate ${current.gate_number}. Only a person can pass it.`,
  };
}

export const OPERATOR_STOP_MESSAGE =
  "You stopped the agent. The last command finished on the server; no later step ran.";

/**
 * Run governed commands in order until the agent must stop. Each command waits for
 * a refreshed Workspace (the server precondition) before the next one is chosen.
 * A failed command throws and nothing after it runs.
 */
export async function runAgentSequence(
  studyId: string,
  planner: PlannerMode,
  hooks: SequenceHooks,
  maxSteps = 9,
): Promise<AgentStop | OperatorStop | null> {
  let workspace = await hooks.fetchWorkspace();
  hooks.onWorkspace(workspace);
  try {
    for (let index = 0; index < maxSteps; index += 1) {
      if (hooks.shouldStop?.()) {
        return { kind: "operator-stop", message: OPERATOR_STOP_MESSAGE };
      }
      const gate = serverGateStop(workspace);
      if (gate) {
        return gate;
      }
      const next = nextAgentStep(workspace, hooks.options?.());
      if (!isAgentStep(next)) {
        return next;
      }
      hooks.onStep(next);
      const receipt = await executeAgentStep(studyId, workspace, next, planner);
      const before = workspace;
      workspace = await hooks.fetchWorkspace();
      hooks.onWorkspace(workspace);
      hooks.onReceipt?.(next, receipt, before, workspace);
    }
    return null;
  } finally {
    hooks.onStep(null);
  }
}
