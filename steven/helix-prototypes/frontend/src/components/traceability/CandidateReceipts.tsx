import type { CandidateEvaluation } from "@/lib/types";

import { Card, Chip, Kicker, ListRow, type Tone } from "../ui";
import { shortHash } from "./TraceFlow";

// Lane C (#22). Stored candidate evaluation receipts beside the claim flow: provenance
// bindings, template conformance, study-output evaluation, next-attempt decision, and
// hashes. Read from `workspace.candidate_evaluations`; this view never reruns an evaluation.

const statusTone = (status: string): Tone => (status === "passed" ? "pass" : status === "failed" ? "warn" : "block");

export function CandidateReceipts({
  evaluation,
  evaluationCount,
  claimId,
}: {
  /** The newest stored evaluation that binds `claimId` (see `evaluationForClaim`). */
  evaluation: CandidateEvaluation | undefined;
  /** How many evaluations the workspace stores in total, to word the empty state. */
  evaluationCount: number;
  claimId: string;
}) {
  if (!evaluation) {
    return (
      <Card stack aria-labelledby="hx-receipts-h" data-testid="candidate-receipts" data-empty="true">
        <div>
          <Kicker>Candidate evaluation receipts · {claimId}</Kicker>
          <h2 id="hx-receipts-h">
            {evaluationCount > 0 ? `No candidate evaluation covers ${claimId}` : "No candidate evaluation recorded"}
          </h2>
          <p className="hx-sub">
            {evaluationCount > 0
              ? "Stored receipts belong to other sections' candidates; none binds this claim. This gate only reads stored receipts."
              : "Receipts appear after the Draft stage evaluates a section candidate. This gate only reads stored receipts."}
          </p>
        </div>
      </Card>
    );
  }
  const provenance = evaluation.provenance_receipt;
  const template = evaluation.template_conformance_receipt;
  const output = evaluation.study_output_evaluation_receipt;
  const next = evaluation.next_attempt_decision;
  const bindings = provenance.bindings.filter((binding) => binding.claim_id === claimId);
  const blockedTemplate = template.results.filter((result) => result.status !== "passed");
  const failedOutput = output.results.filter((result) => result.status !== "passed");

  return (
    <Card stack aria-labelledby="hx-receipts-h" data-testid="candidate-receipts">
      <div>
        <Kicker>Candidate evaluation receipts</Kicker>
        <h2 id="hx-receipts-h">{evaluation.candidate_id}</h2>
        <p className="hx-sub hx-mono">
          {evaluation.evaluation_id} · {evaluation.section_package_id}
        </p>
      </div>
      <div>
        <ListRow meta={<Chip tone={statusTone(provenance.status)} size="xs">{provenance.status}</Chip>}>
          <span data-testid="receipt-provenance">
            Provenance binding · {bindings.length} of {provenance.bindings.length} bindings for {claimId}
            {provenance.blockers.length > 0 ? ` · ${provenance.blockers.length} blockers` : ""}
          </span>
        </ListRow>
        <ListRow meta={<Chip tone={statusTone(template.status)} size="xs">{template.status}</Chip>}>
          <span data-testid="receipt-template">
            Template conformance · {template.results.length} checks
            {blockedTemplate.length > 0 ? ` · ${blockedTemplate.map((result) => result.rule_id).join(", ")}` : ""}
          </span>
        </ListRow>
        <ListRow meta={<Chip tone={statusTone(output.status)} size="xs">{output.status}</Chip>}>
          <span data-testid="receipt-output">
            Study-output evaluation · {output.suite_id}@{output.suite_version}
            {failedOutput.length > 0 ? ` · ${failedOutput.length} failed` : ""}
          </span>
        </ListRow>
        <ListRow meta={<Chip tone={next.action === "retry" ? "warn" : next.action === "hold" ? "muted" : "info"} size="xs">{next.action.replaceAll("_", " ")}</Chip>}>
          <span data-testid="receipt-next-attempt">
            Next attempt · attempt {next.attempt} of {next.max_attempts}
            {next.reasons.length > 0 ? ` · ${next.reasons.join("; ")}` : ""}
          </span>
        </ListRow>
      </div>
      {bindings.length > 0 && (
        <ul className="hx-receipt-bindings" aria-label={`Provenance bindings for ${claimId}`}>
          {bindings.map((binding) => (
            <li key={`${binding.location}-${binding.claim_hash}`}>
              <span className="hx-mono">{binding.location}</span> {binding.text}{" "}
              <span className="hx-mono">{shortHash(binding.claim_hash)}</span>
            </li>
          ))}
        </ul>
      )}
      <dl className="hx-receipt-hashes hx-mono" data-testid="receipt-hashes">
        {Object.entries(evaluation.hashes).map(([name, value]) => (
          <div key={name}>
            <dt>{name.replaceAll("_", " ")}</dt>
            <dd title={value}>{shortHash(value)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
