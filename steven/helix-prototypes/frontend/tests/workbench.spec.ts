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
  await expect(page.getByTestId("review-scaffold-revision")).toBeVisible();
  await expect(page.getByText("3", { exact: true }).first()).toBeVisible();
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
