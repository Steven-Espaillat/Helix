// Visual parity kit defaults (UI step 0). Rationale: tests/parity/README.md.

/** Both sides render at this CSS viewport with deviceScaleFactor 1. */
export const VIEWPORT = { width: 1440, height: 900 } as const;

/**
 * pixelmatch per-pixel YIQ color-distance threshold (0..1). The pixelmatch
 * default (0.1) is too loose for this palette: at 0.1, swapping --hx-surface
 * white for cream, --hx-bg, or --hx-line for --hx-line-soft measured 0.000%.
 * At 0.02 those swaps fail every enforced screen while identical markup still
 * measures 0.000%. scripts/verify-parity-sensitivity.sh proves both.
 * Token values are also checked directly (the "design tokens" tests).
 */
export const DEFAULT_PIXEL_THRESHOLD = 0.02;

/**
 * A screen FAILS when more than 1% of its compared (unmasked) pixels differ.
 * Anti-aliased pixels are excluded (includeAA: false). With the same fonts on
 * both sides, identical markup measures 0%; a 1px shift of one text line or a
 * wrong font weight in a component measures well above 1%.
 */
export const DEFAULT_MAX_DIFF_RATIO = 0.01;

export const DEFAULT_REFERENCE_FILE = "research/helix-e2e-workbench-v1.html";

export const BASE_URL = (process.env.HELIX_PARITY_BASE_URL ?? "http://127.0.0.1:3020").replace(/\/$/, "");
// Default output is uncommitted (gitignored) so parallel lane runs never
// conflict. Commit only your own screens' folders under evidence/parity/
// (see README "Evidence").
export const OUT_DIR = process.env.HELIX_PARITY_OUT ?? "parity-out";
/**
 * Sensitivity self-test only: extra CSS injected into OUR side (never the
 * reference). scripts/verify-parity-sensitivity.sh uses it to prove the kit
 * fails on known token breaks. Never set it in a normal run.
 */
export const MUTATE_CSS = process.env.HELIX_PARITY_MUTATE_CSS ?? "";
export const INCLUDE_PENDING = process.env.HELIX_PARITY_INCLUDE_PENDING === "1";
export const ONLY = (process.env.HELIX_PARITY_ONLY ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
