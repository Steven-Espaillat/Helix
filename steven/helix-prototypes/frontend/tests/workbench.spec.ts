import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const apiRoot = process.env.HELIX_API_URL ?? "http://127.0.0.1:8000/api/v1";

test("runs the synthetic study from validation through explicit export", async ({ page, request }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByTestId("helix-workbench")).toBeVisible();
  await expect(page.getByText("Synthetic / not for submission", { exact: true })).toBeVisible();
  await expect(page.getByTestId("release-status")).toHaveText("blocked");
  await expect(page.getByTestId("draft-body-weight")).toBeDisabled();
  await expect(page.getByTestId("evaluate-candidate")).toBeDisabled();
  await expect(page.getByTestId("query-cross-section")).toBeDisabled();
  await expect(page.getByTestId("promote-section-draft")).toBeDisabled();
  await expect(page.getByTestId("section-run-ineligible")).toContainText("Run hybrid validation first");
  await expect(page.getByTestId("template-contract-gates")).toBeVisible();
  await expect(page.getByTestId("eligibility-section.5_2_3_body_weight")).toHaveText("blocked");
  await expect(page.getByTestId("eligibility-section.5_3_discussion")).toHaveText("blocked");
  await expect(page.getByLabel("Study summary").getByText("1,662", { exact: true })).toBeVisible();
  await page.screenshot({ path: "../evidence/helix-workbench-initial.png", fullPage: true });

  await page.getByRole("button", { name: /Authorized upload and frozen manifest/ }).click();
  await expect(page.getByTestId("source-manifest").locator(".source-manifest-row")).toHaveCount(10);
  await expect(page.getByTestId("source-manifest").getByText("body-weights.csv")).toBeVisible();
  await page.screenshot({ path: "../evidence/helix-source-manifest.png", fullPage: true });

  await page.getByTestId("run-validation").click();
  await expect(page.getByRole("status")).toContainText("13 checks completed");
  await expect(page.getByTestId("draft-body-weight")).toBeEnabled();
  await expect(page.getByTestId("evaluate-candidate")).toBeDisabled();
  await expect(page.getByTestId("query-cross-section")).toBeDisabled();
  await expect(page.getByTestId("promote-section-draft")).toBeDisabled();
  await expect(page.getByTestId("eligibility-section.5_2_3_body_weight")).toHaveText("ready");
  await expect(page.getByTestId("eligibility-section.5_3_discussion")).toHaveText("ready");
  const workspaceBeforeDraft = await request.get(`${apiRoot}/studies/STUDY-HLX-028/workspace`);
  expect(workspaceBeforeDraft.ok()).toBeTruthy();
  const eligibilityWorkspace: unknown = await workspaceBeforeDraft.json();
  await assertRenderedEligibility(page, eligibilityWorkspace);
  await expect(page.getByTestId("gate-TCR-BW-FIELDS")).toContainText("passed");
  await expect(page.getByTestId("gate-TCR-DISC-FIELDS")).toContainText("passed");
  await expect(page.getByTestId("impact-section.5_2_3_body_weight")).toContainText(
    "origin section.5_2_3_body_weight",
  );
  await expect(page.getByTestId("review-scaffold-history")).toBeVisible();
  await expect(page.getByTestId("review-scaffold-revision")).toBeVisible();
  const workspaceAfterValidation = eligibilityWorkspace as { review_scaffold_revisions?: Array<{ triggering_event_id?: string }> };
  const triggeringEventId = workspaceAfterValidation.review_scaffold_revisions?.[0]?.triggering_event_id;
  expect(triggeringEventId).toBeTruthy();
  await expect(page.getByTestId("review-scaffold-history")).toContainText(String(triggeringEventId));
  await expect(page.getByText("3", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /Report assembly/ }).click();
  await expect(page.getByTestId("review-scaffold-history")).toHaveCount(0);
  await page.getByRole("button", { name: /Study journey/ }).click();
  const runPlan = page.getByTestId("run-plan");
  await expect(runPlan.getByText(/^RUN-/)).toBeVisible();
  await expect(runPlan.getByText("REPEAT_DOSE_28D_RODENT", { exact: true })).toBeVisible();
  await runPlan.getByText(/Complete Run Plan/).click();
  await expect(runPlan.getByText("section.5_2_3_body_weight", { exact: true }).first()).toBeVisible();
  await expect(runPlan.getByText("helix-section-agent", { exact: true })).toBeVisible();
  await page.screenshot({ path: "../evidence/helix-run-plan.png", fullPage: true });

  const dataValidation = page.getByTestId("data-validation-package");
  await expect(dataValidation.getByText("validation.body_weight", { exact: true }).first()).toBeVisible();
  await expect(dataValidation.getByText("body-weight-summary@1.0.0")).toBeVisible();
  await expect(page.getByTestId("validated-claim-C-BW-HIGH").getByText("286.2 g")).toBeVisible();
  await expect(page.getByTestId("section-claim-references").getByText("section.5_2_3_body_weight")).toBeVisible();
  await expect(page.getByTestId("section-claim-references").getByText("section.5_3_discussion")).toBeVisible();
  await page.getByTestId("run-body-weight-validation").click();
  await expect(page.getByRole("status")).toContainText("persisted claims");
  const executionResponse = await request.post(`${apiRoot}/studies/STUDY-HLX-028/data-validation-packages`, {
    data: {
      actor: "HELIX workbench",
      package_id: "validation.body_weight",
      idempotency_key: "workbench-STUDY-HLX-028-validation.body_weight-v1",
    },
  });
  expect(executionResponse.ok()).toBeTruthy();
  const execution: unknown = await executionResponse.json();
  expect(isObject(execution) && isObject(execution.receipt) && execution.receipt.idempotent_replay === true).toBeTruthy();
  await mkdir(resolve(process.cwd(), "../evidence"), { recursive: true });
  await writeFile(
    resolve(process.cwd(), "../evidence/body-weight-validation-receipt.json"),
    `${JSON.stringify(execution, null, 2)}\n`,
  );
  await page.screenshot({ path: "../evidence/helix-body-weight-validation.png", fullPage: true });

  await page.getByRole("button", { name: /Evidence chain/ }).click();
  await expect(page.getByTestId("evidence-chain")).toBeVisible();
  await expect(page.getByText("286.2 g", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("10 exact records", { exact: true })).toBeVisible();
  await expect(page.getByText("Exact reconciliation passed", { exact: true })).toBeVisible();
  await expect(page.getByTestId("claim-lineage").getByText("dose_group", { exact: true })).toBeVisible();
  await expect(page.getByTestId("claim-lineage").getByText(/sha256:/)).toBeVisible();
  await expect(page.getByTestId("claim-lineage").getByText(/body-weight-summary-recompute@1.0.0/)).toBeVisible();
  const lineageResponse = await request.get(`${apiRoot}/studies/STUDY-HLX-028/claims/C-BW-HIGH/evidence`);
  expect(lineageResponse.ok()).toBeTruthy();
  const lineage: unknown = await lineageResponse.json();
  expect(isPersistedClaimLineage(lineage)).toBeTruthy();
  await writeFile(
    resolve(process.cwd(), "../evidence/body-weight-claim-lineage.json"),
    `${JSON.stringify(lineage, null, 2)}\n`,
  );
  await page.screenshot({ path: "../evidence/helix-body-weight-lineage.png", fullPage: true });

  await page.getByRole("button", { name: /Liver Hypertrophy Incidence/ }).click();
  await expect(page.getByText("4 animals", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Source and claim agree.", { exact: true })).toBeVisible();
  await expect(page.getByText("agent source severity match", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Report assembly/ }).click();
  await expect(page.getByRole("heading", { name: "Anatomic pathology" })).toBeVisible();
  await expect(
    page.locator(".report-paper").getByText("The pattern draft says moderate.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "OECD TG 407, 2025" }).first()).toBeVisible();

  for (let remaining = 3; remaining > 0; remaining -= 1) {
    const buttons = page.getByRole("button", { name: "Record synthetic disposition" });
    await expect(buttons).toHaveCount(remaining);
    await buttons.first().click();
    await expect(buttons).toHaveCount(remaining - 1);
  }
  await expect(
    page.locator(".report-paper").getByText("Minimal hepatocellular hypertrophy", { exact: false }),
  ).toBeVisible();

  await recordApproval(page, "Pathologist review");
  await recordApproval(page, "Independent peer review");
  await recordApproval(page, "Quality Assurance Unit statement");
  await recordApproval(page, "Study director approval");

  await expect(page.getByTestId("release-status")).toHaveText("ready for export");
  await expect(page.getByTestId("export-package")).toBeEnabled();
  await page.getByTestId("export-package").click();
  await expect(page.getByTestId("release-status")).toHaveText("exported");
  await expect(page.getByText("4 synthetic artifacts checksummed", { exact: false })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: /Study report PDF/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("repeat-dose-study-report.pdf");
  expect(await download.failure()).toBeNull();

  const workspaceResponse = await request.get(`${apiRoot}/studies/STUDY-HLX-028/workspace`);
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace: unknown = await workspaceResponse.json();
  expect(isExportedWorkspace(workspace)).toBeTruthy();
  expect(hasSingleBodyWeightExecution(workspace)).toBeTruthy();

  await page.screenshot({ path: "../evidence/helix-workbench-exported.png", fullPage: true });
  expect(browserErrors).toEqual([]);
});

test("keeps draft blocked when the API reports ineligible despite ready-looking claims", async ({
  page,
}) => {
  let sectionRunPosts = 0;
  await page.route("**/api/v1/studies/*/section-runs", async (route) => {
    if (route.request().method() === "POST") {
      sectionRunPosts += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "The Codex SDK adapter must not start." }),
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const response = await route.fetch();
    const workspace: unknown = await response.json();
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(withBlockedBodyWeight(workspace)),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("helix-workbench")).toBeVisible();
  await expect(page.getByTestId("eligibility-section.5_2_3_body_weight")).toHaveText("blocked");
  await expect(page.getByTestId("eligibility-section.5_3_discussion")).toHaveText("ready");
  await expect(page.getByTestId("draft-body-weight")).toBeDisabled();
  await expect(page.getByTestId("gate-TCR-BW-FIELDS")).toContainText("blocked");
  expect(sectionRunPosts).toBe(0);
});

test("enables draft from backend eligibility even when claims look incomplete", async ({ page }) => {
  let sectionRunPosts = 0;
  await page.route("**/api/v1/studies/*/section-runs", async (route) => {
    if (route.request().method() === "POST") {
      sectionRunPosts += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "The test must not start a Codex thread." }),
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const response = await route.fetch();
    const workspace: unknown = await response.json();
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(withForcedEligibility(workspace, true)),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("eligibility-section.5_2_3_body_weight")).toHaveText("ready");
  await expect(page.getByTestId("draft-body-weight")).toBeEnabled();
  expect(sectionRunPosts).toBe(0);
});

test("renders candidate evaluation and cross-section query from backend-owned workspace fields", async ({
  page,
}) => {
  const evaluation = injectedEvaluation();
  const query = injectedQuery();
  const promotion = injectedPromotion();
  let evaluationPosts = 0;
  let queryPosts = 0;
  let promotionPosts = 0;
  await page.route("**/api/v1/studies/*/section-runs", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "The test must not start a Codex thread." }),
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/v1/studies/*/section-runs/*/evaluations", async (route) => {
    evaluationPosts += 1;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(evaluation),
    });
  });
  await page.route("**/api/v1/studies/*/section-runs/*/cross-section-queries", async (route) => {
    queryPosts += 1;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(query),
    });
  });
  await page.route("**/api/v1/studies/*/section-runs/*/promotions", async (route) => {
    promotionPosts += 1;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Section promotion rejected: package_permission" }),
    });
  });
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const response = await route.fetch();
    const workspace: unknown = await response.json();
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(
        withRecordedCandidate(workspace, {
          includeEvaluation: evaluationPosts > 0,
          includeQuery: queryPosts > 0,
          includePromotion: evaluationPosts > 0,
          evaluation,
          query,
          promotion,
        }),
      ),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("evaluate-candidate")).toBeEnabled();
  await expect(page.getByTestId("query-cross-section")).toBeEnabled();
  await expect(page.getByTestId("promote-section-draft")).toBeDisabled();
  await expect(page.getByTestId("section-run-receipt")).toContainText("SDC-EVAL000001");
  await expect(page.getByTestId("candidate-evaluation")).toHaveCount(0);
  await expect(page.getByTestId("section-promotion")).toHaveCount(0);

  await page.getByTestId("evaluate-candidate").click();
  await expect(page.getByTestId("candidate-evaluation")).toBeVisible();
  await expect(page.getByTestId("evaluation-id")).toHaveText("CEV-EVAL000001");
  await expect(page.getByTestId("evaluation-candidate-hash")).toHaveText(INJECTED_HASH);
  await expect(page.getByTestId("provenance-status")).toHaveText("Provenance passed");
  await expect(page.getByTestId("provenance-binding-paragraph:BW-P1:span:0")).toContainText(
    `C-BW-HIGH ${INJECTED_CLAIM_HASH} ${INJECTED_ARTIFACT_HASH}`,
  );
  await expect(page.getByTestId("study-output-status")).toHaveText("Study output passed review_required");
  await expect(page.getByTestId("conformance-TCF-BW-COMPLETENESS")).toContainText("completeness passed");
  await expect(page.getByTestId("conformance-TCF-BW-TABLE-COVERAGE")).toContainText("table_coverage passed");
  await expect(page.getByTestId("conformance-TCF-BW-TERMINOLOGY")).toContainText("terminology passed");
  await expect(page.getByTestId("conformance-TCF-BW-UNITS")).toContainText("units passed");
  await expect(page.getByTestId("conformance-TCF-BW-ROUNDING")).toContainText("rounding passed");
  await expect(page.getByTestId("conformance-TCF-BW-APPROVED-LANGUAGE")).toContainText(
    "approved_language passed",
  );
  await expect(page.getByTestId("next-attempt-action")).toHaveText("Next attempt hold");
  await expect(page.getByTestId("evaluation-hash")).toHaveText(INJECTED_EVALUATION_HASH);
  await expect(page.getByTestId("retry-body-weight")).toHaveCount(0);
  expect(evaluationPosts).toBe(1);
  await expect(page.getByTestId("promote-section-draft")).toBeEnabled();
  await expect(page.getByTestId("section-promotion")).toBeVisible();
  await expect(page.getByTestId("promotion-status")).toHaveText("rejected");
  await expect(page.getByTestId("promotion-candidate-hash")).toHaveText(INJECTED_HASH);
  await expect(page.getByTestId("promotion-failed")).toHaveText("package_permission");
  await expect(page.getByTestId("promotion-condition-package_permission")).toContainText(
    "vertical_slice packages cannot be promoted",
  );
  await expect(page.getByTestId("promotion-warning")).toHaveText("Rounding display difference");
  await expect(page.getByTestId("promotion-gates")).toHaveText("PRV-EVAL000001, TCF-EVAL000001");

  await page.getByTestId("query-cross-section").click();
  await expect(page.getByTestId("cross-section-query")).toBeVisible();
  await expect(page.getByTestId("query-status")).toHaveText("returned");
  await expect(page.getByTestId("query-requested")).toHaveText("claim:C-BW-HIGH, validation.body_weight");
  await expect(page.getByTestId("query-hash-claim:C-BW-HIGH")).toContainText(INJECTED_CLAIM_HASH);
  await expect(page.getByTestId("query-hash-validation.body_weight")).toContainText(INJECTED_ARTIFACT_HASH);
  expect(queryPosts).toBe(1);

  await page.getByTestId("promote-section-draft").click();
  await expect(page.getByRole("status")).toContainText("package_permission");
  expect(promotionPosts).toBe(1);
  await expect(page.getByTestId("section-draft")).toHaveCount(0);
});

test("renders backend promotion status and draft evidence without recalculating eligibility", async ({
  page,
}) => {
  const evaluation = injectedEvaluation();
  const query = injectedQuery();
  const promotion = injectedEligiblePromotion();
  const draft = injectedSectionDraft();
  await page.route("**/api/v1/studies/*/section-runs", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "The test must not start a Codex thread." }),
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const response = await route.fetch();
    const workspace: unknown = await response.json();
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(
        withRecordedCandidate(workspace, {
          includeEvaluation: true,
          includeQuery: false,
          includePromotion: true,
          includeDraft: true,
          evaluation,
          query,
          promotion,
          draft,
        }),
      ),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("promotion-status")).toHaveText("eligible");
  await expect(page.getByTestId("promotion-failed")).toHaveText("package_permission");
  await expect(page.getByTestId("promotion-condition-package_permission")).toContainText("failed");
  await expect(page.getByTestId("section-draft")).toBeVisible();
  await expect(page.getByTestId("draft-id")).toHaveText("SD-EVAL000001");
  await expect(page.getByTestId("draft-status")).toHaveText("section_draft");
  await expect(page.getByTestId("draft-candidate-hash")).toHaveText(INJECTED_HASH);
  await expect(page.getByTestId("draft-gates")).toHaveText("PRV-EVAL000001, TCF-EVAL000001");
  await expect(page.getByTestId("draft-disposition-RD-EVAL000001")).toContainText(
    `RD-EVAL000001 SOE-EVAL000001 ${INJECTED_HASH} ${INJECTED_ARTIFACT_HASH}`,
  );
});

test("shows every immutable attempt and offers no fourth attempt after stop_for_review", async ({
  page,
}) => {
  let sectionRunPosts = 0;
  await page.route("**/api/v1/studies/*/section-runs", async (route) => {
    if (route.request().method() === "POST") {
      sectionRunPosts += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ detail: "This drafting cycle already used three Candidate Attempts" }),
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const response = await route.fetch();
    const workspace: unknown = await response.json();
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(withStoppedCycle(workspace)),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("candidate-attempt-1")).toBeVisible();
  await expect(page.getByTestId("candidate-attempt-2")).toBeVisible();
  await expect(page.getByTestId("candidate-attempt-3")).toBeVisible();
  await expect(page.getByTestId("candidate-attempt-3")).toContainText("Candidate attempt 3 of 3");
  await expect(page.getByTestId("next-attempt-action")).toHaveText("Next attempt stop_for_review");
  await expect(page.getByTestId("retry-body-weight")).toHaveCount(0);
  await expect(page.getByTestId("candidate-attempt-4")).toHaveCount(0);
  expect(sectionRunPosts).toBe(0);
});

async function recordApproval(page: import("@playwright/test").Page, label: string) {
  const row = page.locator(".approval-row").filter({ hasText: label });
  await row.getByRole("button", { name: "Record" }).click();
  await expect(row.locator(".approval-check")).toBeVisible();
}

function isPersistedClaimLineage(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.claim) || !Array.isArray(value.lineage) || !Array.isArray(value.source_hashes)) {
    return false;
  }
  return (
    value.claim.claim_id === "C-BW-HIGH" &&
    value.claim.value === 286.2 &&
    value.claim.grain === "dose_group" &&
    value.exact_match === true &&
    value.lineage.length > 0 &&
    value.source_hashes.some((item) => typeof item === "string" && item.startsWith("sha256:")) &&
    isObject(value.rule_versions) &&
    value.rule_versions["body-weight-summary-recompute"] === "1.0.0"
  );
}

function hasSingleBodyWeightExecution(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("data_validation_executions" in value)) {
    return false;
  }
  const executions = value.data_validation_executions;
  if (!Array.isArray(executions) || executions.length !== 1 || !isObject(executions[0])) {
    return false;
  }
  const execution = executions[0];
  if (!isObject(execution.receipt) || !Array.isArray(execution.section_references)) {
    return false;
  }
  const receiptId = execution.receipt.receipt_id;
  return (
    execution.receipt.package_id === "validation.body_weight" &&
    execution.receipt.executor_id === "body-weight-summary" &&
    typeof receiptId === "string" &&
    execution.section_references.length === 2 &&
    execution.section_references.every(
      (item) => isObject(item) && item.claim_id === "C-BW-HIGH" && item.executor_receipt_id === receiptId,
    )
  );
}

function isExportedWorkspace(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("release_gate" in value) || !("export_artifacts" in value)) {
    return false;
  }
  const gate = value.release_gate;
  const artifacts = value.export_artifacts;
  return (
    typeof gate === "object" &&
    gate !== null &&
    "status" in gate &&
    gate.status === "exported" &&
    Array.isArray(artifacts) &&
    artifacts.length === 4 &&
    artifacts.every(
      (artifact) =>
        typeof artifact === "object" &&
        artifact !== null &&
        "checksum" in artifact &&
        typeof artifact.checksum === "string" &&
        artifact.checksum.startsWith("sha256:"),
    )
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const INJECTED_HASH = `sha256:${"cafe".repeat(16)}`;
const INJECTED_CLAIM_HASH = `sha256:${"b0b0".repeat(16)}`;
const INJECTED_ARTIFACT_HASH = `sha256:${"a11e".repeat(16)}`;
const INJECTED_EVALUATION_HASH = `sha256:${"eeee".repeat(16)}`;

function injectedEvaluation(): Record<string, unknown> {
  const rule = (ruleId: string, checkKind: string) => ({
    gate_id: "body-weight-output-style",
    rule_id: ruleId,
    check_kind: checkKind,
    status: "passed",
    enforcement_class: "hard_blocker",
    waivable: false,
    message: `Template Conformance Gate ${ruleId} passed`,
  });
  return {
    schema_version: "helix.candidate-evaluation/v1",
    evaluation_id: "CEV-EVAL000001",
    run_id: "SRUN-EVAL000001",
    candidate_id: "SDC-EVAL000001",
    candidate_hash: INJECTED_HASH,
    section_package_id: "section.5_2_3_body_weight",
    provenance_receipt: {
      schema_version: "helix.provenance-receipt/v1",
      receipt_id: "PRV-EVAL000001",
      candidate_id: "SDC-EVAL000001",
      candidate_hash: INJECTED_HASH,
      status: "passed",
      enforcement_class: "hard_blocker",
      waivable: false,
      bindings: [
        {
          location: "paragraph:BW-P1:span:0",
          text: "Terminal high-dose body weight was 286.2 g.",
          claim_id: "C-BW-HIGH",
          claim_hash: INJECTED_CLAIM_HASH,
          artifact_hash: INJECTED_ARTIFACT_HASH,
        },
      ],
      blockers: [],
    },
    study_output_evaluation_receipt: {
      schema_version: "helix.study-output-evaluation-receipt/v1",
      receipt_id: "SOE-EVAL000001",
      candidate_id: "SDC-EVAL000001",
      candidate_hash: INJECTED_HASH,
      suite_id: "helix-section-study-output",
      suite_version: "0.1.0",
      suite_hash: INJECTED_ARTIFACT_HASH,
      status: "passed",
      enforcement_class: "review_required",
      waivable: false,
      results: [{ assertion: "is-json", status: "passed", message: "Candidate JSON parsed." }],
    },
    template_conformance_receipt: {
      schema_version: "helix.template-conformance-receipt/v1",
      receipt_id: "TCF-EVAL000001",
      candidate_id: "SDC-EVAL000001",
      candidate_hash: INJECTED_HASH,
      section_package_id: "section.5_2_3_body_weight",
      status: "passed",
      results: [
        { ...rule("TCF-BW-COMPLETENESS", "completeness"), gate_id: "body-weight-content-completeness" },
        { ...rule("TCF-BW-TABLE-COVERAGE", "table_coverage"), gate_id: "body-weight-output-table-shape" },
        rule("TCF-BW-TERMINOLOGY", "terminology"),
        rule("TCF-BW-UNITS", "units"),
        rule("TCF-BW-ROUNDING", "rounding"),
        rule("TCF-BW-APPROVED-LANGUAGE", "approved_language"),
      ],
    },
    next_attempt_decision: {
      action: "hold",
      attempt: 1,
      max_attempts: 3,
      reasons: ["Deterministic gates passed; promotion is out of scope"],
      blocking_receipt_ids: [],
    },
    hashes: {
      candidate: INJECTED_HASH,
      provenance: INJECTED_CLAIM_HASH,
      study_output_evaluation: INJECTED_ARTIFACT_HASH,
      template_conformance: INJECTED_CLAIM_HASH,
      evaluation: INJECTED_EVALUATION_HASH,
    },
  };
}

function injectedQuery(): Record<string, unknown> {
  return {
    schema_version: "helix.cross-section-query-receipt/v1",
    query_id: "CSQ-EVAL000001",
    run_id: "SRUN-EVAL000001",
    section_package_id: "section.5_2_3_body_weight",
    requested_artifact_ids: ["claim:C-BW-HIGH", "validation.body_weight"],
    returned: [
      { artifact_id: "claim:C-BW-HIGH", kind: "claim", hash: INJECTED_CLAIM_HASH },
      { artifact_id: "validation.body_weight", kind: "fact", hash: INJECTED_ARTIFACT_HASH },
    ],
    rejected_artifact_ids: [],
    status: "returned",
  };
}

function promotionConditions(packagePassed: boolean): Record<string, unknown>[] {
  return [
    {
      condition_id: "package_permission",
      passed: packagePassed,
      reason: packagePassed ? null : "vertical_slice packages cannot be promoted",
      evidence_ids: [],
    },
    { condition_id: "no_hard_blocker", passed: true, reason: null, evidence_ids: [] },
    { condition_id: "provenance_passed", passed: true, reason: null, evidence_ids: [] },
    { condition_id: "conformance_passed", passed: true, reason: null, evidence_ids: [] },
    { condition_id: "review_required_current", passed: true, reason: null, evidence_ids: [] },
  ];
}

function injectedPromotion(): Record<string, unknown> {
  return {
    schema_version: "helix.section-promotion-decision/v1",
    eligible: false,
    candidate_id: "SDC-EVAL000001",
    candidate_hash: INJECTED_HASH,
    run_id: "SRUN-EVAL000001",
    conditions: promotionConditions(false),
    failed_condition_ids: ["package_permission"],
    warnings: ["Rounding display difference"],
    current_disposition_ids: [],
    gate_decision_ids: ["PRV-EVAL000001", "TCF-EVAL000001"],
  };
}

function injectedEligiblePromotion(): Record<string, unknown> {
  return {
    schema_version: "helix.section-promotion-decision/v1",
    eligible: true,
    candidate_id: "SDC-EVAL000001",
    candidate_hash: INJECTED_HASH,
    run_id: "SRUN-EVAL000001",
    conditions: promotionConditions(false),
    failed_condition_ids: ["package_permission"],
    warnings: [],
    current_disposition_ids: ["RD-EVAL000001"],
    gate_decision_ids: ["PRV-EVAL000001", "TCF-EVAL000001"],
  };
}

function injectedSectionDraft(): Record<string, unknown> {
  return {
    schema_version: "helix.section-draft/v1",
    status: "section_draft",
    draft_id: "SD-EVAL000001",
    run_id: "SRUN-EVAL000001",
    section_id: "5_2_3_body_weight",
    candidate_id: "SDC-EVAL000001",
    candidate_hash: INJECTED_HASH,
    content_hash: INJECTED_CLAIM_HASH,
    promoted_at: "2026-09-24T12:00:00Z",
    gate_decision_ids: ["PRV-EVAL000001", "TCF-EVAL000001"],
    bound_dispositions: [
      {
        disposition_id: "RD-EVAL000001",
        result_id: "SOE-EVAL000001",
        decision: "approved_exception",
        artifact_hash: INJECTED_HASH,
        dependency_fingerprint: INJECTED_ARTIFACT_HASH,
      },
    ],
  };
}

function withRecordedCandidate(
  workspace: unknown,
  options: {
    includeEvaluation: boolean;
    includeQuery: boolean;
    includePromotion?: boolean;
    includeDraft?: boolean;
    evaluation: Record<string, unknown>;
    query: Record<string, unknown>;
    promotion?: Record<string, unknown>;
    draft?: Record<string, unknown>;
  },
): unknown {
  if (!isObject(workspace)) {
    throw new Error("Workspace is missing.");
  }
  return {
    ...workspace,
    section_runs: [
      {
        receipt: {
          run_id: "SRUN-EVAL000001",
          section_id: "5_2_3_body_weight",
          section_package_id: "section.5_2_3_body_weight",
          status: "candidate_recorded",
          candidate_id: "SDC-EVAL000001",
          candidate_hash: INJECTED_HASH,
          envelope_hash: INJECTED_ARTIFACT_HASH,
          agent_runtime: "codex_sdk",
          codex_thread_id: "thread-eval-001",
          skill_name: "helix-section-agent",
          skill_hash: INJECTED_CLAIM_HASH,
          review_scaffold_revision: 2,
          idempotent_replay: false,
        },
        candidate: {
          schema_version: "helix.section-draft-candidate/v1",
          status: "section_draft_candidate",
          candidate_id: "SDC-EVAL000001",
          run_id: "SRUN-EVAL000001",
          section_id: "5_2_3_body_weight",
          section_package_id: "section.5_2_3_body_weight",
          section_package_version: "0.1.0",
          drafting_cycle_id: "CYCLE-BW-001",
          attempt: 1,
          validated_claim_ids: ["C-BW-HIGH"],
          content_blocks: [
            {
              block_id: "BW-P1",
              kind: "paragraph",
              content: "Terminal high-dose body weight was 286.2 g.",
              factual_spans: [
                { text: "Terminal high-dose body weight was 286.2 g.", claim_ids: ["C-BW-HIGH"] },
              ],
            },
          ],
          executor_receipt_ids: ["EXEC-BW-SUMMARY-001"],
          agent_receipt: {
            runtime: "codex_sdk",
            thread_id: "thread-eval-001",
            skill_name: "helix-section-agent",
            skill_hash: INJECTED_CLAIM_HASH,
          },
        },
        envelope: {},
        review_scaffold: {},
      },
    ],
    candidate_evaluations: options.includeEvaluation ? [options.evaluation] : [],
    cross_section_queries: options.includeQuery ? [options.query] : [],
    promotion_decisions: options.includePromotion && options.promotion ? [options.promotion] : [],
    section_drafts: options.includeDraft && options.draft ? [options.draft] : [],
  };
}

function withStoppedCycle(workspace: unknown): unknown {
  if (!isObject(workspace)) {
    throw new Error("Workspace is missing.");
  }
  const runs = [1, 2, 3].map((attempt) => storedAttempt(attempt));
  const evaluations = [1, 2, 3].map((attempt) =>
    injectedCycleEvaluation(attempt, attempt === 3 ? "stop_for_review" : "retry"),
  );
  return {
    ...workspace,
    section_runs: runs,
    candidate_evaluations: evaluations,
  };
}

function storedAttempt(attempt: number): Record<string, unknown> {
  const runId = `SRUN-CYCLE00000${attempt}`;
  const candidateId = `SDC-CYCLE00000${attempt}`;
  return {
    receipt: {
      run_id: runId,
      section_id: "5_2_3_body_weight",
      section_package_id: "section.5_2_3_body_weight",
      status: "candidate_recorded",
      candidate_id: candidateId,
      candidate_hash: INJECTED_HASH,
      envelope_hash: INJECTED_ARTIFACT_HASH,
      agent_runtime: "codex_sdk",
      codex_thread_id: `thread-cycle-00${attempt}`,
      skill_name: "helix-section-agent",
      skill_hash: INJECTED_CLAIM_HASH,
      review_scaffold_revision: attempt + 1,
      idempotent_replay: false,
    },
    candidate: {
      schema_version: "helix.section-draft-candidate/v1",
      status: "section_draft_candidate",
      candidate_id: candidateId,
      run_id: runId,
      section_id: "5_2_3_body_weight",
      section_package_id: "section.5_2_3_body_weight",
      section_package_version: "0.1.0",
      drafting_cycle_id: "CYCLE-BW-001",
      attempt,
      validated_claim_ids: ["C-BW-HIGH"],
      content_blocks: [
        {
          block_id: "BW-P1",
          kind: "paragraph",
          content: "Terminal high-dose body weight was 286.2 g.",
          factual_spans: [
            { text: "Terminal high-dose body weight was 286.2 g.", claim_ids: ["C-BW-HIGH"] },
          ],
        },
      ],
      executor_receipt_ids: ["EXEC-BW-SUMMARY-001"],
      agent_receipt: {
        runtime: "codex_sdk",
        thread_id: `thread-cycle-00${attempt}`,
        skill_name: "helix-section-agent",
        skill_hash: INJECTED_CLAIM_HASH,
      },
    },
    envelope: {},
    review_scaffold: {},
  };
}

function injectedCycleEvaluation(
  attempt: number,
  action: "retry" | "stop_for_review",
): Record<string, unknown> {
  const evaluation = injectedEvaluation();
  return {
    ...evaluation,
    evaluation_id: `CEV-CYCLE00000${attempt}`,
    run_id: `SRUN-CYCLE00000${attempt}`,
    candidate_id: `SDC-CYCLE00000${attempt}`,
    next_attempt_decision: {
      action,
      attempt,
      max_attempts: 3,
      reasons: ["Provenance compilation failed"],
      blocking_receipt_ids: ["PRV-CYCLE000001"],
    },
  };
}

function withBlockedBodyWeight(workspace: unknown): unknown {
  if (!isObject(workspace) || !Array.isArray(workspace.section_run_eligibility)) {
    throw new Error("Workspace eligibility is missing.");
  }
  const claims = Array.isArray(workspace.claims) ? [...workspace.claims] : [];
  if (!claims.some((item) => isObject(item) && item.claim_id === "C-BW-HIGH")) {
    claims.push({
      claim_id: "C-BW-HIGH",
      section_id: "S5",
      field_id: "body-weight",
      value: 286.2,
      unit: "g",
      grain: "dose_group",
      status: "validated",
      claim_type: "mean",
    });
  } else {
    workspace.claims = claims.map((item) =>
      isObject(item) && item.claim_id === "C-BW-HIGH" ? { ...item, status: "validated" } : item,
    );
  }
  return {
    ...workspace,
    claims,
    section_run_eligibility: workspace.section_run_eligibility.map((item) => {
      if (!isObject(item)) {
        return item;
      }
      if (item.section_package_id === "section.5_2_3_body_weight") {
        const gateResults = Array.isArray(item.gate_results) ? [...item.gate_results] : [];
        const fieldsIndex = gateResults.findIndex(
          (result) => isObject(result) && result.result_id === "TCR-BW-FIELDS",
        );
        const blockedFields = {
          gate_id: "body-weight-template-fields",
          section_package_id: "section.5_2_3_body_weight",
          result_id: "TCR-BW-FIELDS",
          status: "blocked",
          enforcement_class: "hard_blocker",
          waivable: false,
          check_kind: "fields",
          message: "Template Contract Gate body-weight-template-fields failed",
        };
        if (fieldsIndex >= 0) {
          gateResults[fieldsIndex] = { ...gateResults[fieldsIndex], ...blockedFields };
        } else {
          gateResults.unshift(blockedFields);
        }
        return {
          ...item,
          eligible: false,
          reasons: ["Template Contract Gate body-weight-template-fields failed"],
          gate_results: gateResults,
        };
      }
      return {
        ...item,
        eligible: true,
        reasons: [],
      };
    }),
  };
}

function withForcedEligibility(workspace: unknown, eligible: boolean): unknown {
  if (!isObject(workspace) || !Array.isArray(workspace.section_run_eligibility)) {
    throw new Error("Workspace eligibility is missing.");
  }
  return {
    ...workspace,
    claims: [],
    section_run_eligibility: workspace.section_run_eligibility.map((item) =>
      isObject(item)
        ? {
            ...item,
            eligible,
            reasons: eligible ? [] : ["blocked by test"],
          }
        : item,
    ),
  };
}

async function assertRenderedEligibility(
  page: import("@playwright/test").Page,
  workspace: unknown,
) {
  if (!isObject(workspace) || !Array.isArray(workspace.section_run_eligibility)) {
    throw new Error("Workspace eligibility is missing.");
  }
  for (const item of workspace.section_run_eligibility) {
    if (!isObject(item) || typeof item.section_package_id !== "string") {
      throw new Error("Eligibility is missing a section package id.");
    }
    await expect(page.getByTestId(`eligibility-${item.section_package_id}`)).toHaveText(
      item.eligible === true ? "ready" : "blocked",
    );
    if (!Array.isArray(item.gate_results) || !isObject(item.impact_set)) {
      throw new Error("Eligibility is missing backend gate results.");
    }
    await expect(page.getByTestId(`impact-${item.section_package_id}`)).toContainText(
      `origin ${String(item.impact_set.origin_section_package_id)}`,
    );
    for (const result of item.gate_results) {
      if (!isObject(result) || typeof result.result_id !== "string") {
        throw new Error("Gate result is missing a result id.");
      }
      const row = page.getByTestId(`gate-${result.result_id}`);
      await expect(row).toContainText(String(result.status));
      await expect(row).toContainText(String(result.check_kind));
      await expect(row).toContainText(String(result.message));
      await expect(row).toContainText(result.waivable === true ? "waivable" : "non-waivable");
    }
  }
}
