import { expect, test, type Page, type Route } from "@playwright/test";

import { nextAgentStep } from "../src/lib/api/agentSteps";
import type { Workspace } from "../src/lib/types";

import {
  clone,
  freezeFixture,
  frozenWorkspace,
  journeyAt,
  liveWorkspace,
  regulatoryClaim,
  stageButtons,
  trackCommands,
  type Json,
} from "./lane-a-helpers";

// Lane B (#21): the shared Agent Step view and the governed command sequence.
// The Pinned Run comes from the recorded freeze fixture, and every command response
// is mocked, so no test calls Codex or an LLM and none needs qualified packages.

const BW_SECTION = "section.5_2_3_body_weight";
const runId = freezeFixture.after.pinned_run.run_id;
const dvResults = (freezeFixture.after.data_validation_executions as Json[])[0].results as Json[];

const sectionNode = (freezeFixture.after.pinned_run.run_plan.nodes as Json[]).find((node) => node.node_id === BW_SECTION);
const SECTION_RUN_KEY_PREFIX = `workbench:STUDY-HLX-028:${runId}/${BW_SECTION}:section-run:${sectionNode?.package_version ?? "section-run.v1"}`;
// Backend freeze_data_validation_key(run_id): the freeze and Extract share one run-scoped key.
const DV_KEY = `dvp-${runId}-validation.body_weight`;
const CONFIRMED_KEY = "helix.agent-dv-confirmed.v1";

const hybridResult = { ...clone(dvResults[0]), result_id: "VR-HYBRID-TEST-1", executor_id: null };

type Harness = {
  validated: boolean;
  bodies: Record<string, Json[]>;
  sectionRun: (route: Route) => Promise<void>;
  dataValidation: (route: Route, attempt: number) => Promise<void>;
};

async function harness(page: Page, overrides: Partial<Harness> = {}) {
  const h: Harness = {
    validated: false,
    bodies: {},
    sectionRun: (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Section Agent unavailable (test double)." }),
      }),
    dataValidation: (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          ...(freezeFixture.after.data_validation_executions as Json[])[0],
          receipt: {
            ...((freezeFixture.after.data_validation_executions as Json[])[0].receipt as Json),
            idempotent_replay: true,
          },
        }),
      }),
    ...overrides,
  };
  const record = (name: string, route: Route) => {
    (h.bodies[name] ??= []).push((route.request().postDataJSON() ?? {}) as Json);
  };
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const live = await liveWorkspace(route);
    if (!live) return;
    const workspace = frozenWorkspace(live, {
      // Package results always appear in Workspace validations; a hybrid result is added only
      // after the validation run, so the agent must not mistake package results for it.
      validations: h.validated ? [...clone(dvResults), hybridResult] : clone(dvResults),
      section_run_eligibility: (live.section_run_eligibility as Json[]).map((entry) =>
        entry.section_package_id === BW_SECTION
          ? { ...entry, eligible: h.validated, reasons: h.validated ? [] : ["validation has not run"] }
          : entry,
      ),
      section_runs: [],
      cross_section_queries: [],
      candidate_evaluations: [],
      promotion_decisions: [],
      section_drafts: [],
      journey: journeyAt(h.validated ? "draft" : "validate"),
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(workspace) });
  });
  let dvAttempt = 0;
  await page.route("**/api/v1/studies/*/data-validation-packages", async (route) => {
    record("data-validation", route);
    dvAttempt += 1;
    await h.dataValidation(route, dvAttempt);
  });
  await page.route("**/api/v1/studies/*/validation-runs", async (route) => {
    record("validation", route);
    h.validated = true;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        run_id: "VAL-TEST-1",
        study_id: "STUDY-HLX-028",
        planner: "fixture",
        planner_label: "Fixture planner for tool-contract testing",
        llm_used: false,
        rule_bundle_version: "helix-rules-1.0.0",
        results: dvResults,
        created_at: "2026-09-24T12:00:00Z",
      }),
    });
  });
  await page.route("**/api/v1/studies/*/section-runs", async (route) => {
    record("section-run", route);
    await h.sectionRun(route);
  });
  // #25 run-event stream: no events in these tests (commands refresh the Workspace).
  await page.route("**/api/v1/studies/*/pinned-runs/*/events", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );
  await page.route("**/api/v1/studies/*/section-runs/*/**", async (route) => {
    record("after-section-run", route);
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "must not be called" }) });
  });
  return h;
}

const live = (page: Page) => page.getByTestId("agent-live");

async function confirmFreezeExecution(page: Page) {
  // The freeze-created execution was already confirmed by an earlier replay in this session.
  await page.addInitScript(
    ([key, value]) => window.sessionStorage.setItem(key, JSON.stringify([value])),
    [CONFIRMED_KEY, runId] as const,
  );
}

async function openStage(page: Page, name: RegExp) {
  await page.goto("/");
  await expect(page.getByTestId("helix-workbench")).toBeVisible();
  await stageButtons(page).filter({ hasText: name }).first().click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.clear());
});

// A Workspace refetch can still be in flight when a test ends; drop its route instead of
// failing on "route.fetch: Test ended" (teardown race, not a product failure).
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("current stage shows server boundary, evidence, and a disabled pause with its reason", async ({ page }) => {
  await harness(page);
  await page.goto("/");
  const view = page.getByTestId("agent-stage-view");
  await expect(view).toHaveAttribute("data-stage", "validate");
  await expect(page.getByTestId("agent-run-banner")).toContainText("Agent waiting · Stage 5 of 9");
  await expect(page.getByTestId("agent-run-banner")).toContainText("Next human gate: Traceability review");
  await expect(page.getByTestId("agent-stage-card")).toContainText("Stage 5 of 9 · Agent step");
  await expect(page.getByTestId("agent-activity-card").getByRole("heading", { name: "Agent activity" })).toBeVisible();
  await expect(page.getByTestId("agent-activity-count")).toHaveText(/^\d+ of \d+ actions$/);
  await expect(page.getByTestId("agent-live")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("agent-control-boundary")).toContainText("Control boundary");
  await expect(page.getByTestId("agent-stage-io")).toBeVisible();
  await expect(page.getByTestId("evidence-validation-count")).toContainText("not run");
  await expect(page.getByTestId("evidence-eligibility")).toContainText("Blocked");
  const pause = page.getByTestId("agent-pause");
  await expect(pause).toBeDisabled();
  await expect(pause).toHaveAccessibleDescription(/no pause or resume command/);
  await expect(page.getByText("Synthetic data · Not for submission").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(regulatoryClaim);
  await page.screenshot({ path: "../evidence/ui-lane-b/agent-validate-current.png", fullPage: true });
});

test("completed stages are read-only review of recorded actions and never send commands", async ({ page }) => {
  await harness(page);
  const commands = trackCommands(page);
  await openStage(page, /Parse/);
  const view = page.getByTestId("agent-stage-view");
  await expect(view).toHaveAttribute("data-stage", "parse");
  await expect(page.getByTestId("agent-stage-review")).toBeVisible();
  await expect(page.getByTestId("agent-commands")).toHaveCount(0);
  await expect(page.getByTestId("evidence-pinned-run")).toContainText(runId);
  await expect(page.getByTestId("evidence-governed-inputs")).toBeVisible();
  await expect(page.getByTestId("agent-action").first()).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("agent-action").first()).toContainText("Recorded");
  await openStage(page, /Extract/);
  await expect(page.getByTestId("evidence-dvp-receipt")).toBeVisible();
  await expect(page.getByTestId("evidence-dvp-rules")).not.toBeEmpty();
  expect(commands).toEqual([]);
});

test("the sequence replays Extract, waits for refreshed state, stops on the first failure, and runs nothing after it", async ({ page }) => {
  const h = await harness(page);
  const commands = trackCommands(page);
  await page.goto("/");
  await page.getByTestId("agent-run-sequence").click();
  await expect(live(page)).toHaveAttribute("data-tone", "block");
  await expect(live(page)).toContainText("Run governed Section Agent failed");
  await expect(live(page)).toContainText("Section Agent unavailable (test double).");
  await expect(live(page)).toContainText("later steps did not run");
  await expect(live(page)).toHaveAttribute("role", "status");
  await expect(live(page)).toHaveAttribute("aria-live", "polite");
  // Governed order: the freeze-created execution is re-addressed (replay), then validation,
  // then (after the refresh made the section eligible) the section run.
  expect(commands.filter((item) => !item.endsWith("/workspace"))).toEqual([
    "POST /api/v1/studies/STUDY-HLX-028/data-validation-packages",
    "POST /api/v1/studies/STUDY-HLX-028/validation-runs",
    "POST /api/v1/studies/STUDY-HLX-028/section-runs",
  ]);
  expect(h.bodies["data-validation"]).toEqual([
    { actor: "HELIX workbench", package_id: "validation.body_weight", idempotency_key: DV_KEY },
  ]);
  expect(h.bodies["after-section-run"]).toBeUndefined();
  // #17: governed resource (Pinned Run + section package), command, package version, action ID.
  expect(h.bodies["section-run"][0].idempotency_key).toBe(`${SECTION_RUN_KEY_PREFIX}:a1`);
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "draft");
  await expect(page.getByTestId("evidence-draft")).toHaveCount(0);
  await expect(page.getByTestId("agent-evidence-missing")).toContainText("has not run");
  await page.screenshot({ path: "../evidence/ui-lane-b/agent-sequence-stopped.png", fullPage: true });
  // Eligibility before and after the validation run, from the two server snapshots.
  await stageButtons(page).filter({ hasText: /Validate/ }).first().click();
  await expect(page.getByTestId("evidence-eligibility-before")).toContainText("Blocked");
  await expect(page.getByTestId("evidence-eligibility")).toContainText("Eligible to draft");
  await expect(page.getByTestId("evidence-validation-run")).toContainText("VAL-TEST-1");
  await page.screenshot({ path: "../evidence/ui-lane-b/agent-validate-eligibility-change.png", fullPage: true });
});

test("an unknown result reuses the key; a definite rejection gets a new attempt key", async ({ page }) => {
  let failFirst = true;
  await confirmFreezeExecution(page);
  const h = await harness(page, {
    validated: true,
    sectionRun: async (route) => {
      if (failFirst) {
        failFirst = false;
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Section run conflicts with server state (test double)." }),
      });
    },
  });
  await page.goto("/");
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "draft");
  const run = page.getByTestId("agent-run-step");
  await run.click();
  await expect(live(page)).toContainText("Run governed Section Agent failed");
  await run.click();
  await expect(live(page)).toContainText("conflicts with server state");
  await run.click();
  await expect.poll(() => h.bodies["section-run"]?.length).toBe(3);
  const keys = h.bodies["section-run"].map((body) => body.idempotency_key);
  expect(keys).toEqual([`${SECTION_RUN_KEY_PREFIX}:a1`, `${SECTION_RUN_KEY_PREFIX}:a1`, `${SECTION_RUN_KEY_PREFIX}:a2`]);
});

test("extract replays the freeze-created execution with the freeze's key and never runs a second one", async ({ page }) => {
  const executions = freezeFixture.after.data_validation_executions as Json[];
  const h = await harness(page);
  await page.goto("/");
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "validate");
  // The freeze already recorded the execution, so the next governed command is its replay.
  await expect(page.getByTestId("agent-replay-note")).toContainText("idempotent replay");
  await openStage(page, /Extract/);
  await expect(page.getByTestId("agent-commands")).toHaveCount(0);
  await openStage(page, /Validate/);
  await expect(page.getByTestId("agent-run-step")).toHaveText("Confirm Data Validation receipt (idempotent replay)");
  await page.getByTestId("agent-run-step").click();
  await expect(live(page)).toContainText("returned the recorded execution");
  await expect(live(page)).toContainText("as an idempotent replay");
  expect(h.bodies["data-validation"]).toHaveLength(1);
  // Confirmed for this Pinned Run: the next command is validation, not a second replay.
  await expect(page.getByTestId("agent-run-step")).toHaveText("Run deterministic and hybrid validation");
  expect(h.bodies["data-validation"][0].idempotency_key).toBe(DV_KEY);
  await stageButtons(page).filter({ hasText: /Extract/ }).first().click();
  await expect(page.getByTestId("evidence-dvp-replay")).toContainText("idempotent replay of the recorded execution");
  await expect(page.getByTestId("evidence-dvp-replay")).toContainText(String((executions[0].receipt as Json).receipt_id));
  await expect(page.getByTestId("evidence-dvp-receipt")).toContainText(String((executions[0].receipt as Json).receipt_id));
  await page.screenshot({ path: "../evidence/ui-lane-b/agent-extract-replay.png", fullPage: true });
});

test("extract executes the missing package once, with the freeze's run-scoped key", async ({ page }) => {
  const h = await harness(page);
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const liveBody = await liveWorkspace(route);
    if (!liveBody) return;
    // Freeze left the package absent: Extract is the current stage.
    const workspace = frozenWorkspace(liveBody, { data_validation_executions: [], validations: [], journey: journeyAt("extract") });
    if (h.bodies["data-validation"]?.length) {
      Object.assign(workspace, { data_validation_executions: freezeFixture.after.data_validation_executions, journey: journeyAt("validate") });
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(workspace) });
  });
  h.dataValidation = (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify((freezeFixture.after.data_validation_executions as Json[])[0]),
    });
  await page.goto("/");
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "extract");
  await page.getByTestId("agent-run-step").click();
  await expect(live(page)).toContainText("Execute Data Validation Package: recorded by the server.");
  expect(h.bodies["data-validation"]).toHaveLength(1);
  expect(h.bodies["data-validation"][0]).toMatchObject({ package_id: "validation.body_weight", idempotency_key: DV_KEY });
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "validate");
  // The execution is now confirmed for this Pinned Run: no replay is queued before validation.
  await expect(page.getByTestId("agent-run-step")).toHaveText("Run deterministic and hybrid validation");
});

// P1 (Codex PRRT_kwDOUohZWs6l2RQP): the decision reads the evaluation and promotion outcome,
// never the mere presence of the promotion decision that evaluation always records.
test.describe("next agent step after candidate evaluation", () => {
  const SR = "SR-TEST-0001";
  function evaluated(
    action: "retry" | "stop_for_review" | "hold",
    extra: { promotion_decisions?: Json[]; section_drafts?: Json[] } = {},
  ): Workspace {
    const attempt = action === "stop_for_review" ? 3 : 1;
    return {
      ...clone(freezeFixture.after),
      validations: [...clone(dvResults), hybridResult],
      section_run_eligibility: [{ section_package_id: BW_SECTION, eligible: true, reasons: [] }],
      section_runs: [{ receipt: { run_id: SR, section_package_id: BW_SECTION } }],
      cross_section_queries: [{ run_id: SR }],
      candidate_evaluations: [
        {
          run_id: SR,
          next_attempt_decision: {
            action,
            attempt,
            max_attempts: 3,
            reasons: action === "hold" ? ["Deterministic gates passed; promotion is out of scope"] : ["blocked"],
            blocking_receipt_ids: action === "hold" ? [] : ["PR-TEST-1"],
          },
        },
      ],
      // Evaluation always records a decision; for a blocked candidate it is ineligible.
      promotion_decisions: extra.promotion_decisions ?? [
        { run_id: SR, eligible: action === "hold", failed_condition_ids: action === "hold" ? [] : ["no_hard_blocker"] },
      ],
      section_drafts: extra.section_drafts ?? [],
    } as unknown as Workspace;
  }
  const confirmed = { confirmedDataValidationRuns: new Set([runId]) };

  test("a capped candidate (stop_for_review) is a human stop, never the Traceability gate", () => {
    const next = nextAgentStep(evaluated("stop_for_review"), confirmed);
    expect(next).toMatchObject({ kind: "human-decision", stageId: "draft" });
    expect(JSON.stringify(next)).toContain("stopped for review after 3 of 3 attempts");
  });

  test("retry is a human decision", () => {
    expect(nextAgentStep(evaluated("retry"), confirmed)).toMatchObject({ kind: "human-decision", stageId: "draft" });
  });

  test("hold with an eligible decision and no Section Draft runs promotion on that run", () => {
    expect(nextAgentStep(evaluated("hold"), confirmed)).toMatchObject({ action: "section-promotion", runId: SR });
  });

  test("hold with an ineligible decision stops for a person with the failed conditions", () => {
    const next = nextAgentStep(
      evaluated("hold", { promotion_decisions: [{ run_id: SR, eligible: false, failed_condition_ids: ["package_permission"] }] }),
      confirmed,
    );
    expect(next).toMatchObject({ kind: "human-decision", stageId: "draft" });
    expect(JSON.stringify(next)).toContain("package_permission");
  });

  test("Traceability is reported only once a Section Draft is promoted for the run", () => {
    const next = nextAgentStep(evaluated("hold", { section_drafts: [{ run_id: SR, draft_id: "SD-TEST-1" }] }), confirmed);
    expect(next).toMatchObject({ kind: "gate", stageId: "traceability" });
    // A draft for another run does not count.
    const other = nextAgentStep(evaluated("hold", { section_drafts: [{ run_id: "SR-OTHER", draft_id: "SD-TEST-2" }] }), confirmed);
    expect(other).toMatchObject({ action: "section-promotion" });
  });
});

// P1 (Codex PRRT_kwDOUohZWs6l2RQT): one command at a time across the agent and the legacy
// StudyJourney controls, and a double click starts one command.
test("legacy commands wait while an agent command is in flight; no duplicate POST /validation-runs", async ({ page }) => {
  await confirmFreezeExecution(page);
  const h = await harness(page);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/studies/*/validation-runs", async (route) => {
    (h.bodies.validation ??= []).push((route.request().postDataJSON() ?? {}) as Json);
    await gate; // hold the agent's validation in flight
    h.validated = true;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        run_id: "VAL-TEST-1",
        study_id: "STUDY-HLX-028",
        planner: "fixture",
        planner_label: "Fixture planner for tool-contract testing",
        llm_used: false,
        rule_bundle_version: "helix-rules-1.0.0",
        results: dvResults,
        created_at: "2026-09-24T12:00:00Z",
      }),
    });
  });
  const commands = trackCommands(page);
  await page.goto("/");
  const run = page.getByTestId("agent-run-step");
  await expect(run).toHaveText("Run deterministic and hybrid validation");
  await run.dblclick();
  await expect.poll(() => h.bodies.validation?.length ?? 0).toBe(1);
  await expect(run).toBeDisabled();
  await expect(page.getByTestId("agent-run-sequence")).toBeDisabled();
  for (const id of ["run-validation", "run-body-weight-validation", "draft-body-weight"]) {
    const control = page.getByTestId(id);
    if ((await control.count()) > 0) await expect(control).toBeDisabled();
  }
  await expect(page.getByTestId("run-validation")).toHaveCount(1);
  await page.getByTestId("run-validation").click({ force: true }).catch(() => undefined);
  release();
  await expect(live(page)).toContainText("Run deterministic and hybrid validation: recorded by the server.");
  expect(commands.filter((item) => item.endsWith("/validation-runs"))).toEqual([
    "POST /api/v1/studies/STUDY-HLX-028/validation-runs",
  ]);
  // Settled: the legacy controls are usable again.
  await expect(page.getByTestId("run-validation")).toBeEnabled();
});
