import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

import { clone, liveWorkspace, regulatoryClaim, stageButtons, trackCommands, type Json } from "./lane-a-helpers";

// Lane D (#23): Human Gate 3 review, per-role approvals, explicit export, downloads, and the
// HELIX_DEMO_UNQUALIFIED_PACKAGES labels. Every state below was captured from a real backend
// (see the fixture _note); the routes only replay it so the suite runs on the shipped tree.

type Fixture = {
  review: Json;
  approved: Json;
  fsa: Json;
  exported: Json;
  demo_review: Json;
  director_first_error: { status: number; body: Json };
  export_receipt: Json & { exported_at: string; artifacts: { artifact_id: string; checksum: string }[] };
  export_replay: Json;
  evidence: Json & { lineage: unknown[] };
  artifact_bytes: Record<string, { content_type: string; base64: string }>;
};

const fx = JSON.parse(readFileSync(resolve(__dirname, "fixtures/lane-d-review.json"), "utf8")) as Fixture;
const PRIORS = ["pathologist", "peer_reviewer", "qau"] as const;
const MEANINGS: Record<string, string> = {
  pathologist: "Scientific review complete",
  peer_reviewer: "Independent peer review complete",
  qau: "Quality assurance statement recorded",
  study_director: "Final report approval",
};
const DEMO = "Demo: not qualified";

type Phase = "review" | "approved" | "fsa" | "exported";
type Harness = {
  phase: Phase;
  demo: boolean;
  roles: string[];
  approvalBodies: Json[];
  exportPosts: number;
  exportFailuresLeft: number;
  evidenceRequests: string[];
  /** Last live GET workspace; POST mocks reuse it and never forward a command to the backend. */
  live: Json | null;
};

/** Real captured state for the phase, with approvals narrowed to the roles recorded so far. */
function stateFor(live: Json, h: Harness): Json {
  const workspace: Json = { ...live, ...clone(fx.review) };
  if (h.phase !== "review") Object.assign(workspace, clone(fx[h.phase]));
  if (h.phase === "review" && h.roles.length > 0) {
    const all = (fx.approved.approvals as Json[]) ?? [];
    workspace.approvals = h.roles.map((role) => all.find((item) => item.role === role)).filter(Boolean);
  }
  if (h.demo) {
    // Demo delta only touches pre-approval fields; keep later-phase approvals/gates.
    const { demo_unqualified_packages, pinned_run, release_candidate } = clone(fx.demo_review);
    Object.assign(workspace, { demo_unqualified_packages, pinned_run });
    if (h.phase === "review") workspace.release_candidate = release_candidate;
  } else {
    delete workspace.demo_unqualified_packages;
  }
  return workspace;
}

async function harness(page: Page, init: Partial<Harness> = {}): Promise<Harness> {
  const h: Harness = {
    phase: "review",
    demo: false,
    roles: [],
    approvalBodies: [],
    exportPosts: 0,
    exportFailuresLeft: 0,
    evidenceRequests: [],
    live: null,
    ...init,
  };
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const live = await liveWorkspace(route);
    if (live) {
      h.live = live;
      await json(route, 200, stateFor(live, h));
    }
  });
  await page.route("**/api/v1/studies/*/approvals", async (route) => {
    const body = route.request().postDataJSON() as Json;
    h.approvalBodies.push(body);
    const role = String(body.role);
    if (role === "study_director" && !PRIORS.every((item) => h.roles.includes(item))) {
      await json(route, fx.director_first_error.status, fx.director_first_error.body);
      return;
    }
    h.roles.push(role);
    if (role === "study_director") h.phase = "approved";
    await json(route, 200, stateFor(h.live ?? {}, h));
  });
  await page.route("**/api/v1/studies/*/final-study-approvals", async (route) => {
    h.phase = "fsa";
    await json(route, 200, stateFor(h.live ?? {}, h));
  });
  await page.route("**/api/v1/studies/*/exports", async (route) => {
    h.exportPosts += 1;
    if (h.exportFailuresLeft > 0) {
      h.exportFailuresLeft -= 1;
      await json(route, 409, { detail: "Synthetic export conflict injected by the test" });
      return;
    }
    const replay = h.phase === "exported";
    h.phase = "exported";
    await json(route, 200, replay ? fx.export_replay : fx.export_receipt);
  });
  await page.route("**/api/v1/studies/*/exports/*", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    const artifact = fx.artifact_bytes[id];
    if (!artifact || h.phase !== "exported") {
      await json(route, 409, { detail: "The artifact is not available before explicit export" });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": artifact.content_type, "Content-Disposition": `attachment; filename="${id}.json"` },
      body: Buffer.from(artifact.base64, "base64"),
    });
  });
  await page.route("**/api/v1/studies/*/claims/*/evidence", async (route) => {
    h.evidenceRequests.push(new URL(route.request().url()).pathname);
    await json(route, 200, fx.evidence);
  });
  return h;
}

// Workspace routes may still be in flight when a test ends (reloads, refresh after export).
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

function reviewStage(page: Page) {
  return page.getByTestId("review-stage");
}

test("renders the server report in three columns with blockers, references, and no regulatory claim", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await harness(page);
  const commands = trackCommands(page);
  await page.goto("/");
  await expect(reviewStage(page)).toBeVisible();
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-selected-stage", "review-export");
  const sections = fx.review.report as { sections: { section_id: string; title: string; status: string }[] };
  for (const section of sections.sections) {
    const item = page.getByTestId(`review-section-${section.section_id}`);
    await expect(item).toContainText(section.title);
  }
  // Default selection: the first section with a server review marker (S6).
  await expect(page.getByTestId("draft-canvas")).toContainText("Clinical pathology");
  await expect(page.getByTestId("draft-blocks").locator(".hx-flag")).not.toHaveCount(0);
  await page.getByTestId("review-section-S7").click();
  await expect(page.getByTestId("draft-canvas")).toContainText("Anatomic pathology");
  await expect(page.getByTestId("draft-canvas")).toContainText("Minimal hepatocellular hypertrophy");
  await expect(page.getByTestId("regulatory-references")).toBeVisible();
  // Required-fields panel removed upstream by Steven (per Perk); do not reintroduce.
  await expect(page.getByTestId("required-fields")).toHaveCount(0);
  await expect(reviewStage(page)).toContainText("A prepared package is not FDA acceptance.");
  await expect(page.getByTestId("synthetic-badge")).toHaveText("Synthetic data · Not for submission");
  expect(await page.locator("body").innerText()).not.toMatch(regulatoryClaim);
  await expect(page.getByText(DEMO)).toHaveCount(0);
  // The legacy ReportAssembly (base, now visible at Gate 3 again) generates a missing section
  // draft on mount. That POST is base behavior; the Gate 3 review view itself sends no command.
  expect(commands.filter((c) => !/^POST \S+\/sections\/[^/]+\/draft$/.test(c))).toEqual([]);
  expect(errors).toEqual([]);
});

test("inspect provenance reads the claim evidence endpoint and shows the lineage edges", async ({ page }) => {
  const h = await harness(page);
  await page.goto("/");
  await page.getByTestId("review-section-S5").click();
  await page.getByTestId("inspect-provenance-C-BW-HIGH-M").click();
  await expect(page.getByTestId("lineage-edges")).toBeVisible();
  await expect(page.getByTestId("lineage-edges").locator("li")).toHaveCount(fx.evidence.lineage.length);
  // Critique P1-b: the provenance readout carries no hashes.
  await expect(page.getByTestId("lineage-edges")).not.toContainText("sha256:");
  // Chief of Staff: the legacy panels (StudyJourney, ReportAssembly) stay reachable at Gate 3.
  for (const panel of await page.getByTestId("stage-view").locator(":scope > .view-content").all()) {
    await expect(panel).toBeVisible();
  }
  expect(h.evidenceRequests).toContain("/api/v1/studies/STUDY-HLX-028/claims/C-BW-HIGH-M/evidence");
});

test("records one role per call in any order; study director waits for the three priors; never exports", async ({
  page,
}) => {
  const h = await harness(page);
  const commands = trackCommands(page);
  await page.goto("/");
  const director = page.getByTestId("approve-study_director");
  await expect(director).toBeDisabled();
  // The reason is visible text tied to the button, not a tooltip.
  await expect(page.getByTestId("signoff-hint-study_director")).toHaveText("Unlocks after the three sign-offs above.");
  await expect(director).toHaveAttribute("aria-describedby", "hx-hint-study_director");
  await expect(page.getByTestId("export-final-package")).toBeDisabled();
  // Non-canonical order on purpose.
  for (const role of ["qau", "pathologist", "peer_reviewer"]) {
    await page.getByTestId(`approve-${role}`).click();
    await expect(page.getByTestId(`signoff-${role}`)).toHaveAttribute("data-signed", "true");
    await expect(page.getByTestId(`signoff-${role}`)).toContainText(MEANINGS[role]);
    if (role !== "peer_reviewer") await expect(director).toBeDisabled();
  }
  await expect(director).toBeEnabled();
  await director.click();
  await expect(page.getByTestId("signoff-study_director")).toHaveAttribute("data-signed", "true");
  expect(h.approvalBodies.map((body) => body.role)).toEqual(["qau", "pathologist", "peer_reviewer", "study_director"]);
  for (const body of h.approvalBodies) {
    expect(Object.keys(body).sort()).toEqual(["meaning", "reviewer", "role"]);
    expect(body.meaning).toBe(MEANINGS[String(body.role)]);
    expect(String(body.meaning).length).toBeGreaterThanOrEqual(4);
    expect(String(body.meaning).length).toBeLessThanOrEqual(200);
  }
  // Approvals alone never export and never pass the release gate client-side.
  await expect(page.getByTestId("export-final-package")).toBeDisabled();
  await expect(page.getByTestId("export-disabled-reason")).toHaveAttribute("data-gate", "ready_for_signature");
  await expect(page.getByTestId("export-disabled-reason")).toHaveText("Export unlocks after Final Study Approval is signed.");
  expect(commands.filter((command) => command.includes("/exports"))).toEqual([]);
  expect(h.exportPosts).toBe(0);
});

test("a server-refused approval shows the server detail and leaves the sign-off pending", async ({ page }) => {
  await harness(page);
  // Registered after the harness, so it wins: replay the real 409 the server returned when the
  // study director approved before the three priors.
  await page.route("**/api/v1/studies/*/approvals", (route) =>
    route.fulfill({
      status: fx.director_first_error.status,
      contentType: "application/json",
      body: JSON.stringify(fx.director_first_error.body),
    }),
  );
  await page.goto("/");
  await page.getByTestId("approve-pathologist").click();
  await expect(page.getByTestId("signoff-error-pathologist")).toContainText(String(fx.director_first_error.body.detail));
  await expect(page.getByTestId("signoff-error-pathologist")).toHaveAttribute("role", "alert");
  await expect(page.getByTestId("signoff-pathologist")).toHaveAttribute("data-signed", "false");
  expect(fx.director_first_error.status).toBe(409);
});

test("export is enabled only by the server ready_for_export gate and is its own action", async ({ page }) => {
  const h = await harness(page, { phase: "approved", roles: ["qau", "pathologist", "peer_reviewer", "study_director"] });
  const commands = trackCommands(page);
  await page.goto("/");
  await expect(page.getByTestId("export-final-package")).toBeDisabled();
  await page.getByTestId("approve-final-study").click();
  await expect(page.getByTestId("signoff-final-study-approval")).toHaveAttribute("data-signed", "true");
  await expect(page.getByTestId("review-approval-current")).toHaveAttribute("data-state", "current");
  await expect(page.getByTestId("review-approval-manifest-hash")).toHaveText(/^sha256:[a-f0-9]{64}$/);
  // Critique P1-a: the hash list is collapsed by default; every full hash is there on expand.
  expect(await page.getByTestId("approval-hashes").evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
  await expect(page.getByTestId("review-approval-manifest-hash")).toBeHidden();
  await page.getByTestId("approval-hashes-toggle").click();
  await expect(page.getByTestId("review-approval-manifest-hash")).toBeVisible();
  await expect(page.getByTestId("approval-hashes").locator('[data-testid^="review-approval-artifact-"]').first()).toBeVisible();
  // Final Study Approval recorded; still no export until the explicit click.
  expect(h.exportPosts).toBe(0);
  const exportButton = page.getByTestId("export-final-package");
  await expect(exportButton).toBeEnabled();
  // Progress does not complete on approval.
  await expect(stageButtons(page).nth(8)).not.toHaveAccessibleName(/\(Approved\)$|\(Complete\)$|\(Done\)$/);
  await exportButton.click();
  await expect(page.getByTestId("export-receipt")).toBeVisible();
  await expect(page.getByTestId("export-exported-at")).toHaveAttribute("datetime", fx.export_receipt.exported_at);
  // A first export is not a replay, so the repeat-export row is absent.
  await expect(page.getByTestId("export-idempotent-replay")).toHaveCount(0);
  await expect(exportButton).toHaveText("Package exported");
  await expect(exportButton).toBeDisabled();
  expect(h.exportPosts).toBe(1);
  expect(commands.filter((command) => command.endsWith("/exports"))).toEqual(["POST /api/v1/studies/STUDY-HLX-028/exports"]);
  await expect(page.getByRole("navigation", { name: "Journey progress" })).toContainText("9 of 9 stages complete");
});

test("downloads list every exported artifact and each download returns the checksummed server bytes", async ({
  page,
}) => {
  await harness(page, { phase: "fsa", roles: ["pathologist", "peer_reviewer", "qau", "study_director"] });
  await page.goto("/");
  await expect(page.getByTestId("downloads")).toHaveCount(0);
  await page.getByTestId("export-final-package").click();
  const downloads = page.getByTestId("downloads");
  await expect(downloads).toBeVisible();
  await expect(downloads.getByTestId("downloads-table").locator('[role="row"]:not(.head)')).toHaveCount(
    fx.export_receipt.artifacts.length,
  );
  for (const artifact of fx.export_receipt.artifacts) {
    await expect(page.getByTestId(`download-checksum-${artifact.artifact_id}`)).toHaveText(artifact.checksum);
    await expect(page.getByTestId(`download-media-${artifact.artifact_id}`)).toHaveText(
      fx.artifact_bytes[artifact.artifact_id].content_type,
    );
    await expect(downloads).toContainText(artifact.artifact_id);
    const link = page.getByTestId(`download-${artifact.artifact_id}`);
    await expect(link).toHaveAttribute(
      "href",
      new RegExp(`/api/v1/studies/STUDY-HLX-028/exports/${artifact.artifact_id}$`),
    );
    const pending = page.waitForEvent("download");
    await link.click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    const bytes = await readFile((await download.path())!);
    expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(artifact.checksum);
  }
  await expect(downloads.getByTestId("downloads-demo-note")).toHaveCount(0);
});

test("export errors are shown with a retry, and a replayed export is labeled idempotent", async ({ page }) => {
  const h = await harness(page, {
    phase: "fsa",
    roles: ["pathologist", "peer_reviewer", "qau", "study_director"],
    exportFailuresLeft: 1,
  });
  await page.goto("/");
  const exportButton = page.getByTestId("export-final-package");
  await exportButton.click();
  await expect(page.getByTestId("export-error")).toContainText("Synthetic export conflict injected by the test");
  await expect(page.getByTestId("export-error")).toContainText("Nothing was exported.");
  await expect(exportButton).toContainText("Retry export");
  await expect(page.getByTestId("downloads")).toHaveCount(0);
  await expect(stageButtons(page).nth(8)).toHaveAccessibleName(/\(Awaiting you\)$/);
  await exportButton.click();
  await expect(page.getByTestId("export-receipt")).toBeVisible();
  await expect(page.getByTestId("export-idempotent-replay")).toHaveCount(0);
  expect(h.exportPosts).toBe(2);
  // The server replays the same receipt for the same idempotency key.
  expect(fx.export_replay.idempotent_replay).toBe(true);
  expect(fx.export_replay.exported_at).toBe(fx.export_receipt.exported_at);
  expect(fx.export_replay.artifacts).toEqual(fx.export_receipt.artifacts);
});

test("reload restores sign-offs, receipt, downloads, and completed progress from getWorkspace alone", async ({ page }) => {
  await harness(page, { phase: "exported", roles: ["pathologist", "peer_reviewer", "qau", "study_director"] });
  const commands = trackCommands(page);
  await page.goto("/");
  await page.reload();
  for (const role of [...PRIORS, "study_director"]) {
    await expect(page.getByTestId(`signoff-${role}`)).toHaveAttribute("data-signed", "true");
  }
  await expect(page.getByTestId("signoff-final-study-approval")).toHaveAttribute("data-signed", "true");
  await expect(page.getByTestId("export-final-package")).toHaveText("Package exported");
  await expect(page.getByTestId("export-receipt")).toBeVisible();
  await expect(page.getByTestId("export-exported-at")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
  for (const artifact of fx.export_receipt.artifacts) {
    await expect(page.getByTestId(`download-checksum-${artifact.artifact_id}`)).toHaveText(artifact.checksum);
  }
  await expect(page.getByRole("navigation", { name: "Journey progress" })).toContainText("9 of 9 stages complete");
  await expect(reviewStage(page)).toHaveAttribute("data-gate-status", "complete");
  expect(commands).toEqual([]);
});

test("demo flag on: the review stage shows no demo UI; the server's pending packages are untouched", async ({
  page,
}) => {
  // Critique P1-c: the demo flag has no visible UI. The server still reports the packages.
  await harness(page, { demo: true });
  await page.goto("/");
  const packages = fx.demo_review.demo_unqualified_packages as { section_package_id: string; prototype_section_id: string }[];
  expect(packages.map((item) => item.section_package_id)).toEqual(["section.5_2_3_body_weight", "section.5_3_discussion"]);
  await expect(page.getByTestId("review-stage")).toBeVisible();
  for (const item of packages) {
    await page.getByTestId(`review-section-${item.prototype_section_id}`).click();
    await expect(page.getByTestId("draft-canvas")).toBeVisible();
  }
  await expect(page.getByText(DEMO)).toHaveCount(0);
  await expect(page.getByTestId("demo-mode-banner")).toHaveCount(0);
  await expect(page.locator(".demo-label, .demo-banner")).toHaveCount(0);
  // Packages stay pending: nothing claims qualification or invents hashes.
  for (const item of fx.demo_review.demo_unqualified_packages as Json[]) {
    expect(item.qualification_status).toBe("pending");
    expect(Object.keys(item)).not.toContain("qualification_hash");
  }
  expect(await page.locator("body").innerText()).not.toMatch(regulatoryClaim);
});

test("demo flag on: exported downloads show no demo note", async ({ page }) => {
  await harness(page, { demo: true, phase: "exported", roles: ["pathologist", "peer_reviewer", "qau", "study_director"] });
  await page.goto("/");
  await expect(page.getByTestId("downloads")).toBeVisible();
  await expect(page.getByTestId("downloads-demo-note")).toHaveCount(0);
  await expect(page.getByText(DEMO)).toHaveCount(0);
});

test("demo flag on: freeze stays a human action; nothing freezes on load or on approval", async ({ page }) => {
  // Upload stage (not yet frozen) with the demo flag reported by the server.
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const live = await liveWorkspace(route);
    if (live) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...live, demo_unqualified_packages: clone(fx.demo_review.demo_unqualified_packages) }),
      });
    }
  });
  const commands = trackCommands(page);
  await page.goto("/");
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-selected-stage", "upload");
  await expect(page.getByTestId("demo-mode-banner")).toHaveCount(0);
  await expect(page.getByTestId("freeze-manifest")).toBeDisabled();
  await page.waitForTimeout(1000);
  expect(commands.filter((command) => command.includes("/pinned-runs"))).toEqual([]);
  await expect(stageButtons(page).nth(0)).toHaveAccessibleName(/\(Awaiting you\)$/);
});

test("demo flag off: no demo label anywhere in the review stage or downloads", async ({ page }) => {
  await harness(page, { phase: "exported", roles: ["pathologist", "peer_reviewer", "qau", "study_director"] });
  await page.goto("/");
  await expect(page.getByTestId("downloads")).toBeVisible();
  await expect(page.getByText(DEMO)).toHaveCount(0);
  await expect(page.getByTestId("demo-mode-banner")).toHaveCount(0);
});
