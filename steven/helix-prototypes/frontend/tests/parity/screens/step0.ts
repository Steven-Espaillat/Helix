import type { ParityScreen } from "../types";

// OWNER: UI step 0. Shell chrome and shared-component fixtures.
// Fixture screens render src/app/parity (needs HELIX_PARITY_FIXTURES=1 on the web server).

const header = (colorScheme: "light" | "dark"): ParityScreen => ({
  id: `shell-header-${colorScheme}`,
  title: `Shell header (${colorScheme})`,
  lane: "step0",
  issue: "#18",
  status: "enforced",
  colorScheme,
  reference: { path: "?stage=0", selector: ".hx-top", mask: [".hx-study span", ".hx-avatar"] },
  ours: {
    path: "/",
    selector: '[data-testid="shell-header"]',
    waitFor: '[data-testid="release-status"]',
    mask: ['[data-testid="study-descriptor"]', '[data-testid="demo-avatar"]'],
  },
  // The header is 1440x60 and the brand mark is well under 1% of it, so the
  // default 1% budget let a full logo recolor pass (0.6%). Identical markup
  // measures 0.000%, so hold the header to 0.1%.
  maxDiffRatio: 0.001,
  notes:
    "Strict 0.1% budget (brand mark is under 1% of the header area). Masks: the study descriptor is server data (the reference copy is static), and the avatar is the documented #27 deviation (synthetic identity icon instead of initials). The release pill must read 'Release blocked' on both sides (fresh seed).",
});

const rail = (stage: number, colorScheme: "light" | "dark"): ParityScreen => ({
  id: `component-stage-rail-s${stage}-${colorScheme}`,
  title: `Shared StageRail at reference ?stage=${stage} (${colorScheme})`,
  lane: "step0",
  status: "enforced",
  colorScheme,
  reference: { path: `?stage=${stage}`, selector: ".hx-stepper" },
  ours: { path: `/parity?fixture=upload&stage=${stage}`, selector: '[data-testid="fixture-rail"]' },
  notes: "Component fixture with the reference STAGES copy. Lane A wires the same component to workspace.journey.",
});

export const step0Screens: ParityScreen[] = [
  header("light"),
  header("dark"),
  rail(0, "light"),
  rail(7, "light"),
  rail(0, "dark"),
  {
    id: "component-gate-banner-light",
    title: "Shared GateBanner (gate 1 awaiting)",
    lane: "step0",
    status: "enforced",
    colorScheme: "light",
    reference: { path: "?stage=0", selector: "#hx-panel .hx-banner" },
    ours: { path: "/parity?fixture=upload&stage=0", selector: '[data-testid="fixture-gate-banner"]' },
  },
  {
    id: "component-file-table-light",
    title: "Shared DataTable + Chip (reference upload file table)",
    lane: "step0",
    status: "enforced",
    colorScheme: "light",
    reference: { path: "?stage=0", selector: "#hx-panel .hx-table" },
    ours: { path: "/parity?fixture=upload&stage=0", selector: '[data-testid="fixture-file-table"]' },
  },
  {
    id: "component-auth-card-light",
    title: "Shared Card + Kicker + ListRow + Button (reference authorization card)",
    lane: "step0",
    status: "enforced",
    colorScheme: "light",
    reference: { path: "?stage=0", selector: "#hx-panel .g-upload > aside" },
    ours: { path: "/parity?fixture=upload&stage=0", selector: '[data-testid="fixture-auth-card"]' },
    notes: "The consent label and copy are reference fixture text; #20 changes the production label.",
  },
  {
    id: "component-upload-composition-light",
    title: "Shared components composed as the reference ?stage=0 viewport (fixture copy)",
    lane: "step0",
    status: "enforced",
    colorScheme: "light",
    reference: { path: "?stage=0", selector: "viewport", mask: [".hx-avatar"] },
    ours: { path: "/parity?fixture=upload&stage=0", selector: "viewport", mask: ['[data-testid="demo-avatar"]'] },
    notes:
      "Header, StageRail, GateBanner, Card, DataTable, Chip, ListRow, Button and the lane-A upload seed CSS together. The drop zone and consent styles come from src/styles/views/upload.css.",
  },
  {
    id: "shell-viewport-light",
    title: "Whole first viewport, shell vs reference ?stage=0",
    lane: "step0",
    status: "report-only",
    colorScheme: "light",
    reference: { path: "?stage=0", selector: "viewport", mask: [".hx-study span", ".hx-avatar"] },
    ours: {
      path: "/",
      selector: "viewport",
      waitFor: '[data-testid="release-status"]',
      mask: ['[data-testid="study-descriptor"]', '[data-testid="demo-avatar"]'],
    },
    notes:
      "Report-only until lanes A-D replace the pre-v1 panels below the header. Expected to be far from the reference today; it tracks overall drift.",
  },
];
