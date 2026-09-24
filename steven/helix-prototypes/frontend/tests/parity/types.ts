// Visual parity kit types (UI step 0). See tests/parity/README.md.

export type Lane = "step0" | "A" | "B" | "C" | "D";

/**
 * enforced     compared and FAILS the run above maxDiffRatio.
 * report-only  compared and reported, never fails (e.g. whole-page drift while lanes land).
 * pending      skipped until the owning lane implements the screen; run it anyway
 *              with HELIX_PARITY_INCLUDE_PENDING=1 (reported, never fails).
 */
export type ParityStatus = "enforced" | "report-only" | "pending";

export type CaptureSpec = {
  /** Ours: path appended to HELIX_PARITY_BASE_URL. Reference: query/hash appended to the file URL (e.g. "?stage=7"). */
  path: string;
  /** Element to capture (first match), or "viewport" for the whole 1440x900 viewport. */
  selector: string;
  /** Wait for this selector before capturing (defaults to `selector`). */
  waitFor?: string;
  /** Regions excluded from the diff on BOTH images (union of both sides' boxes). */
  mask?: string[];
  /** Replace text of matching elements before capture (use sparingly; document why). */
  replaceText?: Array<{ selector: string; text: string }>;
  /** Extra CSS injected before capture. */
  css?: string;
};

export type ParityScreen = {
  id: string;
  title: string;
  lane: Lane;
  issue?: string;
  status: ParityStatus;
  colorScheme: "light" | "dark";
  /** Reference file relative to steven/helix-prototypes (default research/helix-e2e-workbench-v1.html). */
  referenceFile?: string;
  reference: CaptureSpec;
  ours: CaptureSpec;
  /** Per-screen override of the failing diff ratio. Justify it in `notes`. */
  maxDiffRatio?: number;
  /** Per-screen override of pixelmatch's per-pixel color threshold (0..1). */
  pixelThreshold?: number;
  notes?: string;
};
