import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const apiRoot = process.env.HELIX_API_URL ?? "http://127.0.0.1:8000/api/v1";

test("rejects a workspace response from an incompatible API", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const response = await route.fetch();
    const workspace: unknown = await response.json();
    if (!isObject(workspace)) {
      throw new Error("Workspace fixture is invalid.");
    }
    const incompatibleWorkspace = { ...workspace };
    delete incompatibleWorkspace.section_run_eligibility;
    delete incompatibleWorkspace.section_runs;
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(incompatibleWorkspace),
    });
  });

  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "The workbench API is unavailable." }),
  ).toBeVisible();
  await expect(
    page.getByText("The workspace response does not match the generated API contract."),
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});

/** DH-7: true when the server's pinned run was frozen with the demo flag (skipped packages recorded). */
async function isDemoFrozen(request: import("@playwright/test").APIRequestContext): Promise<boolean> {
  const response = await request.get(`${apiRoot}/studies/STUDY-HLX-028/workspace`);
  const workspace = (await response.json()) as {
    pinned_run?: { event_history: { event: string; details?: Record<string, unknown> }[] } | null;
  };
  const requested = workspace.pinned_run?.event_history.find((event) => event.event === "run_requested");
  const value = requested?.details?.demo_unqualified_packages;
  return typeof value === "string" && value.length > 0;
}

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
  await expect(page.getByText("Synthetic data · Not for submission", { exact: true })).toBeVisible();
  await expect(page.getByTestId("release-status")).toHaveText("Release blocked");
  await expect(page.getByTestId("release-status")).toHaveAttribute("data-status", "blocked");
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

  // DH-1: the freeze auto-starts the governed agent sequence. On this seed the server moves
  // to Human gate 2 after validation, so the agent must stop there and never call the Section
  // Agent. The route is a guard so a regression can never reach Codex from this live run.
  const sectionRunPosts: string[] = [];
  await page.route("**/api/v1/studies/*/section-runs", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sectionRunPosts.push(route.request().url());
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Section Agent not under test." }) });
  });
  // Human Gate 1 (#22 P1): a human freezes the authorized manifest; validation never auto-freezes.
  await page.getByTestId("freeze-consent").check();
  await page.getByTestId("freeze-manifest").click();
  await expect(page.getByTestId("workbench-notice")).toContainText("Manifest frozen by the server as Pinned Run");
  await expect(page.getByTestId("traceability-stage-view")).toBeVisible();
  await expect(page.getByTestId("agent-stop-sequence")).toHaveCount(0);
  expect(sectionRunPosts).toEqual([]);
  await page.getByTestId("run-validation").click();
  await expect(page.getByTestId("workbench-notice")).toContainText("13 checks completed");
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
  await expect(page.getByTestId("workbench-notice")).toContainText("persisted claims");
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

  // Lane C (#22): claim evidence renders only inside Human Gate 2 (the legacy EvidenceChain
  // panel is removed); the Gate 2 view is covered by tests/traceability-gate.spec.ts.
  const lineageResponse = await request.get(`${apiRoot}/studies/STUDY-HLX-028/claims/C-BW-HIGH/evidence`);
  expect(lineageResponse.ok()).toBeTruthy();
  const lineage: unknown = await lineageResponse.json();
  expect(isPersistedClaimLineage(lineage)).toBeTruthy();
  await writeFile(
    resolve(process.cwd(), "../evidence/body-weight-claim-lineage.json"),
    `${JSON.stringify(lineage, null, 2)}\n`,
  );
  await page.screenshot({ path: "../evidence/helix-body-weight-lineage.png", fullPage: true });

  // Lane C (#22): dispositions are typed reviewer commands recorded at Human Gate 2.
  // The legacy report button only routes there; it never fabricates a command.
  await page.getByRole("button", { name: /Record (synthetic|Gate 2) disposition/ }).first().click();
  await expect(page.getByTestId("traceability-stage-view")).toBeVisible();
  for (const [resultId, decision] of [
    ["VR-004", "Corrected"],
    ["VR-005", "Corrected"],
    ["VR-006", "Approved exception"],
  ] as const) {
    await page.getByTestId(`open-blocker-${resultId}`).click();
    await page.getByTestId(`record-disposition-${resultId}`).click();
    const form = page.getByTestId(`disposition-form-${resultId}`);
    await form.getByRole("radio", { name: decision }).check();
    await form.getByLabel("Reason").fill(`Synthetic reviewer disposition for ${resultId}.`);
    await form.getByLabel("Reviewer").fill("Dr. Avery Reviewer");
    await form.getByTestId("disposition-submit").click();
    await expect(page.getByTestId(`rule-badge-${resultId}`)).toHaveText("Disposition");
  }
  await expect(page.getByTestId("continue-to-review")).toBeEnabled();
  await page.getByTestId("continue-to-review").click();
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-selected-stage", "review-export");
  // Lane D (#23): Human Gate 3 opens once the server reports review-export current.
  await expect(page.getByTestId("review-stage")).toBeVisible();
  await page.getByTestId("review-section-S7").click();
  await expect(page.getByTestId("draft-canvas").getByRole("heading", { name: "Anatomic pathology" })).toBeVisible();
  await expect(
    page.getByTestId("draft-canvas").getByText("Minimal hepatocellular hypertrophy", { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId("regulatory-references").getByRole("link", { name: "OECD TG 407, 2025" }).first()).toBeVisible();

  await recordApproval(page, "pathologist");
  await recordApproval(page, "peer_reviewer");
  await recordApproval(page, "qau");
  await recordApproval(page, "study_director");

  await expect(page.getByTestId("release-status")).toHaveText("Ready for signature");
  await expect(page.getByText("FDA approved")).toHaveCount(0);
  await expect(page.getByTestId("review-fsa-scope")).toBeVisible();
  await page.getByTestId("approve-final-study").click();
  await expect(page.getByTestId("review-approval-current")).toHaveAttribute("data-state", "current");
  await expect(page.getByTestId("review-approval-manifest-hash")).toHaveText(/^sha256:[a-f0-9]{64}$/);
  // The legacy ReportAssembly FSA card stays in sync with the same server record.
  await expect(page.getByTestId("approval-current")).toHaveText("current");
  await expect(page.getByTestId("release-status")).toHaveText("Ready for export");
  if (await isDemoFrozen(request)) {
    // DH-7 (#68), flag ON on the shipped pending tree: the run was frozen with the demo flag, so
    // export fails closed. The button is disabled with its reason and the API refuses with a 409.
    await expect(page.getByTestId("export-final-package")).toBeDisabled();
    await expect(page.getByTestId("export-disabled-reason")).toHaveAttribute("data-gate", "demo_not_qualified");
    const refused = await request.post(`${apiRoot}/studies/STUDY-HLX-028/exports`, {
      data: { actor: "Dr. Sam Director", idempotency_key: "workbench-demo-frozen-export" },
    });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { detail: { code: string } }).detail.code).toBe("demo_not_qualified");
    const refusedWorkspace = (await (await request.get(`${apiRoot}/studies/STUDY-HLX-028/workspace`)).json()) as {
      release_gate: { status: string };
      export_artifacts: { artifact_id: string; status: string }[];
    };
    expect(refusedWorkspace.release_gate.status).not.toBe("exported");
    for (const artifact of refusedWorkspace.export_artifacts) {
      expect(artifact.status).not.toBe("exported");
      const download = await request.get(
        `${apiRoot}/studies/STUDY-HLX-028/exports/${encodeURIComponent(artifact.artifact_id)}`,
      );
      expect(download.status()).toBe(409);
    }
    await expect(page.getByTestId("release-status")).not.toHaveText("Package exported");
    await expect(page.getByTestId("export-receipt")).toHaveCount(0);
    expect(browserErrors).toEqual([]);
    return;
  }
  await expect(page.getByTestId("export-final-package")).toBeEnabled();
  await page.getByTestId("export-final-package").click();
  await expect(page.getByTestId("release-status")).toHaveText("Package exported");
  await expect(page.getByTestId("export-receipt")).toBeVisible();
  await expect(page.getByText("FDA approved")).toHaveCount(0);

  const workspaceResponse = await request.get(`${apiRoot}/studies/STUDY-HLX-028/workspace`);
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace: unknown = await workspaceResponse.json();
  expect(isExportedWorkspace(workspace)).toBeTruthy();
  expect(hasSingleBodyWeightExecution(workspace)).toBeTruthy();
  const exported = asExportedWorkspace(workspace);
  const approval = exported.final_study_approval;
  expect(approval).not.toBeNull();
  const approved = new Map(
    approval!.included_artifact_hashes.map((item) => [item.artifact_id, item.content_hash]),
  );
  expect(exported.export_artifacts.length).toBe(approved.size);
  for (const artifact of exported.export_artifacts) {
    expect(artifact.status).toBe("exported");
    expect(artifact.checksum).toBe(approved.get(artifact.artifact_id));
    const downloadPromise = page.waitForEvent("download");
    await expect(page.getByTestId(`download-checksum-${artifact.artifact_id}`)).toHaveText(artifact.checksum!);
    await page.getByTestId(`download-${artifact.artifact_id}`).click();
    const download = await downloadPromise;
    expect(await download.failure()).toBeNull();
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const bytes = await import("node:fs/promises").then((fs) => fs.readFile(downloadPath!));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    expect(digest).toBe(artifact.checksum);
    const apiDownload = await request.get(
      `${apiRoot}/studies/STUDY-HLX-028/exports/${encodeURIComponent(artifact.artifact_id)}`,
    );
    expect(apiDownload.ok()).toBeTruthy();
    const apiBytes = Buffer.from(await apiDownload.body());
    expect(apiBytes.equals(bytes)).toBeTruthy();
  }

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
  // The drafted-section view adds its own "Needs your review" status; target the command notice.
  await expect(page.getByRole("status").filter({ hasText: "Section promotion rejected" })).toContainText(
    "package_permission",
  );
  expect(promotionPosts).toBe(1);
  await expect(page.getByTestId("section-draft")).toHaveCount(0);
});

test("renders predecessor run identity and carry-forward counts from the workspace", async ({ page }) => {
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const response = await route.fetch();
    const workspace: unknown = await response.json();
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(withSupersedingRun(workspace)),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("superseding-run")).toBeVisible();
  await expect(page.getByTestId("predecessor-run-id")).toHaveText("RUN-PRED00000001");
  await expect(page.getByTestId("supersession-reason")).toHaveText(
    "Correct the locked body-weight source after authorized review",
  );
  await expect(page.getByTestId("parse-reuse")).toHaveText("parse.body_weights reused");
  await expect(page.getByTestId("carried-forward-count")).toHaveText("1");
  await expect(page.getByTestId("rerun-nodes")).toHaveText("section.5_3_discussion");
  await expect(page.getByTestId("predecessor-snapshot-hash")).toHaveText(INJECTED_HASH);
});

test("renders the exact Final Study Approval scope from the workspace", async ({ page }) => {
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const response = await route.fetch();
    const workspace: unknown = await response.json();
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(withReviewStage(withFinalStudyApproval(workspace))),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("final-study-approval-scope")).toBeVisible();
  await expect(page.getByTestId("approval-current")).toHaveText("current");
  await expect(page.getByTestId("approval-manifest-hash")).toHaveText(INJECTED_HASH);
  await expect(page.getByTestId("approval-artifact-RUN-PRED00000001")).toHaveText(INJECTED_HASH);
  // Lane D (#23): the same scope also renders in the Human Gate 3 sign-off column.
  await expect(page.getByTestId("review-fsa-scope")).toBeVisible();
  await expect(page.getByTestId("review-approval-current")).toHaveAttribute("data-state", "current");
  await expect(page.getByTestId("review-approval-manifest-hash")).toHaveText(INJECTED_HASH);
  await expect(page.getByTestId("review-approval-artifact-RUN-PRED00000001")).toHaveText(INJECTED_HASH);
  await expect(page.getByText("FDA approved")).toHaveCount(0);
});

test("labels every approved export artifact kind instead of showing raw kinds", async ({ page }) => {
  // The backend sets export_artifacts to these kinds once a release candidate exists
  // (service.py, approved_exports.py); SLICE 11 labels them for the reviewer.
  const labels: Record<string, string> = {
    pinned_run: "Pinned run manifest",
    data_validation_receipt: "Data validation receipt",
    section_draft_candidate: "Section draft candidate",
    section_draft: "Section draft",
  };
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const response = await route.fetch();
    const workspace = (await response.json()) as { export_artifacts: Array<Record<string, unknown>> };
    const template = workspace.export_artifacts[0];
    workspace.export_artifacts = Object.keys(labels).map((kind, index) => ({
      ...template,
      artifact_id: `ART-${kind.toUpperCase()}`,
      kind,
      path: `exports/approved/${index + 1}.json`,
      status: index % 2 === 0 ? "exported" : "pending",
      checksum: index % 2 === 0 ? INJECTED_HASH : null,
    }));
    await route.fulfill({ status: response.status(), contentType: "application/json", body: JSON.stringify(workspace) });
  });

  await page.goto("/");
  const names = page.locator(".export-card .artifact-list strong");
  await expect(names).toHaveText(Object.values(labels));
  for (const kind of Object.keys(labels)) {
    await expect(page.locator(".export-card").getByText(kind, { exact: true })).toHaveCount(0);
  }
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
  await expect(page.getByTestId("candidate-attempt-CYCLE-BW-001-1")).toBeVisible();
  await expect(page.getByTestId("candidate-attempt-CYCLE-BW-001-2")).toBeVisible();
  await expect(page.getByTestId("candidate-attempt-CYCLE-BW-001-3")).toBeVisible();
  await expect(page.getByTestId("candidate-attempt-CYCLE-BW-001-3")).toContainText(
    "Candidate attempt 3 of 3",
  );
  await expect(page.getByTestId("next-attempt-action")).toHaveText("Next attempt stop_for_review");
  await expect(page.getByTestId("retry-body-weight")).toHaveCount(0);
  await expect(page.getByTestId("candidate-attempt-CYCLE-BW-001-4")).toHaveCount(0);
  expect(sectionRunPosts).toBe(0);
});

test("offers revise after stop_for_review and shows a new cycle without changing discussion hashes", async ({
  page,
}) => {
  const cycleTwo = "CYCLE-REV0000001";
  let revised = false;
  let revisionPosts = 0;
  await page.route("**/api/v1/studies/*/section-runs", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ detail: "This drafting cycle already used three Candidate Attempts" }),
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/v1/studies/*/section-revisions", async (route) => {
    revisionPosts += 1;
    revised = true;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(injectedRevisionReceipt(cycleTwo)),
    });
  });
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const response = await route.fetch();
    const workspace: unknown = await response.json();
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(
        revised ? withRevisedCycle(workspace, cycleTwo) : withStoppedCycle(workspace, true),
      ),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("revise-body-weight")).toBeEnabled();
  const discussionBefore = await page.getByTestId("impact-section.5_3_discussion").textContent();
  await page.getByTestId("revise-body-weight").click();
  await expect(page.getByTestId(`drafting-cycle-${cycleTwo}`)).toBeVisible();
  await expect(page.getByTestId("revise-body-weight")).toBeDisabled();
  await expect(page.getByTestId("impact-section.5_3_discussion")).toHaveText(discussionBefore ?? "");
  expect(revisionPosts).toBe(1);
});

async function recordApproval(page: import("@playwright/test").Page, role: string) {
  // Lane D (#23): one control per role in the Human Gate 3 sign-off column.
  await page.getByTestId(`approve-${role}`).click();
  await expect(page.getByTestId(`signoff-${role}`)).toHaveAttribute("data-signed", "true");
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


function asExportedWorkspace(value: unknown): {
  export_artifacts: Array<{ artifact_id: string; checksum: string | null; status: string }>;
  final_study_approval: {
    included_artifact_hashes: Array<{ artifact_id: string; content_hash: string }>;
  } | null;
} {
  if (!isExportedWorkspace(value) || !isObject(value)) {
    throw new Error("workspace is not exported");
  }
  const approval = value.final_study_approval;
  return {
    export_artifacts: value.export_artifacts as Array<{
      artifact_id: string;
      checksum: string | null;
      status: string;
    }>,
    final_study_approval: (approval ?? null) as {
      included_artifact_hashes: Array<{ artifact_id: string; content_hash: string }>;
    } | null,
  };
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
    artifacts.length > 0 &&
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
          skill_references_hash: INJECTED_CLAIM_HASH,
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
            skill_references_hash: INJECTED_CLAIM_HASH,
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

function withStoppedCycle(workspace: unknown, canOpenRevision = false): unknown {
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
    drafting_cycles: [injectedCycle("CYCLE-BW-001", null)],
    can_open_revision: canOpenRevision,
  };
}

/** Lane D (#23): the server journey with review-export current and every earlier stage complete. */
function withReviewStage(workspace: unknown): unknown {
  if (!isObject(workspace) || !isObject(workspace.journey) || !Array.isArray(workspace.journey.stages)) {
    throw new Error("Workspace journey is missing.");
  }
  const stages = workspace.journey.stages as Record<string, unknown>[];
  const last = stages.length - 1;
  return {
    ...workspace,
    journey: {
      ...workspace.journey,
      current_stage_id: stages[last].stage_id,
      stages: stages.map((stage, index) => ({
        ...stage,
        status: index < last ? "complete" : "current",
        selectable: true,
      })),
    },
  };
}

function withFinalStudyApproval(workspace: unknown): unknown {
  if (!isObject(workspace)) {
    throw new Error("Workspace is missing.");
  }
  return {
    ...workspace,
    approval_current: true,
    release_candidate: {
      schema_version: "helix.release-candidate/v1",
      status: "release_candidate",
      export_eligible: true,
      run_id: "RUN-PRED00000001",
      study_id: "TOX-2026-014",
      included_artifacts: [
        {
          artifact_id: "RUN-PRED00000001",
          kind: "pinned_run",
          content_hash: INJECTED_HASH,
        },
      ],
      current_drafting_cycles: [],
      content_hash: INJECTED_HASH,
    },
    final_study_approval: {
      schema_version: "helix.final-study-approval/v1",
      approval_id: "FSA-SCOPE000001",
      run_id: "RUN-PRED00000001",
      study_id: "TOX-2026-014",
      reviewer: "Dr. Sam Director",
      recorded_at: "2026-09-24T00:00:00Z",
      manifest_hash: INJECTED_HASH,
      included_artifact_hashes: [
        { artifact_id: "RUN-PRED00000001", content_hash: INJECTED_HASH },
      ],
      idempotency_key: "injected-fsa-scope",
    },
  };
}

function withSupersedingRun(workspace: unknown): unknown {
  if (!isObject(workspace) || !isObject(workspace.pinned_run)) {
    throw new Error("Workspace is missing a pinned run.");
  }
  return {
    ...workspace,
    pinned_run: {
      ...workspace.pinned_run,
      predecessor_run_id: "RUN-PRED00000001",
      supersession_reason: "Correct the locked body-weight source after authorized review",
    },
    predecessor_snapshots: [
      {
        schema_version: "helix.predecessor-snapshot/v1",
        snapshot_hash: INJECTED_HASH,
        pinned_run: workspace.pinned_run,
        frozen_inputs: {
          records: { animals: [], body_weights: [], clinical_observations: [], food_consumption: [], organ_weights: [], microscopic_findings: [], formulation: [] },
          manifest: [],
          template: {},
          validation_package: {},
          section_packages: {},
          skill_hash: INJECTED_HASH,
          suite_hash: INJECTED_HASH,
          executor_hash: INJECTED_HASH,
          validation_package_hash: INJECTED_HASH,
        },
        claims: [],
        provenance_edges: [],
        validation_results: [],
        data_validation_executions: [],
        gate_decisions: [],
        review_dispositions: [],
        approvals: [],
        events: [],
        review_scaffold_revisions: [],
        section_runs: [],
        section_drafts: [],
        candidate_evaluations: [],
        drafting_cycles: [],
      },
    ],
    superseding_run_receipt: {
      schema_version: "helix.superseding-run/v1",
      run_id: workspace.pinned_run.run_id,
      predecessor_run_id: "RUN-PRED00000001",
      predecessor_snapshot_hash: INJECTED_HASH,
      reason: "Correct the locked body-weight source after authorized review",
      parse_reuse: [{ node_id: "parse.body_weights", content_hash: INJECTED_HASH, reused: true }],
      carried_forward: [
        {
          kind: "section_draft_candidate",
          section_package_id: "section.5_2_3_body_weight",
          artifact_id: "SDC-PRED0000001",
          content_hash: INJECTED_HASH,
          dependency_fingerprint: INJECTED_HASH,
          lineage: {
            predecessor_run_id: "RUN-PRED00000001",
            predecessor_artifact_id: "SDC-PRED0000001",
            predecessor_content_hash: INJECTED_HASH,
            predecessor_dependency_fingerprint: INJECTED_HASH,
          },
          stored_run: null,
          section_draft: null,
        },
      ],
      rerun_node_ids: ["section.5_3_discussion"],
      impact_set: {
        origin_section_package_id: "section.5_3_discussion",
        direct: ["section.5_3_discussion"],
        transitive: [],
      },
      fresh_validation_receipt_ids: ["DVR-FRESH000001"],
      fresh_gate_ids: ["GATE-RELEASE"],
      fresh_scaffold_revision: 1,
    },
  };
}

function withRevisedCycle(workspace: unknown, cycleId: string): unknown {
  if (!isObject(workspace)) {
    throw new Error("Workspace is missing.");
  }
  const stopped = withStoppedCycle(workspace, false);
  if (!isObject(stopped)) {
    throw new Error("Stopped workspace is missing.");
  }
  return {
    ...stopped,
    drafting_cycles: [injectedCycle("CYCLE-BW-001", null), injectedCycle(cycleId, "CYCLE-BW-001")],
    can_open_revision: false,
  };
}

function injectedCycle(cycleId: string, predecessor: string | null): Record<string, unknown> {
  return {
    schema_version: "helix.drafting-cycle/v1",
    cycle_id: cycleId,
    run_id: "RUN-CYCLE000001",
    section_package_id: "section.5_2_3_body_weight",
    predecessor_cycle_id: predecessor,
    max_attempts: 3,
    impact_set: {
      origin_section_package_id: "section.5_2_3_body_weight",
      direct: ["section.5_2_3_body_weight"],
      transitive: [],
    },
    opened_at: "2026-09-24T12:00:00Z",
    opened_by: predecessor ? "Dr. Ada Path" : "HELIX Codex section runtime",
    triggering_event_id: `EV-${cycleId.replace("CYCLE-", "")}`,
  };
}

function injectedRevisionReceipt(cycleId: string): Record<string, unknown> {
  return {
    cycle: injectedCycle(cycleId, "CYCLE-BW-001"),
    stale_disposition_ids: [],
    stale_approval_ids: [],
    review_scaffold_revision: 4,
    idempotent_replay: false,
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
      skill_references_hash: INJECTED_CLAIM_HASH,
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
        skill_references_hash: INJECTED_CLAIM_HASH,
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

// Critique P1-f: Gate 3 hides the legacy fallback panels. These legacy displays are asserted
// from the traceability stage, where the fallback panels still render.
