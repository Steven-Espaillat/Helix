import { expect, test, type Page, type Route } from "@playwright/test";

import {
  freezeFixture,
  frozenWorkspace,
  journeyAt,
  liveWorkspace,
  stageButtons,
  studyId,
  trackCommands,
  type Json,
  type Journey,
} from "./lane-a-helpers";
import { legacyJourney, openLegacyJourney } from "./legacy-journey";

// DH-2 (#66): the legacy StudyJourney is off the default stage path. Every governed command it
// offered is on a stage view; the Draft-stage human decisions it alone offered (retry, revise,
// first attempt in a new cycle) are on the Draft stage view. Every command response is mocked.

const BW = "section.5_2_3_body_weight";
const REVISED = "CYCLE-REV0000001";
const hash = (seed: string) => `sha256:${seed.repeat(16)}`;
const stageIds = freezeFixture.after.journey.stages.map((stage) => stage.stage_id);
const LEGACY_CONTROLS = [
  "run-validation",
  "run-body-weight-validation",
  "draft-body-weight",
  "retry-body-weight",
  "revise-body-weight",
  "evaluate-candidate",
  "query-cross-section",
  "promote-section-draft",
];

type DraftState = {
  cycles: string[];
  attempts: Array<{
    cycle: string;
    attempt: number;
    action: "retry" | "stop_for_review";
    maxAttempts?: number;
    /** False until the server records a cross-section query / evaluation for this attempt. */
    queried?: boolean;
    evaluated?: boolean;
  }>;
  canRevise: boolean;
};

/** liveWorkspace, also tolerating a refetch still in flight when the test ends (teardown race). */
async function serverWorkspace(route: Route): Promise<Json | null> {
  try {
    return await liveWorkspace(route);
  } catch (error) {
    if (/Test ended/i.test(String(error))) return null;
    throw error;
  }
}

function runId(cycle: string, attempt: number) {
  return `SRUN-${cycle.replace("CYCLE-", "")}-${attempt}`;
}

function storedAttempt(cycle: string, attempt: number): Json {
  const id = runId(cycle, attempt);
  const receipt = {
    run_id: id,
    section_id: "5_2_3_body_weight",
    section_package_id: BW,
    status: "candidate_recorded",
    candidate_id: `SDC-${id}`,
    candidate_hash: hash("cafe"),
    envelope_hash: hash("a11e"),
    agent_runtime: "codex_sdk",
    codex_thread_id: `thread-${id}`,
    skill_name: "helix-section-agent",
    skill_hash: hash("b0b0"),
    skill_references_hash: hash("b0b0"),
    review_scaffold_revision: attempt + 1,
    idempotent_replay: false,
  };
  return {
    receipt,
    candidate: {
      schema_version: "helix.section-draft-candidate/v1",
      status: "section_draft_candidate",
      candidate_id: receipt.candidate_id,
      run_id: id,
      section_id: "5_2_3_body_weight",
      section_package_id: BW,
      section_package_version: "0.1.0",
      drafting_cycle_id: cycle,
      attempt,
      validated_claim_ids: ["C-BW-HIGH"],
      content_blocks: [],
      executor_receipt_ids: [],
      agent_receipt: { runtime: "codex_sdk", thread_id: receipt.codex_thread_id, skill_name: "helix-section-agent" },
    },
    envelope: {},
    review_scaffold: {},
  };
}

function evaluation(cycle: string, attempt: number, action: "retry" | "stop_for_review", maxAttempts = 3): Json {
  const id = runId(cycle, attempt);
  return {
    evaluation_id: `CEV-${id}`,
    run_id: id,
    candidate_id: `SDC-${id}`,
    candidate_hash: hash("cafe"),
    provenance_receipt: { receipt_id: `PRV-${id}`, status: "failed", bindings: [] },
    study_output_evaluation_receipt: { status: "passed", enforcement_class: "review_required" },
    template_conformance_receipt: { status: "passed", results: [] },
    hashes: { evaluation: hash("eeee") },
    next_attempt_decision: {
      action,
      attempt,
      max_attempts: maxAttempts,
      reasons: ["Provenance compilation failed"],
      blocking_receipt_ids: [`PRV-${id}`],
    },
  };
}

function cycle(cycleId: string, predecessor: string | null): Json {
  return {
    schema_version: "helix.drafting-cycle/v1",
    cycle_id: cycleId,
    run_id: "RUN-CYCLE000001",
    section_package_id: BW,
    predecessor_cycle_id: predecessor,
    max_attempts: 3,
    impact_set: { origin_section_package_id: BW, direct: [BW], transitive: [] },
    opened_at: "2026-09-24T12:00:00Z",
    opened_by: predecessor ? "Dr. Ada Path" : "HELIX Codex section runtime",
    triggering_event_id: `EV-${cycleId}`,
  };
}

/** The server reports Draft complete once validation passes; Traceability is then current. */
function draftComplete(): Journey {
  return journeyAt("traceability");
}

function draftWorkspace(live: Json, state: DraftState): Json {
  return frozenWorkspace(live, {
    section_run_eligibility: (live.section_run_eligibility as Json[]).map((entry) =>
      entry.section_package_id === BW ? { ...entry, eligible: true, reasons: [] } : entry,
    ),
    section_runs: state.attempts.map((item) => storedAttempt(item.cycle, item.attempt)),
    cross_section_queries: state.attempts.filter((item) => item.queried !== false).map((item) => ({
      query_id: `CSQ-${runId(item.cycle, item.attempt)}`,
      run_id: runId(item.cycle, item.attempt),
      status: "returned",
      requested_artifact_ids: [],
      returned: [],
      rejected_artifact_ids: [],
    })),
    candidate_evaluations: state.attempts
      .filter((item) => item.evaluated !== false)
      .map((item) => evaluation(item.cycle, item.attempt, item.action, item.maxAttempts)),
    promotion_decisions: [],
    section_drafts: [],
    drafting_cycles: state.cycles.map((id, index) => cycle(id, index === 0 ? null : state.cycles[index - 1])),
    can_open_revision: state.canRevise,
    journey: draftComplete(),
  });
}

type Bodies = { sectionRuns: Json[]; revisions: Json[]; queries: string[]; evaluations: string[] };

/** A receipt shape the client accepts (assertCrossSectionQuery). */
function queryReceipt(id: string): Json {
  return {
    schema_version: "helix.cross-section-query-receipt/v1",
    query_id: `CSQ-${id}`,
    run_id: id,
    section_package_id: BW,
    requested_artifact_ids: ["claim:C-BW-HIGH", "validation.body_weight"],
    returned: [
      { artifact_id: "claim:C-BW-HIGH", kind: "claim", hash: hash("b0b0") },
      { artifact_id: "validation.body_weight", kind: "fact", hash: hash("a11e") },
    ],
    rejected_artifact_ids: [],
    status: "returned",
  };
}

/** An evaluation the client accepts (assertCandidateEvaluation). */
function evaluationReceipt(id: string, attempt: number, action: "retry" | "stop_for_review"): Json {
  const receipt = (kind: string) => ({ receipt_id: `${kind}-${id}`, candidate_id: `SDC-${id}`, candidate_hash: hash("cafe") });
  return {
    schema_version: "helix.candidate-evaluation/v1",
    evaluation_id: `CEV-${id}`,
    run_id: id,
    candidate_id: `SDC-${id}`,
    candidate_hash: hash("cafe"),
    section_package_id: BW,
    provenance_receipt: {
      schema_version: "helix.provenance-receipt/v1",
      ...receipt("PRV"),
      status: "failed",
      enforcement_class: "hard_blocker",
      waivable: false,
      bindings: [],
      blockers: [],
    },
    study_output_evaluation_receipt: {
      schema_version: "helix.study-output-evaluation-receipt/v1",
      ...receipt("SOE"),
      suite_id: "helix-section-study-output",
      suite_version: "0.1.0",
      suite_hash: hash("a11e"),
      status: "passed",
      enforcement_class: "review_required",
      waivable: false,
      results: [],
    },
    template_conformance_receipt: {
      schema_version: "helix.template-conformance-receipt/v1",
      ...receipt("TCF"),
      section_package_id: BW,
      status: "passed",
      results: [],
    },
    next_attempt_decision: {
      action,
      attempt,
      max_attempts: 3,
      reasons: ["Provenance compilation failed"],
      blocking_receipt_ids: [`PRV-${id}`],
    },
    hashes: {
      candidate: hash("cafe"),
      provenance: hash("b0b0"),
      study_output_evaluation: hash("a11e"),
      template_conformance: hash("b0b0"),
      evaluation: hash("eeee"),
    },
  };
}

/**
 * `bare`: like the real server, POST /section-runs records only the candidate. The query and
 * the evaluation for that attempt exist only once their own commands are sent.
 */
async function serveDraft(page: Page, state: DraftState, options: { bare?: boolean } = {}): Promise<Bodies> {
  const bodies: Bodies = { sectionRuns: [], revisions: [], queries: [], evaluations: [] };
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const live = await serverWorkspace(route);
    if (live) await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draftWorkspace(live, state)) });
  });
  await page.route("**/api/v1/studies/*/pinned-runs/*/events", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );
  await page.route("**/api/v1/studies/*/section-runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = (route.request().postDataJSON() ?? {}) as Json;
    bodies.sectionRuns.push(body);
    const key = String(body.idempotency_key);
    const match = /-body-weight-(CYCLE-[A-Z0-9-]+)-attempt-(\d+)$/.exec(key);
    const cycleId = match?.[1] ?? "CYCLE-BW-001";
    const attempt = Number(match?.[2] ?? 1);
    state.attempts.push(
      options.bare
        ? { cycle: cycleId, attempt, action: "retry", queried: false, evaluated: false }
        : { cycle: cycleId, attempt, action: "retry" },
    );
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(storedAttempt(cycleId, attempt).receipt),
    });
  });
  const attemptFor = (url: string) => {
    const id = decodeURIComponent(new URL(url).pathname.split("/").at(-2) ?? "");
    return { id, item: state.attempts.find((entry) => runId(entry.cycle, entry.attempt) === id) };
  };
  await page.route("**/api/v1/studies/*/section-runs/*/cross-section-queries", async (route) => {
    const { id, item } = attemptFor(route.request().url());
    bodies.queries.push(id);
    if (item) item.queried = true;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(queryReceipt(id)) });
  });
  await page.route("**/api/v1/studies/*/section-runs/*/evaluations", async (route) => {
    const { id, item } = attemptFor(route.request().url());
    bodies.evaluations.push(id);
    if (item) item.evaluated = true;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(evaluationReceipt(id, item?.attempt ?? 1, item?.action ?? "retry")),
    });
  });
  await page.route("**/api/v1/studies/*/section-revisions", async (route) => {
    bodies.revisions.push((route.request().postDataJSON() ?? {}) as Json);
    state.cycles.push(REVISED);
    state.canRevise = false;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        cycle: cycle(REVISED, "CYCLE-BW-001"),
        stale_disposition_ids: [],
        stale_approval_ids: [],
        review_scaffold_revision: 4,
        idempotent_replay: false,
      }),
    });
  });
  return bodies;
}

async function openDraftStage(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("helix-workbench")).toBeVisible();
  await stageButtons(page).nth(stageIds.indexOf("draft")).click();
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "draft");
}

async function expectNoLegacyJourney(page: Page) {
  await expect(legacyJourney(page)).toHaveCount(0);
  for (const id of LEGACY_CONTROLS) await expect(page.getByTestId(id)).toHaveCount(0);
}

const live = (page: Page) => page.getByTestId("agent-live");

/** The agent confirmed the freeze-created Extract receipt earlier in this session. */
async function confirmDataValidation(page: Page) {
  await page.addInitScript(
    ([key, value]) => window.sessionStorage.setItem(key, JSON.stringify([value])),
    ["helix.agent-dv-confirmed.v1", freezeFixture.after.pinned_run.run_id] as const,
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.clear());
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("no stage on the default path renders StudyJourney, and each agent stage has one set of agent controls", async ({ page }) => {
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const body = await serverWorkspace(route);
    if (!body) return;
    const journey = journeyAt("validate");
    journey.stages = journey.stages.map((stage) => ({ ...stage, selectable: true }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(frozenWorkspace(body, { journey })) });
  });
  const commands = trackCommands(page);
  await page.goto("/");
  await expect(page.getByTestId("helix-workbench")).toBeVisible();
  await expect(page.getByTestId("legacy-journey-toggle")).toHaveAttribute("aria-expanded", "false");
  for (const [index, stageId] of stageIds.entries()) {
    await stageButtons(page).nth(index).click();
    await expect(page.getByTestId("stage-view")).toHaveAttribute("data-selected-stage", stageId);
    await expectNoLegacyJourney(page);
    await expect(page.getByTestId("agent-commands")).toHaveCount(stageId === "validate" ? 1 : 0);
  }
  // Viewing stages sends no governed command (Gate 3 drafts its section content on open, lane D).
  expect(commands.filter((item) => !item.includes("/sections/"))).toEqual([]);
});

test("the Draft stage offers the retry StudyJourney offered, with the same governed key", async ({ page }) => {
  const state: DraftState = { cycles: ["CYCLE-BW-001"], attempts: [{ cycle: "CYCLE-BW-001", attempt: 1, action: "retry" }], canRevise: false };
  const bodies = await serveDraft(page, state);
  await openDraftStage(page);
  await expectNoLegacyJourney(page);
  // The server reports Draft complete, so the agent's stop is read from the evidence here.
  await expect(page.getByTestId("evidence-next-attempt")).toContainText("retry · attempt 1 of 3");
  const retry = page.getByTestId("agent-human-retry");
  await expect(retry).toHaveText("Retry candidate (attempt 2 of 3)");
  await expect(page.getByTestId("agent-human-revise")).toHaveCount(0);
  await retry.click();
  await expect(live(page)).toContainText("recorded by the server");
  // A person's decision keeps the Draft view; it does not follow the server stage (DH-1).
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "draft");
  expect(bodies.sectionRuns).toEqual([
    expect.objectContaining({ section_package_id: BW, idempotency_key: `workbench-${studyId}-body-weight-CYCLE-BW-001-attempt-2` }),
  ]);
  await expect(page.getByTestId("agent-human-retry")).toHaveText("Retry candidate (attempt 3 of 3)");
});

test("after stop_for_review there is no fourth attempt; revise and the new cycle's first attempt are on the Draft stage", async ({ page }) => {
  const state: DraftState = {
    cycles: ["CYCLE-BW-001"],
    attempts: [1, 2, 3].map((attempt) => ({ cycle: "CYCLE-BW-001", attempt, action: attempt === 3 ? "stop_for_review" : "retry" })),
    canRevise: true,
  };
  const bodies = await serveDraft(page, state);
  const commands = trackCommands(page);
  await openDraftStage(page);
  await expectNoLegacyJourney(page);
  await expect(page.getByTestId("agent-human-retry")).toHaveCount(0);
  await page.getByTestId("agent-human-revise").click();
  await expect(live(page)).toContainText(`${REVISED} opened from CYCLE-BW-001`);
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "draft");
  expect(bodies.revisions).toEqual([
    expect.objectContaining({ section_package_id: BW, idempotency_key: `workbench-${studyId}-revise-CYCLE-BW-001` }),
  ]);
  await expect(page.getByTestId("agent-human-revise")).toHaveCount(0);
  // The agent still reads the previous cycle's stop; the first attempt in the new cycle is a person's command.
  const draftCycle = page.getByTestId("agent-human-draft-cycle");
  await expect(draftCycle).toHaveText(`Draft attempt 1 in ${REVISED}`);
  await draftCycle.click();
  await expect(live(page)).toContainText("recorded by the server");
  expect(bodies.sectionRuns).toEqual([
    expect.objectContaining({ idempotency_key: `workbench-${studyId}-body-weight-${REVISED}-attempt-1` }),
  ]);
  await expect(page.getByTestId("agent-human-draft-cycle")).toHaveCount(0);
  expect(commands.filter((item) => !item.endsWith("/workspace"))).toEqual([
    `POST /api/v1/studies/${studyId}/section-revisions`,
    `POST /api/v1/studies/${studyId}/section-runs`,
  ]);
});

test("a stopped cycle with no revision offered shows the agent stop and no human commands", async ({ page }) => {
  const state: DraftState = {
    cycles: ["CYCLE-BW-001"],
    attempts: [1, 2, 3].map((attempt) => ({ cycle: "CYCLE-BW-001", attempt, action: attempt === 3 ? "stop_for_review" : "retry" })),
    canRevise: false,
  };
  const commands = trackCommands(page);
  await serveDraft(page, state);
  await openDraftStage(page);
  await expect(page.getByTestId("evidence-next-attempt")).toContainText("stop_for_review · attempt 3 of 3");
  await expect(page.getByTestId("agent-human-decisions")).toHaveCount(0);
  expect(commands).toEqual([]);
});

test("retry is hidden on the Draft stage exactly when StudyJourney hid it (legacy cap of 3 attempts)", async ({ page }) => {
  // The server asks for a retry at attempt 3 of 4; StudyJourney never offered a fourth attempt.
  const state: DraftState = {
    cycles: ["CYCLE-BW-001"],
    attempts: [1, 2, 3].map((attempt) => ({ cycle: "CYCLE-BW-001", attempt, action: "retry", maxAttempts: 4 })),
    canRevise: false,
  };
  const commands = trackCommands(page);
  await serveDraft(page, state);
  await openDraftStage(page);
  await expect(page.getByTestId("evidence-next-attempt")).toContainText("retry · attempt 3 of 4");
  await expect(page.getByTestId("agent-human-retry")).toHaveCount(0);
  await expect(page.getByTestId("agent-human-decisions")).toHaveCount(0);
  // Same shared predicate: the legacy panel hides its retry control too.
  await openLegacyJourney(page);
  await expect(page.getByTestId("candidate-attempt-CYCLE-BW-001-3")).toBeVisible();
  await expect(page.getByTestId("retry-body-weight")).toHaveCount(0);
  expect(commands).toEqual([]);
});

// P1 (Codex PRRT_kwDOUohZWs6l85Fw): /section-runs records only the candidate. After a person's
// retry, the next governed steps (query, then evaluation) must be reachable on the Draft stage
// with the legacy toggle OFF, although the server reports Draft (and later stages) complete.
test("after a person's retry the Draft stage offers the query, then the evaluation, with the legacy panel closed", async ({ page }) => {
  await confirmDataValidation(page); // in session: the agent already confirmed the Extract receipt
  const state: DraftState = { cycles: ["CYCLE-BW-001"], attempts: [{ cycle: "CYCLE-BW-001", attempt: 1, action: "retry" }], canRevise: false };
  const bodies = await serveDraft(page, state, { bare: true });
  const commands = trackCommands(page);
  await openDraftStage(page);
  await page.getByTestId("agent-human-retry").click();
  await expect(live(page)).toContainText("recorded by the server");
  const attemptTwo = runId("CYCLE-BW-001", 2);
  await expect(page.getByTestId("evidence-query")).toContainText("not run");
  const run = page.getByTestId("agent-run-step");
  await expect(run).toHaveText("Query declared dependencies");
  await expect(run).toBeEnabled();
  await run.click();
  await expect(live(page)).toContainText("Query declared dependencies: recorded by the server.");
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "draft");
  await expect(run).toHaveText("Evaluate candidate");
  await run.click();
  await expect(live(page)).toContainText("Evaluate candidate: recorded by the server.");
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "draft");
  // Evaluated: the agent stops for a person again, and the next retry is offered.
  await expect(page.getByTestId("agent-run-step")).toHaveCount(0);
  await expect(page.getByTestId("agent-human-retry")).toHaveText("Retry candidate (attempt 3 of 3)");
  await expectNoLegacyJourney(page);
  expect(bodies.queries).toEqual([attemptTwo]);
  expect(bodies.evaluations).toEqual([attemptTwo]);
  expect(commands.filter((item) => !item.endsWith("/workspace"))).toEqual([
    `POST /api/v1/studies/${studyId}/section-runs`,
    `POST /api/v1/studies/${studyId}/section-runs/${attemptTwo}/cross-section-queries`,
    `POST /api/v1/studies/${studyId}/section-runs/${attemptTwo}/evaluations`,
  ]);
});

test("after a reload, a person's first attempt in a new cycle leads through the Extract replay to the query on the Draft stage", async ({ page }) => {
  // New session: the Extract receipt is not confirmed yet, so the agent's real next step is its
  // idempotent replay. The Draft view still offers it, then the query, with the legacy panel closed.
  const state: DraftState = {
    cycles: ["CYCLE-BW-001", REVISED],
    attempts: [1, 2, 3].map((attempt) => ({ cycle: "CYCLE-BW-001", attempt, action: attempt === 3 ? "stop_for_review" : "retry" })),
    canRevise: false,
  };
  const bodies = await serveDraft(page, state, { bare: true });
  await openDraftStage(page);
  const replays: Json[] = [];
  await page.route("**/api/v1/studies/*/data-validation-packages", async (route) => {
    replays.push((route.request().postDataJSON() ?? {}) as Json);
    const execution = (freezeFixture.after.data_validation_executions as Json[])[0];
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ ...execution, receipt: { ...(execution.receipt as Json), idempotent_replay: true } }),
    });
  });
  await page.getByTestId("agent-human-draft-cycle").click();
  await expect(live(page)).toContainText("recorded by the server");
  const run = page.getByTestId("agent-run-step");
  await expect(run).toHaveText("Confirm Data Validation receipt (idempotent replay)");
  await run.click();
  await expect(live(page)).toContainText("idempotent replay");
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "draft");
  await expect(run).toHaveText("Query declared dependencies");
  await run.click();
  await expect(run).toHaveText("Evaluate candidate");
  expect(replays).toEqual([
    expect.objectContaining({ idempotency_key: `dvp-${freezeFixture.after.pinned_run.run_id}-validation.body_weight` }),
  ]);
  expect(bodies.queries).toEqual([runId(REVISED, 1)]);
  await expectNoLegacyJourney(page);
});

test("the legacy records stay reachable behind one toggle and hide again", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("helix-workbench")).toBeVisible();
  await openLegacyJourney(page);
  await expect(page.getByTestId("template-contract-gates")).toBeVisible();
  await page.getByTestId("legacy-journey-toggle").click();
  await expect(page.getByTestId("legacy-journey-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(legacyJourney(page)).toHaveCount(0);
});
