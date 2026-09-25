import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { liveWorkspace, regulatoryClaim, type Json } from "./lane-a-helpers";

// DH-6 (Steven-Espaillat/Helix#71): Gate 3 disclaimer and export receipt copy. The exported state
// replays the captured lane D fixture over the live workspace (as review-export.spec does); nothing
// is posted to the backend.

type Artifact = { artifact_id: string; kind: string; status: string; checksum: string | null };
const fx = JSON.parse(readFileSync(resolve(__dirname, "fixtures/lane-d-review.json"), "utf8")) as {
  review: Json;
  exported: Json & { export_artifacts: Artifact[] };
};
const LAYOUT_LINE = "The report follows an FDA-like layout for demonstration only.";

async function serve(page: Page, phase: "review" | "exported") {
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const live = await liveWorkspace(route);
    if (!live) return;
    const workspace: Json = { ...live, ...structuredClone(fx.review) };
    if (phase === "exported") Object.assign(workspace, structuredClone(fx.exported));
    delete workspace.demo_unqualified_packages;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(workspace) });
  });
  await page.goto("/");
  await expect(page.getByTestId("review-stage")).toBeVisible();
}

for (const phase of ["review", "exported"] as const) {
  test(`the FDA-like layout line appears exactly once on the page, in the Gate 3 disclaimer (${phase})`, async ({ page }) => {
    await serve(page, phase);
    const disclaimer = page.getByTestId("review-stage").locator(".hx-review-disclaimer");
    await expect(disclaimer).toContainText("Synthetic data · Not for submission.");
    await expect(disclaimer).toContainText(LAYOUT_LINE);
    await expect(disclaimer).toContainText("HELIX makes no regulatory claim.");
    // Exactly once in the whole page text, not just inside Gate 3.
    const body = await page.locator("body").innerText();
    expect(body.split("FDA-like layout for demonstration only").length - 1).toBe(1);
    expect(body).not.toMatch(regulatoryClaim);
  });
}

test("the export receipt says what was exported and lists every approved file with its full hash", async ({ page }) => {
  await serve(page, "exported");
  const receipt = page.getByTestId("export-receipt");
  await expect(receipt).toBeVisible();
  const exported = fx.exported.export_artifacts.filter((item) => item.status === "exported");
  expect(exported.length).toBeGreaterThan(0);
  await expect(receipt.getByTestId("export-receipt-scope")).toContainText(
    `Only the ${exported.length} ${exported.length === 1 ? "file" : "files"} approved in Final Study Approval`,
  );
  await expect(receipt.getByTestId("export-receipt-hashes").locator("li")).toHaveCount(exported.length);
  for (const artifact of exported) {
    await expect(receipt.getByTestId(`export-receipt-hash-${artifact.artifact_id}`)).toHaveText(artifact.checksum!);
    expect(artifact.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  }
  // The receipt makes no demo or regulator claim.
  await expect(receipt).not.toContainText(/demo/i);
  await expect(receipt).not.toContainText(regulatoryClaim);
});
