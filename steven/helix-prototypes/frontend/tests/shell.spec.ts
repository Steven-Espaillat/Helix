import { expect, test, type Page } from "@playwright/test";

// UI SLICE 0 (#18): v1 tokens and the one-page shell.
// Source of truth: research/helix-e2e-workbench-v1.html (header + token block).

const apiRoot = process.env.HELIX_API_URL ?? "http://127.0.0.1:8000/api/v1";
const studyId = "STUDY-HLX-028";

const releaseLabels: Record<string, string> = {
  blocked: "Release blocked",
  ready_for_review: "Ready for review",
  ready_for_signature: "Ready for signature",
  ready_for_export: "Ready for export",
  exported: "Package exported",
};

// Resolved values of the reference light-dark() tokens.
const themeTokens = {
  light: { bg: "rgb(245, 247, 248)", surface: "rgb(255, 255, 255)", ink: "rgb(17, 28, 36)", accent: "#0a5f66" },
  dark: { bg: "rgb(13, 20, 27)", surface: "rgb(20, 30, 40)", ink: "rgb(231, 238, 246)", accent: "#5cc3cb" },
} as const;

const forbiddenClaims =
  /FDA[- ]approv|approved by (the )?FDA|FDA[- ]complian|compliant with (the )?FDA|submission[- ]read|ready for submission/i;

for (const colorScheme of ["light", "dark"] as const) {
  test(`renders the v1 header and one-page shell in ${colorScheme} theme`, async ({ page, request }) => {
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.emulateMedia({ colorScheme });

    const workspaceResponse = await request.get(`${apiRoot}/studies/${studyId}/workspace`);
    expect(workspaceResponse.ok()).toBeTruthy();
    const workspace = (await workspaceResponse.json()) as {
      study: { study_id: string; species: string; duration_days: number; route: string };
      workflow_state: string;
      release_gate: { status: string };
      report: { template: { version: string } };
    };

    await page.goto("/");
    await expect(page.getByTestId("helix-workbench")).toBeVisible();

    const header = page.getByTestId("shell-header");
    await expect(header.getByText("HELIX", { exact: true })).toBeVisible();
    await expect(page.getByTestId("study-id")).toHaveText(workspace.study.study_id);
    const descriptor = page.getByTestId("study-descriptor");
    await expect(descriptor).toContainText(`${workspace.study.duration_days}-day ${workspace.study.route}`);
    await expect(descriptor).toContainText(workspace.study.species);
    await expect(descriptor).toContainText(`Template ${workspace.report.template.version}`);
    await expect(page.getByTestId("synthetic-badge")).toHaveText("Synthetic data · Not for submission");
    await expect(page.getByTestId("synthetic-badge")).toBeVisible();

    const pill = page.getByTestId("release-status");
    await expect(pill).toHaveText(releaseLabels[workspace.release_gate.status]);
    await expect(pill).toHaveAttribute("data-status", workspace.release_gate.status);
    await expect(pill).toHaveAttribute("data-workflow-state", workspace.workflow_state);
    await expect(page.getByTestId("workflow-state")).toHaveText(workspace.workflow_state);

    const avatar = page.getByRole("img", { name: /Synthetic demo identity/ });
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveAttribute("aria-label", /Not an authenticated user or signer/);

    // Reserved regions for the progress bar and the stage view.
    await expect(page.getByTestId("progress-region")).toBeVisible();
    await expect(page.getByTestId("stage-view")).toBeVisible();

    // The old three tabs and any side menu are absent.
    for (const name of [/Study journey/, /Evidence chain/, /Report assembly/]) {
      await expect(page.getByRole("button", { name })).toHaveCount(0);
      await expect(page.getByRole("tab", { name })).toHaveCount(0);
    }
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByRole("tablist")).toHaveCount(0);

    // Tokens resolve per theme.
    const colors = await page.evaluate(() => {
      const shell = document.getElementById("helix-e2e")!;
      const top = shell.querySelector(".hx-top")!;
      return {
        bg: getComputedStyle(shell).backgroundColor,
        surface: getComputedStyle(top).backgroundColor,
        ink: getComputedStyle(shell).color,
        accent: getComputedStyle(document.documentElement).getPropertyValue("--hx-accent").trim().toLowerCase(),
      };
    });
    expect(colors.bg).toBe(themeTokens[colorScheme].bg);
    expect(colors.surface).toBe(themeTokens[colorScheme].surface);
    expect(colors.ink).toBe(themeTokens[colorScheme].ink);
    expect(colors.accent).toBe(themeTokens[colorScheme].accent);

    // Typography: Plex Sans for UI, Plex Mono for identifiers, Georgia only in the report body.
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      const georgiaOutsideReport = Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .filter((element) => getComputedStyle(element).fontFamily.includes("Georgia"))
        .filter((element) => !element.closest(".report-paper"))
        .map((element) => element.className || element.tagName);
      return {
        shell: getComputedStyle(document.getElementById("helix-e2e")!).fontFamily,
        studyId: getComputedStyle(document.querySelector('[data-testid="study-id"]')!).fontFamily,
        plexSansLoaded: document.fonts.check('600 14px "IBM Plex Sans"'),
        plexMonoLoaded: document.fonts.check('500 14px "IBM Plex Mono"'),
        georgiaOutsideReport,
      };
    });
    expect(fonts.shell.startsWith('"IBM Plex Sans"')).toBeTruthy();
    expect(fonts.studyId.startsWith('"IBM Plex Mono"')).toBeTruthy();
    expect(fonts.plexSansLoaded).toBeTruthy();
    expect(fonts.plexMonoLoaded).toBeTruthy();
    expect(fonts.georgiaOutsideReport).toEqual([]);

    // Inline stroke SVG icons; no emoji or decorative text symbols in the shell chrome.
    await expect(header.locator("svg")).toHaveCount(2);
    const chromeText = await page.evaluate(() =>
      [".hx-top", '[data-testid="progress-region"]'].map((selector) => document.querySelector(selector)!.textContent ?? "").join(" "),
    );
    expect(chromeText).not.toMatch(/[\p{Extended_Pictographic}\u2713\u2714\u2192\u2190]/u);
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/\p{Extended_Pictographic}/u);

    await assertNoRegulatoryClaim(page);
    await page.screenshot({ path: `../evidence/helix-v1-shell-${colorScheme}.png` });
    expect(browserErrors).toEqual([]);
  });
}

test("announces workspace loading and API errors and retries from the keyboard", async ({ page }) => {
  let workspaceCalls = 0;
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    workspaceCalls += 1;
    if (workspaceCalls === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Synthetic outage for the retry boundary." }),
      });
      return;
    }
    // Hold the retry long enough to observe the announced loading state.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });

  await page.goto("/");
  const alert = page.getByRole("alert", { name: "The workbench API is unavailable." });
  await expect(alert).toContainText("The workbench API is unavailable.");
  await expect(page.getByRole("heading", { name: "The workbench API is unavailable." })).toBeVisible();
  await expect(page.getByTestId("synthetic-badge")).toHaveText("Synthetic data · Not for submission");
  await expect(page.getByTestId("release-status")).toHaveCount(0);

  const retry = page.getByRole("button", { name: "Retry connection" });
  await page.keyboard.press("Tab");
  await expect(retry).toBeFocused();
  await page.keyboard.press("Enter");

  const loading = page.getByRole("status");
  await expect(loading).toContainText("Building the evidence workspace.");
  await expect(loading).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("helix-workbench")).toBeVisible();
  await expect(page.getByTestId("release-status")).toBeVisible();
  expect(workspaceCalls).toBe(2);
});

test("renders the release pill from server state without inferring readiness", async ({ page }) => {
  let status = "ready_for_export";
  await page.route("**/api/v1/studies/*/workspace", async (route) => {
    const response = await route.fetch();
    const workspace = (await response.json()) as Record<string, unknown> & {
      release_gate: Record<string, unknown>;
    };
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      // Only the gate status changes; blockers and approvals stay as the server sent them.
      body: JSON.stringify({ ...workspace, release_gate: { ...workspace.release_gate, status } }),
    });
  });

  await page.goto("/");
  const pill = page.getByTestId("release-status");
  await expect(pill).toHaveText("Ready for export");
  await expect(pill).toHaveAttribute("data-status", "ready_for_export");

  status = "exported";
  await page.reload();
  await expect(pill).toHaveText("Package exported");
  await expect(pill).toHaveAttribute("data-status", "exported");
  await assertNoRegulatoryClaim(page);
});

async function assertNoRegulatoryClaim(page: Page) {
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(forbiddenClaims);
}
