import { rmSync } from "node:fs";
import path from "node:path";

import { OUT_DIR } from "./parity.config";

// Clears the per-screen summary rows from a previous run.
export default function globalSetup() {
  rmSync(path.resolve(__dirname, "../..", OUT_DIR, ".rows"), { recursive: true, force: true });
}
