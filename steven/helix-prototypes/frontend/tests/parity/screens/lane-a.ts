import type { ParityScreen } from "../types";

// OWNER: Lane A (#19 journey progress, #20 freeze manifest, #26 upload/run controls).
// Flip `status` to "enforced" when the screen ships. Match the reference `?stage=N`
// to the server state the lane's backend is seeded into.

export const laneAScreens: ParityScreen[] = [
  {
    id: "journey-progress-light",
    title: "Progress Bar in the shell (#19)",
    lane: "A",
    issue: "#19",
    status: "pending",
    colorScheme: "light",
    reference: { path: "?stage=0", selector: ".hx-stepper" },
    ours: { path: "/", selector: '[data-testid="progress-region"]', waitFor: '[data-testid="release-status"]' },
    notes: "Set the reference ?stage to the seeded server stage before enforcing.",
  },
  {
    id: "upload-gate-light",
    title: "Human Gate 1 upload + authorization (#20)",
    lane: "A",
    issue: "#20",
    status: "pending",
    colorScheme: "light",
    reference: { path: "?stage=0", selector: "#hx-panel", mask: [".hx-drop"] },
    ours: { path: "/", selector: '[data-testid="stage-view"]', waitFor: '[data-testid="release-status"]', mask: [".hx-drop"] },
    notes: "#20 disables or removes the drop zone and relabels the primary action; mask or accept those diffs explicitly.",
  },
];
