"use client";

import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  evaluateCandidate,
  exportPackage,
  getWorkspace,
  queryCrossSection,
  recordApproval,
  recordDisposition,
  runDataValidation,
  runSectionAgent,
  runValidation,
} from "@/lib/api";
import type { ApprovalRole, PlannerMode, Workspace } from "@/lib/types";

import { EvidenceChain } from "./EvidenceChain";
import { ReportAssembly } from "./ReportAssembly";
import { StudyJourney } from "./StudyJourney";

type View = "journey" | "evidence" | "report";

type Props = {
  studyId: string;
};

const viewLabels: Record<View, { label: string; eyebrow: string }> = {
  journey: { label: "Study journey", eyebrow: "Workflow" },
  evidence: { label: "Evidence chain", eyebrow: "Traceability" },
  report: { label: "Report assembly", eyebrow: "Structured output" },
};

export function HelixWorkbench({ studyId }: Props) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [activeView, setActiveView] = useState<View>("journey");
  const [selectedClaimId, setSelectedClaimId] = useState("C-BW-HIGH");
  const [planner, setPlanner] = useState<PlannerMode>("fixture");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      const receipt = await runSectionAgent(studyId);
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

  async function resolve(resultId: string, message: string) {
    setBusy(resultId);
    setNotice(null);
    setError(null);
    try {
      setWorkspace(await recordDisposition(studyId, resultId, message));
      setNotice(`Synthetic review disposition recorded for ${resultId}.`);
    } catch (cause) {
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

  async function performExport() {
    setBusy("export");
    setNotice(null);
    setError(null);
    try {
      const receipt = await exportPackage(studyId);
      await refresh();
      setNotice(
        `${receipt.artifacts.length} synthetic artifacts checksummed. This is not an FDA submission.`,
      );
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(null);
    }
  }

  function inspectClaim(claimId: string) {
    setSelectedClaimId(claimId);
    setActiveView("evidence");
  }

  if (error && !workspace) {
    return (
      <main className="boot-state">
        <div className="boot-mark">H</div>
        <p className="eyebrow">HELIX could not load</p>
        <h1>The workbench API is unavailable.</h1>
        <p>{error}</p>
        <button className="button primary" type="button" onClick={() => void refresh()}>
          Retry connection
        </button>
      </main>
    );
  }

  if (!workspace) {
    return (
      <main className="boot-state" aria-live="polite">
        <div className="boot-mark pulse">H</div>
        <p className="eyebrow">Loading synthetic study</p>
        <h1>Building the evidence workspace.</h1>
      </main>
    );
  }

  const releaseStatus = workspace.release_gate.status;

  return (
    <main className="app-shell" data-testid="helix-workbench">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            H
          </div>
          <div>
            <div className="brand-name">HELIX</div>
            <div className="brand-subtitle">Nonclinical evidence workbench</div>
          </div>
        </div>
        <div className="study-heading">
          <p className="eyebrow">Active study</p>
          <div className="study-title-row">
            <h1>{workspace.study.study_id}</h1>
            <span className="quiet-separator">/</span>
            <span>
              {workspace.study.duration_days}-day {workspace.study.route} toxicity
            </span>
          </div>
        </div>
        <div className="topbar-status">
          <span className="badge synthetic">Synthetic / not for submission</span>
          <span className={`badge release ${releaseStatus}`} data-testid="release-status">
            {formatStatus(releaseStatus)}
          </span>
        </div>
      </header>

      <div className="workspace-nav-wrap">
        <nav className="workspace-nav" aria-label="Workspace views">
          {(Object.keys(viewLabels) as View[]).map((view) => (
            <button
              className={activeView === view ? "view-tab active" : "view-tab"}
              key={view}
              type="button"
              aria-current={activeView === view ? "page" : undefined}
              onClick={() => setActiveView(view)}
            >
              <span>{viewLabels[view].eyebrow}</span>
              {viewLabels[view].label}
            </button>
          ))}
        </nav>
        <div className="nav-meta">
          <span>Template {workspace.report.template.version}</span>
          <span>{workspace.report.template.ctd_location}</span>
        </div>
      </div>

      {(notice || error) && (
        <div className={error ? "notice error" : "notice"} role="status">
          <span>{error ?? notice}</span>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
          >
            Close
          </button>
        </div>
      )}

      <div className="workspace-body">
        {activeView === "journey" && (
          <StudyJourney
            workspace={workspace}
            planner={planner}
            validationBusy={busy === "validation"}
            dataValidationBusy={busy === "data-validation"}
            sectionRunBusy={busy === "section-run"}
            evaluationBusy={busy === "candidate-evaluation"}
            queryBusy={busy === "cross-section-query"}
            onPlannerChange={setPlanner}
            onValidate={() => void validate()}
            onExecuteBodyWeight={() => void executeBodyWeight()}
            onDraftBodyWeight={() => void draftBodyWeight()}
            onEvaluateCandidate={() => void evaluateBodyWeight()}
            onQueryCrossSection={() => void queryBodyWeightFacts()}
          />
        )}
        {activeView === "evidence" && (
          <EvidenceChain
            workspace={workspace}
            selectedClaimId={selectedClaimId}
            onSelectClaim={setSelectedClaimId}
          />
        )}
        {activeView === "report" && (
          <ReportAssembly
            workspace={workspace}
            busy={busy}
            onInspectClaim={inspectClaim}
            onResolve={(resultId, message) => void resolve(resultId, message)}
            onApprove={(role) => void approve(role)}
            onExport={() => void performExport()}
          />
        )}
      </div>

      <footer className="app-footer">
        <span>Pattern test bed</span>
        <span>Rule bundle helix-rules-1.0.0</span>
        <span>Regulatory sources retrieved 2026-09-22</span>
        <span>Not a validated production system</span>
      </footer>
    </main>
  );
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
