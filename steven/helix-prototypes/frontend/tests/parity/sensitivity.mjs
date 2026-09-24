// Parity kit sensitivity self-test (UI step 0). Run via
// scripts/verify-parity-sensitivity.sh. Each case re-runs the kit with
// HELIX_PARITY_MUTATE_CSS injected into our side only and checks which
// enforced checks fail. Output: parity-out/sensitivity/<case>/ and
// parity-out/sensitivity/report.json.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const FRONTEND = path.resolve(import.meta.dirname, "../..");
const OUT = "parity-out/sensitivity";
const PIXEL_SCREENS = [
  "shell-header-light",
  "shell-header-dark",
  "component-stage-rail-s0-light",
  "component-stage-rail-s7-light",
  "component-stage-rail-s0-dark",
  "component-gate-banner-light",
  "component-file-table-light",
  "component-auth-card-light",
  "component-upload-composition-light",
];
const TOKENS = ["design-tokens-light", "design-tokens-dark"];

// mustFail: checks that MUST fail for this break. clean: nothing may fail.
const CASES = [
  { name: "clean", css: "", mustFail: [] },
  {
    name: "bg-plus-surface",
    css: ":root{--hx-bg:light-dark(#E3EEFF,#0D2440);--hx-surface:light-dark(#FFF1D6,#3A1E28)}",
    mustFail: [...PIXEL_SCREENS, ...TOKENS],
  },
  {
    name: "surface-only",
    css: ":root{--hx-surface:light-dark(#FFF1D6,#3A1E28)}",
    mustFail: [...TOKENS],
    mustFailSome: PIXEL_SCREENS,
  },
  {
    name: "bg-plus-line-soft",
    css: ":root{--hx-bg:light-dark(#E3EEFF,#0D2440);--hx-line:light-dark(#EEF1F3,#24374A)}",
    mustFail: [...TOKENS],
    mustFailSome: PIXEL_SCREENS,
  },
  {
    name: "accent",
    css: ":root{--hx-accent:light-dark(#C0392B,#FF5A36)}",
    mustFail: ["shell-header-light", "shell-header-dark", ...TOKENS],
  },
];

const report = [];
let ok = true;
for (const c of CASES) {
  const out = path.join(OUT, c.name);
  const run = spawnSync("npx", ["playwright", "test", "-c", "playwright.parity.config.ts", "--reporter=line"], {
    cwd: FRONTEND,
    env: { ...process.env, HELIX_PARITY_OUT: out, HELIX_PARITY_MUTATE_CSS: c.css },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const rows = JSON.parse(readFileSync(path.join(FRONTEND, out, "summary.json"), "utf8")).rows;
  const failed = rows.filter((row) => row.pass === false).map((row) => row.id);
  const problems = [];
  if (c.name === "clean") {
    if (run.status !== 0 || failed.length) problems.push(`clean run failed: ${failed.join(", ") || `exit ${run.status}`}`);
  } else {
    if (run.status === 0) problems.push("run exited 0 on a break");
    const missed = c.mustFail.filter((id) => !failed.includes(id));
    if (missed.length) problems.push(`break not caught by: ${missed.join(", ")}`);
    if (c.mustFailSome && !c.mustFailSome.some((id) => failed.includes(id))) problems.push("no pixel screen caught the break");
  }
  const ratios = Object.fromEntries(rows.map((row) => [row.id, row.ratio === null ? null : Number((row.ratio * 100).toFixed(3))]));
  report.push({ case: c.name, css: c.css, exit: run.status, failed, ratiosPct: ratios, ok: problems.length === 0, problems });
  if (problems.length) ok = false;
  console.log(`[sensitivity] ${c.name}: ${problems.length ? "PROBLEM " + problems.join("; ") : "ok"} (failed: ${failed.join(", ") || "none"})`);
}
mkdirSync(path.join(FRONTEND, OUT), { recursive: true });
writeFileSync(path.join(FRONTEND, OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(ok ? "[sensitivity] PASS" : "[sensitivity] FAIL");
process.exit(ok ? 0 : 1);
