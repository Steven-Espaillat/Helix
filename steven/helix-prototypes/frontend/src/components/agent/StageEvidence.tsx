import type { ReactNode } from "react";

import { BODY_WEIGHT_PACKAGE, BODY_WEIGHT_SECTION, hybridValidationCount } from "@/lib/api/agentSteps";
import type { JourneyStageId, Workspace } from "@/lib/types";

import type { AgentReceipts, EligibilityChange } from "./useAgentSteps";

// Lane B (#21). Package-understanding evidence per Agent Step, read only from the persisted
// Workspace plus receipts that a command returned on this page. Nothing here is derived
// progress and no value is invented: an empty field says "not recorded".

function Hash({ value }: { value: string | null | undefined }) {
  if (!value) {
    return <span className="hx-sub">not recorded</span>;
  }
  return (
    <code className="hx-mono" title={value}>
      {value.length > 16 ? `${value.slice(0, 16)}…` : value}
    </code>
  );
}

function Id({ value }: { value: string | null | undefined }) {
  return value ? <code className="hx-mono">{value}</code> : <span className="hx-sub">not recorded</span>;
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="hx-agent-fact" data-testid={testId}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Missing({ children }: { children: ReactNode }) {
  return <p className="hx-sub" data-testid="agent-evidence-missing">{children}</p>;
}

function list(values: readonly string[] | null | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "none";
}

type Eligibility = EligibilityChange["after"];

function eligibilityText(entry: Eligibility): string {
  if (!entry) return "not recorded";
  return entry.eligible ? "Eligible to draft" : `Blocked: ${entry.reasons.join("; ")}`;
}

type Props = {
  stageId: JourneyStageId;
  workspace: Workspace;
  receipts?: AgentReceipts;
  eligibilityChange?: EligibilityChange | null;
};

export function StageEvidence({ stageId, workspace, receipts = {}, eligibilityChange = null }: Props) {
  const pinned = workspace.pinned_run;
  const run = workspace.section_runs.filter((item) => item.receipt.section_package_id === BODY_WEIGHT_SECTION).at(-1)?.receipt;
  const execution = workspace.data_validation_executions.find(
    (item) => item.receipt.run_id === pinned?.run_id && item.receipt.package_id === BODY_WEIGHT_PACKAGE,
  );
  const body = (() => {
    switch (stageId) {
      case "parse":
        if (!pinned) return <Missing>No Pinned Run yet. A person freezes the manifest at Human gate 1.</Missing>;
        return (
          <>
            <Row label="Pinned Run" testId="evidence-pinned-run">
              <Id value={pinned.run_id} /> · {pinned.status}
            </Row>
            <Row label="Freeze receipt" testId="evidence-freeze-receipt">
              <Id value={pinned.receipt.receipt_id} />
            </Row>
            <Row label="Manifest hash">
              <Hash value={pinned.manifest_hash} />
            </Row>
            <Row label="Run-plan fingerprint">
              <Hash value={pinned.receipt.run_plan_fingerprint} />
            </Row>
            <Row label="Manifest entries">{workspace.manifest.length}</Row>
            <Row label="Sources / records" testId="evidence-counts">
              {workspace.summary.source_count} sources · {workspace.summary.record_count} records
            </Row>
            <Row label="Run-plan nodes" testId="evidence-run-plan-nodes">
              <ul className="hx-agent-list">
                {pinned.run_plan.nodes.map((node) => (
                  <li key={node.node_id}>
                    <code className="hx-mono">{node.node_id}</code> · {node.node_type} · {node.status}{" "}
                    <Hash value={node.input_fingerprint} />
                  </li>
                ))}
              </ul>
            </Row>
            <Row label="Governed inputs" testId="evidence-governed-inputs">
              {pinned.governed_inputs.length} · fingerprint <Hash value={pinned.receipt.governed_inputs_fingerprint} />
              <ul className="hx-agent-list">
                {pinned.governed_inputs.map((item) => (
                  <li key={item.artifact_id}>
                    {item.artifact_id} ({item.kind}, {item.version}) <Hash value={item.content_hash} />
                  </li>
                ))}
              </ul>
            </Row>
          </>
        );
      case "resolve": {
        const resolution = pinned?.study_type_resolution;
        if (!resolution) return <Missing>Study type is resolved when the manifest is frozen.</Missing>;
        return (
          <>
            <Row label="Resolution" testId="evidence-study-type">
              {resolution.study_type_id ?? "not resolved"} ({resolution.status})
            </Row>
            <Row label="Mapping">
              {resolution.mapping_version} <Hash value={resolution.mapping_hash} />
            </Row>
            <Row label="Protocol fields" testId="evidence-protocol-fields">
              {Object.entries(resolution.protocol_fields ?? {})
                .map(([key, value]) => `${key}: ${String(value)}`)
                .join(" · ") || "none"}
            </Row>
            <Row label="Evidence">{(resolution.evidence ?? []).length} items</Row>
            <p className="hx-sub">Prior report patterns supply structure only, never values.</p>
          </>
        );
      }
      case "extract": {
        if (!execution) return <Missing>The Data Validation Package has not run for this Pinned Run.</Missing>;
        const receipt = execution.receipt;
        const returned = receipts["data-validation"];
        return (
          <>
            <Row label="Receipt" testId="evidence-dvp-receipt">
              <Id value={receipt.receipt_id} /> · {receipt.status}
            </Row>
            {returned && (
              <Row label="Last command result" testId="evidence-dvp-replay">
                <Id value={returned.receipt.receipt_id} />
                {returned.receipt.idempotent_replay
                  ? " · idempotent replay of the recorded execution (no second run)"
                  : " · executed for this Pinned Run"}
              </Row>
            )}
            <Row label="Run-plan node">
              <Id value={receipt.node_id} /> · input <Hash value={receipt.input_fingerprint} />
            </Row>
            <Row label="Package">
              {receipt.package_id}@{receipt.package_version} <Hash value={receipt.package_hash} />
            </Row>
            <Row label="Executor">
              {receipt.executor_id}@{receipt.executor_version} <Hash value={receipt.executor_hash} />
            </Row>
            <Row label="Source artifact">
              {receipt.source_artifact_id} <Hash value={receipt.source_hash} />
            </Row>
            <Row label="Rules" testId="evidence-dvp-rules">
              {receipt.rule_bundle_id}: {list(receipt.rule_ids)}
            </Row>
            <Row label="Validated claims">{list(receipt.claim_ids)}</Row>
            <Row label="Provenance edges" testId="evidence-dvp-edges">
              {execution.provenance_edges.length}
              <ul className="hx-agent-list">
                {execution.provenance_edges.map((edge) => (
                  <li key={edge.edge_id}>
                    {edge.source_record_id} → {edge.transform_id}@{edge.transform_version} → {edge.claim_id}
                  </li>
                ))}
              </ul>
            </Row>
            <Row label="Section references" testId="evidence-dvp-sections">
              {list(execution.section_references.map((item) => `${item.section_id} (${item.claim_id})`))}
            </Row>
            <Row label="Event">
              <Id value={receipt.event_id} />
            </Row>
          </>
        );
      }
      case "validate": {
        const eligibility = workspace.section_run_eligibility.find((item) => item.section_package_id === BODY_WEIGHT_SECTION) ?? null;
        const validation = receipts.validation;
        const blockers = workspace.validations.filter((item) => item.status === "fail" && item.severity === "blocker");
        return (
          <>
            <Row label="Hybrid validation results" testId="evidence-validation-count">
              {hybridValidationCount(workspace) === 0 ? "not run" : hybridValidationCount(workspace)}
            </Row>
            {validation && (
              <Row label="Validation run" testId="evidence-validation-run">
                <Id value={validation.run_id} /> · {validation.rule_bundle_version} · {validation.planner_label} · LLM used:{" "}
                {validation.llm_used ? "yes" : "no"} · {validation.results.length} results
              </Row>
            )}
            <Row label="All validation results">{workspace.validations.length}</Row>
            <Row label="Blockers" testId="evidence-blockers">
              {blockers.length === 0 ? "none" : blockers.map((item) => `${item.rule_id} (${item.result_id})`).join(", ")}
            </Row>
            {eligibilityChange && (
              <Row label="Eligibility before validation" testId="evidence-eligibility-before">
                {eligibilityText(eligibilityChange.before)}
              </Row>
            )}
            <Row label={eligibilityChange ? "Eligibility after validation" : "Body-weight section"} testId="evidence-eligibility">
              {eligibilityText(eligibility)}
            </Row>
          </>
        );
      }
      case "draft": {
        if (!run) return <Missing>The Section Agent has not run for the body-weight section.</Missing>;
        const query = [...(workspace.cross_section_queries ?? [])].reverse().find((item) => item.run_id === run.run_id);
        const evaluation = [...(workspace.candidate_evaluations ?? [])].reverse().find((item) => item.run_id === run.run_id);
        const promotion = [...(workspace.promotion_decisions ?? [])].reverse().find((item) => item.run_id === run.run_id);
        const draft = [...(workspace.section_drafts ?? [])].reverse().find((item) => item.run_id === run.run_id);
        const decision = evaluation?.next_attempt_decision;
        return (
          <>
            <Row label="Section Agent run" testId="evidence-section-run">
              <Id value={run.run_id} /> · {run.status}
              {run.idempotent_replay ? " · idempotent replay" : ""}
            </Row>
            <Row label="Candidate">
              {run.candidate_id} <Hash value={run.candidate_hash} />
            </Row>
            <Row label="Envelope / skill">
              envelope <Hash value={run.envelope_hash} /> · {run.skill_name} <Hash value={run.skill_hash} /> · references{" "}
              <Hash value={run.skill_references_hash} />
            </Row>
            <Row label="Thread / scaffold">
              <Id value={run.codex_thread_id} /> · review scaffold revision {run.review_scaffold_revision ?? "not recorded"}
            </Row>
            <Row label="Dependency query" testId="evidence-query">
              {query ? (
                <>
                  <Id value={query.query_id} /> · {query.status} · requested {list(query.requested_artifact_ids)} · returned{" "}
                  {query.returned.length} · rejected {list(query.rejected_artifact_ids)}
                </>
              ) : (
                "not run"
              )}
            </Row>
            <Row label="Candidate evaluation" testId="evidence-evaluation">
              {evaluation ? (
                <>
                  <Id value={evaluation.evaluation_id} /> · provenance {evaluation.provenance_receipt.status} · study output{" "}
                  {evaluation.study_output_evaluation_receipt.status} · template conformance{" "}
                  {evaluation.template_conformance_receipt.status}
                </>
              ) : (
                "not run"
              )}
            </Row>
            <Row label="Next-attempt decision" testId="evidence-next-attempt">
              {decision
                ? `${decision.action} · attempt ${decision.attempt} of ${decision.max_attempts}${decision.reasons.length ? ` · ${decision.reasons.join("; ")}` : ""}`
                : "not recorded"}
            </Row>
            <Row label="Promotion decision" testId="evidence-promotion">
              {promotion
                ? promotion.eligible
                  ? `Eligible · gate decisions ${list(promotion.gate_decision_ids)}`
                  : `Rejected: ${list(promotion.failed_condition_ids)}`
                : "not run"}
            </Row>
            <Row label="Section Draft" testId="evidence-draft">
              {draft ? (
                <>
                  <Id value={draft.draft_id} /> · {draft.status} · content <Hash value={draft.content_hash} /> · bound
                  dispositions {draft.bound_dispositions.length}
                </>
              ) : (
                "none"
              )}
            </Row>
          </>
        );
      }
      case "provenance": {
        const evaluation = run
          ? [...(workspace.candidate_evaluations ?? [])].reverse().find((item) => item.run_id === run.run_id)
          : undefined;
        const edges = workspace.data_validation_executions.flatMap((item) => item.provenance_edges);
        return (
          <>
            <Row label="Evidence edges" testId="evidence-provenance-count">
              {workspace.summary.provenance_count}
            </Row>
            <Row label="Source → report lineage" testId="evidence-lineage">
              {edges.length === 0 ? (
                "not recorded"
              ) : (
                <ul className="hx-agent-list">
                  {edges.map((edge) => (
                    <li key={edge.edge_id}>
                      {edge.source_pointer} <Hash value={edge.source_hash} /> → {edge.transform_id}@{edge.transform_version} →{" "}
                      {edge.claim_id} ({edge.authority_tier})
                    </li>
                  ))}
                </ul>
              )}
            </Row>
            <Row label="Candidate-level lineage" testId="evidence-candidate-lineage">
              {evaluation ? (
                <>
                  {evaluation.candidate_id} <Hash value={evaluation.candidate_hash} /> · provenance receipt{" "}
                  <Id value={evaluation.provenance_receipt.receipt_id} /> · {evaluation.provenance_receipt.bindings.length} bindings
                </>
              ) : (
                "no candidate evaluation recorded"
              )}
            </Row>
            <Row label="Claims">{workspace.claims.length}</Row>
            <p className="hx-sub">
              <a href="#hx-evidence">Inspect exact source rows, recomputation, and lineage</a>
            </p>
          </>
        );
      }
      default:
        return null;
    }
  })();
  if (!body) return null;
  return (
    <dl className="hx-agent-facts" data-testid="agent-stage-evidence">
      {body}
    </dl>
  );
}
