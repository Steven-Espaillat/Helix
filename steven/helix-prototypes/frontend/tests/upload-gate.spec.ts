import { expect, test, type Page, type Request } from "@playwright/test";

import {
  apiRoot,
  freezeFixture,
  frozenWorkspace,
  liveWorkspace,
  regulatoryClaim,
  serveWorkspace,
  stageButtons,
  studyId,
  type Json,
} from "./lane-a-helpers";

// Lane A (#20): Human Gate 1 and the real freeze command. Freeze responses are mocked
// because the shipped section packages are not qualified (the live API refuses with 422);
// the frozen workspace comes from the test-local fixture.

const runId = freezeFixture.after.pinned_run.run_id;

type Harness = { frozen: boolean; dataValidation: boolean; freezeBodies: Json[]; dvBodies: Json[] };

async function harness(page: Page, respond: (h: Harness, request: Request) => { status: number; body: unknown }) {
  const h: Harness = { frozen: false, dataValidation: true, freezeBodies: [], dvBodies: [] };
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const workspace = await liveWorkspace(route);
    if (!workspace) return;
    const body = h.frozen
      ? frozenWorkspace(workspace, h.dataValidation ? {} : { data_validation_executions: [] })
      : workspace;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/api/v1/studies/*/pinned-runs", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    h.freezeBodies.push(request.postDataJSON() as Json);
    const { status, body } = respond(h, request);
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/api/v1/studies/*/data-validation-packages", async (route) => {
    h.dvBodies.push(route.request().postDataJSON() as Json);
    h.dataValidation = true;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(freezeFixture.after.data_validation_executions) });
  });
  return h;
}

function freezeSucceeds(h: Harness) {
  h.frozen = true;
  h.dataValidation = true;
  return { status: 201, body: freezeFixture.after.pinned_run };
}

test("renders the manifest from the workspace and keeps freeze disabled until consent", async ({ page, request }) => {
  const workspace = (await (await request.get(`${apiRoot}/studies/${studyId}/workspace`)).json()) as {
    manifest: { artifact_id: string; name: string }[];
  };
  await harness(page, freezeSucceeds);
  await page.goto("/");
  const gate = page.getByTestId("upload-gate");
  await expect(gate).toBeVisible();
  await expect(page.getByTestId("upload-gate-banner")).toBeVisible();
  const rows = page.getByTestId("manifest-table").locator('[role="row"]:not(.head)');
  await expect(rows).toHaveCount(workspace.manifest.length);
  for (const entry of workspace.manifest) {
    await expect(page.getByTestId("manifest-table")).toContainText(entry.name);
    await expect(page.getByTestId(`manifest-status-${entry.artifact_id}`)).not.toHaveText("Frozen");
  }
  await expect(page.getByTestId("unsupported-upload-validation")).toContainText("not available yet");
  await expect(page.getByTestId("authorization-checklist")).toContainText(`of ${workspace.manifest.length} seeded inputs authorized`);
  const freeze = page.getByTestId("freeze-manifest");
  await expect(freeze).toBeDisabled();
  await page.getByTestId("freeze-consent").check();
  await expect(freeze).toBeEnabled();
  await page.getByTestId("freeze-consent").uncheck();
  await expect(freeze).toBeDisabled();
  expect(await page.locator("body").innerText()).not.toMatch(regulatoryClaim);
});

test("freezes through the server, shows the Pinned Run, and restores it on reload", async ({ page }) => {
  const h = await harness(page, freezeSucceeds);
  await page.goto("/");
  await page.getByTestId("freeze-consent").check();
  await page.getByTestId("freeze-manifest").click();
  expect(h.freezeBodies).toHaveLength(1);
  expect(h.freezeBodies[0].actor).toBeTruthy();
  expect(String(h.freezeBodies[0].idempotency_key)).toMatch(/^STUDY-HLX-028:[0-9a-f]+:freeze-pinned-run:v1:AUTH-/);

  await expect(page.getByTestId("freeze-live")).toHaveText(`Manifest frozen by the server as Pinned Run ${runId}.`);
  // Progress moved only because the refreshed workspace says so.
  await expect(stageButtons(page).nth(0)).toHaveAccessibleName(/\(Approved\)$/);
  await expect(stageButtons(page).nth(4)).toHaveAttribute("aria-current", "step");
  await stageButtons(page).nth(0).click();
  const detail = page.getByTestId("pinned-run-detail");
  await expect(detail).toBeVisible();
  const run = freezeFixture.after.pinned_run as Json & {
    manifest_hash: string;
    receipt: { receipt_id: string };
    run_plan: { run_plan_id: string };
    governed_inputs: unknown[];
    study_type_resolution: { study_type_id: string | null };
  };
  await expect(page.getByTestId("pinned-run-id")).toHaveText(runId);
  await expect(page.getByTestId("pinned-run-manifest-hash")).toHaveText(run.manifest_hash);
  await expect(page.getByTestId("pinned-run-receipt")).toHaveText(run.receipt.receipt_id);
  await expect(page.getByTestId("pinned-run-plan")).toContainText(run.run_plan.run_plan_id);
  await expect(page.getByTestId("pinned-run-governed-inputs")).toContainText(`Governed inputs (${run.governed_inputs.length})`);
  await expect(page.getByTestId("pinned-run-resolution")).toContainText(String(run.study_type_resolution.study_type_id ?? "unresolved"));
  const execution = (freezeFixture.after.data_validation_executions as { receipt: { receipt_id: string } }[])[0];
  await expect(page.getByTestId("pinned-run-data-validation")).toContainText(execution.receipt.receipt_id);
  await expect(page.getByTestId("freeze-manifest")).toBeDisabled();
  await expect(page.getByTestId("freeze-manifest")).toContainText(runId);
  await expect(page.getByTestId("intake-upload")).toHaveCount(0);

  await page.reload();
  await stageButtons(page).nth(0).click();
  await expect(page.getByTestId("pinned-run-id")).toHaveText(runId);
  await expect(page.getByTestId("upload-gate")).toHaveAttribute("data-frozen", "true");
  expect(h.freezeBodies).toHaveLength(1);
});

test("a retry after an unknown result reuses the same idempotency key, even after reload", async ({ page }) => {
  let calls = 0;
  const h = await harness(page, (state) => {
    calls += 1;
    if (calls === 1) return { status: 503, body: { detail: "upstream timeout" } };
    return freezeSucceeds(state);
  });
  await page.goto("/");
  await page.getByTestId("freeze-consent").check();
  await page.getByTestId("freeze-manifest").click();
  await expect(page.getByTestId("freeze-error")).toBeVisible();
  await page.reload();
  await page.getByTestId("freeze-consent").check();
  await page.getByTestId("freeze-manifest").click();
  await expect(page.getByTestId("freeze-live")).toContainText(runId);
  expect(h.freezeBodies).toHaveLength(2);
  expect(h.freezeBodies[1].idempotency_key).toBe(h.freezeBodies[0].idempotency_key);
});

test("a changed manifest uses a new idempotency key", async ({ page }) => {
  let changed = false;
  const bodies: Json[] = [];
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const workspace = (await liveWorkspace(route)) as (Json & { manifest: Json[] }) | null;
    if (!workspace) return;
    if (changed) workspace.manifest = workspace.manifest.map((entry, index) => (index === 0 ? { ...entry, checksum: "sha256:changed" } : entry));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(workspace) });
  });
  await page.route("**/api/v1/studies/*/pinned-runs", async (route) => {
    bodies.push(route.request().postDataJSON() as Json);
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "try again" }) });
  });
  await page.goto("/");
  await page.getByTestId("freeze-consent").check();
  await page.getByTestId("freeze-manifest").click();
  await expect(page.getByTestId("freeze-error")).toBeVisible();
  changed = true;
  await page.reload();
  await page.getByTestId("freeze-consent").check();
  await page.getByTestId("freeze-manifest").click();
  await expect(page.getByTestId("freeze-error")).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1].idempotency_key).not.toBe(bodies[0].idempotency_key);
});

test("shows the server refusal list and stays unfrozen", async ({ page }) => {
  await harness(page, () => ({
    status: 422,
    body: {
      // Shape copied from the live API refusal for the unqualified shipped packages.
      detail: [
        { code: "invalid_package_qualification", subject: "section.5_2_3_body_weight", message: "Agentic package qualification has not passed" },
        { code: "invalid_package_qualification", subject: "section.5_3_discussion", message: "Agentic package qualification has not passed" },
      ],
    },
  }));
  await page.goto("/");
  await page.getByTestId("freeze-consent").check();
  await page.getByTestId("freeze-manifest").click();
  await expect(page.getByTestId("freeze-refused")).toContainText("section.5_2_3_body_weight");
  await expect(page.getByTestId("freeze-live")).toContainText("refused");
  await expect(page.getByTestId("upload-gate")).toHaveAttribute("data-frozen", "false");
  await expect(stageButtons(page).nth(1)).toBeDisabled();
});

test("a Data Validation failure after freeze shows the partial state and retries with the run-scoped key", async ({ page }) => {
  const retry = {
    operation: "run_data_validation",
    method: "POST",
    path: `/api/v1/studies/${studyId}/data-validation-packages`,
    package_id: "validation.body_weight",
    idempotency_key: `dvp-${runId}-validation.body_weight`,
  };
  const h = await harness(page, (state) => {
    state.frozen = true;
    state.dataValidation = false;
    return {
      status: 409,
      body: {
        detail: {
          code: "data_validation_failed_after_freeze",
          message: "Manifest frozen; Data Validation failed.",
          study_id: studyId,
          run_id: runId,
          pinned_run_preserved: true,
          reason: "RuntimeError",
          retry,
        },
      },
    };
  });
  await page.goto("/");
  await page.getByTestId("freeze-consent").check();
  await page.getByTestId("freeze-manifest").click();
  await expect(page.getByTestId("freeze-partial")).toContainText("Manifest frozen; Data Validation failed.");
  await expect(page.getByTestId("pinned-run-data-validation-missing")).toBeVisible();

  // The partial state is derived from the workspace, so it survives a reload.
  await page.reload();
  await stageButtons(page).nth(0).click();
  await expect(page.getByTestId("freeze-partial")).toBeVisible();
  await page.getByTestId("retry-data-validation").click();
  await expect(page.getByTestId("freeze-partial")).toHaveCount(0);
  await expect(page.getByTestId("freeze-live")).toHaveText(`Data Validation recorded for Pinned Run ${runId}.`);
  expect(h.dvBodies).toHaveLength(1);
  expect(h.dvBodies[0].idempotency_key).toBe(retry.idempotency_key);
  expect(h.dvBodies[0].package_id).toBe("validation.body_weight");
  expect(h.freezeBodies).toHaveLength(1);
});

test("only Human Gate 1 can pin a run: legacy validation is hidden and the API refuses to auto-freeze", async ({ page, request }) => {
  // P1 on #22, against the live API: no service actor may freeze the manifest.
  await page.goto("/");
  await expect(page.getByTestId("freeze-consent")).not.toBeChecked();
  await expect(page.getByTestId("validation-locked")).toBeVisible();
  await expect(page.getByTestId("run-validation")).toBeDisabled();
  await expect(page.getByTestId("run-body-weight-validation")).toBeDisabled();

  for (const [path, body, operation] of [
    ["validation-runs", { planner: "fixture" }, "run_validation"],
    [
      "data-validation-packages",
      { actor: "HELIX validation service", package_id: "validation.body_weight", idempotency_key: "dvp-e2e-no-human-freeze" },
      "run_data_validation",
    ],
  ] as const) {
    const response = await request.post(`${apiRoot}/studies/${studyId}/${path}`, { data: body });
    expect(response.status()).toBe(409);
    const detail = ((await response.json()) as { detail: Json }).detail;
    expect(detail.code).toBe("human_freeze_required");
    expect(detail.operation).toBe(operation);
  }
  const workspace = (await (await request.get(`${apiRoot}/studies/${studyId}/workspace`)).json()) as Json;
  expect(workspace.pinned_run).toBeNull();
});

test("legacy validation unlocks once a human freeze has pinned the run", async ({ page }) => {
  await serveWorkspace(page, (workspace) => frozenWorkspace(workspace));
  await page.goto("/");
  await expect(page.getByTestId("validation-locked")).toHaveCount(0);
  await expect(page.getByTestId("run-validation")).toBeEnabled();
  await expect(page.getByTestId("run-body-weight-validation")).toBeEnabled();
});
