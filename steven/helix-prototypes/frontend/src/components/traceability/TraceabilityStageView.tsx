"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { getEvidence } from "@/lib/api";
import type { EvidenceChainData } from "@/lib/types";

import { CheckIcon, WarnIcon } from "../icons";
import { Button, Card, Chip, GateBanner, Kicker, ListRow, Spinner, cx, toneColor } from "../ui";
import { CandidateReceipts } from "./CandidateReceipts";
import { ClaimEvidence } from "./ClaimEvidence";
import type { DispositionCommand } from "./dispositionRules";
import {
  claimForResult,
  continueEligibility,
  evaluationForClaim,
  isRecorded,
  latestDispositions,
  requiredBlockerIds,
  ruleDisplay,
  stageById,
  type Disposition,
  type TraceabilityWorkspace,
} from "./gateState";
import { RuleAccordion, humanizeRule } from "./RuleAccordion";
import type { ClaimRequest } from "./useTraceabilityGate";

// Lane C (#22): Human Gate 2, the Traceability Review. Everything rendered here is
// server state: the workspace (journey, validations, dispositions, candidate
// evaluations) and `getEvidence` for the selected claim. The only local state is
// which claim and rule row are being viewed and whether the form is open.

export type TraceabilityStageViewProps = {
  workspace: TraceabilityWorkspace;
  /** Records the typed command and resolves once the refreshed workspace is set; rejects with the server error. */
  onRecordDisposition: (resultId: string, command: DispositionCommand) => Promise<unknown>;
  /** Selects the Review view. It never passes the gate; the server already has. */
  onContinue: () => void;
  /** A claim the reviewer asked to open (Inspect provenance on a report statement). */
  claimRequest?: ClaimRequest | null;
  /** Loads the evidence chain for a claim. Defaults to the API's `getEvidence`. */
  loadEvidence?: (studyId: string, claimId: string) => Promise<EvidenceChainData>;
};

export function TraceabilityStageView({
  workspace,
  onRecordDisposition,
  onContinue,
  loadEvidence = getEvidence,
  claimRequest = null,
}: TraceabilityStageViewProps) {
  const studyId = workspace.study.study_id;
  const dispositions = useMemo(() => latestDispositions(workspace), [workspace]);
  const required = useMemo(() => requiredBlockerIds(workspace), [workspace]);
  const trace = stageById(workspace, "traceability");
  const gatePassed = trace?.status === "complete";
  const gateOpen = Boolean(trace && trace.status !== "complete" && trace.status !== "pending");
  const eligibility = continueEligibility(workspace);

  const [claimId, setClaimId] = useState<string>(() =>
    requestedClaim(workspace, claimRequest) ?? defaultClaim(workspace, required),
  );
  const [chain, setChain] = useState<EvidenceChainData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openResultId, setOpenResultId] = useState<string | null>(null);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const [formResultId, setFormResultId] = useState<string | null>(null);

  // getEvidence reloads when the selected claim changes and after every refreshed
  // workspace (a disposition returns a new workspace).
  useEffect(() => {
    let active = true;
    setLoadError(null);
    // No claim, no lookup: never ask the API for an empty claim ID.
    if (!claimId) {
      setChain(null);
      return;
    }
    void loadEvidence(studyId, claimId)
      .then((value) => {
        if (active) setChain(value);
      })
      .catch((cause: unknown) => {
        if (active) {
          setChain(null);
          setLoadError(cause instanceof Error ? cause.message : "Evidence lookup failed.");
        }
      });
    return () => {
      active = false;
    };
  }, [loadEvidence, studyId, claimId, workspace.validations, workspace.dispositions]);

  const current = chain && chain.claim.claim_id === claimId ? chain : null;
  const results = current?.validations ?? [];

  // Open the first blocked row once per claim (the reference opens the blocker).
  useEffect(() => {
    if (!current || openedFor === claimId) return;
    const firstBlocked = current.validations.find((result) => ruleDisplay(result, dispositions.get(result.result_id)) === "blocked");
    const firstOpen = firstBlocked ?? current.validations.find((result) => result.status !== "pass");
    setOpenResultId(firstOpen?.result_id ?? null);
    setOpenedFor(claimId);
  }, [current, claimId, openedFor, dispositions]);

  // One calm status for the selected claim; per-rule badges carry the detail (no tallies, #70).
  const displays = results.map((result) => ruleDisplay(result, dispositions.get(result.result_id)));
  const claimStatus: { tone: "pass" | "block" | "warn"; label: string } = displays.includes("blocked")
    ? { tone: "block", label: "Needs disposition" }
    : displays.includes("disposition")
      ? { tone: "warn", label: "Dispositioned" }
      : { tone: "pass", label: "All rules pass" };

  const selectedClaim = workspace.claims.find((claim) => claim.claim_id === claimId);
  const evaluation = evaluationForClaim(workspace, claimId);
  const evaluationCount = workspace.candidate_evaluations?.length ?? 0;

  function selectClaim(nextClaimId: string, resultId?: string) {
    setFormResultId(null);
    if (nextClaimId !== claimId) {
      setChain(null);
      setClaimId(nextClaimId);
      if (resultId) {
        setOpenResultId(resultId);
        setOpenedFor(nextClaimId);
      } else {
        setOpenedFor(null);
      }
    } else if (resultId) {
      setOpenResultId(resultId);
    }
    if (resultId) {
      window.requestAnimationFrame(() => document.getElementById(`hx-rule-btn-${resultId}`)?.focus());
    }
  }

  // A new Inspect request selects its claim (if the server lists it), once per nonce.
  const handledRequest = useRef(claimRequest?.nonce ?? 0);
  useEffect(() => {
    if (!claimRequest || claimRequest.nonce === handledRequest.current) return;
    handledRequest.current = claimRequest.nonce;
    const requested = requestedClaim(workspace, claimRequest);
    if (requested) selectClaim(requested);
    // Keyed on the request alone: workspace refreshes must not re-apply an old request.
  }, [claimRequest]);

  async function record(resultId: string, command: DispositionCommand) {
    await onRecordDisposition(resultId, command);
    setFormResultId(null);
    window.requestAnimationFrame(() => document.getElementById(`hx-rule-btn-${resultId}`)?.focus());
  }

  return (
    <div className="stack hx-trace hx-v1" data-testid="traceability-stage-view">
      <div className="stack" data-testid="traceability-gate">
        <GateBanner
          gateNumber={2}
          passed={gatePassed}
          title="Review the traceability of the agent's work"
          data-testid="traceability-gate-banner"
          right={
            <>
              <span id="hx-trace-hint" data-testid="continue-hint">
                {gatePassed && eligibility.eligible ? "Reviewed and approved." : eligibility.hint}
              </span>
              <Button
                variant="primary"
                size="sm"
                disabled={!eligibility.eligible}
                aria-describedby="hx-trace-hint"
                onClick={onContinue}
                data-testid="continue-to-review"
              >
                Approve and continue to review
              </Button>
            </>
          }
        />
        <div className="hx-trace-head">
          <div>
            <Kicker data-testid="trace-claim-kicker">
              {claimId ? `Claim ${claimId}` : "No claims"}
              {selectedClaim ? ` \u00b7 ${humanizeField(selectedClaim.field_id)}` : ""}
            </Kicker>
            <h1>Validation and traceability</h1>
            <p className="hx-sub">Open a rule to see how the value flows from the frozen source to the report.</p>
          </div>
          {current && (
            <div className="hx-trace-chips" data-testid="trace-summary" data-status={claimStatus.tone}>
              <Chip tone={claimStatus.tone} className="hx-trace-chip">
                {claimStatus.label}
              </Chip>
            </div>
          )}
        </div>
        {!claimId ? (
          <Card data-testid="trace-no-claims">
            <Kicker>No claims to trace</Kicker>
            <p className="hx-sub">The server has not recorded any claims for this study, so there is no evidence to review yet.</p>
          </Card>
        ) : loadError ? (
          <Card role="alert" data-testid="evidence-error">
            <Kicker>Evidence unavailable</Kicker>
            <p className="hx-sub">{loadError}</p>
          </Card>
        ) : !current ? (
          <div className="hx-acc hx-acc-loading" role="status" aria-live="polite">
            <Spinner /> Loading evidence for {claimId}…
          </div>
        ) : (
          <RuleAccordion
            chain={current}
            results={results}
            dispositions={dispositions}
            openResultId={openResultId}
            onToggle={(resultId) => {
              setFormResultId(null);
              setOpenResultId((open) => (open === resultId ? null : resultId));
            }}
            gateOpen={gateOpen}
            formResultId={formResultId}
            onOpenForm={setFormResultId}
            onRecord={record}
          />
        )}
      </div>

      <GateBlockers workspace={workspace} required={required} claimId={claimId} onSelect={selectClaim} />

      <div className="hx-trace-detail">
        {claimId && <CandidateReceipts evaluation={evaluation} evaluationCount={evaluationCount} claimId={claimId} />}
        {current && <ClaimEvidence chain={current} />}
      </div>
    </div>
  );
}

function GateBlockers({
  workspace,
  required,
  claimId,
  onSelect,
}: {
  workspace: TraceabilityWorkspace;
  required: string[];
  claimId: string;
  onSelect: (claimId: string, resultId?: string) => void;
}) {
  const dispositions = latestDispositions(workspace);
  const byId = new Map(workspace.validations.map((result) => [result.result_id, result]));
  return (
    <Card stack aria-labelledby="hx-blockers-h" data-testid="gate-blockers">
      <div>
        <Kicker>Required dispositions</Kicker>
        <h2 id="hx-blockers-h">{blockersHeading(required, dispositions)}</h2>
      </div>
      <div>
        {required.map((resultId) => {
          const result = byId.get(resultId);
          const recorded = isRecorded(dispositions.get(resultId));
          const owner = claimForResult(workspace, result);
          return (
            <ListRow
              key={resultId}
              icon={recorded ? <CheckIcon size={16} /> : <WarnIcon size={16} />}
              iconColor={toneColor(recorded ? "warn" : "block")}
              meta={
                owner ? (
                  <Button size="sm" onClick={() => onSelect(owner, resultId)} data-testid={`open-blocker-${resultId}`}>
                    Open rule
                  </Button>
                ) : (
                  <span className="hx-sub">No claim scope</span>
                )
              }
            >
              <span data-testid={`blocker-${resultId}`}>
                <span className="hx-mono">{resultId}</span> · {result ? humanizeRule(result.rule_id) : "Unknown rule"} ·{" "}
                {recorded ? "Disposition" : "Blocked"}
                {owner ? ` · ${owner}` : ""}
              </span>
            </ListRow>
          );
        })}
      </div>
      <div className="hx-trace-claims" role="group" aria-label="Claims in this gate">
        {workspace.claims.map((claim) => (
          <button
            key={claim.claim_id}
            type="button"
            className={cx("hx-btn", "sm", claim.claim_id === claimId && "is-selected")}
            aria-pressed={claim.claim_id === claimId}
            onClick={() => onSelect(claim.claim_id)}
            data-testid={`claim-${claim.claim_id}`}
          >
            {claim.claim_id}
          </button>
        ))}
      </div>
    </Card>
  );
}

function blockersHeading(required: string[], dispositions: Map<string, Disposition>): string {
  if (required.length === 0) return "No blockers need a disposition";
  return required.every((id) => isRecorded(dispositions.get(id))) ? "Every blocker has a disposition" : "Blockers awaiting a disposition";
}

function requestedClaim(workspace: TraceabilityWorkspace, request: ClaimRequest | null): string | undefined {
  return request && workspace.claims.some((claim) => claim.claim_id === request.claimId) ? request.claimId : undefined;
}

function defaultClaim(workspace: TraceabilityWorkspace, required: string[]): string {
  const dispositions = latestDispositions(workspace);
  const byId = new Map(workspace.validations.map((result) => [result.result_id, result]));
  for (const resultId of required) {
    if (isRecorded(dispositions.get(resultId))) continue;
    const owner = claimForResult(workspace, byId.get(resultId));
    if (owner) return owner;
  }
  return workspace.claims.at(0)?.claim_id ?? "";
}


function humanizeField(fieldId: string): string {
  const text = fieldId.replaceAll("-", " ").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
