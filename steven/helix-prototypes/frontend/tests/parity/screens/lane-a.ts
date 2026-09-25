import type { ParityScreen } from "../types";

// OWNER: Lane A (#19 journey progress, #20 freeze manifest, #26 upload/run controls).
// The seeded server state is Upload current (Gate 1 awaiting the study owner), which is
// the reference `?stage=0`.

export const laneAScreens: ParityScreen[] = [
  {
    id: "journey-progress-light",
    title: "Progress Bar in the shell (#19)",
    lane: "A",
    issue: "#19",
    status: "enforced",
    colorScheme: "light",
    reference: { path: "?stage=0", selector: ".hx-stepper" },
    ours: {
      path: "/",
      selector: '[data-testid="journey-progress"] .hx-stepper',
      waitFor: '[data-testid="release-status"]',
    },
    notes: "Seeded server stage is Upload current, matching ?stage=0.",
  },
  {
    id: "upload-gate-light",
    title: "Human Gate 1 upload + authorization (#20)",
    lane: "A",
    issue: "#20",
    status: "report-only",
    colorScheme: "light",
    reference: { path: "?stage=0", selector: "#hx-panel", mask: [".hx-drop"] },
    ours: {
      path: "/",
      selector: '[data-testid="upload-gate"]',
      waitFor: '[data-testid="manifest-table"]',
      mask: [".hx-drop", '[data-testid="intake-upload"]', '[data-testid="manifest-hashes"]'],
    },
    notes:
      "#20 relabels the drop zone and checklist to separate seeded facts from unsupported upload validation, and #26 adds the real intake form; those regions are masked.",
  },
];
