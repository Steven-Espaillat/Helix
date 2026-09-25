"use client";

import type { EvidenceChainData, ValidationResult } from "@/lib/types";

import { ChevronIcon } from "../icons";
import { Button, Chip, cx, type Tone } from "../ui";
import { DispositionForm } from "./DispositionForm";
import type { DispositionCommand } from "./dispositionRules";
import { ruleDisplay, type Disposition, type RuleDisplay } from "./gateState";
import { TraceFlow, type FlowTone } from "./TraceFlow";

// Lane C (#22). Accordion table from research/helix-e2e-workbench-v1.html (viewTrace):
// chevron, Validation rule, Evidence, Result. Row headers are buttons with
// aria-expanded/aria-controls, and only one row is open at a time (the parent owns it).

const BADGE: Record<RuleDisplay, { label: string; tone: Tone; flow: FlowTone; note: string }> = {
  pass: { label: "Pass", tone: "pass", flow: "pass", note: "Checked:" },
  disposition: { label: "Disposition", tone: "warn", flow: "warn", note: "Disposition:" },
  blocked: { label: "Blocked", tone: "block-solid", flow: "block", note: "Blocker:" },
  warning: { label: "Warning", tone: "warn", flow: "warn", note: "Warning:" },
  skipped: { label: "Skipped", tone: "muted", flow: "warn", note: "Skipped:" },
};

const DECISION_LABEL: Record<string, string> = {
  corrected: "Corrected",
  explained_in_nsdrg: "Explained in nSDRG",
  approved_exception: "Approved exception",
};

type Props = {
  chain: EvidenceChainData;
  results: ValidationResult[];
  dispositions: Map<string, Disposition>;
  openResultId: string | null;
  onToggle: (resultId: string) => void;
  gateOpen: boolean;
  formResultId: string | null;
  onOpenForm: (resultId: string | null) => void;
  onRecord: (resultId: string, command: DispositionCommand) => Promise<unknown>;
};

export function RuleAccordion({
  chain,
  results,
  dispositions,
  openResultId,
  onToggle,
  gateOpen,
  formResultId,
  onOpenForm,
  onRecord,
}: Props) {
  return (
    <div className="hx-acc" data-testid="rule-accordion">
      <div className="hx-acc-head hx-acc-cols" aria-hidden="true">
        <span />
        <span>Validation rule</span>
        <span className="ev">Evidence</span>
        <span>Result</span>
      </div>
      {results.length === 0 && (
        <p className="hx-acc-empty hx-sub">No validation results are attached to this claim yet.</p>
      )}
      {results.map((result) => {
        const disposition = dispositions.get(result.result_id);
        const display = ruleDisplay(result, disposition);
        const badge = BADGE[display];
        const isOpen = openResultId === result.result_id;
        const panelId = `hx-rule-${result.result_id}`;
        const buttonId = `hx-rule-btn-${result.result_id}`;
        const label = humanizeRule(result.rule_id);
        return (
          <div
            key={result.result_id}
            className={cx("hx-acc-item", isOpen && "is-open")}
            data-testid={`rule-row-${result.result_id}`}
            data-display={display}
          >
            <button
              type="button"
              id={buttonId}
              className="hx-acc-btn hx-acc-cols"
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => onToggle(result.result_id)}
            >
              <span className="hx-chev">
                <ChevronIcon />
              </span>
              <strong>{label}</strong>
              <span className="ev hx-cell-ink2">{evidenceSummary(result)}</span>
              <span>
                <Chip tone={badge.tone} data-testid={`rule-badge-${result.result_id}`}>
                  {badge.label}
                </Chip>
              </span>
            </button>
            <div className="hx-acc-panel" id={panelId} role="region" aria-labelledby={buttonId} hidden={!isOpen}>
              {isOpen && (
                <>
                  <TraceFlow chain={chain} result={result} tone={badge.flow} />
                  <div className={cx("hx-note", `t-${badge.flow}`)} data-testid={`rule-note-${result.result_id}`}>
                    <span>
                      <strong className={`hx-note-label is-${badge.flow}`}>{badge.note} </strong>
                      {display === "disposition" && disposition ? (
                        <DispositionText disposition={disposition} />
                      ) : (
                        result.message
                      )}
                    </span>
                    {display === "blocked" && gateOpen && formResultId !== result.result_id && (
                      <Button size="sm" onClick={() => onOpenForm(result.result_id)} data-testid={`record-disposition-${result.result_id}`}>
                        Record disposition
                      </Button>
                    )}
                  </div>
                  {display === "blocked" && gateOpen && formResultId === result.result_id && (
                    <DispositionForm
                      resultId={result.result_id}
                      ruleLabel={label}
                      onSubmit={(command) => onRecord(result.result_id, command)}
                      onCancel={() => onOpenForm(null)}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DispositionText({ disposition }: { disposition: Disposition }) {
  return (
    <span data-testid={`disposition-record-${disposition.result_id}`}>
      {DECISION_LABEL[disposition.decision] ?? disposition.decision}. {disposition.reason}{" "}
      <span className="hx-disp-audit">
        Reviewer {disposition.reviewer} · <span className="hx-mono">{disposition.disposition_id}</span>
        {disposition.timestamp ? <> · {disposition.timestamp}</> : null}
      </span>
    </span>
  );
}

export function humanizeRule(ruleId: string): string {
  const text = ruleId.replaceAll("-", " ").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function evidenceSummary(result: ValidationResult): string {
  const count = result.evidence_ids.length;
  const ids = count > 0 ? `${count} linked ${count === 1 ? "ID" : "IDs"}` : "No linked IDs";
  return `${ids} · ${result.message}`;
}
