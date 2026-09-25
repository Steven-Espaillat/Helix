import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

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
import { claimStatus, type RuleDisplay } from "../src/components/traceability/gateState";

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

// #70: Gate 2 shows no blocker, rule or panel tallies; per-rule badges and the blocker
// list carry the status. Scoped to the gate chrome and the blocker card.
async function expectNoCountChrome(page: Page) {
  for (const id of ["traceability-gate", "gate-blockers"]) {
    const text = await page.getByTestId(id).innerText();
    expect(text, `${id} renders a tally`).not.toMatch(/\b\d+\s+(passed|blocked|blockers?|dispositions?|blocked rules?)\b/i);
    expect(text, `${id} renders an x-of-y tally`).not.toMatch(/\b\d+\s+of\s+\d+\s+(blockers?|rules?|dispositions?)\b/i);
  }
}

test("renders Gate 2 from server state with an accessible single-open accordion", async ({ page }) => {
  await serveGate(page);
  await openGate(page);

  await expect(page.getByText("Synthetic data · Not for submission", { exact: true })).toBeVisible();
  const banner = page.getByTestId("traceability-gate-banner");
  await expect(banner).toContainText("Human gate 2 of 3");
  await expect(banner).toContainText("Review the traceability of the agent's work");
  await expect(page.getByTestId("continue-to-review")).toBeDisabled();
  await expect(page.getByTestId("continue-hint")).toHaveText("Record a disposition for each blocked rule to continue.");
  await expect(page.getByRole("heading", { name: "Validation and traceability" })).toBeVisible();
  await expect(page.getByTestId("trace-claim-kicker")).toContainText("Claim C-BW-HIGH");
  await expect(page.getByTestId("trace-summary")).toHaveText("Needs disposition");
  await expect(page.getByTestId("trace-summary")).toHaveAttribute("data-status", "block");
  await expectNoCountChrome(page);

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
  // Lineage edges start collapsed (#70) and open on demand with every edge.
  await expect(evidence.getByTestId("lineage-disclosure")).not.toHaveAttribute("open", "");
  await expect(evidence.getByTestId("lineage-edges")).toBeHidden();
  await evidence.getByTestId("lineage-toggle").click();
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
  await expect(page.getByTestId("trace-summary")).toHaveText("Dispositioned");
  await expectNoCountChrome(page);
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
  await expect(page.getByTestId("gate-blockers")).toContainText("Blockers awaiting a disposition");
  await expect(page.getByTestId("blocker-VR-004")).toContainText("Disposition");
  await expectNoCountChrome(page);

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

  await expect(page.getByTestId("gate-blockers")).toContainText("Every blocker has a disposition");
  await expectNoCountChrome(page);
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

// DH-4 phase 1: the HITL report (ReportAssembly) renders only in the Gate 3 body, so these tests
// make Gate 3 selectable (status stays pending) and open it before each Inspect. Assertions are unchanged.
const reportReachable = (workspace: Json): Json => {
  const journey = workspace.journey as Journey;
  return {
    ...workspace,
    journey: {
      ...journey,
      stages: journey.stages.map((stage) => (stage.stage_id === "review-export" ? { ...stage, selectable: true } : stage)),
    },
  };
};

async function openReport(page: Page) {
  await stageButtons(page).nth(8).click();
  await expect(page.getByTestId("review-drafts-body")).toBeVisible();
}

test("Inspect on a report statement opens Gate 2 on that statement's claim", async ({ page }) => {
  await serveGate(page, reportReachable);
  await openGate(page);
  await expect(page.getByTestId("trace-claim-kicker")).toContainText("Claim C-BW-HIGH");

  // The legacy report panel's section S7 carries the liver statements (C-MI-LIVER).
  const inspectLiver = page.getByRole("button", { name: "Inspect 4 provenance edges" }).first();
  await openReport(page);
  await inspectLiver.click();
  await expect(page.getByTestId("trace-claim-kicker")).toContainText("Claim C-MI-LIVER");
  await expect(page.getByTestId("rule-badge-VR-005")).toBeVisible();
  await expect(page.getByTestId("claim-C-MI-LIVER")).toHaveAttribute("aria-pressed", "true");

  // Inspecting the same statement again reselects it after the reviewer switched away.
  await page.getByTestId("claim-C-BW-HIGH").click();
  await expect(page.getByTestId("trace-claim-kicker")).toContainText("Claim C-BW-HIGH");
  await openReport(page);
  await inspectLiver.click();
  await expect(page.getByTestId("trace-claim-kicker")).toContainText("Claim C-MI-LIVER");
});

/** Unique claim-backed blocks the server's report projection lists for a template section. */
async function reportClaims(request: APIRequestContext, sectionId: string): Promise<Array<{ claimId: string; edges: number }>> {
  const workspace = (await (await request.get(`${apiRoot}/studies/${studyId}/workspace`)).json()) as Json;
  const section = (workspace.report as { sections: Array<{ section_id: string; blocks: Array<Json> }> }).sections.find(
    (item) => item.section_id === sectionId,
  );
  const claims = new Map<string, number>();
  for (const block of section?.blocks ?? []) {
    const claimId = block.claim_id as string | null;
    if (claimId && !claims.has(claimId)) claims.set(claimId, (block.provenance_count as number | null) ?? 0);
  }
  return [...claims].map(([claimId, edges]) => ({ claimId, edges }));
}

test("a drafted section's Inspect opens Gate 2 on that section's own claim", async ({ page, request }) => {
  await serveGate(page, reportReachable);
  await openGate(page);
  await expect(page.getByTestId("trace-claim-kicker")).toContainText("Claim C-BW-HIGH");
  const navigator = page.getByRole("complementary", { name: "Report sections" });
  const paperClaims = page.getByTestId("draft-section-claims");

  await openReport(page);
  // 5.3.3 Microscopic Findings maps to template section S7, whose only claim is C-MI-LIVER.
  await navigator.getByRole("button", { name: /5\.3\.3 Microscopic Findings/ }).click();
  const inspectLiver = paperClaims.getByTestId("inspect-claim-C-MI-LIVER");
  await expect(inspectLiver).toHaveText("Inspect 4 provenance edges");
  await expect(paperClaims.getByRole("button")).toHaveCount(1);
  await inspectLiver.click();
  await expect(page.getByTestId("trace-claim-kicker")).toContainText("Claim C-MI-LIVER");
  await expect(page.getByTestId("claim-C-MI-LIVER")).toHaveAttribute("aria-pressed", "true");

  // 5.2.3 Body Weight (S5) offers one Inspect per claim the server reports for S5, each with
  // its own edge count. Before VR-004 is resolved on the server that is C-BW-HIGH (10 edges);
  // once a live "corrected" disposition resolves it, the server reports S5 by sex
  // (C-BW-HIGH-M and C-BW-HIGH-F), so the claims come from the live report, not a constant.
  const bodyWeight = await reportClaims(request, "S5");
  expect(bodyWeight.length).toBeGreaterThan(0);
  if (!LIVE_WRITES) expect(bodyWeight).toEqual([{ claimId: "C-BW-HIGH", edges: 10 }]);
  await openReport(page);
  await navigator.getByRole("button", { name: /5\.2\.3 Body Weight/ }).click();
  await expect(paperClaims.getByRole("button")).toHaveCount(bodyWeight.length);
  for (const [index, { claimId, edges }] of bodyWeight.entries()) {
    if (index > 0) {
      // DH-4: each Inspect moves to Gate 2; reopen the report in Gate 3 on 5.2.3 for the next claim.
      await openReport(page);
      await navigator.getByRole("button", { name: /5\.2\.3 Body Weight/ }).click();
    }
    const inspect = paperClaims.getByTestId(`inspect-claim-${claimId}`);
    await expect(inspect).toHaveText(`Inspect ${edges} provenance edges`);
    await inspect.click();
    await expect(page.getByTestId("trace-claim-kicker")).toContainText(`Claim ${claimId}`);
    await expect(page.getByTestId(`claim-${claimId}`)).toHaveAttribute("aria-pressed", "true");
  }

  // A section whose template section has no claims shows no Inspect button.
  await openReport(page);
  await navigator.getByRole("button", { name: /1\. Objective/ }).click();
  await expect(page.getByTestId("draft-section-claims")).toHaveCount(0);
});

test("the drafted section's review banner is a note, so the page keeps one status region", async ({ page }) => {
  await serveGate(page, reportReachable);
  await openGate(page);
  await openReport(page); // DH-4: the HITL report renders in the Gate 3 body.
  const navigator = page.getByRole("complementary", { name: "Report sections" });
  await navigator.getByRole("button", { name: /5\.2\.3 Body Weight/ }).click();
  const banner = page.locator(".report-view .review-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Needs your review.");
  await expect(page.getByRole("note", { name: "Section needs review" })).toBeVisible();
  // Static guidance must not be a second live status region (workbench.spec.ts:73 reads getByRole("status")).
  await expect(page.getByRole("status").filter({ hasText: "Needs your review" })).toHaveCount(0);
});

test("the Gate 2 evidence card shows source hashes, rule versions and exact reconciliation", async ({ page }) => {
  // Coverage moved from the removed EvidenceChain panel (workbench.spec full flow). The seed
  // has no source hashes until data validation runs after a qualified freeze, so C-BW-HIGH
  // serves the server-recorded lineage that flow captured (evidence/body-weight-claim-lineage.json).
  const lineage = JSON.parse(
    readFileSync(resolve(__dirname, "../../evidence/body-weight-claim-lineage.json"), "utf8"),
  ) as Json;
  await page.route("**/api/v1/studies/*/claims/C-BW-HIGH/evidence", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(lineage) }),
  );
  await serveGate(page);
  await openGate(page);

  const evidence = page.getByTestId("claim-evidence");
  await expect(evidence).toContainText("Claim evidence · C-BW-HIGH");
  await expect(evidence.getByTestId("evidence-source-hashes")).toContainText(/sha256:[0-9a-f]{12}/);
  await expect(evidence.getByTestId("evidence-rule-versions")).toContainText("body-weight-summary-recompute@1.0.0");
  await expect(evidence.getByTestId("evidence-stored")).toHaveText("286.2 g");
  await expect(evidence.getByTestId("evidence-recomputed")).toHaveText("286.2 g");
  await expect(evidence.getByTestId("evidence-exact-match")).toHaveText("Yes");
  await expect(evidence.getByTestId("evidence-grain")).toHaveText("Dose group");
  await expect(evidence.getByTestId("source-records").getByRole("row")).toHaveCount(11);

  // Liver claim, live getEvidence: source and claim agree (the old "Source and claim agree.").
  await page.getByTestId("claim-C-MI-LIVER").click();
  await expect(evidence).toContainText("Claim evidence · C-MI-LIVER");
  await expect(evidence.getByTestId("evidence-stored")).toHaveText("4 animals");
  await expect(evidence.getByTestId("evidence-recomputed")).toHaveText("4 animals");
  await expect(evidence.getByTestId("evidence-exact-match")).toHaveText("Yes");
  await expect(evidence.getByTestId("source-records").getByRole("row")).toHaveCount(5);
});

// DH-5 P2s (#34 Tester P2-1/P2-2, Codex thread PRRT_kwDOUohZWs6l8Tzz): the claim status chip
// is honest. Green "All rules pass" only for a non-empty all-pass set; warnings outrank
// "Dispositioned"; no results or only skipped results read neutral. Still no counts (#70).
test("claimStatus is green only for a non-empty all-pass set and never hides warnings", () => {
  const status = (displays: RuleDisplay[]) => {
    const { tone, status: key, label } = claimStatus(displays);
    return { tone, key, label };
  };
  expect(status([])).toEqual({ tone: "muted", key: "empty", label: "No rule results" });
  expect(status(["skipped"])).toEqual({ tone: "muted", key: "skipped", label: "Rules skipped" });
  expect(status(["pass", "skipped"])).toEqual({ tone: "muted", key: "skipped", label: "Rules skipped" });
  expect(status(["warning"])).toEqual({ tone: "warn", key: "warnings", label: "Warnings to review" });
  expect(status(["warning", "skipped"])).toEqual({ tone: "warn", key: "warnings", label: "Warnings to review" });
  expect(status(["pass", "warning"])).toEqual({ tone: "warn", key: "warnings", label: "Warnings to review" });
  expect(status(["disposition", "warning"])).toEqual({ tone: "warn", key: "warnings", label: "Warnings to review" });
  expect(status(["disposition", "pass"])).toEqual({ tone: "warn", key: "dispositioned", label: "Dispositioned" });
  expect(status(["blocked", "warning", "disposition"])).toEqual({ tone: "block", key: "blocked", label: "Needs disposition" });
  expect(status(["pass"])).toEqual({ tone: "pass", key: "pass", label: "All rules pass" });
  expect(status(["pass", "pass"])).toEqual({ tone: "pass", key: "pass", label: "All rules pass" });
  for (const displays of [[], ["warning"], ["skipped"], ["disposition", "warning"]] as RuleDisplay[][]) {
    expect(claimStatus(displays).label).not.toMatch(/\d/);
  }
});

test("the Gate 2 status chip reads neutral or warning, never green, for empty and warning-only claims", async ({ page }) => {
  // Route-mocked getEvidence: the live C-BW-HIGH chain with its validations replaced.
  let patch: (validations: Json[]) => Json[] = (validations) => validations;
  await page.route("**/api/v1/studies/*/claims/C-BW-HIGH/evidence", async (route) => {
    const body = (await (await route.fetch()).json()) as Json;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...body, validations: patch(body.validations as Json[]) }),
    });
  });
  await serveGate(page);
  const summary = page.getByTestId("trace-summary");

  // No rule results: neutral, and the accordion shows its empty state.
  patch = () => [];
  await openGate(page);
  await page.getByTestId("claim-C-BW-HIGH").click();
  await expect(summary).toHaveText("No rule results");
  await expect(summary).toHaveAttribute("data-status", "muted");
  await expect(summary).toHaveAttribute("data-claim-status", "empty");
  await expect(page.getByTestId("traceability-gate")).not.toContainText("All rules pass");

  // Only warning results: a warning state, not green.
  patch = (validations) => validations.map((item) => ({ ...item, status: "fail", severity: "warning" }));
  await openGate(page);
  await page.getByTestId("claim-C-BW-HIGH").click();
  await expect(summary).toHaveText("Warnings to review");
  await expect(summary).toHaveAttribute("data-status", "warn");
  await expect(summary).toHaveAttribute("data-claim-status", "warnings");
  // VR-003 passes live; here it is only a warning. (VR-004 may carry an earlier serial disposition.)
  await expect(page.getByTestId("rule-badge-VR-003")).toHaveText("Warning");
  await expectNoCountChrome(page);
});

test("a dispositioned blocker with a remaining warning reads Warnings to review, not Dispositioned", async ({ page }) => {
  // Display-only mocks, no writes: the workspace carries a recorded disposition for VR-004,
  // and getEvidence turns the passing rule into a warning.
  await page.route("**/api/v1/studies/*/claims/C-BW-HIGH/evidence", async (route) => {
    const body = (await (await route.fetch()).json()) as Json;
    const validations = (body.validations as Json[]).map((item) =>
      item.status === "pass" ? { ...item, status: "fail", severity: "warning", message: "Synthetic warning left to review." } : item,
    );
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...body, validations }) });
  });
  await serveGate(page, (workspace) => ({
    ...workspace,
    dispositions: [
      ...(workspace.dispositions as Json[]),
      {
        disposition_id: "RD-P2-MOCK-1",
        result_id: "VR-004",
        decision: "corrected",
        reason: "Synthetic display-only disposition.",
        reviewer: "Dr. Lane C Reviewer",
        timestamp: new Date().toISOString(),
        artifact_id: null,
        artifact_hash: null,
        dependency_fingerprint: null,
      },
    ],
  }));
  await openGate(page);
  await page.getByTestId("claim-C-BW-HIGH").click();
  await expect(page.getByTestId("rule-badge-VR-004")).toHaveText("Disposition");
  await expect(page.getByTestId("rule-badge-VR-003")).toHaveText("Warning");
  const summary = page.getByTestId("trace-summary");
  await expect(summary).toHaveText("Warnings to review");
  await expect(summary).toHaveAttribute("data-claim-status", "warnings");
  await expect(summary).not.toContainText("Dispositioned");
  await expect(summary).not.toContainText("All rules pass");
  await expectNoCountChrome(page);
});
