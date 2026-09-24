import type { ParityScreen } from "../types";

// OWNER: Lane D (#23 review/approval/export/downloads + demo-unqualified flag).

export const laneDScreens: ParityScreen[] = [
  {
    id: "review-export-light",
    title: "Human Gate 3 Review and export (#23)",
    lane: "D",
    issue: "#23",
    status: "pending",
    colorScheme: "light",
    reference: { path: "?stage=8", selector: "#hx-panel" },
    ours: { path: "/", selector: '[data-testid="stage-view"]', waitFor: '[data-testid="release-status"]' },
    notes: "#23 replaces 'Record demo approvals' with per-role controls; mask the sign-off actions or accept the diff explicitly.",
  },
  {
    id: "review-export-dark",
    title: "Human Gate 3 Review and export, dark (#23)",
    lane: "D",
    issue: "#23",
    status: "pending",
    colorScheme: "dark",
    reference: { path: "?stage=8", selector: "#hx-panel" },
    ours: { path: "/", selector: '[data-testid="stage-view"]', waitFor: '[data-testid="release-status"]' },
  },
];
