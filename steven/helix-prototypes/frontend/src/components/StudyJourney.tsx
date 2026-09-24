"use client";

import { useEffect, useMemo, useState } from "react";

import type { PlannerMode, Workspace } from "@/lib/types";

type Props = {
  workspace: Workspace;
  planner: PlannerMode;
  validationBusy: boolean;
  dataValidationBusy: boolean;
  sectionRunBusy: boolean;
  evaluationBusy: boolean;
  queryBusy: boolean;
  onPlannerChange: (planner: PlannerMode) => void;
  onValidate: () => void;
  onExecuteBodyWeight: () => void;
  onDraftBodyWeight: () => void;
  onRetryBodyWeight: () => void;
  onEvaluateCandidate: () => void;
  onQueryCrossSection: () => void;
};

export function StudyJourney({
  workspace,
  planner,
  validationBusy,
  dataValidationBusy,
  sectionRunBusy,
  evaluationBusy,
  queryBusy,
  onPlannerChange,
  onValidate,
  onExecuteBodyWeight,
  onDraftBodyWeight,
  onRetryBodyWeight,
  onEvaluateCandidate,
  onQueryCrossSection,
}: Props) {
  const defaultStage = useMemo(
    () =>
      workspace.stages.find((stage) => stage.status === "current" || stage.status === "blocked") ??
      workspace.stages.at(-1),
    [workspace.stages],
  );
  const [selectedStageId, setSelectedStageId] = useState(defaultStage?.stage_id ?? "gate");

  useEffect(() => {
    if (!workspace.stages.some((stage) => stage.stage_id === selectedStageId)) {
      setSelectedStageId(defaultStage?.stage_id ?? "gate");
    }
  }, [defaultStage, selectedStageId, workspace.stages]);

  const stage =
    workspace.stages.find((candidate) => candidate.stage_id === selectedStageId) ?? defaultStage;
  const fixture = workspace.planner_capabilities.find((item) => item.mode === "fixture");
  const llm = workspace.planner_capabilities.find((item) => item.mode === "openai_compatible");
  const bodyWeightEligibility = workspace.section_run_eligibility.find(
    (item) => item.section_package_id === "section.5_2_3_body_weight",
  );
  const bodyWeightRuns = workspace.section_runs.filter(
    (item) => item.receipt.section_package_id === "section.5_2_3_body_weight",
  );
  const bodyWeightRun = bodyWeightRuns.at(-1);
  const bodyWeightEvaluations = workspace.candidate_evaluations ?? [];
  const bodyWeightEvaluation = bodyWeightEvaluations.find(
    (item) => item.run_id === bodyWeightRun?.receipt.run_id,
  );
  const canRetry =
    bodyWeightEvaluation?.next_attempt_decision.action === "retry" &&
    bodyWeightEvaluation.next_attempt_decision.attempt < 3;
  const bodyWeightQuery = (workspace.cross_section_queries ?? []).find(
    (item) => item.run_id === bodyWeightRun?.receipt.run_id,
  );
  const dataValidation = workspace.data_validation_executions.at(-1);
  const terminalClaim = dataValidation?.claims.find((claim) => claim.claim_id === "C-BW-HIGH");
  const commandBusy =
    validationBusy || dataValidationBusy || sectionRunBusy || evaluationBusy || queryBusy;
  const latestScaffold = workspace.review_scaffold_revisions?.at(-1);

  if (!stage) {
    return null;
  }

  return (
    <section className="view-content" aria-labelledby="journey-heading">
      <div className="view-intro">
        <div>
          <p className="eyebrow">Evidence-to-report control plane</p>
          <h2 id="journey-heading">A ten-stage journey with visible boundaries.</h2>
          <p>
            HELIX can locate, extract, check, and draft. Qualified people retain scientific
            interpretation, quality assurance, signatures, and export authorization.
          </p>
        </div>
        <div className="summary-strip" aria-label="Study summary">
          <Metric value={workspace.summary.source_count} label="Frozen sources" />
          <Metric value={workspace.summary.record_count.toLocaleString()} label="Study records" />
          <Metric value={workspace.summary.provenance_count} label="Evidence edges" />
          <Metric
            value={workspace.summary.blocker_count}
            label="Open blockers"
            tone={workspace.summary.blocker_count > 0 ? "danger" : "success"}
          />
        </div>
      </div>

      <div className="stage-rail" aria-label="Study workflow stages">
        {workspace.stages.map((item, index) => (
          <button
            key={item.stage_id}
            type="button"
            className={`stage-step ${item.status} ${item.stage_id === stage.stage_id ? "selected" : ""}`}
            onClick={() => setSelectedStageId(item.stage_id)}
            aria-current={item.stage_id === stage.stage_id ? "step" : undefined}
          >
            <span className="stage-index">{String(index + 1).padStart(2, "0")}</span>
            <span className="stage-dot" aria-hidden="true" />
            <span className="stage-name">{item.name}</span>
          </button>
        ))}
      </div>

      <div className="journey-grid">
        <article className="panel stage-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Selected stage</p>
              <h3>{stage.name}</h3>
            </div>
            <span className={`owner-chip ${stage.owner}`}>{ownerLabel(stage.owner)}</span>
          </div>
          <p className="lead-copy">{stage.summary}</p>
          <div className="check-list">
            {stage.checks.map((check) => (
              <div className="check-row" key={check}>
                <span className="check-icon">✓</span>
                <span>{check}</span>
              </div>
            ))}
          </div>
          {stage.stage_id === "authorized-upload" && (
            <div className="source-manifest" data-testid="source-manifest">
              <div className="source-manifest-heading">
                <strong>Frozen source manifest</strong>
                <span>{workspace.manifest.length} authorized</span>
              </div>
              {workspace.manifest.map((entry) => (
                <div className="source-manifest-row" key={entry.artifact_id}>
                  <span className="manifest-lock">✓</span>
                  <div>
                    <strong>{entry.name}</strong>
                    <span>
                      Tier {entry.authority_tier} · {entry.version} · {entry.authorized_by}
                    </span>
                  </div>
                  <code>{entry.checksum.slice(0, 15)}…</code>
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="panel transformation-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Evidence transformation</p>
              <h3>Input stays distinct from output.</h3>
            </div>
            <span className={`status-dot-label ${stage.status}`}>
              <span /> {stage.status}
            </span>
          </div>
          <div className="flow-pair">
            <div className="flow-node">
              <span>Input</span>
              <strong>{stage.input_title}</strong>
              <code>{stage.input_detail}</code>
            </div>
            <div className="flow-arrow" aria-hidden="true">
              →
            </div>
            <div className="flow-node output">
              <span>Output</span>
              <strong>{stage.output_title}</strong>
              <code>{stage.output_detail}</code>
            </div>
          </div>
          <div className="boundary-callout">
            <span>Control boundary</span>
            <p>{stage.boundary}</p>
          </div>
        </article>

        <aside className="panel validation-console">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Hybrid validation</p>
              <h3>Plan with a model. Decide with code.</h3>
            </div>
          </div>
          <div className="planner-options" role="radiogroup" aria-label="Check planner">
            <button
              type="button"
              role="radio"
              aria-checked={planner === "fixture"}
              className={planner === "fixture" ? "planner-option active" : "planner-option"}
              onClick={() => onPlannerChange("fixture")}
            >
              <span className="planner-title">
                Fixture planner <small>Offline</small>
              </span>
              <span>{fixture?.detail}</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={planner === "openai_compatible"}
              disabled={!llm?.available}
              className={planner === "openai_compatible" ? "planner-option active" : "planner-option"}
              onClick={() => onPlannerChange("openai_compatible")}
            >
              <span className="planner-title">
                LLM planner <small>{llm?.available ? "Configured" : "Needs API key"}</small>
              </span>
              <span>{llm?.detail}</span>
            </button>
          </div>
          <button
            className="button primary wide"
            type="button"
            onClick={onValidate}
            disabled={commandBusy}
            data-testid="run-validation"
          >
            {validationBusy ? "Running checks…" : "Run hybrid validation"}
          </button>
          <button
            className="button secondary wide"
            type="button"
            onClick={onExecuteBodyWeight}
            disabled={commandBusy}
            data-testid="run-body-weight-validation"
          >
            {dataValidationBusy ? "Executing package…" : "Execute body-weight package"}
          </button>
          {workspace.section_run_eligibility.map((item) => (
            <div className="eligibility-summary" key={item.section_package_id}>
              <strong>{item.section_package_id}</strong>
              <span data-testid={`eligibility-${item.section_package_id}`}>
                {item.eligible ? "ready" : "blocked"}
              </span>
            </div>
          ))}
          <button
            className="button secondary wide"
            type="button"
            onClick={onDraftBodyWeight}
            disabled={!bodyWeightEligibility?.eligible || commandBusy}
            data-testid="draft-body-weight"
          >
            {sectionRunBusy ? "Drafting with Codex…" : "Draft body-weight component"}
          </button>
          {!bodyWeightEligibility?.eligible && (
            <p className="fine-print" data-testid="section-run-ineligible">
              {bodyWeightEligibility?.reasons.join(" ")}
            </p>
          )}
          {bodyWeightRuns.map((run) => {
            const evaluation = bodyWeightEvaluations.find((item) => item.run_id === run.receipt.run_id);
            const isLatest = run.receipt.run_id === bodyWeightRun?.receipt.run_id;
            return (
              <div
                className="section-run-receipt"
                key={run.receipt.run_id}
                data-testid={`candidate-attempt-${run.candidate.attempt}`}
              >
                <strong>
                  Candidate attempt {run.candidate.attempt} of 3
                </strong>
                {isLatest ? (
                  <span data-testid="section-run-receipt">{run.receipt.candidate_id}</span>
                ) : (
                  <span>{run.receipt.candidate_id}</span>
                )}
                <code>{run.receipt.candidate_hash}</code>
                <span>{run.receipt.skill_name}</span>
                <code>{run.receipt.skill_hash}</code>
                <span>Thread {run.receipt.codex_thread_id}</span>
                <code>Envelope {run.receipt.envelope_hash}</code>
                <span>Review Scaffold Revision {run.receipt.review_scaffold_revision}</span>
                {evaluation && (
                  <div
                    className="candidate-attempt-evaluation"
                    data-testid={isLatest ? "candidate-evaluation" : `candidate-evaluation-${run.candidate.attempt}`}
                  >
                    <strong>Candidate evaluation</strong>
                    <span data-testid={isLatest ? "evaluation-id" : undefined}>{evaluation.evaluation_id}</span>
                    <code data-testid={isLatest ? "evaluation-candidate-hash" : undefined}>
                      {evaluation.candidate_hash}
                    </code>
                    <span data-testid={isLatest ? "provenance-status" : undefined}>
                      Provenance {evaluation.provenance_receipt.status}
                    </span>
                    {isLatest &&
                      evaluation.provenance_receipt.bindings.map((item) => (
                        <code key={item.location} data-testid={`provenance-binding-${item.location}`}>
                          {item.claim_id} {item.claim_hash} {item.artifact_hash}
                        </code>
                      ))}
                    <span data-testid={isLatest ? "study-output-status" : undefined}>
                      Study output {evaluation.study_output_evaluation_receipt.status}{" "}
                      {evaluation.study_output_evaluation_receipt.enforcement_class}
                    </span>
                    <span data-testid={isLatest ? "conformance-status" : undefined}>
                      Conformance {evaluation.template_conformance_receipt.status}
                    </span>
                    {isLatest &&
                      evaluation.template_conformance_receipt.results.map((item) => (
                        <span key={item.rule_id} data-testid={`conformance-${item.rule_id}`}>
                          {item.rule_id} {item.check_kind} {item.status}
                        </span>
                      ))}
                    <span data-testid={isLatest ? "next-attempt-action" : undefined}>
                      Next attempt {evaluation.next_attempt_decision.action}
                    </span>
                    <code data-testid={isLatest ? "evaluation-hash" : undefined}>
                      {evaluation.hashes.evaluation}
                    </code>
                  </div>
                )}
              </div>
            );
          })}
          {canRetry && (
            <button
              className="button secondary wide"
              type="button"
              onClick={onRetryBodyWeight}
              disabled={commandBusy}
              data-testid="retry-body-weight"
            >
              {sectionRunBusy ? "Retrying with Codex…" : "Retry candidate"}
            </button>
          )}
          <button
            className="button secondary wide"
            type="button"
            onClick={onEvaluateCandidate}
            disabled={!bodyWeightRun || commandBusy}
            data-testid="evaluate-candidate"
          >
            {evaluationBusy ? "Evaluating candidate…" : "Evaluate candidate"}
          </button>
          <button
            className="button secondary wide"
            type="button"
            onClick={onQueryCrossSection}
            disabled={!bodyWeightRun || commandBusy}
            data-testid="query-cross-section"
          >
            {queryBusy ? "Querying dependencies…" : "Query declared dependencies"}
          </button>
          {bodyWeightQuery && (
            <div className="section-run-receipt" data-testid="cross-section-query">
              <strong>Cross-section query</strong>
              <span data-testid="query-status">{bodyWeightQuery.status}</span>
              <span data-testid="query-requested">{bodyWeightQuery.requested_artifact_ids.join(", ")}</span>
              {bodyWeightQuery.returned.map((item) => (
                <code key={item.artifact_id} data-testid={`query-hash-${item.artifact_id}`}>
                  {item.artifact_id} {item.hash}
                </code>
              ))}
            </div>
          )}
          <p className="fine-print">
            The planner can only select registered tools. Python calculates every result and gate state.
          </p>
        </aside>
      </div>

      {workspace.pinned_run && (
        <article className="panel run-plan-card" data-testid="run-plan">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Pinned governance identity</p>
              <h3>{workspace.pinned_run.run_id}</h3>
            </div>
            <span className={`owner-chip ${workspace.pinned_run.status === "planned" ? "agent" : "human"}`}>
              {workspace.pinned_run.status.replaceAll("_", " ")}
            </span>
          </div>
          <div className="run-plan-fingerprints">
            <div>
              <span>Manifest</span>
              <code>{workspace.pinned_run.manifest_hash}</code>
            </div>
            <div>
              <span>Run Plan</span>
              <code>{workspace.pinned_run.run_plan.fingerprint}</code>
            </div>
            <div>
              <span>Study type</span>
              <code>
                {workspace.pinned_run.study_type_resolution.study_type_id ?? "[NEEDS REVIEW]"}
              </code>
            </div>
          </div>
          <details>
            <summary>
              Complete Run Plan · {workspace.pinned_run.run_plan.nodes.length} nodes · {workspace.pinned_run.governed_inputs.length} governed inputs
            </summary>
            <div className="run-plan-grid">
              <div>
                <strong>Execution graph</strong>
                {workspace.pinned_run.run_plan.nodes.map((node) => (
                  <div className="run-plan-row" key={node.node_id}>
                    <span className={`status-dot-label ${node.status}`}><span />{node.status}</span>
                    <div>
                      <strong>{node.node_id}</strong>
                      <small>{node.node_type} · depends on {node.depends_on.join(", ") || "nothing"}</small>
                    </div>
                    <code>{node.input_fingerprint}</code>
                  </div>
                ))}
              </div>
              <div>
                <strong>Governed inputs</strong>
                {workspace.pinned_run.governed_inputs.map((input) => (
                  <div className="run-plan-row" key={`${input.kind}-${input.artifact_id}`}>
                    <span className="count-chip">{input.kind}</span>
                    <div>
                      <strong>{input.artifact_id}</strong>
                      <small>{input.version} · {input.path}</small>
                    </div>
                    <code>{input.content_hash}</code>
                  </div>
                ))}
              </div>
            </div>
          </details>
        </article>
      )}

      {dataValidation && (
        <article className="panel run-plan-card" data-testid="data-validation-package">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Body-weight Data Validation Package</p>
              <h3>{dataValidation.receipt.package_id}</h3>
            </div>
            <span className={`owner-chip ${dataValidation.receipt.status === "passed" ? "agent" : "human"}`}>
              {dataValidation.receipt.status}
            </span>
          </div>
          <div className="run-plan-fingerprints">
            <div>
              <span>Pinned run</span>
              <code>{dataValidation.receipt.run_id}</code>
            </div>
            <div>
              <span>Executor</span>
              <code>
                {dataValidation.receipt.executor_id}@{dataValidation.receipt.executor_version}
              </code>
            </div>
            <div>
              <span>Source</span>
              <code>
                {dataValidation.receipt.source_artifact_id} · {dataValidation.receipt.source_hash}
              </code>
            </div>
          </div>
          <p className="fine-print">
            Package {dataValidation.receipt.package_version} · {dataValidation.receipt.package_hash}
          </p>
          <div className="dvp-claim-block" data-testid="validated-claim-C-BW-HIGH">
            {terminalClaim ? (
              <>
                <strong>
                  {terminalClaim.claim_id} · {terminalClaim.value} {terminalClaim.unit}
                </strong>
                <span>
                  Grain {displayGrain(terminalClaim.grain)} · transform {terminalClaim.transform_id}{" "}
                  {terminalClaim.transform_version}
                </span>
                <code>{terminalClaim.source_hashes?.at(0)}</code>
                <small>
                  Rule versions{" "}
                  {Object.entries(terminalClaim.rule_versions ?? {})
                    .map(([ruleId, version]) => `${ruleId}@${version}`)
                    .join(" · ")}
                </small>
              </>
            ) : (
              <strong>No validated body-weight claim was persisted.</strong>
            )}
          </div>
          <div className="dvp-rule-list" data-testid="data-validation-rules">
            {dataValidation.results.map((result) => (
              <div className="run-plan-row" key={result.result_id}>
                <span className={`result-chip ${result.status}`}>{result.enforcement_class}</span>
                <div>
                  <strong>{result.rule_id}</strong>
                  <small>{result.message}</small>
                </div>
                <code>{result.waivable ? "waivable" : "non-waivable"}</code>
              </div>
            ))}
          </div>
          <div className="dvp-section-refs" data-testid="section-claim-references">
            {dataValidation.section_references.map((reference) => (
              <div className="run-plan-row" key={reference.section_package_id}>
                <span className="count-chip">{reference.section_id}</span>
                <div>
                  <strong>{reference.title}</strong>
                  <small>
                    {reference.section_package_id} cites {reference.claim_id}
                  </small>
                </div>
                <code>{reference.executor_receipt_id}</code>
              </div>
            ))}
          </div>
        </article>
      )}

      <article className="panel run-plan-card" data-testid="template-contract-gates">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Template Contract Gates</p>
            <h3>Backend eligibility before any Codex thread.</h3>
          </div>
        </div>
        {workspace.section_run_eligibility.map((item) => (
          <div className="contract-package" key={item.section_package_id}>
            <div className="contract-package-heading">
              <strong>{item.section_package_id}</strong>
              <span className={`status-dot-label ${item.eligible ? "complete" : "blocked"}`}>
                <span />
                {item.eligible ? "ready" : "blocked"}
              </span>
            </div>
            <div className="dvp-rule-list">
              {item.gate_results.map((result) => (
                <div className="run-plan-row" key={result.result_id} data-testid={`gate-${result.result_id}`}>
                  <span className={`result-chip ${result.status}`}>{result.status}</span>
                  <div>
                    <strong>{result.result_id}</strong>
                    <small>
                      {result.check_kind} · {result.message}
                    </small>
                  </div>
                  <code>{result.waivable ? "waivable" : "non-waivable"}</code>
                </div>
              ))}
            </div>
            <div className="impact-set" data-testid={`impact-${item.section_package_id}`}>
              <span>Section Impact Set</span>
              <code>origin {item.impact_set.origin_section_package_id}</code>
              <small>direct {item.impact_set.direct.join(", ") || "none"}</small>
              <small>transitive {item.impact_set.transitive.join(", ") || "none"}</small>
            </div>
          </div>
        ))}
        {isRecord(latestScaffold) && (
          <div className="scaffold-revision" data-testid="review-scaffold-revision">
            <strong>
              Review Scaffold Revision {String(latestScaffold.sequence)} · {String(latestScaffold.revision_id)}
            </strong>
            {scaffoldEntries(latestScaffold).map((section) => (
              <div className="run-plan-row" key={section.section_id}>
                <span className={`result-chip ${section.render_state}`}>{section.render_state}</span>
                <div>
                  <strong>{section.section_id}</strong>
                  <small>{section.heading}</small>
                </div>
                <code>{section.placeholder ?? "none"}</code>
              </div>
            ))}
          </div>
        )}
      </article>

      <div className="journey-lower-grid">
        <article className="panel source-map-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Package map</p>
              <h3>One frozen study package, four controlled outputs.</h3>
            </div>
          </div>
          <div className="package-map">
            <PackageNode label="Authorized research inputs" value="10" detail="Frozen and checksummed" />
            <MapArrow />
            <PackageNode label="Normalized evidence" value="1,662" detail="Typed and source-linked" />
            <MapArrow />
            <PackageNode label="Structured report" value="8" detail="Sections with field rules" />
            <MapArrow />
            <PackageNode
              label="Export package"
              value="4"
              detail="Report and synthetic data support files"
            />
          </div>
        </article>

        <aside className="panel activity-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Append-only activity</p>
              <h3>Latest decisions</h3>
            </div>
            <span className="count-chip">{workspace.events.length}</span>
          </div>
          <div className="activity-list">
            {[...workspace.events]
              .reverse()
              .slice(0, 5)
              .map((event) => (
                <div className="activity-row" key={event.event_id}>
                  <span className="activity-marker" />
                  <div>
                    <strong>{humanize(event.event)}</strong>
                    <span>
                      {event.actor} · {formatTime(event.timestamp)}
                    </span>
                  </div>
                  <em>{event.outcome}</em>
                </div>
              ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

function Metric({
  value,
  label,
  tone = "default",
}: {
  value: string | number;
  label: string;
  tone?: "default" | "danger" | "success";
}) {
  return (
    <div className={`metric ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function PackageNode({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="package-node">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function MapArrow() {
  return (
    <div className="map-arrow" aria-hidden="true">
      →
    </div>
  );
}

function ownerLabel(owner: "agent" | "human" | "hybrid"): string {
  return {
    agent: "Agent executed",
    human: "Human controlled",
    hybrid: "Hybrid control",
  }[owner];
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function displayGrain(grain: string): string {
  return grain.replaceAll("_x_", " × ");
}

function scaffoldEntries(revision: Record<string, unknown>) {
  const sections = revision.sections;
  if (!Array.isArray(sections)) {
    return [];
  }
  return sections.flatMap((item) => {
    if (!isRecord(item) || typeof item.section_id !== "string" || typeof item.heading !== "string") {
      return [];
    }
    return [
      {
        section_id: item.section_id,
        heading: item.heading,
        render_state: typeof item.render_state === "string" ? item.render_state : "unknown",
        placeholder: typeof item.placeholder === "string" ? item.placeholder : null,
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(value));
}
