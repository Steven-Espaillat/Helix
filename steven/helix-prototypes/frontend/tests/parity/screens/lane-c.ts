import type { ParityScreen } from "../types";

// OWNER: Lane C (#22 Traceability Review gate).

export const laneCScreens: ParityScreen[] = [
  {
    id: "traceability-gate-light",
    title: "Human Gate 2 Traceability Review (#22)",
    lane: "C",
    issue: "#22",
    status: "pending",
    colorScheme: "light",
    reference: { path: "?stage=7", selector: "#hx-panel" },
    ours: { path: "/", selector: '[data-testid="stage-view"]', waitFor: '[data-testid="release-status"]' },
  },
];
