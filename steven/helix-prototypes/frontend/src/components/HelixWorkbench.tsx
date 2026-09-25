"use client";

import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  evaluateCandidate,
  exportPackage,
  getWorkspace,
  promoteSectionDraft,
  queryCrossSection,
  recordApproval,
  recordFinalStudyApproval,
  reviseSection,
  runDataValidation,
  runSectionAgent,
  runValidation,
} from "@/lib/api";
import type { ApprovalRole, PlannerMode, Workspace } from "@/lib/types";

import { TraceabilityStageView } from "./traceability/TraceabilityStageView";
import { useTraceabilityGate } from "./traceability/useTraceabilityGate";
import { CloseIcon, RetryIcon } from "./icons";
import { ReportAssembly } from "./ReportAssembly";
import { ProgressBar } from "./journey/ProgressBar";
import { useSelectedStage } from "./journey/useSelectedStage";
import { ShellHeader } from "./shell/ShellHeader";
import { StudyJourney } from "./StudyJourney";
import { Button, Card, Kicker, Pill, Spinner, type Tone } from "./ui";
import { IntakeUploadForm } from "./upload/IntakeUploadForm";
import { UploadGate } from "./upload/UploadGate";

type Props = {
  studyId: string;
};

type ReleaseStatus = Workspace["release_gate"]["status"];

// Presentation only: label and tone for the server-reported release gate
// status. The shell never derives or recalculates release readiness.
const releasePresentation: Record<ReleaseStatus, { label: string; tone: Tone }> = {
  blocked: { label: "Release blocked", tone: "block" },
  ready_for_review: { label: "Ready for review", tone: "warn" },
  ready_for_signature: { label: "Ready for signature", tone: "warn" },
  ready_for_export: { label: "Ready for export", tone: "pass" },
  exported: { label: "Package exported", tone: "info" },
};

export function HelixWorkbench({ studyId }: Props) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const { selectedStageId, select: selectStage } = useSelectedStage(workspace?.journey);
  const [planner, setPlanner] = useState<PlannerMode>("fixture");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Lane C (#22): Gate 2 handlers live in the lane-C hook.
  const traceabilityGate = useTraceabilityGate({ studyId, setWorkspace, selectStage, setNotice, setError });

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setWorkspace(await getWorkspace(studyId));
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }, [studyId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function validate() {
    setBusy("validation");
    setNotice(null);
    setError(null);
    try {
      const run = await runValidation(studyId, planner);
      await refresh();
      setNotice(
        `${run.results.length} checks completed with ${run.planner_label}. LLM used: ${run.llm_used ? "yes" : "no"}.`,
      );
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(null);
    }
  }

  async function executeBodyWeight() {
    setBusy("data-validation");
    setNotice(null);
    setError(null);
    try {
      const execution = await runDataValidation(studyId);
      await refresh();
      setNotice(
        `${execution.receipt.package_id} ${execution.receipt.status} with ${execution.claims.length} persisted claims.`,
      );
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(null);
    }
  }

  async function draftBodyWeight() {
    setBusy("section-run");
    setNotice(null);
    setError(null);
    try {
      const receipt = await runSectionAgent(studyId, draftIdempotencyKey(studyId, workspace));
      await refresh();
      setNotice(
        `${receipt.candidate_id} recorded from Codex SDK in Review Scaffold Revision ${receipt.review_scaffold_revision}.`,
      );
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(null);
    }
  }

  async function reviseBodyWeight() {
    setBusy("section-revision");
    setNotice(null);
    setError(null);
    try {
      const current = workspace?.drafting_cycles
        ?.filter((cycle) => cycle.section_package_id === "section.5_2_3_body_weight")
        .at(-1);
      const receipt = await reviseSection(
        studyId,
        `workbench-${studyId}-revise-${current?.cycle_id ?? "CYCLE-BW-001"}`,
      );
      await refresh();
      setNotice(
        `${receipt.cycle.cycle_id} opened from ${receipt.cycle.predecessor_cycle_id ?? "no predecessor"}.`,
      );
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(null);
    }
  }

  async function retryBodyWeight() {
    const latest = workspace?.section_runs.at(-1);
    const evaluation = (workspace?.candidate_evaluations ?? []).find(
      (item) => item.run_id === latest?.receipt.run_id,
    );
    if (evaluation?.next_attempt_decision.action !== "retry") {
      return;
    }
    const cycleId = latest?.candidate.drafting_cycle_id ?? "CYCLE-BW-001";
    const nextAttempt = evaluation.next_attempt_decision.attempt + 1;
    setBusy("section-run");
    setNotice(null);
    setError(null);
    try {
      const receipt = await runSectionAgent(
        studyId,
        `workbench-${studyId}-body-weight-${cycleId}-attempt-${nextAttempt}`,
      );
      await refresh();
      setNotice(
        `${receipt.candidate_id} recorded from Codex SDK in Review Scaffold Revision ${receipt.review_scaffold_revision}.`,
      );
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(null);
    }
  }

  async function evaluateBodyWeight() {
    if (!workspace?.section_runs.at(-1)) {
      return;
    }
    const runId = workspace.section_runs.at(-1)?.receipt.run_id;
    if (!runId) {
      return;
    }
    setBusy("candidate-evaluation");
    setNotice(null);
    setError(null);
    try {
      const evaluation = await evaluateCandidate(studyId, runId);
      await refresh();
      setNotice(
        `${evaluation.evaluation_id} ${evaluation.next_attempt_decision.action} for ${evaluation.candidate_id}.`,
      );
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(null);
    }
  }

  async function queryBodyWeightFacts() {
    if (!workspace?.section_runs.at(-1)) {
      return;
    }
    const runId = workspace.section_runs.at(-1)?.receipt.run_id;
    if (!runId) {
      return;
    }
    setBusy("cross-section-query");
    setNotice(null);
    setError(null);
    try {
      const receipt = await queryCrossSection(studyId, runId);
      await refresh();
      setNotice(
        `${receipt.query_id} ${receipt.status} for ${receipt.requested_artifact_ids.length} requested artifacts.`,
      );
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(null);
    }
  }

  async function promoteBodyWeight() {
    const runId = workspace?.section_runs.at(-1)?.receipt.run_id;
    if (!runId) {
      return;
    }
    setBusy("section-promotion");
    setNotice(null);
    setError(null);
    try {
      const draft = await promoteSectionDraft(studyId, runId);
      await refresh();
      setNotice(`${draft.draft_id} promoted from ${draft.candidate_id}.`);
    } catch (cause) {
      await refresh();
      setError(messageFrom(cause));
    } finally {
      setBusy(null);
    }
  }

  async function approve(role: ApprovalRole) {
    setBusy(role);
    setNotice(null);
    setError(null);
    try {
      setWorkspace(await recordApproval(studyId, role));
      setNotice(`${roleLabel(role)} recorded in the synthetic audit trail.`);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(null);
    }
  }

  async function approveFinalStudy() {
    setBusy("final-study-approval");
    setNotice(null);
    setError(null);
    try {
      const key = `workbench-${studyId}-fsa-${workspace?.release_candidate?.content_hash?.slice(-12) ?? "pending"}`;
      setWorkspace(await recordFinalStudyApproval(studyId, key));
      setNotice("Final Study Approval recorded for the exact release-candidate hashes.");
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(null);
    }
  }

  async function performExport() {
    setBusy("export");
    setNotice(null);
    setError(null);
    try {
      const receipt = await exportPackage(studyId);
      await refresh();
      setNotice(
        `${receipt.artifacts.length} approved artifacts exported. Status: exported. Never a regulator approval claim.`,
      );
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div id="helix-e2e" className="hx-app" data-testid="helix-shell">
      <ShellHeader
        studyId={workspace ? workspace.study.study_id : studyId}
        descriptor={
          workspace ? studyDescriptor(workspace) : error ? "Workspace unavailable" : "Loading workspace"
        }
        loaded={Boolean(workspace)}
        title={workspace?.study.study_type_id}
        releasePill={workspace ? <ReleasePill workspace={workspace} /> : undefined}
      />

      {!workspace && error ? (
        <main className="hx-main">
          <Card className="hx-boundary-state" role="alert" aria-labelledby="hx-load-error">
            <Kicker>HELIX could not load</Kicker>
            <h1 id="hx-load-error">The workbench API is unavailable.</h1>
            <p className="hx-sub">{error}</p>
            <Button variant="primary" onClick={() => void refresh()}>
              <RetryIcon size={16} />
              Retry connection
            </Button>
          </Card>
        </main>
      ) : !workspace ? (
        <main className="hx-main">
          <Card className="hx-boundary-state" role="status" aria-live="polite">
            <Spinner />
            <Kicker>Loading synthetic study</Kicker>
            <h1>Building the evidence workspace.</h1>
            <p className="hx-sub">Requesting the workspace from the HELIX API.</p>
          </Card>
        </main>
      ) : (
        <main className="hx-main" data-testid="helix-workbench">
          <h1 className="hx-sr">HELIX report workspace for {workspace.study.study_id}</h1>
          <div className="hx-progress-region" data-testid="progress-region">
            <ProgressBar journey={workspace.journey} selectedStageId={selectedStageId} onSelect={selectStage} />
            <p className="hx-sub hx-progress-meta">
              Server workflow state{" "}
              <span className="hx-mono" data-testid="workflow-state">
                {workspace.workflow_state}
              </span>
            </p>
          </div>

          {(notice || error) && (
            <div className={error ? "hx-notice t-block" : "hx-notice t-info"} role="status">
              <span>{error ?? notice}</span>
              <Button
                size="sm"
                aria-label="Dismiss message"
                onClick={() => {
                  setError(null);
                  setNotice(null);
                }}
              >
                <CloseIcon size={14} />
                Close
              </Button>
            </div>
          )}

          <section
            className="hx-stage-view"
            aria-label="Stage view"
            data-testid="stage-view"
            data-selected-stage={selectedStageId ?? undefined}
          >
            {selectedStageId === "upload" && (
              <UploadGate workspace={workspace} onRefresh={refresh} onKeepView={() => selectStage("upload")}>
                <IntakeUploadForm />
              </UploadGate>
            )}
            {selectedStageId === "traceability" && (
              <TraceabilityStageView
                workspace={workspace}
                onRecordDisposition={traceabilityGate.onRecordDisposition}
                onContinue={traceabilityGate.onContinue}
              />
            )}
            {/* Lanes B, C and D replace these legacy panels with their stage views. Until
                then they remain the fallback so no stage loses its working controls. */}
            <StudyJourney
              workspace={workspace}
              planner={planner}
              validationBusy={busy === "validation"}
              dataValidationBusy={busy === "data-validation"}
              sectionRunBusy={busy === "section-run"}
              evaluationBusy={busy === "candidate-evaluation"}
              queryBusy={busy === "cross-section-query"}
              promotionBusy={busy === "section-promotion"}
              revisionBusy={busy === "section-revision"}
              onPlannerChange={setPlanner}
              onValidate={() => void validate()}
              onExecuteBodyWeight={() => void executeBodyWeight()}
              onDraftBodyWeight={() => void draftBodyWeight()}
              onReviseBodyWeight={() => void reviseBodyWeight()}
              onRetryBodyWeight={() => void retryBodyWeight()}
              onEvaluateCandidate={() => void evaluateBodyWeight()}
              onQueryCrossSection={() => void queryBodyWeightFacts()}
              onPromoteSectionDraft={() => void promoteBodyWeight()}
            />
            <ReportAssembly
              workspace={workspace}
              busy={busy}
              onInspectClaim={() => selectStage("traceability")}
              onResolve={() => selectStage("traceability")}
              onApprove={(role) => void approve(role)}
              onFinalStudyApproval={() => void approveFinalStudy()}
              onExport={() => void performExport()}
            />
          </section>

          <footer className="hx-footer">
            <span>Pattern test bed</span>
            <span>Rule bundle helix-rules-1.0.0</span>
            <span>Regulatory sources retrieved 2026-09-22</span>
            <span>Not a validated production system</span>
          </footer>
        </main>
      )}
    </div>
  );
}

function ReleasePill({ workspace }: { workspace: Workspace }) {
  const status = workspace.release_gate.status;
  const presentation = releasePresentation[status] ?? {
    label: formatStatus(status),
    tone: "muted" as Tone,
  };
  return (
    <Pill
      tone={presentation.tone}
      data-testid="release-status"
      data-status={status}
      data-workflow-state={workspace.workflow_state}
      title={`Release gate ${formatStatus(status)}. Workflow state ${formatStatus(workspace.workflow_state)}.`}
    >
      {presentation.label}
    </Pill>
  );
}

function studyDescriptor(workspace: Workspace): string {
  const { study, report } = workspace;
  const plannedAnimals = study.dose_groups.reduce(
    (total, group) => total + group.planned_n_per_sex * group.sexes.length,
    0,
  );
  return [
    `${study.duration_days}-day ${study.route} toxicity`,
    study.species,
    `${plannedAnimals} planned animals`,
    `Template ${report.template.version}`,
  ].join(" \u00b7 ");
}

function draftIdempotencyKey(studyId: string, workspace: Workspace | null): string {
  const latest = workspace?.drafting_cycles?.at(-1);
  if (!latest || latest.cycle_id === "CYCLE-BW-001") {
    const attemptCount = (workspace?.section_runs ?? []).filter(
      (item) => item.candidate.drafting_cycle_id === "CYCLE-BW-001",
    ).length;
    if (attemptCount === 0) {
      const runId = workspace?.pinned_run?.run_id ?? "unpinned";
      return `workbench-${studyId}-body-weight-${runId}-v1`;
    }
  }
  const cycleId = latest?.cycle_id ?? "CYCLE-BW-001";
  const nextAttempt =
    (workspace?.section_runs ?? []).filter((item) => item.candidate.drafting_cycle_id === cycleId)
      .length + 1;
  return `workbench-${studyId}-body-weight-${cycleId}-attempt-${nextAttempt}`;
}

function formatStatus(value: string): string {
  return value.replaceAll("_", " ");
}

function roleLabel(role: ApprovalRole): string {
  const labels: Record<ApprovalRole, string> = {
    pathologist: "Pathologist review",
    peer_reviewer: "Peer review",
    qau: "Quality Assurance Unit statement",
    study_director: "Study director approval",
  };
  return labels[role];
}

function messageFrom(cause: unknown): string {
  if (cause instanceof ApiError || cause instanceof Error) {
    return cause.message;
  }
  return "An unexpected workbench error occurred.";
}
