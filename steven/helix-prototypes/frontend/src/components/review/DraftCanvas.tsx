"use client";

import { useEffect, useState } from "react";

import { ApiError, getEvidence } from "@/lib/api";
import type { EvidenceChainData, Workspace } from "@/lib/types";

import { Button, Card, Kicker, Spinner } from "../ui";

// Lane D (#23): document-style canvas for one report section of WorkspaceResponse.report.
// "Inspect provenance edges" calls getEvidence for that block's claim and renders the exact
// lineage the server returns. Regulatory references are shown with their binding context.

type Section = Workspace["report"]["sections"][number];
type Lineage =
  | { state: "idle" }
  | { state: "loading"; claimId: string }
  | { state: "error"; claimId: string; message: string }
  | { state: "loaded"; claimId: string; chain: EvidenceChainData };

export function DraftCanvas({ workspace, section }: { workspace: Workspace; section: Section }) {
  const studyId = workspace.study.study_id;
  const template = workspace.report.template;
  const templateSection = template.sections.find((item) => item.section_id === section.section_id);
  const references = new Map(template.references.map((item) => [item.reference_id, item]));
  const [lineage, setLineage] = useState<Lineage>({ state: "idle" });

  useEffect(() => {
    setLineage({ state: "idle" });
  }, [section.section_id]);

  async function inspect(claimId: string) {
    setLineage({ state: "loading", claimId });
    try {
      setLineage({ state: "loaded", claimId, chain: await getEvidence(studyId, claimId) });
    } catch (cause) {
      const message = cause instanceof ApiError || cause instanceof Error ? cause.message : "Evidence unavailable.";
      setLineage({ state: "error", claimId, message });
    }
  }

  const sectionNumber = section.section_id.replace(/^S/, "");
  const usedReferenceIds = [...new Set(section.fields.flatMap((field) => field.regulatory_reference_ids))];

  return (
    <Card as="article" className="hx-doc" aria-labelledby="hx-doc-title" data-testid="draft-canvas">
      <Kicker>
        Draft · Section {sectionNumber} · {section.title}
      </Kicker>
      <h2 id="hx-doc-title" className="hx-doc-title">
        {section.title}
      </h2>
      {templateSection?.purpose && <p className="hx-doc-purpose hx-sub">{templateSection.purpose}</p>}

      <div className="hx-doc-body" data-testid="draft-blocks">
        {section.blocks.map((block) =>
          block.kind === "review_marker" ? (
            <div className="hx-flag" key={block.block_id} data-testid={`review-marker-${block.block_id}`}>
              <strong>Needs review · </strong>
              {stripMarker(block.text)}
            </div>
          ) : (
            <div key={block.block_id} className="hx-doc-block">
              <p>{block.text}</p>
              {block.claim_id && (
                <div className="hx-doc-lineage">
                  <Button
                    onClick={() => void inspect(block.claim_id ?? "")}
                    aria-controls="hx-lineage-readout"
                    data-testid={`inspect-provenance-${block.claim_id}`}
                  >
                    Inspect {block.provenance_count} provenance edge{block.provenance_count === 1 ? "" : "s"}
                  </Button>
                  <span className="hx-mono">{block.claim_id}</span>
                </div>
              )}
            </div>
          ),
        )}
      </div>

      <div id="hx-lineage-readout" className="hx-doc-readout" aria-live="polite" data-testid="lineage-readout">
        {lineage.state === "loading" && (
          <span className="hx-mono">
            <Spinner /> Loading evidence for {lineage.claimId}…
          </span>
        )}
        {lineage.state === "error" && (
          <span className="hx-mono" role="alert">
            {lineage.claimId}: {lineage.message}
          </span>
        )}
        {lineage.state === "loaded" && <LineageReadout chain={lineage.chain} />}
      </div>

      {/* Template identity only. The per-field "Required fields and authority" list was removed
          upstream by Steven (per Perk) and is not reintroduced here. */}
      <p className="hx-sub hx-mono" data-testid="template-identity">
        Template {template.template_id} · CTD location {template.ctd_location}
      </p>

      {usedReferenceIds.length > 0 && (
        <section className="hx-doc-refs" aria-labelledby="hx-doc-refs-h" data-testid="regulatory-references">
          <h3 id="hx-doc-refs-h">Regulatory references</h3>
          <p className="hx-sub">
            Context for reviewers only. A cited reference is not a regulatory claim about this synthetic draft.
          </p>
          <ul>
            {usedReferenceIds.map((id) => {
              const reference = references.get(id);
              if (!reference) return null;
              return (
                <li key={id}>
                  <a href={reference.url} target="_blank" rel="noreferrer">
                    {reference.citation}
                  </a>{" "}
                  <span className="hx-sub">
                    {reference.title} · {reference.binding ? "binding" : "non-binding"} {reference.authority.replaceAll("_", " ")}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="hx-sub hx-doc-disclaimer">{template.disclaimer}</p>
        </section>
      )}

      {usedReferenceIds.length === 0 && <p className="hx-sub hx-doc-disclaimer">{template.disclaimer}</p>}

      <AgentState workspace={workspace} />
      <p className="hx-sub hx-mono hx-doc-footer" data-testid="draft-footer">
        {workspace.study.study_id} · Protocol {workspace.study.protocol_version} · Synthetic working draft
      </p>
    </Card>
  );
}

function LineageReadout({ chain }: { chain: EvidenceChainData }) {
  const edges = chain.lineage ?? [];
  return (
    <div className="hx-doc-lineage-list" data-testid="lineage-edges" data-claim={chain.claim.claim_id}>
      <span className="hx-mono">
        {chain.claim.claim_id} · {edges.length} edge{edges.length === 1 ? "" : "s"} · transform{" "}
        {chain.transform_id ?? "none"}
        {chain.transform_version ? `@${chain.transform_version}` : ""}
      </span>
      <ol>
        {edges.map((edge) => (
          <li key={edge.edge_id} className="hx-mono" data-testid={`lineage-edge-${edge.edge_id}`}>
            {edge.source_record_id} → {edge.transform_id}
            {edge.transform_version ? `@${edge.transform_version}` : ""} → {edge.claim_id} · tier {edge.authority_tier}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Candidate, evaluation, promotion, and disposition state from the server, when it exists. */
function AgentState({ workspace }: { workspace: Workspace }) {
  const runs = workspace.section_runs ?? [];
  if (runs.length === 0) return null;
  const latest = runs.at(-1);
  if (!latest) return null;
  const evaluation = (workspace.candidate_evaluations ?? []).find((item) => item.run_id === latest.receipt.run_id);
  const promotion = (workspace.promotion_decisions ?? [])
    .filter((item) => item.candidate_id === latest.candidate.candidate_id)
    .at(-1);
  const draft = (workspace.section_drafts ?? []).find((item) => item.candidate_id === latest.candidate.candidate_id);
  return (
    <section className="hx-doc-agent" aria-labelledby="hx-doc-agent-h" data-testid="section-agent-state">
      <h3 id="hx-doc-agent-h">Section agent state</h3>
      <ul className="hx-mono">
        <li>
          {latest.candidate.section_package_id} · candidate {latest.candidate.candidate_id} · attempt{" "}
          {latest.candidate.attempt}
        </li>
        <li>evaluation {evaluation ? `${evaluation.evaluation_id} · ${evaluation.next_attempt_decision.action}` : "not run"}</li>
        <li>
          promotion{" "}
          {promotion
            ? promotion.eligible
              ? "eligible"
              : `blocked · ${promotion.failed_condition_ids.join(", ")}`
            : "not decided"}
        </li>
        <li>
          draft {draft ? `${draft.draft_id} · ${draft.bound_dispositions.length} bound dispositions` : "not promoted"}
        </li>
      </ul>
    </section>
  );
}

function stripMarker(value: string): string {
  return value.replace("[NEEDS REVIEW: ", "").replace(/\]$/, "");
}
