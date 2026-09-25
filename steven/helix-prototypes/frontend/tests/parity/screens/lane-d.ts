import type { ParityScreen } from "../types";

// OWNER: Lane D (#23 review/approval/export/downloads + demo-unqualified flag).
//
// Human Gate 3 is reachable only after a human freeze, validation, and traceability
// dispositions, so a fresh seed (the kit's throwaway server) never shows it. "Ours" is the
// lane-D fixture route /parity/review (HELIX_PARITY_FIXTURES=1 only; display state captured
// from a real review-export workspace, demo flag off).
//
// Chief of Staff decision (PR #25): the static chrome is ENFORCED at 0 % (header and rail at
// stage 8, the Gate 3 banner, and the gate control "Export final package"). The server-driven
// report body stays REPORT-ONLY with the report region masked. The reference is not refreshed.

const chrome = (colorScheme: "light" | "dark"): ParityScreen[] => [
  {
    id: `review-header-${colorScheme}`,
    title: `Gate 3 shell header (#23, ${colorScheme})`,
    lane: "D",
    issue: "#23",
    status: "enforced",
    colorScheme,
    reference: { path: "?stage=8", selector: ".hx-top", mask: [".hx-study span", ".hx-avatar"] },
    ours: {
      path: "/parity/review",
      selector: '[data-testid="shell-header"]',
      mask: ['[data-testid="study-descriptor"]', '[data-testid="demo-avatar"]'],
    },
    maxDiffRatio: 0.001,
    notes: "Same masks and 0.1% budget as step0 shell-header (descriptor and avatar are data / #27).",
  },
  {
    id: `review-rail-s8-${colorScheme}`,
    title: `Gate 3 Progress Bar at stage 8 (#23, ${colorScheme})`,
    lane: "D",
    issue: "#23",
    status: "enforced",
    colorScheme,
    reference: { path: "?stage=8", selector: ".hx-stepper" },
    ours: { path: "/parity/review", selector: '[data-testid="journey-progress"] .hx-stepper' },
    notes: "The real ProgressBar rendering the captured review-export journey (8 of 9 complete).",
  },
  {
    id: `review-gate-banner-${colorScheme}`,
    title: `Gate 3 banner (#23, ${colorScheme})`,
    lane: "D",
    issue: "#23",
    status: "enforced",
    colorScheme,
    reference: { path: "?stage=8", selector: "#hx-panel .hx-banner" },
    ours: { path: "/parity/review", selector: '[data-testid="review-gate-banner"]' },
  },
  {
    id: `review-export-control-${colorScheme}`,
    title: `Gate 3 control: Export final package, disabled before sign-off (#23, ${colorScheme})`,
    lane: "D",
    issue: "#23",
    status: "enforced",
    colorScheme,
    reference: {
      path: "?stage=8",
      selector: '#hx-panel [data-action="exportPkg"]',
      css: '#hx-panel aside > :not([data-action="exportPkg"]) { display: none !important; }',
    },
    ours: {
      path: "/parity/review",
      selector: '[data-testid="export-final-package"]',
      css: '[data-testid="sign-offs"] { display: none !important; }',
    },
    notes:
      "The sign-off list above the control is server-driven (masked in review-export-*). It is hidden on both sides so the control is compared on its own, without the sub-pixel offset the data height adds.",
  },
];

const reportMasks = {
  reference: [".hx-doc", ".hx-signoff", '#hx-panel nav[aria-label="Report sections"]', '#hx-panel aside'],
  ours: ['[data-testid="draft-canvas"]', '[data-testid="review-sections"]', '[data-testid="sign-offs"]', '[data-testid="export-panel"]', '[data-testid="review-message"]'],
};

const body = (colorScheme: "light" | "dark"): ParityScreen => ({
  id: `review-export-${colorScheme}`,
  title: `Human Gate 3 Review and export, full panel (#23, ${colorScheme})`,
  lane: "D",
  issue: "#23",
  status: "report-only",
  colorScheme,
  reference: { path: "?stage=8", selector: "#hx-panel", mask: reportMasks.reference },
  ours: { path: "/parity/review", selector: '[data-testid="review-stage"]', mask: reportMasks.ours },
  notes:
    "Report-only by decision: the report body is server-driven (WorkspaceResponse.report, per-role sign-offs, FSA scope), so the section list, canvas, and sign-off card are masked and the panel is taller than the reference.",
});

export const laneDScreens: ParityScreen[] = [...chrome("light"), ...chrome("dark"), body("light"), body("dark")];
