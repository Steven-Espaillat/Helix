import type { ParityScreen } from "../types";

// OWNER: Lane B (#21 Agent Steps + governed drafting).

export const laneBScreens: ParityScreen[] = [
  {
    id: "agent-step-light",
    title: "Agent Step view, stage 4 Extract (#21)",
    lane: "B",
    issue: "#21",
    status: "pending",
    colorScheme: "light",
    reference: { path: "?stage=3", selector: "#hx-panel", mask: [".hx-banner-right .hx-btn"] },
    ours: {
      path: "/",
      selector: '[data-testid="stage-view"]',
      waitFor: '[data-testid="release-status"]',
      mask: [".hx-banner-right .hx-btn"],
    },
    notes: "Pause/Resume are hidden or disabled until #26; the banner action is masked on both sides.",
  },
];
