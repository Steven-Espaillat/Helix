import type { ParityScreen } from "../types";

// OWNER: Lane B (#21 Agent Steps + governed drafting).
//
// Our side renders the real Agent Step view (AgentStageView, RunBanner, ActivityList)
// over the display-only `/parity/agent?stage=N` fixture (src/app/parity/agent, flag-gated
// by HELIX_PARITY_FIXTURES=1, no API calls). It mirrors the reference `?stage=N` state:
// earlier stages done, stage N paused, agent not running. Stage 4 is Validate (stage 5
// of 9), the reference stage with blocker actions.
//
// Deliberate, documented differences:
// - Pause/Resume are disabled until #26, so the banner button is masked on both sides.
// - Our stage card continues below the control boundary with receipt evidence from the
//   server Workspace (not in the reference). It is hidden with `css` on our side so the
//   reference-shaped card is compared.

const REF = "?stage=4";
const OURS = "/parity/agent?stage=4";
const WAIT = '[data-testid="agent-stage-view"][data-stage="validate"]';
const HIDE_EVIDENCE = '[data-testid="agent-stage-evidence"] { display: none !important; }';

export const laneBScreens: ParityScreen[] = [
  {
    id: "agent-run-banner-light",
    title: "Agent Step run banner, Validate paused (#21)",
    lane: "B",
    issue: "#21",
    status: "enforced",
    colorScheme: "light",
    reference: { path: REF, selector: "#hx-panel .hx-banner", mask: [".hx-banner-right .hx-btn"] },
    ours: {
      path: OURS,
      selector: '[data-testid="agent-run-banner"]',
      waitFor: WAIT,
      mask: ['[data-testid="agent-pause"]'],
    },
    notes: "Resume agent is disabled until #26 adds the command; the button is masked on both sides.",
  },
  {
    id: "agent-stage-card-light",
    title: "Agent Step stage card: summary, Input -> Output, control boundary (#21)",
    lane: "B",
    issue: "#21",
    status: "enforced",
    colorScheme: "light",
    reference: { path: REF, selector: "#hx-panel .g-agent > section:first-child" },
    ours: { path: OURS, selector: '[data-testid="agent-stage-card"]', waitFor: WAIT, css: HIDE_EVIDENCE },
    notes: "Receipt evidence below the control boundary is lane B content with no reference counterpart; hidden on our side.",
  },
  {
    id: "agent-activity-card-light",
    title: "Agent activity card: 'n of 4 actions', queued rows (#21)",
    lane: "B",
    issue: "#21",
    status: "enforced",
    colorScheme: "light",
    reference: { path: REF, selector: "#hx-panel .g-agent > section:last-child" },
    ours: { path: OURS, selector: '[data-testid="agent-activity-card"]', waitFor: WAIT },
  },
  {
    id: "agent-step-light",
    title: "Agent Step view, whole panel, Validate paused (#21)",
    lane: "B",
    issue: "#21",
    status: "enforced",
    colorScheme: "light",
    reference: { path: REF, selector: "#hx-panel", mask: [".hx-banner-right .hx-btn"] },
    ours: {
      path: OURS,
      selector: '[data-testid="fixture-agent-panel"]',
      waitFor: WAIT,
      mask: ['[data-testid="agent-pause"]'],
      css: HIDE_EVIDENCE,
    },
    notes: "Same masks and hidden evidence as the banner and stage-card screens.",
  },
];
