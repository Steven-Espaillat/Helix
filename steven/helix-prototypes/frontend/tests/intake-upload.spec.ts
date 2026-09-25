import { expect, test } from "@playwright/test";

import { type Json } from "./lane-a-helpers";

// Lane A (#26, partial): upload through the existing background intake job. The job
// routes are mocked; stage counts come only from the job response.

function job(status: string, completed: number, stage: string | null, extra: Json = {}): Json {
  const all = ["received", "expanded", "classified", "parsed", "persisted"];
  return {
    job_id: "JOB-TEST0001",
    study_id: "STUDY-UP-001",
    status,
    stage,
    stages_completed: completed,
    stages_total: 5,
    stages: Object.fromEntries(all.slice(0, completed).map((name) => [name, { ms: 1 }])),
    metrics: null,
    receipt: null,
    error: null,
    created_at: null,
    updated_at: null,
    ...extra,
  };
}

test("submit stays disabled until files and governed facts are supplied, and never claims receipt early", async ({ page }) => {
  await page.goto("/");
  const form = page.getByTestId("intake-upload");
  await expect(form).toBeVisible();
  await expect(page.getByTestId("intake-submit")).toBeDisabled();
  await page.getByTestId("intake-files").setInputFiles({ name: "bw.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") });
  await expect(form).toContainText("not yet received by HELIX");
  await page.getByTestId("intake-study-id").fill("study-up-001");
  await expect(page.getByTestId("intake-study-id")).toHaveValue("STUDY-UP-001");
  await page.getByTestId("intake-route").fill("oral gavage");
  await page.getByTestId("intake-protocol-version").fill("1.0");
  await expect(page.getByTestId("intake-submit")).toBeDisabled();
  await page.getByTestId("intake-authorized-by").fill("Study owner");
  await expect(page.getByTestId("intake-submit")).toBeEnabled();
  await expect(page.getByTestId("intake-gaps")).toContainText("not available yet");
});

test("polls the job stage by stage and selects the new study when it succeeds", async ({ page }) => {
  const sequence = [job("running", 1, "expanded"), job("running", 3, "parsed"), job("succeeded", 5, null)];
  let polls = 0;
  let submitted: string | null = null;
  await page.route("**/api/v1/studies/jobs", async (route) => {
    submitted = route.request().postData();
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(job("queued", 0, null)) });
  });
  await page.route("**/api/v1/studies/jobs/JOB-TEST0001", async (route) => {
    const next = sequence[Math.min(polls, sequence.length - 1)];
    polls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(next) });
  });
  await page.goto("/");
  await page.getByTestId("intake-files").setInputFiles({ name: "bw.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") });
  await page.getByTestId("intake-study-id").fill("STUDY-UP-001");
  await page.getByTestId("intake-route").fill("oral gavage");
  await page.getByTestId("intake-protocol-version").fill("1.0");
  await page.getByTestId("intake-authorized-by").fill("Study owner");
  await page.getByTestId("intake-submit").click();
  await expect(page.getByTestId("intake-job-count")).toHaveText("0 of 5 stages");
  await expect(page.getByTestId("intake-job-count")).toHaveText("3 of 5 stages");
  await expect(page.getByTestId("intake-stage-classified")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("intake-stage-parsed")).toHaveAttribute("data-state", "current");
  await expect(page).toHaveURL(/STUDY-UP-001/, { timeout: 15_000 });
  expect(submitted).toContain("oral gavage");
  expect(submitted).toContain("bw.csv");
});

test("a failed job shows the server error and does not select a study", async ({ page }) => {
  await page.route("**/api/v1/studies/jobs", (route) =>
    route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(job("queued", 0, null)) }),
  );
  await page.route("**/api/v1/studies/jobs/JOB-TEST0001", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(job("failed", 2, "classified", { error: "Unrecognized domain in bw.csv" })),
    }),
  );
  await page.goto("/");
  await page.getByTestId("intake-files").setInputFiles({ name: "bw.csv", mimeType: "text/csv", buffer: Buffer.from("x") });
  await page.getByTestId("intake-study-id").fill("STUDY-UP-001");
  await page.getByTestId("intake-route").fill("oral gavage");
  await page.getByTestId("intake-protocol-version").fill("1.0");
  await page.getByTestId("intake-authorized-by").fill("Study owner");
  await page.getByTestId("intake-submit").click();
  await expect(page.getByTestId("intake-job-error")).toHaveText("Unrecognized domain in bw.csv");
  await expect(page.getByTestId("intake-stage-classified")).toHaveAttribute("data-state", "pending");
  await expect(page).not.toHaveURL(/STUDY-UP-001/);
});
