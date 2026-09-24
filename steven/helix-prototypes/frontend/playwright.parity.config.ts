import { defineConfig } from "@playwright/test";

// Visual parity kit (UI step 0). Run with scripts/verify-parity.sh or
// `HELIX_PARITY_BASE_URL=http://127.0.0.1:<web-port> npm run test:parity`.
export default defineConfig({
  testDir: "./tests/parity",
  testMatch: /parity\.spec\.ts$/,
  globalSetup: "./tests/parity/global-setup.ts",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    trace: "off",
  },
});
