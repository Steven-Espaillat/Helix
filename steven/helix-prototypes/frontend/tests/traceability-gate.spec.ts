import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  apiRoot,
  clone,
  journeyAt,
  liveWorkspace,
  regulatoryClaim,
  stageButtons,
  studyId,
  trackCommands,
  type Json,
  type Journey,
} from "./lane-a-helpers";

// Lane C (#22): Human Gate 2, the Traceability Review.
//
// The seeded synthetic study cannot reach Gate 2 without a qualified freeze and a
// Codex section run, so the journey projection is served from the lane A fixture shape
// (`journeyAt`). Everything else is LIVE: validations, dispositions, `getEvidence`, and
// every disposition POST hit the real backend, and the projected Gate 2 actions are
// rebuilt from the live dispositions on every workspace read. The UI never decides.
//
// Tests run serially; later tests build on earlier dispositions.
//
// The shared e2e backend must stay at the fresh seed for the specs that run after this
// one (workbench.spec expects "Release blocked"), so by default ACCEPTED disposition
// writes go to a test-local double that echoes the typed command into the live workspace.
// Rejected writes (409) always hit the live server, which stores nothing. Set
// HELIX_LANE_C_LIVE_WRITES=1 against a lane-owned database to send every write live.
test.describe.configure({ mode: "serial" });

const LIVE_WRITES = process.env.HELIX_LANE_C_LIVE_WRITES === "1";
const doubled: Json[] = [];

function withDoubled(workspace: Json): Json {
  if (LIVE_WRITES || doubled.length === 0) return workspace;
  const gate = workspace.release_gate as Json & { blocking_result_ids: string[] };
  return {
    ...workspace,
    dispositions: [...(workspace.dispositions as Json[]), ...doubled],
    release_gate: {
      ...gate,
      blocking_result_ids: gate.blocking_result_ids.filter((id) => !doubled.some((item) => item.result_id === id)),
    },
  };
}

const REQUIRED = ["VR-004", "VR-005", "VR-006"];
const RECORDED = new Set(["corrected", "explained_in_nsdrg", "approved_exception"]);

const receipt = JSON.parse(
  readFileSync(resolve(__dirname, "../../evidence/candidate-evaluation-receipt.json"), "utf8"),
) as { evaluation: Json };

const allBindings = (receipt.evaluation.provenance_receipt as { bindings: Array<{ claim_id: string }> }).bindings;
const bwBindings = allBindings.filter((binding) => binding.claim_id === "C-BW-HIGH").length;

type Disposition = { result_id: string; decision: string; reviewer: string | null };

/** Gate 2 projection over the live dispositions (fixture shape; the server owns the real one). */
function gateJourney(workspace: Json): Journey {
  const latest = new Map<string, Disposition>();
  for (const item of workspace.dispositions as Disposition[]) latest.set(item.result_id, item);
  const done = (id: string) => {
    const item = latest.get(id);
    return Boolean(item && RECORDED.has(item.decision) && item.reviewer);
  };
  const allDone = REQUIRED.every(done);
  const journey = journeyAt(allDone ? "review-export" : "traceability", allDone ? "current" : "blocked");
  journey.stages = journey.stages.map((stage) =>
    stage.stage_id === "traceability"
      ? {
          ...stage,
          actions: REQUIRED.map((id) => ({
            action_id: `disposition:${id}`,
            label: done(id) ? `Blocker ${id} dispositioned` : `Blocker ${id} awaits disposition`,
            status: done(id) ? "done" : "blocked",
            outcome: done(id) ? "dispositioned" : "blocker",
            command: `POST /api/v1/studies/${studyId}/validation-results/${id}/dispositions`,
            detail: null,
          })),
        }
      : stage,
  );
  return journey;
}

async function serveGate(
  page: Page,
  extra: (workspace: Json) => Json = (workspace) => workspace,
  { live = LIVE_WRITES }: { live?: boolean } = {},
) {
  const project = (workspace: Json) => {
    const current = withDoubled(workspace);
    return extra({ ...current, journey: gateJourney(current) });
  };
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const workspace = await liveWorkspace(route);
    if (!workspace) return;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(project(workspace)) });
  });
  // The disposition POST returns the updated workspace; project Gate 2 over it too.
  await page.route("**/api/v1/studies/*/validation-results/*/dispositions", async (route) => {
    if (live) {
      const response = await route.fetch();
      const body = (await response.json()) as Json;
      const patched = response.ok() ? project(body) : body;
      await route.fulfill({ status: response.status(), contentType: "application/json", body: JSON.stringify(patched) });
      return;
    }
    const url = new URL(route.request().url());
    const resultId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
    const command = route.request().postDataJSON() as Json;
    doubled.push({
      disposition_id: `RD-DOUBLE-${doubled.length + 1}`,
      result_id: resultId,
      decision: command.decision,
      reason: command.reason,
      reviewer: command.reviewer,
      timestamp: new Date().toISOString(),
      artifact_id: null,
      artifact_hash: null,
      dependency_fingerprint: null,
    });
    const workspaceUrl = url.href.replace(/\/validation-results\/.*$/, "/workspace");
    const response = await route.fetch({ url: workspaceUrl, method: "GET", postData: undefined });
    const workspace = (await response.json()) as Json;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(project(workspace)) });
  });
}

async function openGate(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("release-status")).toBeVisible();
  await stageButtons(page).nth(7).click();
  await expect(page.getByTestId("traceability-stage-view")).toBeVisible();
  await expect(page.getByTestId("rule-accordion")).toBeVisible();
}

test("renders Gate 2 from server state with an accessible single-open accordion", async ({ page }) => {
  await serveGate(page);
  await openGate(page);

  await expect(page.getByText("Synthetic data · Not for submission", { exact: true })).toBeVisible();
  const banner = page.getByTestId("traceability-gate-banner");
  await expect(banner).toContainText("Human gate 2 of 3");
  await expect(banner).toContainText("Review the traceability of the agent's work");
  await expect(page.getByTestId("continue-to-review")).toBeDisabled();
  await expect(page.getByTestId("continue-hint")).toContainText("Record a disposition for 3 blocked rules");
  await expect(page.getByRole("heading", { name: "Validation and traceability" })).toBeVisible();
  await expect(page.getByTestId("trace-claim-kicker")).toContainText("Claim C-BW-HIGH");
  await expect(page.getByTestId("trace-summary")).toContainText("1 passed");
  await expect(page.getByTestId("trace-summary")).toContainText("1 blocked");

  const rows = page.getByTestId("rule-accordion").locator(".hx-acc-btn");
  await expect(rows).toHaveCount(2);
  // The blocker opens first, like the reference.
  const blocker = page.getByRole("button", { name: /Grain sex stratified/ });
  const pass = page.getByRole("button", { name: /Claim provenance/ });
  await expect(blocker).toHaveAttribute("aria-expanded", "true");
  await expect(blocker).toHaveAttribute("aria-controls", "hx-rule-VR-004");
  await expect(page.locator("#hx-rule-VR-004")).toBeVisible();
  await expect(page.getByTestId("rule-badge-VR-004")).toHaveText("Blocked");
  await expect(page.getByTestId("rule-note-VR-004")).toContainText("Blocker:");

  // Only one row opens at a time, by keyboard.
  await pass.focus();
  await page.keyboard.press("Enter");
  await expect(pass).toHaveAttribute("aria-expanded", "true");
  await expect(blocker).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#hx-rule-VR-004")).toBeHidden();
  await expect(page.getByTestId("rule-badge-VR-003")).toHaveText("Pass");
  await page.keyboard.press("Space");
  await expect(pass).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".hx-acc-item.is-open")).toHaveCount(0);

  await expect(page.locator("body")).not.toContainText(regulatoryClaim);
});

test("loads getEvidence per claim and shows the five-step flow, lineage, and receipts", async ({ page }) => {
  const evidenceCalls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/evidence")) evidenceCalls.push(new URL(request.url()).pathname);
  });
  await serveGate(page, (workspace) => ({ ...workspace, candidate_evaluations: [receipt.evaluation] }));
  await openGate(page);

  const flow = page.getByTestId("trace-flow");
  await expect(flow.locator("li")).toHaveCount(5);
  await expect(flow.locator('[data-step="source"]')).toContainText("10 BW records");
  await expect(flow.locator('[data-step="source"]')).toContainText(" … ");
  await expect(flow.locator('[data-step="facts"]')).toContainText("domain=BW");
  await expect(flow.locator('[data-step="transform"]')).toContainText("mean-v1");
  await expect(flow.locator('[data-step="transform"]')).toContainText("inputs=10");
  await expect(flow.locator('[data-step="claim"]')).toContainText("286.2 g");
  await expect(flow.locator('[data-step="claim"]')).toContainText("C-BW-HIGH · ");
  await expect(flow.locator('[data-step="report"]')).toContainText("Terminal mean body weight");
  // Steps checked by the blocked grain rule carry the block tone.
  await expect(flow.locator("li.f-block")).toHaveCount(3);

  const evidence = page.getByTestId("claim-evidence");
  await expect(evidence.getByTestId("source-records").getByRole("row")).toHaveCount(11);
  await expect(evidence.getByTestId("lineage-edges").getByRole("row")).toHaveCount(11);
  await expect(evidence.getByTestId("claim-lineage")).toContainText("mean-v1");
  await expect(evidence.getByTestId("claim-lineage")).toContainText("@");
  // Recomputation and exact match moved from the flow to the full evidence facts.
  await expect(evidence.getByTestId("claim-lineage")).toContainText("286.2 g");
  await expect(evidence.getByTestId("claim-lineage")).toContainText("Yes");

  const receipts = page.getByTestId("candidate-receipts");
  await expect(receipts.getByTestId("receipt-provenance")).toContainText(`${bwBindings} of ${allBindings.length} bindings for C-BW-HIGH`);
  await expect(receipts.getByTestId("receipt-template")).toContainText("Template conformance");
  await expect(receipts.getByTestId("receipt-output")).toContainText("Study-output evaluation");
  await expect(receipts.getByTestId("receipt-next-attempt")).toContainText("attempt 1 of 3");
  await expect(receipts.getByTestId("receipt-hashes")).toContainText("provenance");

  // Changing the claim reloads getEvidence and the accordion.
  await page.getByTestId("claim-C-MI-LIVER").click();
  await expect(page.getByTestId("trace-claim-kicker")).toContainText("Claim C-MI-LIVER");
  await expect(page.getByTestId("rule-badge-VR-005")).toHaveText("Blocked");
  await expect(page.getByTestId("trace-flow").locator('[data-step="transform"]')).toContainText("incidence-count-v1");
  // Receipts follow the selected claim: the stored candidate binds only body-weight claims,
  // so C-MI-LIVER shows a claim-scoped empty state, never the body-weight candidate.
  await expect(receipts).toHaveAttribute("data-empty", "true");
  await expect(receipts).toContainText("No candidate evaluation covers C-MI-LIVER");
  await expect(receipts.getByTestId("receipt-provenance")).toHaveCount(0);
  await expect(receipts).not.toContainText(String(receipt.evaluation.candidate_id));
  await page.getByTestId("claim-C-BW-HIGH").click();
  await expect(receipts.getByTestId("receipt-provenance")).toContainText(`${bwBindings} of ${allBindings.length} bindings for C-BW-HIGH`);
  expect(evidenceCalls.some((path) => path.endsWith("/claims/C-BW-HIGH/evidence"))).toBeTruthy();
  expect(evidenceCalls.some((path) => path.endsWith("/claims/C-MI-LIVER/evidence"))).toBeTruthy();
});

test("mirrors server limits client-side and keeps server rejections in the form", async ({ page }) => {
  const commands = trackCommands(page);
  // Live: the server rejects this command (409) and stores nothing.
  await serveGate(page, undefined, { live: true });
  await openGate(page);

  await page.getByTestId("record-disposition-VR-004").click();
  const form = page.getByTestId("disposition-form-VR-004");
  await expect(form).toBeVisible();

  // Client feedback: nothing is sent.
  await form.getByTestId("disposition-submit").click();
  await expect(form.locator(".hx-disp-error").getByText("Choose a decision.")).toBeVisible();
  await expect(form.locator(".hx-disp-error").getByText(/Reason must be 8 to 500 characters/)).toBeVisible();
  await expect(form.locator(".hx-disp-error").getByText(/Reviewer must be 2 to 120 characters/)).toBeVisible();
  await expect(form.getByTestId("disposition-live")).toContainText("3 fields need attention");
  await expect(form.getByRole("radio", { name: "Corrected" })).toBeFocused();
  expect(commands).toEqual([]);

  // Server 409: the server decides which decision is allowed for this blocker.
  await form.getByRole("radio", { name: "Approved exception" }).check();
  await form.getByLabel("Reason").fill("Synthetic reviewer note for the grain blocker.");
  await form.getByLabel("Reviewer").fill("Dr. Lane C Reviewer");
  await form.getByTestId("disposition-submit").click();
  await expect(form.getByTestId("disposition-server-error")).toContainText("not allowed for VR-004");
  await expect(form.getByTestId("disposition-live")).toContainText("Server rejected the disposition");
  await expect(form.getByLabel("Reason")).toHaveValue("Synthetic reviewer note for the grain blocker.");
  await expect(page.getByTestId("rule-badge-VR-004")).toHaveText("Blocked");
  expect(commands).toEqual([`POST /api/v1/studies/${studyId}/validation-results/VR-004/dispositions`]);

  // Server 422 (FastAPI field errors) stays attached to the field.
  await page.route("**/validation-results/VR-004/dispositions", (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        detail: [{ type: "string_too_short", loc: ["body", "reviewer"], msg: "String should have at least 2 characters" }],
      }),
    }),
  );
  await form.getByRole("radio", { name: "Corrected" }).check();
  await form.getByTestId("disposition-submit").click();
  await expect(form.getByTestId("disposition-server-error")).toContainText("(422)");
  await expect(form.locator(".hx-disp-error").getByText("String should have at least 2 characters", { exact: true })).toBeVisible();
  await expect(form.getByLabel("Reviewer")).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByLabel("Reviewer")).toBeFocused();
});

test("a recorded disposition keeps the blocker and shows Disposition, never Pass", async ({ page, request }) => {
  const commands = trackCommands(page);
  const posted: unknown[] = [];
  page.on("request", (item) => {
    if (item.method() === "POST" && item.url().includes("/dispositions")) posted.push(item.postDataJSON());
  });
  await serveGate(page);
  await openGate(page);

  await page.getByTestId("record-disposition-VR-004").click();
  const form = page.getByTestId("disposition-form-VR-004");
  await form.getByRole("radio", { name: "Corrected" }).check();
  await form.getByLabel("Reason").fill("Re-run mean-v1 by sex before release. Flag kept in section 5.");
  await form.getByLabel("Reviewer").fill("Dr. Lane C Reviewer");
  await form.getByTestId("disposition-submit").click();

  await expect(form).toBeHidden();
  await expect(page.getByTestId("rule-badge-VR-004")).toHaveText("Disposition");
  await expect(page.getByTestId("rule-row-VR-004")).toHaveAttribute("data-display", "disposition");
  const note = page.getByTestId("rule-note-VR-004");
  await expect(note).toContainText("Disposition:");
  await expect(note).toContainText("Corrected. Re-run mean-v1 by sex before release.");
  await expect(note).toContainText("Reviewer Dr. Lane C Reviewer");
  await expect(note).toContainText(/RD-[A-Z0-9-]+/);
  await expect(page.getByTestId("trace-summary")).toContainText("1 disposition");
  await expect(page.getByTestId("rule-accordion").getByText("Pass", { exact: true })).toHaveCount(1); // VR-003 only
  await expect(page.getByTestId("continue-to-review")).toBeDisabled();
  expect(commands).toEqual([`POST /api/v1/studies/${studyId}/validation-results/VR-004/dispositions`]);

  // The wire command is exactly what the reviewer typed: no injected decision, reason
  // prefix, or fixed reviewer.
  expect(posted.at(-1)).toEqual({
    decision: "corrected",
    reason: "Re-run mean-v1 by sex before release. Flag kept in section 5.",
    reviewer: "Dr. Lane C Reviewer",
  });
  const workspace = (await (await request.get(`${apiRoot}/studies/${studyId}/workspace`)).json()) as Json;
  if (LIVE_WRITES) {
    // The server stored the same command.
    const stored = (workspace.dispositions as Array<Json>).filter((item) => item.result_id === "VR-004").at(-1);
    expect(stored).toMatchObject(posted.at(-1) as Json);
  }
  // The blocker is still a failing validation on the server.
  const validation = (workspace.validations as Array<Json>).find((item) => item.result_id === "VR-004");
  expect(validation?.status).toBe("fail");

  // Reload restores the disposition from getWorkspace.
  await page.reload();
  await stageButtons(page).nth(7).click();
  await page.getByTestId("claim-C-BW-HIGH").click();
  await expect(page.getByTestId("rule-badge-VR-004")).toHaveText("Disposition");
});

test("Continue waits for server-reported dispositions and Review, then only changes the view", async ({ page }) => {
  const commands = trackCommands(page);
  await serveGate(page);
  await openGate(page);
  await expect(page.getByTestId("gate-blockers")).toContainText("1 of 3 blockers have a disposition");

  for (const [resultId, decision, rule] of [
    ["VR-005", "Corrected", /Mi severity reconcile/],
    ["VR-006", "Approved exception", /Noael human judgment/],
  ] as const) {
    await page.getByTestId(`open-blocker-${resultId}`).click();
    await expect(page.getByRole("button", { name: rule })).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("continue-to-review")).toBeDisabled();
    await page.getByTestId(`record-disposition-${resultId}`).click();
    const form = page.getByTestId(`disposition-form-${resultId}`);
    await form.getByRole("radio", { name: decision }).check();
    await form.getByLabel("Reason").fill(`Synthetic reviewer disposition for ${resultId}.`);
    await form.getByLabel("Reviewer").fill("Dr. Lane C Reviewer");
    await form.getByTestId("disposition-submit").press("Enter");
    await expect(page.getByTestId(`rule-badge-${resultId}`)).toHaveText("Disposition");
  }

  await expect(page.getByTestId("gate-blockers")).toContainText("3 of 3 blockers have a disposition");
  const next = page.getByTestId("continue-to-review");
  await expect(next).toBeEnabled();
  await expect(page.getByTestId("continue-hint")).toHaveText("Reviewed and approved.");
  const before = commands.length;
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-selected-stage", "review-export");
  await expect(page.getByTestId("traceability-stage-view")).toHaveCount(0);
  expect(commands.length).toBe(before); // Continue sends no command.
  await expect(page.locator("body")).not.toContainText(regulatoryClaim);
});

test("Continue stays disabled when the server has not opened Review", async ({ page }) => {
  // All dispositions exist (previous test), but this projection keeps Review pending.
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const workspace = await liveWorkspace(route);
    if (!workspace) return;
    const current = withDoubled(workspace);
    const held = clone(gateJourney(current));
    held.stages = held.stages.map((stage) =>
      stage.stage_id === "review-export"
        ? { ...stage, status: "pending", selectable: false }
        : stage.stage_id === "traceability"
          ? { ...stage, status: "blocked", selectable: true }
          : stage,
    );
    held.current_stage_id = "traceability";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...current, journey: held }) });
  });
  await openGate(page);
  await expect(page.getByTestId("continue-to-review")).toBeDisabled();
  await expect(page.getByTestId("continue-hint")).toHaveText("Waiting for the server to open Review.");
});

test("with zero claims the gate shows an empty state and never requests evidence for an empty claim ID", async ({ page }) => {
  const evidenceCalls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/evidence")) evidenceCalls.push(new URL(request.url()).pathname);
  });
  await serveGate(page, (workspace) => ({ ...workspace, claims: [], candidate_evaluations: [receipt.evaluation] }));
  await page.goto("/");
  await expect(page.getByTestId("release-status")).toBeVisible();
  await stageButtons(page).nth(7).click();
  await expect(page.getByTestId("traceability-stage-view")).toBeVisible();
  await expect(page.getByTestId("trace-no-claims")).toBeVisible();
  await expect(page.getByTestId("trace-claim-kicker")).toHaveText("No claims");
  await expect(page.getByTestId("evidence-error")).toHaveCount(0);
  await expect(page.getByTestId("rule-accordion")).toHaveCount(0);
  await expect(page.getByTestId("candidate-receipts")).toHaveCount(0);
  // Required blockers stay listed from the server journey, without a claim to open.
  await expect(page.getByTestId("gate-blockers")).toContainText("No claim scope");
  await page.waitForLoadState("networkidle");
  expect(evidenceCalls).toEqual([]);
});
