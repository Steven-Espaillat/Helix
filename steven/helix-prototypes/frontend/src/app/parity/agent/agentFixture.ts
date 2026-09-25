// Lane B (#21) display-only fixture for the parity kit ONLY (tests/parity).
// Agent-stage copy is verbatim from research/helix-e2e-workbench-v1.html (STAGES),
// so the diff measures styling, not wording. Values are synthetic. Never import
// this from production code: production renders server state.
import type { JourneyStage, Workspace } from "@/lib/types";

import { REFERENCE_STAGES } from "../fixtures";

type AgentCopy = {
  summary: string;
  input: [string, string];
  output: [string, string];
  boundary: string;
  acts: Array<[string, string?]>;
};

const AGENT_COPY: Record<number, AgentCopy> = {
  1: {
    summary: "Format-specific parsers convert each frozen file into normalized facts without changing the originals.",
    input: ["10 frozen files", "PDF \u00b7 DOCX \u00b7 CSV \u00b7 XLSX"],
    output: ["Typed source records", "40 animals \u00b7 1,662 evidence records"],
    boundary: "Parsing may flag ambiguity. It may not repair or overwrite raw study data.",
    acts: [
      ["Read protocol v3"],
      ["Parsed sponsor template v5 \u00b7 48 report fields"],
      ["Parsed LIMS, pathology and statistics files"],
      ["Created 1,662 source records with pointers"],
    ],
  },
  2: {
    summary:
      "HELIX resolves the study as a 28-day repeat-dose rodent study and retrieves the approved report pattern for structure only.",
    input: ["Protocol facts", "species \u00b7 route \u00b7 duration \u00b7 endpoints"],
    output: ["Study profile", "REPEAT_DOSE_28D_RODENT \u00b7 template v5"],
    boundary: "Prior reports may guide structure and phrasing. Their values never enter the new study.",
    acts: [
      ["Read species, route, duration and endpoints"],
      ["Resolved REPEAT_DOSE_28D_RODENT"],
      ["Selected pattern set P-28D-05 for structure only"],
      ["Recorded catalog context"],
    ],
  },
  3: {
    summary: "Code reads the selected source rows and computes report-ready values at the required grain.",
    input: ["Normalized study records", "BW \u00b7 CL \u00b7 FW \u00b7 OM \u00b7 MI \u00b7 PC"],
    output: ["Candidate claims", "values \u00b7 units \u00b7 grain \u00b7 transform IDs"],
    boundary: "The model selects tools and evidence. Deterministic code reads values and performs math.",
    acts: [
      ["Ran mean-v1 on 200 BW rows"],
      ["Ran incidence-count-v1 on 200 MI findings"],
      ["Versioned every transform"],
      ["Confirmed no model-generated numbers"],
    ],
  },
  4: {
    summary: "Rules check keys, terminology, units, grain, authority, aggregation and source-to-report reconciliation.",
    input: ["Candidate claims", "claims + field rule registry"],
    output: ["Validation evidence", "passes \u00b7 blockers \u00b7 exact evidence IDs"],
    boundary: "A failed rule creates a blocker. The agent cannot downgrade it to green.",
    acts: [
      ["Ran schema, key and unit checks"],
      ["Grain mismatch in C-BW-HIGH", "Blocker"],
      ["MI severity conflict in section 7", "Blocker"],
      ["Recorded evidence IDs for each result"],
    ],
  },
  5: {
    summary:
      "The narrative model writes only around validated claims and inserts explicit review markers for unresolved fields.",
    input: ["Validated claims + pattern", "facts separated from style pattern"],
    output: ["Eight structured sections", "draft text \u00b7 tables \u00b7 review markers"],
    boundary: "The model may write prose. It may not invent a value or make the final scientific judgment.",
    acts: [
      ["Instantiated 8 report sections"],
      ["Inserted validated claims"],
      ["Kept 3 review markers for unresolved fields"],
      ["Left NOAEL for human judgment"],
    ],
  },
  6: {
    summary:
      "Every report claim is linked to exact source records, the deterministic transform, validation results and manifest version.",
    input: ["Draft claims + evidence IDs", "all numeric claims"],
    output: ["Provenance graph", "12 edges \u00b7 source \u2192 transform \u2192 claim"],
    boundary: "A numeric claim without a provenance edge cannot pass its section gate.",
    acts: [
      ["Inspected all numeric claims"],
      ["Compiled 12 provenance edges"],
      ["Attached authority tiers"],
      ["Linked claims to MANIFEST-HLX-028"],
    ],
  },
};

const STAGE_IDS = [
  "upload",
  "parse",
  "resolve",
  "extract",
  "validate",
  "draft",
  "provenance",
  "traceability",
  "review-export",
] as const;

/**
 * The reference `?stage=N` state (agent not running): stages before N complete with all
 * actions recorded, stage N paused with its actions queued, later stages pending.
 */
function stageAt(index: number, current: number): JourneyStage {
  const ref = REFERENCE_STAGES[index];
  const copy = AGENT_COPY[index];
  const status = index < current ? "complete" : index === current ? "paused" : "pending";
  const gate = "gate" in ref ? ref.gate : null;
  return {
    stage_id: STAGE_IDS[index],
    sequence: index + 1,
    short_label: ref.short,
    name: ref.name,
    kind: gate ? "human_gate" : "agent_step",
    gate_number: gate,
    gate_status: null,
    status,
    selectable: index <= current,
    summary: copy?.summary ?? "",
    input: { title: copy?.input[0] ?? "", detail: copy?.input[1] ?? "" },
    output: { title: copy?.output[0] ?? "", detail: copy?.output[1] ?? "" },
    control_boundary: copy?.boundary ?? "",
    actions: (copy?.acts ?? []).map(([label, flag], position) => ({
      action_id: `fixture:${STAGE_IDS[index]}:${position + 1}`,
      label,
      detail: null,
      command: null,
      status: index < current ? "done" : "pending",
      outcome: index < current ? (flag ? "blocker" : "passed") : null,
    })),
    started_at: null,
    started_sequence: null,
    finished_at: null,
    finished_sequence: null,
  } as JourneyStage;
}

/** Display-only Workspace: just the fields the Agent Step view reads, all synthetic. */
export function agentFixtureWorkspace(current: number): Workspace {
  return {
    journey: {
      stages: REFERENCE_STAGES.map((_, index) => stageAt(index, current)),
      run: null,
      latest_event: null,
      current_stage_id: STAGE_IDS[current],
    },
    pinned_run: null,
    data_validation_executions: [],
    validations: [],
    section_run_eligibility: [],
    section_runs: [],
    cross_section_queries: [],
    candidate_evaluations: [],
    promotion_decisions: [],
    section_drafts: [],
    planner_capabilities: [],
    manifest: [],
    claims: [],
    summary: {
      blocker_count: 0,
      provenance_count: 0,
      record_count: 0,
      resolved_blocker_count: 0,
      section_count: 0,
      source_count: 0,
    },
  } as unknown as Workspace;
}

export const AGENT_FIXTURE_STAGE_IDS = STAGE_IDS;
