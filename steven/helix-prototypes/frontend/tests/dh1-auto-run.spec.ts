import { expect, test, type Page, type Route } from "@playwright/test";

import { OPERATOR_STOP_MESSAGE, VALIDATION_PENDING_REASON } from "../src/lib/api/agentSteps";

import {
  clone,
  freezeFixture,
  frozenWorkspace,
  journeyAt,
  liveWorkspace,
  stageButtons,
  trackCommands,
  type Json,
} from "./lane-a-helpers";

// DH-1 (Steven-Espaillat/Helix#65): after the human freeze the workbench selects the
// server's current stage and starts the governed agent sequence once. Every command is
// mocked (no Codex, no LLM, no qualified packages needed). The freeze stays the human's.

const BW_SECTION = "section.5_2_3_body_weight";
const runId = freezeFixture.after.pinned_run.run_id;
const dvResults = (freezeFixture.after.data_validation_executions as Json[])[0].results as Json[];
const hybridResult = { ...clone(dvResults[0]), result_id: "VR-HYBRID-DH1", executor_id: null };
const EVIDENCE = "../evidence/demo-hardening/dh-1";

type Harness = {
  frozen: boolean;
  validated: boolean;
  freezeStatus: number;
  holdValidation: Promise<void> | null;
  /** Live-seed shape: a seeded validation result and the server's "not run yet" reason. */
  seeded: boolean;
  /** The server reports Human gate 2 as current once validation has run. */
  gateAfterValidation: boolean;
  /** Fail this many workspace reloads after the freeze (a transient network error). */
  failReloadsAfterFreeze: number;
  bodies: Record<string, Json[]>;
};

async function harness(page: Page, overrides: Partial<Harness> = {}) {
  const h: Harness = { frozen: false, validated: false, freezeStatus: 201, holdValidation: null, seeded: false, gateAfterValidation: false, failReloadsAfterFreeze: 0, bodies: {}, ...overrides };
  const record = (name: string, route: Route) => {
    (h.bodies[name] ??= []).push((route.request().postDataJSON() ?? {}) as Json);
  };
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    if (h.frozen && h.failReloadsAfterFreeze > 0) {
      h.failReloadsAfterFreeze -= 1;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Workspace unavailable (test double)." }) });
      return;
    }
    const live = await liveWorkspace(route);
    if (!live) return;
    const workspace = !h.frozen
      ? live
      : frozenWorkspace(live, {
          validations: h.validated
            ? [...clone(dvResults), hybridResult]
            : [...clone(dvResults), ...(h.seeded ? [{ ...clone(dvResults[0]), result_id: "VR-001", executor_id: null }] : [])],
          section_run_eligibility: (live.section_run_eligibility as Json[]).map((entry) =>
            entry.section_package_id === BW_SECTION
              ? {
                  ...entry,
                  eligible: h.validated,
                  reasons: h.validated ? [] : [h.seeded ? VALIDATION_PENDING_REASON : "validation has not run"],
                }
              : entry,
          ),
          section_runs: [],
          cross_section_queries: [],
          candidate_evaluations: [],
          promotion_decisions: [],
          section_drafts: [],
          journey: journeyAt(h.validated ? (h.gateAfterValidation ? "traceability" : "draft") : "validate"),
        });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(workspace) });
  });
  await page.route("**/api/v1/studies/*/pinned-runs", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    record("freeze", route);
    if (h.freezeStatus !== 201) {
      await route.fulfill({
        status: h.freezeStatus,
        contentType: "application/json",
        body: JSON.stringify({
          detail: [{ code: "invalid_package_qualification", subject: BW_SECTION, message: "Agentic package qualification has not passed" }],
        }),
      });
      return;
    }
    h.frozen = true;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(freezeFixture.after.pinned_run) });
  });
  await page.route("**/api/v1/studies/*/data-validation-packages", async (route) => {
    record("data-validation", route);
    const execution = (freezeFixture.after.data_validation_executions as Json[])[0];
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ ...execution, receipt: { ...(execution.receipt as Json), idempotent_replay: true } }),
    });
  });
  await page.route("**/api/v1/studies/*/validation-runs", async (route) => {
    record("validation", route);
    if (h.holdValidation) await h.holdValidation;
    h.validated = true;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        run_id: "VAL-DH1-1",
        study_id: "STUDY-HLX-028",
        planner: "fixture",
        planner_label: "Fixture planner for tool-contract testing",
        llm_used: false,
        rule_bundle_version: "helix-rules-1.0.0",
        results: dvResults,
        created_at: "2026-09-25T12:00:00Z",
      }),
    });
  });
  await page.route("**/api/v1/studies/*/section-runs", async (route) => {
    record("section-run", route);
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Section Agent unavailable (test double)." }),
    });
  });
  await page.route("**/api/v1/studies/*/pinned-runs/*/events", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );
  return h;
}

const live = (page: Page) => page.getByTestId("agent-live");
// Report Assembly (legacy panel) generates a missing section draft on first mount; that is
// not an agent command, and its timing against the freeze varies.
const posted = (commands: string[]) =>
  commands.filter((item) => !item.endsWith("/workspace") && !item.endsWith("/draft"));

async function humanFreeze(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("upload-gate")).toBeVisible();
  await page.getByTestId("freeze-consent").check();
  await page.getByTestId("freeze-manifest").click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.clear());
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("the human freeze starts the agent once at the server's current stage; it follows the server and stops on error", async ({ page }) => {
  const h = await harness(page);
  const commands = trackCommands(page);
  await humanFreeze(page);
  await expect(page.getByTestId("workbench-notice")).toContainText(`Manifest frozen by the server as Pinned Run ${runId}.`);
  await expect(page.getByTestId("agent-stage-view")).toBeVisible();
  // Stops on the first failed command; the error says later steps did not run.
  await expect(live(page)).toHaveAttribute("data-tone", "block");
  await expect(live(page)).toContainText("Run governed Section Agent failed");
  await expect(live(page)).toContainText("later steps did not run");
  // The view followed the server from Validate to Draft while the run was in flight.
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "draft");
  expect(posted(commands)).toEqual([
    "POST /api/v1/studies/STUDY-HLX-028/pinned-runs",
    "POST /api/v1/studies/STUDY-HLX-028/data-validation-packages",
    "POST /api/v1/studies/STUDY-HLX-028/validation-runs",
    "POST /api/v1/studies/STUDY-HLX-028/section-runs",
  ]);
  await page.screenshot({ path: `${EVIDENCE}/auto-run-stopped-on-error.png`, fullPage: true });
  // Once only: after it stops nothing restarts it; the manual controls are back.
  await expect(page.getByTestId("agent-run-sequence")).toBeVisible();
  await expect(page.getByTestId("agent-stop-sequence")).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(posted(commands)).toHaveLength(4);
  expect(h.bodies.freeze).toHaveLength(1);
});

test("Stop ends the run after the command in flight; nothing later is sent", async ({ page }) => {
  let release: () => void = () => undefined;
  const h = await harness(page, { holdValidation: new Promise<void>((resolve) => (release = resolve)) });
  const commands = trackCommands(page);
  await humanFreeze(page);
  await expect.poll(() => h.bodies.validation?.length ?? 0).toBe(1);
  const stop = page.getByTestId("agent-stop-sequence");
  await expect(stop).toHaveText("Stop agent");
  await expect(page.getByTestId("agent-run-sequence")).toHaveCount(0);
  await stop.click();
  await expect(stop).toHaveText("Stopping after this step…");
  await expect(stop).toBeDisabled();
  await page.screenshot({ path: `${EVIDENCE}/auto-run-stopping.png`, fullPage: true });
  release();
  await expect(live(page)).toContainText(OPERATOR_STOP_MESSAGE);
  await expect(page.getByTestId("agent-stop-sequence")).toHaveCount(0);
  // The validation the server already accepted settled; the view shows where the server is.
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "draft");
  await page.waitForTimeout(1000);
  expect(h.bodies["section-run"]).toBeUndefined();
  expect(posted(commands)).toEqual([
    "POST /api/v1/studies/STUDY-HLX-028/pinned-runs",
    "POST /api/v1/studies/STUDY-HLX-028/data-validation-packages",
    "POST /api/v1/studies/STUDY-HLX-028/validation-runs",
  ]);
  await page.screenshot({ path: `${EVIDENCE}/auto-run-operator-stop.png`, fullPage: true });
});

test("a reload of a frozen run never auto-starts the agent", async ({ page }) => {
  await harness(page, { frozen: true });
  const commands = trackCommands(page);
  await page.goto("/");
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "validate");
  await expect(page.getByTestId("agent-run-sequence")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(posted(commands)).toEqual([]);
});

test("a refused freeze starts nothing, and the agent never freezes on its own", async ({ page }) => {
  const h = await harness(page, { freezeStatus: 422 });
  const commands = trackCommands(page);
  await humanFreeze(page);
  await expect(page.getByTestId("freeze-refused")).toContainText(BW_SECTION);
  await expect(page.getByTestId("upload-gate")).toHaveAttribute("data-frozen", "false");
  await page.waitForTimeout(1500);
  expect(posted(commands)).toEqual(["POST /api/v1/studies/STUDY-HLX-028/pinned-runs"]);
  expect(h.bodies.freeze).toHaveLength(1);
});

test("when idle, a manual pick holds and sends nothing", async ({ page }) => {
  await harness(page);
  const commands = trackCommands(page);
  await humanFreeze(page);
  await expect(live(page)).toContainText("later steps did not run");
  const before = posted(commands).length;
  await stageButtons(page).filter({ hasText: /Validate/ }).first().click();
  await expect(page.getByTestId("agent-stage-view")).toHaveAttribute("data-stage", "validate");
  await stageButtons(page).nth(0).click();
  await expect(page.getByTestId("upload-gate")).toHaveAttribute("data-frozen", "true");
  await page.waitForTimeout(1000);
  await expect(page.getByTestId("upload-gate")).toBeVisible();
  expect(posted(commands)).toHaveLength(before);
  await page.screenshot({ path: `${EVIDENCE}/idle-manual-pick.png`, fullPage: true });
});

test("with seeded validation results, the server's pending reason still sends validation first", async ({ page }) => {
  await harness(page, { seeded: true });
  const commands = trackCommands(page);
  await humanFreeze(page);
  await expect(live(page)).toContainText("Run governed Section Agent failed");
  expect(posted(commands)).toEqual([
    "POST /api/v1/studies/STUDY-HLX-028/pinned-runs",
    "POST /api/v1/studies/STUDY-HLX-028/data-validation-packages",
    "POST /api/v1/studies/STUDY-HLX-028/validation-runs",
    "POST /api/v1/studies/STUDY-HLX-028/section-runs",
  ]);
});

test("Human gate 2 reported by the server stops the run; the agent never passes it", async ({ page }) => {
  const h = await harness(page, { gateAfterValidation: true });
  const commands = trackCommands(page);
  await humanFreeze(page);
  await expect(page.getByTestId("traceability-stage-view")).toBeVisible();
  // The stop message survives the move to the gate as the workbench notice.
  await expect(page.getByTestId("workbench-notice")).toContainText("The agent stops at Human gate 2. Only a person can pass it.");
  await page.waitForTimeout(1000);
  expect(h.bodies["section-run"]).toBeUndefined();
  expect(posted(commands)).toEqual([
    "POST /api/v1/studies/STUDY-HLX-028/pinned-runs",
    "POST /api/v1/studies/STUDY-HLX-028/data-validation-packages",
    "POST /api/v1/studies/STUDY-HLX-028/validation-runs",
  ]);
  await page.screenshot({ path: `${EVIDENCE}/auto-run-stops-at-gate-2.png`, fullPage: true });
});

const AUTO_RUN_COMMANDS = [
  "POST /api/v1/studies/STUDY-HLX-028/pinned-runs",
  "POST /api/v1/studies/STUDY-HLX-028/data-validation-packages",
  "POST /api/v1/studies/STUDY-HLX-028/validation-runs",
  "POST /api/v1/studies/STUDY-HLX-028/section-runs",
];

test("one failed reload after the freeze is retried and the agent still starts once", async ({ page }) => {
  const h = await harness(page, { failReloadsAfterFreeze: 1 });
  const commands = trackCommands(page);
  await humanFreeze(page);
  await expect(page.getByTestId("workbench-notice")).toContainText(`Manifest frozen by the server as Pinned Run ${runId}.`);
  await expect(live(page)).toContainText("Run governed Section Agent failed");
  expect(h.failReloadsAfterFreeze).toBe(0);
  expect(posted(commands)).toEqual(AUTO_RUN_COMMANDS);
});

test("if the reload keeps failing, Upload never claims the freeze and the agent starts after a manual reload", async ({ page }) => {
  await harness(page, { failReloadsAfterFreeze: 2 });
  const commands = trackCommands(page);
  await humanFreeze(page);
  await expect(page.getByTestId("freeze-reload-needed")).toContainText("the workspace did not reload");
  await expect(page.getByTestId("upload-gate")).toBeVisible();
  await expect(page.getByTestId("freeze-live")).not.toContainText("Manifest frozen");
  await expect(page.getByTestId("workbench-notice")).not.toContainText("Manifest frozen");
  await page.waitForTimeout(1000);
  expect(posted(commands)).toEqual(["POST /api/v1/studies/STUDY-HLX-028/pinned-runs"]);
  await page.screenshot({ path: `${EVIDENCE}/freeze-reload-needed.png`, fullPage: true });
  await page.getByTestId("freeze-reload").click();
  await expect(page.getByTestId("workbench-notice")).toContainText(`Manifest frozen by the server as Pinned Run ${runId}.`);
  await expect(live(page)).toContainText("Run governed Section Agent failed");
  expect(posted(commands)).toEqual(AUTO_RUN_COMMANDS);
});
