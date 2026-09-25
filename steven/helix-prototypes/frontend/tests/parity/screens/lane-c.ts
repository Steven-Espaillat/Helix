import type { ParityScreen } from "../types";

// OWNER: Lane C (#22 Traceability Review gate).
//
// The seeded synthetic backend sits at Upload and cannot reach Gate 2 without a qualified
// freeze and a Codex section run, so this screen renders the real TraceabilityStageView at
// the lane C fixture route `/parity/traceability`. That route 404s unless the server runs
// with HELIX_PARITY_FIXTURES=1, holds display state only (the reference `?stage=7` claim,
// C-BW-HIGH with four rules and one blocked grain rule), and never calls the API.

export const laneCScreens: ParityScreen[] = [
  {
    id: "traceability-gate-light",
    title: "Human Gate 2 Traceability Review (#22)",
    lane: "C",
    issue: "#22",
    status: "enforced",
    colorScheme: "light",
    reference: { path: "?stage=7", selector: "#hx-panel" },
    ours: {
      path: "/parity/traceability",
      selector: '[data-testid="traceability-gate"]',
      waitFor: '[data-testid="trace-flow"]',
    },
    notes:
      "Fixture display state mirrors the reference RULES/TRACE copy. Remaining text differences are data-driven: rule labels come from server rule ids (e.g. 'Grain sex stratified' for 'Expected grain'), the evidence column prefixes the linked-ID count, and the transform detail lists the claim's grain key and input count.",
  },
];
