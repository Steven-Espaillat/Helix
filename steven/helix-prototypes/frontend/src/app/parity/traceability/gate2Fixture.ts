// Lane C (#22) display state for the Gate 2 parity fixture ONLY (tests/parity).
// The copy mirrors research/helix-e2e-workbench-v1.html (`TRACE`, `RULES`, stage 7):
// claim C-BW-HIGH with four rules, one blocked grain rule and no disposition yet.
// Never import this from production code: production renders server state.

import type { TraceabilityWorkspace } from "@/components/traceability/gateState";
import type { Claim, EvidenceChainData, ValidationResult } from "@/lib/types";

const CLAIM_ID = "C-BW-HIGH";

const ANIMALS: Array<[string, string, number]> = [
  ["HXL-M401", "M", 291.2],
  ["HXL-M402", "M", 288.4],
  ["HXL-M403", "M", 294.1],
  ["HXL-M404", "M", 286.9],
  ["HXL-M405", "M", 290.4],
  ["HXL-F401", "F", 238.5],
  ["HXL-F402", "F", 235.2],
  ["HXL-F403", "F", 240.1],
  ["HXL-F404", "F", 236.8],
  ["HXL-F405", "F", 236.4],
];

const sources: EvidenceChainData["sources"] = ANIMALS.map(([animal, sex, value]) => ({
  record_id: `BW-${animal}-D28`,
  domain: "BW",
  grain: "animal_x_day",
  unit: "g",
  value,
  source_pointer: `A-BW#${animal}:DAY28`,
  attributes: { animal_id: animal, group_id: "G4", sex, timepoint: "DAY 28" },
}));

const claim: Claim = {
  claim_id: CLAIM_ID,
  field_id: "terminal_body_weight,_high-dose_group",
  grain: "dose_group",
  grain_key: { group: "G4", day: "28" },
  section_id: "5.2",
  status: "needs_review",
  transform_id: "mean-v1",
  transform_version: "1.0",
  unit: "g",
  value: 263.8,
};

function rule(
  result_id: string,
  rule_id: string,
  status: ValidationResult["status"],
  evidence_ids: string[],
  message: string,
): ValidationResult {
  return {
    result_id,
    rule_id,
    rule_version: "1.0",
    kind: "deterministic",
    scope_id: CLAIM_ID,
    severity: status === "pass" ? "info" : "blocker",
    status,
    evidence_ids,
    message,
  };
}

const sourceIds = sources.map((source) => source.record_id);

const validations: ValidationResult[] = [
  rule("VR-T01", "frozen-manifest-match", "pass", sourceIds, "source pointers resolve to MANIFEST-HLX-028"),
  rule("VR-T02", "authority-threshold", "pass", sourceIds, "Tier 1 locked study data"),
  rule(
    "VR-T03",
    "grain-sex-stratified",
    "fail",
    [CLAIM_ID],
    "mean-v1 grouped by dose only. Section 5.2 expects dose group × sex.",
  ),
  rule("VR-T04", "report-reconciliation", "pass", [CLAIM_ID], "263.8 g equals derived value"),
];

export const gate2Chain: EvidenceChainData = {
  claim,
  sources,
  lineage: sources.map((source, index) => ({
    edge_id: `PE-T${String(index + 1).padStart(2, "0")}`,
    claim_id: CLAIM_ID,
    source_record_id: source.record_id,
    source_pointer: source.source_pointer,
    authority_tier: 1,
    transform_id: "mean-v1",
    transform_version: "1.0",
  })),
  transform_id: "mean-v1",
  transform_version: "1.0",
  recomputed_value: 263.8,
  exact_match: true,
  report_text: "Terminal mean body weight, high-dose group",
  validations,
};

export const gate2Workspace: TraceabilityWorkspace = {
  study: { study_id: "STUDY-HLX-028" },
  claims: [claim],
  validations,
  dispositions: [],
  candidate_evaluations: [],
  release_gate: { blocking_result_ids: ["VR-T03"] },
  journey: {
    stages: [
      {
        stage_id: "traceability",
        status: "blocked",
        selectable: true,
        actions: [{ action_id: "disposition:VR-T03", label: "Blocker VR-T03", status: "blocked", outcome: "blocker" }],
      },
      { stage_id: "review-export", status: "pending", selectable: false, actions: [] },
    ],
  },
};
