import { expect, test } from "@playwright/test";

import {
  clone,
  freezeFixture,
  frozenWorkspace,
  journeyAt,
  regulatoryClaim,
  serveWorkspace,
  stageButtons,
  trackCommands,
  withJourney,
  type Stage,
} from "./lane-a-helpers";

// Lane A (#19): the Progress Bar renders the backend nine-stage projection. The only
// local state is the selected reached stage.

const names = [
  "Upload",
  "Parse",
  "Resolve",
  "Extract",
  "Validate",
  "Draft",
  "Provenance",
  "Traceability review",
  "Review and export",
];

test("renders the seeded nine-stage projection with only Upload reachable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Journey progress" });
  await expect(nav).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(1);
  const buttons = stageButtons(page);
  await expect(buttons).toHaveCount(9);
  await expect(nav).toContainText("0 of 9 stages complete");
  await expect(buttons.nth(0)).toHaveAttribute("aria-current", "step");
  await expect(buttons.nth(0)).toHaveAccessibleName("Stage 1: Upload and authorize inputs (Awaiting you)");
  // Governance: the agent does not start before manifest authorization.
  for (let index = 1; index < 9; index += 1) {
    await expect(buttons.nth(index)).toBeDisabled();
    await expect(buttons.nth(index)).not.toHaveAttribute("aria-current", "step");
  }
  await expect(nav.locator(".hx-node.gate")).toHaveCount(3);
  await expect(nav.locator(".hx-spinner, [role=progressbar]")).toHaveCount(0);
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-selected-stage", "upload");
  await expect(page.getByTestId("synthetic-badge")).toHaveText("Synthetic data · Not for submission");
  expect(await page.locator("body").innerText()).not.toMatch(regulatoryClaim);
  expect(errors).toEqual([]);
});

test("labels every projected stage state from the server and marks the three human gates", async ({ page }) => {
  const journey = journeyAt("validate", "current", true);
  await serveWorkspace(page, (workspace) => frozenWorkspace(workspace, { journey }));
  await page.goto("/");
  const buttons = stageButtons(page);
  await expect(buttons).toHaveCount(9);
  const expected = [
    "Approved",
    "Done",
    "Done",
    "Done",
    "Agent running",
    "Agent",
    "Agent",
    "Human gate",
    "Human gate",
  ];
  for (const [index, label] of expected.entries()) {
    await expect(buttons.nth(index)).toHaveAccessibleName(new RegExp(`\\(${label}\\)$`));
    await expect(buttons.nth(index).locator(".hx-step-label")).toHaveText(
      (journey.stages[index] as Stage & { short_label: string }).short_label,
    );
  }
  expect(journey.stages.filter((stage) => stage.kind === "human_gate").map((stage) => stage.stage_id)).toEqual([
    "upload",
    "traceability",
    "review-export",
  ]);
  await expect(page.getByRole("navigation", { name: "Journey progress" }).locator(".hx-node.gate")).toHaveCount(3);
  await expect(buttons.nth(4)).toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("navigation", { name: "Journey progress" })).toContainText("4 of 9 stages complete");
  expect(names).toHaveLength(9);
});

for (const status of ["blocked", "paused"] as const) {
  test(`shows a ${status} current stage from the server without advancing`, async ({ page }) => {
    await serveWorkspace(page, (workspace) => frozenWorkspace(workspace, { journey: journeyAt("extract", status) }));
    await page.goto("/");
    const current = stageButtons(page).nth(3);
    await expect(current).toHaveAttribute("aria-current", "step");
    await expect(current).toHaveAccessibleName(new RegExp(`\\(${status === "blocked" ? "Blocked" : "Paused"}\\)$`));
    await expect(stageButtons(page).nth(4)).toBeDisabled();
  });
}

test("selecting a reached stage changes only the local view and sends no command", async ({ page }) => {
  await serveWorkspace(page, (workspace) => frozenWorkspace(workspace, { journey: journeyAt("validate", "current", true) }));
  const commands = trackCommands(page);
  await page.goto("/");
  const buttons = stageButtons(page);
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-selected-stage", "validate");
  await buttons.nth(0).click();
  await expect(buttons.nth(0)).toHaveClass(/is-selected/);
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-selected-stage", "upload");
  await expect(page.getByTestId("upload-gate")).toBeVisible();
  // The server stage is unchanged.
  await expect(buttons.nth(4)).toHaveAttribute("aria-current", "step");
  // Governance: a user cannot select a future stage.
  await expect(buttons.nth(5)).toBeDisabled();
  await buttons.nth(5).click({ force: true });
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-selected-stage", "upload");
  expect(commands).toEqual([]);
});

test("reload restores progress from the workspace and resets selection to the current stage", async ({ page }) => {
  await serveWorkspace(page, (workspace) => frozenWorkspace(workspace, { journey: journeyAt("validate", "current", true) }));
  await page.goto("/");
  await stageButtons(page).nth(1).click();
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-selected-stage", "parse");
  await page.reload();
  await expect(stageButtons(page).nth(4)).toHaveAttribute("aria-current", "step");
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-selected-stage", "validate");
});

test("governance: the agent never passes a human gate", async ({ page }) => {
  // The server holds Traceability review as the current gate; no agent stage runs past it.
  await serveWorkspace(page, (workspace) => frozenWorkspace(workspace, { journey: journeyAt("traceability") }));
  const commands = trackCommands(page);
  await page.goto("/");
  const buttons = stageButtons(page);
  await expect(buttons.nth(7)).toHaveAccessibleName(/\(Awaiting you\)$/);
  await expect(buttons.nth(7)).toHaveAttribute("aria-current", "step");
  await expect(buttons.nth(8)).toBeDisabled();
  await expect(page.getByRole("navigation", { name: "Journey progress" }).locator(".hx-spinner")).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(buttons.nth(7)).toHaveAttribute("aria-current", "step");
  expect(commands).toEqual([]);
});

test("governance: traceability cannot continue while the server reports an undisposed blocker", async ({ page }) => {
  await serveWorkspace(page, (workspace) => frozenWorkspace(workspace, { journey: journeyAt("traceability", "blocked") }));
  await page.goto("/");
  const buttons = stageButtons(page);
  // A blocked gate is shown as Blocked, never Approved or Pass.
  await expect(buttons.nth(7)).toHaveAccessibleName(/\(Blocked\)$/);
  await expect(buttons.nth(7)).not.toHaveAccessibleName(/Approved|Pass/);
  await expect(buttons.nth(8)).toBeDisabled();
});

test("governance: export stays a separate gate after approvals", async ({ page }) => {
  await serveWorkspace(page, (workspace) => frozenWorkspace(workspace, { journey: journeyAt("review-export") }));
  await page.goto("/");
  const last = stageButtons(page).nth(8);
  await expect(last).toHaveAccessibleName(/\(Awaiting you\)$/);
  await expect(page.getByRole("navigation", { name: "Journey progress" })).toContainText("8 of 9 stages complete");
});

test("contract: a ten-stage array is refused, not merged onto nine nodes", async ({ page }) => {
  const journey = clone(freezeFixture.before.journey);
  journey.stages = [...journey.stages, { ...journey.stages[8], stage_id: "export", short_label: "Export" }];
  await serveWorkspace(page, withJourney(journey));
  await page.goto("/");
  // The workspace contract check refuses it before the component renders; the
  // component's own nine-stage assertion is the second layer (see the next test).
  await expect(page.getByRole("heading", { name: "The workbench API is unavailable." })).toBeVisible();
  await expect(page.getByText("The workspace response does not match the generated API contract.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Journey progress" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Stage 10:/ })).toHaveCount(0);
});

test("contract: legacy stages without projection fields are refused", async ({ page }) => {
  const journey = clone(freezeFixture.before.journey);
  journey.stages = journey.stages.map(({ kind: _kind, ...rest }) => rest as Stage);
  await serveWorkspace(page, withJourney(journey));
  await page.goto("/");
  await expect(page.getByTestId("journey-contract-error")).toContainText("legacy stage");
});
