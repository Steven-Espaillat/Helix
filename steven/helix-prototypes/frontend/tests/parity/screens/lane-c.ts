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
    // DH-5 (#70, spec #64) deliberately drops the reference's "3 passed / 1 blocked" tally
    // chips for one count-free claim status, so that header chip region is masked on both sides.
    reference: { path: "?stage=7", selector: "#hx-panel", mask: ['#hx-panel .stack > div[style*="space-between"] > div:last-child'] },
    ours: {
      path: "/parity/traceability",
      selector: '[data-testid="traceability-gate"]',
      waitFor: '[data-testid="trace-flow"]',
      mask: ['[data-testid="trace-summary"]'],
    },
    notes:
      "Fixture display state mirrors the reference RULES/TRACE copy. Remaining text differences are data-driven: rule labels come from server rule ids (e.g. 'Grain sex stratified' for 'Expected grain'), the evidence column prefixes the linked-ID count, and the transform detail lists the claim's grain key and input count. The header tally chips are masked: #70 replaces them with a single count-free claim status chip.",
  },
];
