"use client";

import { useEffect, useState } from "react";

import { getEvidence } from "@/lib/api";
import type { EvidenceChainData, Workspace } from "@/lib/types";

import { ArrowIcon } from "./icons";

type Props = {
  workspace: Workspace;
  selectedClaimId: string;
  onSelectClaim: (claimId: string) => void;
};

export function EvidenceChain({ workspace, selectedClaimId, onSelectClaim }: Props) {
  const [chain, setChain] = useState<EvidenceChainData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setChain(null);
    void getEvidence(workspace.study.study_id, selectedClaimId)
      .then((value) => {
        if (active) {
          setChain(value);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Evidence lookup failed.");
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [selectedClaimId, workspace.study.study_id, workspace.validations]);

  const humanDispositionRecorded = chain?.exact_match === null && chain.claim.status === "approved";
  const claimSatisfied = chain?.exact_match === true || humanDispositionRecorded;

  return (
    <section className="view-content" aria-labelledby="evidence-heading">
      <div className="view-intro evidence-intro">
        <div>
          <p className="eyebrow">Selected report claim</p>
          <h2 id="evidence-heading">One statement, traced all the way back.</h2>
          <p>
            Each card exposes a boundary. The report never becomes the source, and the model never
            becomes the calculator.
          </p>
        </div>
        <div className="claim-picker" aria-label="Report claims">
          {workspace.claims.map((claim) => (
            <button
              key={claim.claim_id}
              type="button"
              className={claim.claim_id === selectedClaimId ? "claim-pill active" : "claim-pill"}
              onClick={() => onSelectClaim(claim.claim_id)}
            >
              <span>{claim.section_id}</span>
              {claimLabel(claim.field_id)}
              <em className={claim.status}>{claim.status.replaceAll("_", " ")}</em>
            </button>
          ))}
        </div>
      </div>

      {loading && !chain && <div className="panel loading-panel">Loading evidence records…</div>}
      {error && <div className="panel inline-error">{error}</div>}

      {chain && (
        <>
          <div className="evidence-chain-grid" data-testid="evidence-chain">
            <ChainCard
              index="01"
              eyebrow="Frozen source"
              title={`${chain.sources.length} exact records`}
              detail={chain.sources.at(0)?.source_pointer ?? "No source record"}
              meta="Manifest locked"
            />
            <ChainConnector />
            <ChainCard
              index="02"
              eyebrow="Normalized facts"
              title={displayGrain(chain.sources.at(0)?.grain ?? chain.claim.grain)}
              detail={`${chain.sources.at(0)?.domain ?? "Study"} domain · ${chain.claim.unit ?? "no unit"}`}
              meta="Typed boundary"
            />
            <ChainConnector />
            <ChainCard
              index="03"
              eyebrow="Deterministic transform"
              title={chain.transform_id ?? "No transform"}
              detail={transformDescription(chain.transform_id)}
              meta="No LLM arithmetic"
            />
            <ChainConnector />
            <ChainCard
              index="04"
              eyebrow="Validated claim"
              title={claimValue(chain)}
              detail={
                chain.exact_match === null
                  ? humanDispositionRecorded
                    ? "Human disposition recorded"
                    : "Human judgment required"
                  : chain.exact_match
                    ? "Exact reconciliation passed"
                    : "Reconciliation failed"
              }
              meta={claimSatisfied ? "Control satisfied" : "Review required"}
              tone={claimSatisfied ? "success" : "danger"}
            />
            <ChainConnector />
            <ChainCard
              index="05"
              eyebrow="Report field"
              title={`${chain.claim.section_id} · ${claimLabel(chain.claim.field_id)}`}
              detail={chain.report_text}
              meta={`${chain.sources.length} provenance edges`}
            />
          </div>

          <div className="evidence-detail-grid">
            <article className="panel validation-table-card">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Rule evidence</p>
                  <h3>Checks attached to this claim</h3>
                </div>
                <span className="count-chip">{chain.validations.length}</span>
              </div>
              {chain.validations.length > 0 ? (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Rule</th>
                        <th>Evidence</th>
                        <th>Executor</th>
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chain.validations.map((result) => (
                        <tr key={result.result_id}>
                          <td>
                            <strong>{humanize(result.rule_id)}</strong>
                            <span>{result.message}</span>
                          </td>
                          <td>{result.evidence_ids.length} linked IDs</td>
                          <td>{result.kind === "agent_planned" ? result.tool_name : "Python rule"}</td>
                          <td>
                            <span className={`result-chip ${result.status}`}>{result.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="empty-copy">Run hybrid validation to attach current rule evidence.</p>
              )}
            </article>

            <aside className="panel evidence-summary-card">
              <p className="eyebrow">Reconciliation</p>
              <h3>
                {chain.exact_match
                  ? "Source and claim agree."
                  : humanDispositionRecorded
                    ? "Human disposition is recorded."
                    : "Review is still required."}
              </h3>
              <div className="comparison-values">
                <div>
                  <span>Stored claim</span>
                  <strong>{claimValue(chain)}</strong>
                </div>
                <div>
                  <span>Recomputed</span>
                  <strong>
                    {chain.recomputed_value === null
                      ? "Not calculated"
                      : `${formatNumber(chain.recomputed_value)} ${chain.claim.unit}`}
                  </strong>
                </div>
              </div>
              <p>
                The backend recomputes this value from the selected source IDs. The UI only displays
                the returned evidence.
              </p>
              <div className="lineage-meta" data-testid="claim-lineage">
                <div>
                  <span>Grain</span>
                  <strong>{displayGrain(chain.claim.grain)}</strong>
                </div>
                <div>
                  <span>Transform</span>
                  <strong>
                    {chain.transform_id ?? "None"} {chain.transform_version ?? ""}
                  </strong>
                </div>
                <div>
                  <span>Source hashes</span>
                  <code>{chain.source_hashes?.at(0) ?? "None"}</code>
                </div>
                <div>
                  <span>Rule versions</span>
                  <code>
                    {Object.entries(chain.rule_versions ?? {})
                      .map(([ruleId, version]) => `${ruleId}@${version}`)
                      .join(" · ") || "None"}
                  </code>
                </div>
              </div>
            </aside>
          </div>

          <article className="panel source-record-card">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Source records</p>
                <h3>Rows used by {chain.transform_id ?? "the report field"}</h3>
              </div>
              {chain.sources.length > 0 && (
                <span className="authority-chip">Authority tier 1</span>
              )}
            </div>
            {chain.sources.length > 0 ? (
              <div className="table-wrap">
                <table className="data-table source-table">
                  <thead>
                    <tr>
                      <th>Record</th>
                      <th>Animal</th>
                      <th>Group</th>
                      <th>Sex</th>
                      <th>Timepoint or tissue</th>
                      <th>Value</th>
                      <th>Source pointer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chain.sources.map((source) => (
                      <tr key={source.record_id}>
                        <td>
                          <code>{source.record_id}</code>
                        </td>
                        <td>{textAttribute(source.attributes.animal_id)}</td>
                        <td>{textAttribute(source.attributes.group_id)}</td>
                        <td>{textAttribute(source.attributes.sex)}</td>
                        <td>
                          {textAttribute(
                            source.attributes.timepoint ?? source.attributes.tissue ?? "Study",
                          )}
                        </td>
                        <td>
                          <strong>
                            {typeof source.value === "number"
                              ? formatNumber(source.value)
                              : source.value} {source.unit}
                          </strong>
                        </td>
                        <td>
                          <code>{source.source_pointer}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-copy">
                This scientific-judgment field has no source value. The gap is deliberate.
              </div>
            )}
          </article>
        </>
      )}
    </section>
  );
}

function ChainCard({
  index,
  eyebrow,
  title,
  detail,
  meta,
  tone = "default",
}: {
  index: string;
  eyebrow: string;
  title: string;
  detail: string;
  meta: string;
  tone?: "default" | "success" | "danger";
}) {
  return (
    <article className={`chain-card ${tone}`}>
      <div className="chain-card-top">
        <span>{index}</span>
        <p className="eyebrow">{eyebrow}</p>
      </div>
      <h3>{title}</h3>
      <p>{detail}</p>
      <small>{meta}</small>
    </article>
  );
}

function ChainConnector() {
  return (
    <div className="chain-connector" aria-hidden="true">
      <ArrowIcon size={16} />
    </div>
  );
}

function displayGrain(grain: string): string {
  return grain.replaceAll("_x_", " × ");
}

function claimLabel(value: string): string {
  return value
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function claimValue(chain: EvidenceChainData): string {
  if (chain.claim.value === null) {
    return "Needs review";
  }
  return `${formatNumber(chain.claim.value)} ${chain.claim.unit}`;
}

function transformDescription(value: string | null): string {
  if (value === "mean-v1") {
    return "Filter G4 at Day 28 · arithmetic mean";
  }
  if (value === "incidence-count-v1") {
    return "Filter finding and dose group · count animals";
  }
  return "No automatic calculation";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function humanize(value: string): string {
  return value.replaceAll("-", " ");
}

function textAttribute(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "Not recorded" : String(value);
}
