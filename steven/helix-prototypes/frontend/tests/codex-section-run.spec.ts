import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const live = process.env.HELIX_CODEX_LIVE === "1";
const apiRoot = process.env.HELIX_API_URL ?? "http://127.0.0.1:8000/api/v1";

test.skip(!live, "Set HELIX_CODEX_LIVE=1 to run the real Codex SDK proof.");

test("drafts the body-weight component through the real Codex SDK", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByTestId("draft-body-weight")).toBeDisabled();
  await page.getByTestId("run-validation").click();
  await expect(page.getByTestId("draft-body-weight")).toBeEnabled();

  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/section-runs") && response.request().method() === "POST",
  );
  await page.getByTestId("draft-body-weight").click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  const receipt: unknown = await response.json();
  expect(isLiveReceipt(receipt)).toBeTruthy();

  await expect(page.getByTestId("section-run-receipt")).toContainText("Codex SDK receipt");
  await expect(page.getByTestId("section-run-receipt")).toContainText("helix-section-agent");
  await expect(page.getByTestId("section-run-receipt")).toContainText(receipt.codex_thread_id);

  const workspaceResponse = await request.get(`${apiRoot}/studies/STUDY-HLX-028/workspace`);
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace: unknown = await workspaceResponse.json();
  expect(isProvenSectionWorkspace(workspace, receipt)).toBeTruthy();

  const evidenceDirectory = resolve(process.cwd(), "../evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    resolve(evidenceDirectory, "codex-section-run-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  await page.screenshot({
    path: resolve(evidenceDirectory, "codex-section-run.png"),
    fullPage: true,
  });
});

type LiveReceipt = {
  agent_runtime: "codex_sdk";
  candidate_hash: string;
  codex_thread_id: string;
  envelope_hash: string;
  skill_hash: string;
  skill_references_hash: string;
  review_scaffold_revision: number;
};

function isLiveReceipt(value: unknown): value is LiveReceipt {
  return (
    isObject(value) &&
    value.agent_runtime === "codex_sdk" &&
    typeof value.codex_thread_id === "string" &&
    value.codex_thread_id.length > 0 &&
    !value.codex_thread_id.toLowerCase().includes("fixture") &&
    isHash(value.candidate_hash) &&
    isHash(value.envelope_hash) &&
    isHash(value.skill_hash) &&
    isHash(value.skill_references_hash) &&
    typeof value.review_scaffold_revision === "number"
  );
}

function isProvenSectionWorkspace(workspace: unknown, receipt: LiveReceipt): boolean {
  if (!isObject(workspace) || !Array.isArray(workspace.section_runs) || !isObject(workspace.release_gate)) {
    return false;
  }
  if (workspace.release_gate.status !== "blocked") {
    return false;
  }
  const run = workspace.section_runs.at(-1);
  if (!isObject(run) || !isObject(run.receipt) || !isObject(run.candidate)) {
    return false;
  }
  return (
    run.receipt.codex_thread_id === receipt.codex_thread_id &&
    run.receipt.skill_hash === receipt.skill_hash &&
    run.receipt.skill_references_hash === receipt.skill_references_hash &&
    run.receipt.candidate_hash === receipt.candidate_hash &&
    run.receipt.envelope_hash === receipt.envelope_hash &&
    run.receipt.review_scaffold_revision === receipt.review_scaffold_revision &&
    run.candidate.status === "section_draft_candidate" &&
    Array.isArray(run.candidate.validated_claim_ids) &&
    run.candidate.validated_claim_ids.length === 1 &&
    run.candidate.validated_claim_ids[0] === "C-BW-HIGH" &&
    JSON.stringify(run.candidate.content_blocks).includes("286.2 g")
  );
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
