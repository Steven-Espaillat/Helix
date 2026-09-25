import { expect, test, type Page } from "@playwright/test";

import { apiRoot, stageButtons, studyId, type Json } from "./lane-a-helpers";

// DH-4 phase 1 (Steven-Espaillat/Helix#69): the HITL per-section drafts and grounded chat
// (ReportAssembly + ChatDock) render inside the Gate 3 body and nowhere else. The workspace is
// projected to Gate 3 current so every stage is selectable; drafts, revise, apply, discard,
// verify and chat history are the LIVE backend. Only the chat model turn is replayed, because
// the grounded model needs an LLM key; the proposal it carries is the backend's real /revise output.

async function atGate3(page: Page) {
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const response = await route.fetch();
    const workspace = (await response.json()) as Json & { journey: { stages: Json[] } };
    const stages = workspace.journey.stages;
    const last = stages.length - 1;
    workspace.journey = {
      ...workspace.journey,
      current_stage_id: stages[last].stage_id,
      stages: stages.map((stage, index) => ({ ...stage, status: index < last ? "complete" : "current", selectable: true })),
    };
    await route.fulfill({ status: response.status(), contentType: "application/json", body: JSON.stringify(workspace) });
  });
}

const sectionPath = (sectionId: string, tail: string) =>
  `${apiRoot}/studies/${encodeURIComponent(studyId)}/sections/${encodeURIComponent(sectionId)}/${tail}`;

test("the section drafts and chat render inside the Gate 3 body only, next to unchanged sign-offs and export", async ({
  page,
}) => {
  await atGate3(page);
  await page.goto("/");
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-selected-stage", "review-export");

  const gate3 = page.getByTestId("review-stage");
  const drafts = gate3.getByTestId("review-drafts-body");
  await expect(drafts).toBeVisible();
  await expect(drafts.locator(".report-view")).toHaveCount(1);
  await expect(drafts.getByTestId("generate-draft")).toBeVisible();
  await expect(drafts.getByTestId("chat-dock")).toHaveCount(1);
  // Gate 3 governance is unchanged and still owned by the review view.
  await expect(gate3.getByTestId("review-gate-banner")).toBeVisible();
  await expect(gate3.getByTestId("sign-offs")).toBeVisible();
  await expect(gate3.getByTestId("export-panel")).toBeVisible();
  // Exactly one report stack on the page.
  await expect(page.locator(".report-view")).toHaveCount(1);
  await expect(page.getByTestId("chat-dock")).toHaveCount(1);

  // No second report stack under any other stage view.
  const count = await stageButtons(page).count();
  for (let index = 0; index < count - 1; index += 1) {
    await stageButtons(page).nth(index).click();
    await expect(page.getByTestId("stage-view")).not.toHaveAttribute("data-selected-stage", "review-export");
    await expect(page.locator(".report-view")).toHaveCount(0);
    await expect(page.getByTestId("chat-dock")).toHaveCount(0);
    await expect(page.getByTestId("review-drafts-body")).toHaveCount(0);
  }
  await stageButtons(page).nth(count - 1).click();
  await expect(page.getByTestId("review-drafts-body").locator(".report-view")).toHaveCount(1);
});

test("generate, chat apply and discard, and verify all work from Gate 3 against the live draft endpoints", async ({
  page,
}) => {
  await atGate3(page);
  const firstDraft = page.waitForResponse(
    (response) => /\/sections\/[^/]+\/draft$/.test(new URL(response.url()).pathname) && response.request().method() === "GET",
  );
  await page.goto("/");
  const drafts = page.getByTestId("review-drafts-body");
  const firstId = decodeURIComponent(new URL((await firstDraft).url()).pathname.split("/").at(-2) ?? "");
  // Work on 5.3.2 Macroscopic Observations so the shared live DB keeps 5.2.3 Body Weight
  // "needs review" for the other specs (e.g. the review-banner note test in traceability-gate).
  const macroDraft = page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    return /\/sections\/[^/]+\/draft$/.test(path) && response.request().method() === "GET" && !path.includes(`/sections/${firstId}/`);
  });
  await drafts.getByRole("complementary", { name: "Report sections" }).getByRole("button", { name: /5\.3\.2 Macroscopic/ }).click();
  const sectionId = decodeURIComponent(new URL((await macroDraft).url()).pathname.split("/").at(-2) ?? "");
  expect(sectionId).not.toBe("");
  expect(sectionId).not.toBe(firstId);
  await expect(drafts.locator(".report-paper-header h3")).toContainText("5.3.2 Macroscopic");

  // Generate (Regenerate) from Gate 3 writes a new draft; it stays honestly marked "needs review".
  await expect(drafts.getByTestId("generate-draft")).toHaveText(/Regenerate|Generate draft/);
  const generated = page.waitForResponse(
    (response) => response.url() === sectionPath(sectionId, "draft") && response.request().method() === "POST",
  );
  await drafts.getByTestId("generate-draft").click();
  expect((await generated).status()).toBe(201);
  const chip = drafts.locator(".report-paper-header .document-status");
  await expect(chip).toContainText("needs review");
  await expect(drafts.getByTestId("verify-draft")).toBeVisible();

  // Grounded chat: the model turn is replayed with the backend's real proposed revision.
  let proposal: Json | null = null;
  await page.route("**/api/v1/studies/*/chat", async (route) => {
    if (route.request().method() !== "POST" || !proposal) return route.fallback();
    const body = route.request().postDataJSON() as Json;
    expect(body.section_id).toBe(sectionId);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        message: {
          message_id: 9_000_001,
          role: "assistant",
          content: "I drafted a rewrite. Apply it or discard it.",
          scope: "section",
          section_id: sectionId,
          intent: "revise",
          draft_version: proposal.version,
          created_at: new Date().toISOString(),
        },
        proposed: proposal,
      }),
    });
  });
  const revise = async (feedback: string) => {
    const response = await page.request.post(sectionPath(sectionId, "revise"), { data: { feedback } });
    expect(response.status()).toBe(201);
    return (await response.json()) as Json;
  };

  proposal = await revise("Tighten the opening sentence.");
  expect(proposal.status).toBe("proposed");
  await drafts.getByTestId("chat-input").fill("Tighten the opening sentence.");
  await drafts.getByTestId("chat-input").press("Enter");
  await expect(drafts.getByTestId("proposed-card")).toBeVisible();
  const applied = page.waitForResponse((response) => response.url() === sectionPath(sectionId, "apply"));
  await drafts.getByTestId("apply-proposed").click();
  expect((await applied).status()).toBe(200);
  await expect(drafts.getByTestId("proposed-card")).toHaveCount(0);
  await expect(drafts.getByTestId("chat-dock")).toContainText(`Applied v${proposal.version}`);

  proposal = await revise("Say it another way.");
  await drafts.getByTestId("chat-input").fill("Say it another way.");
  await drafts.getByTestId("chat-input").press("Enter");
  await expect(drafts.getByTestId("proposed-card")).toBeVisible();
  const discarded = page.waitForResponse((response) => response.url() === sectionPath(sectionId, "discard"));
  await drafts.getByTestId("discard-proposed").click();
  expect((await discarded).status()).toBe(200);
  await expect(drafts.getByTestId("proposed-card")).toHaveCount(0);
  await expect(drafts.getByTestId("chat-dock")).toContainText(`Discarded v${proposal.version}`);

  // Mark verified from Gate 3.
  await expect(chip).toContainText("needs review");
  const verified = page.waitForResponse((response) => response.url() === sectionPath(sectionId, "verify"));
  await drafts.getByTestId("verify-draft").click();
  expect((await verified).status()).toBe(200);
  await expect(chip).toContainText("verified");
  await expect(drafts.getByTestId("verify-draft")).toHaveCount(0);
});
