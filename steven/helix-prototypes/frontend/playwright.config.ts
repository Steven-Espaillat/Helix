import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // The visual parity kit has its own config (playwright.parity.config.ts).
  testIgnore: ["parity/**"],
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.HELIX_WEB_URL ?? "http://127.0.0.1:3000",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
