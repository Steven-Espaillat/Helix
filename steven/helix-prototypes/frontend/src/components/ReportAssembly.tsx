"use client";

import { useMemo, useState } from "react";

import { artifactDownloadUrl } from "@/lib/api";
import type { ApprovalRole, ValidationResult, Workspace } from "@/lib/types";

type Props = {
  workspace: Workspace;
  busy: string | null;
  onInspectClaim: (claimId: string) => void;
  onResolve: (resultId: string, message: string) => void;
  onApprove: (role: ApprovalRole) => void;
  onFinalStudyApproval: () => void;
  onExport: () => void;
};

const approvalOrder: ApprovalRole[] = [
  "pathologist",
  "peer_reviewer",
  "qau",
  "study_director",
];

export function ReportAssembly({
  workspace,
  busy,
  onInspectClaim,
  onResolve,
  onApprove,
  onFinalStudyApproval,
  onExport,
}: Props) {
  const [selectedSectionId, setSelectedSectionId] = useState("S7");
  const section =
    workspace.report.sections.find((item) => item.section_id === selectedSectionId) ??
    workspace.report.sections[0];
  const referenceMap = useMemo(
    () =>
      new Map(
        workspace.report.template.references.map((reference) => [
          reference.reference_id,
          reference,
        ]),
      ),
    [workspace.report.template.references],
  );
  const latestDispositions = latestDispositionMap(workspace);
  const blockingResults = workspace.validations.filter(
    (result) => result.status === "fail" && result.severity === "blocker",
  );
  const openBlockers = blockingResults.filter(
    (result) => !isResolved(latestDispositions.get(result.result_id)?.decision),
  );
  const approvalRoles = new Set(workspace.approvals.map((approval) => approval.role));
  const priorApprovalRoles: ApprovalRole[] = ["pathologist", "peer_reviewer", "qau"];
  const priorHumanApprovalsComplete = priorApprovalRoles.every((role) => approvalRoles.has(role));

  return (
    <section className="view-content report-view" aria-labelledby="report-heading">
      <div className="view-intro report-intro">
        <div>
          <p className="eyebrow">Sponsor template with regulatory anchors</p>
          <h2 id="report-heading">Assemble the report without hiding the gaps.</h2>
          <p>
            The template maps 37 required fields to 21 CFR 58.185 or OECD TG 407. It is a sponsor
            working structure, not an FDA-issued document template.
          </p>
        </div>
        <div className="template-identity">
          <div>
            <span>Template</span>
            <strong>{workspace.report.template.template_id}</strong>
          </div>
          <div>
            <span>CTD location</span>
            <strong>{workspace.report.template.ctd_location}</strong>
          </div>
        </div>
      </div>

      <div className="report-layout">
        <aside className="panel report-sections" aria-label="Report sections">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">Report navigator</p>
              <h3>Eight sections</h3>
            </div>
          </div>
          <div className="section-list">
            {workspace.report.sections.map((item, index) => {
              const issueCount = openBlockers.filter(
                (result) => scopeSection(result, workspace) === item.section_id,
              ).length;
              return (
                <button
                  key={item.section_id}
                  type="button"
                  className={item.section_id === section.section_id ? "section-button active" : "section-button"}
                  onClick={() => setSelectedSectionId(item.section_id)}
                >
                  <span className="section-number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="section-label">
                    <strong>{item.title}</strong>
                    <small>{item.required_field_count} required fields</small>
                  </span>
                  <span className={`section-state ${issueCount ? "issue" : item.status}`}>
                    {issueCount ? `${issueCount} issue${issueCount > 1 ? "s" : ""}` : item.status.replaceAll("_", " ")}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="template-note">
            <strong>Template boundary</strong>
            <p>{workspace.report.template.disclaimer}</p>
          </div>
        </aside>

        <div className="report-center-column">
          <article className="panel report-paper">
            <header className="report-paper-header">
              <div>
                <p className="eyebrow">Draft section {section.section_id.slice(1)}</p>
                <h3>{section.title}</h3>
              </div>
              <span className={`document-status ${section.status}`}>{section.status.replaceAll("_", " ")}</span>
            </header>
            <div className="report-rule" />
            <p className="report-purpose">
              {
                workspace.report.template.sections.find(
                  (templateSection) => templateSection.section_id === section.section_id,
                )?.purpose
              }
            </p>
            <div className="report-blocks">
              {section.blocks.map((block) => (
                <div className={`report-block ${block.kind}`} key={block.block_id}>
                  {block.kind === "review_marker" && <span className="marker-label">Needs review</span>}
                  <p>{stripMarker(block.text)}</p>
                  {block.claim_id && (
                    <button
                      type="button"
                      className="lineage-button"
                      onClick={() => onInspectClaim(block.claim_id ?? "")}
                    >
                      Inspect {block.provenance_count} provenance edges
                    </button>
                  )}
                </div>
              ))}
            </div>
            {section.blocks.length === 0 && (
              <div className="empty-copy">No draft blocks exist for this section.</div>
            )}
            <footer className="report-paper-footer">
              <span>{workspace.study.study_id}</span>
              <span>Protocol {workspace.study.protocol_version}</span>
              <span>Synthetic working draft</span>
            </footer>
          </article>

          <article className="panel field-matrix">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Structured output contract</p>
                <h3>Required fields and authority</h3>
              </div>
              <span className="count-chip">{section.fields.length}</span>
            </div>
            <div className="field-list">
              {section.fields.map((field) => (
                <div className="field-row" key={field.field_id}>
                  <div className="field-status-icon">{field.required ? "R" : "O"}</div>
                  <div className="field-main">
                    <strong>{field.label}</strong>
                    <span>{field.source_expectation}</span>
                  </div>
                  <div className="field-grain">
                    <span>Expected grain</span>
                    <code>{field.expected_grain}</code>
                  </div>
                  <div className="field-references">
                    {field.regulatory_reference_ids.map((referenceId) => {
                      const reference = referenceMap.get(referenceId);
                      return reference ? (
                        <a
                          href={reference.url}
                          target="_blank"
                          rel="noreferrer"
                          key={reference.reference_id}
                        >
                          {reference.citation}
                        </a>
                      ) : null;
                    })}
                  </div>
                  {field.human_judgment && <span className="human-chip">Human judgment</span>}
                </div>
              ))}
            </div>
          </article>
        </div>

        <aside className="release-column">
          <section className="panel release-card">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Release controls</p>
                <h3>Human gate</h3>
              </div>
              <span className={`gate-badge ${workspace.release_gate.status}`}>
                {workspace.release_gate.status.replaceAll("_", " ")}
              </span>
            </div>
            <div className="gate-progress">
              <div>
                <span>Blocking checks</span>
                <strong>
                  {blockingResults.length - openBlockers.length}/{blockingResults.length}
                </strong>
              </div>
              <div className="progress-track">
                <span
                  style={{
                    width: `${blockingResults.length ? ((blockingResults.length - openBlockers.length) / blockingResults.length) * 100 : 100}%`,
                  }}
                />
              </div>
            </div>
            <div className="blocker-list" data-testid="blocker-list">
              {blockingResults.map((result) => {
                const disposition = latestDispositions.get(result.result_id);
                const resolved = isResolved(disposition?.decision);
                return (
                  <div className={resolved ? "blocker resolved" : "blocker"} key={result.result_id}>
                    <div className="blocker-top">
                      <span>{resolved ? "Resolved" : "Open"}</span>
                      <code>{result.result_id}</code>
                    </div>
                    <strong>{humanize(result.rule_id)}</strong>
                    <p>{result.message}</p>
                    {resolved ? (
                      <small>
                        {disposition?.decision.replaceAll("_", " ")} by {disposition?.reviewer}
                      </small>
                    ) : (
                      <button
                        className="button secondary small"
                        type="button"
                        disabled={busy !== null}
                        onClick={() => onResolve(result.result_id, result.message)}
                      >
                        {busy === result.result_id ? "Recording…" : "Record synthetic disposition"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {blockingResults.length === 0 && (
              <p className="empty-copy">Run hybrid validation to create the current gate record.</p>
            )}
          </section>

          <section className="panel approval-card">
            <div className="panel-heading compact">
              <div>
                <p className="eyebrow">Required records</p>
                <h3>Review and approval</h3>
              </div>
              <span className="count-chip">{approvalRoles.size}/4</span>
            </div>
            <div className="approval-list">
              {approvalOrder.map((role, index) => {
                const approval = [...workspace.approvals]
                  .reverse()
                  .find((item) => item.role === role);
                const directorBlocked = role === "study_director" && !priorHumanApprovalsComplete;
                return (
                  <div className={approval ? "approval-row complete" : "approval-row"} key={role}>
                    <span className="approval-index">{index + 1}</span>
                    <div>
                      <strong>{approvalLabel(role)}</strong>
                      <span>{approval ? `${approval.reviewer} · recorded` : approvalDetail(role)}</span>
                    </div>
                    {approval ? (
                      <span className="approval-check">✓</span>
                    ) : (
                      <button
                        type="button"
                        className="text-button"
                        disabled={openBlockers.length > 0 || directorBlocked || busy !== null}
                        onClick={() => onApprove(role)}
                      >
                        {busy === role ? "Recording…" : "Record"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel approval-card" data-testid="final-study-approval-scope">
            <div className="panel-heading compact">
              <div>
                <p className="eyebrow">Hash-bound record</p>
                <h3>Final Study Approval</h3>
              </div>
              <span
                className="count-chip"
                data-testid="approval-current"
              >
                {workspace.approval_current
                  ? "current"
                  : workspace.final_study_approval
                    ? "stale"
                    : "ready for signature"}
              </span>
            </div>
            <p>
              Approval applies only to the exact release-candidate manifest and included artifact
              hashes. Language stays at ready for signature / ready for export — never a regulator
              approval claim.
            </p>
            {workspace.release_candidate && (
              <div className="artifact-list">
                <div>
                  <strong>Manifest</strong>
                  <code data-testid="approval-manifest-hash">
                    {workspace.final_study_approval?.manifest_hash
                      ?? workspace.release_candidate.content_hash}
                  </code>
                </div>
                {(workspace.final_study_approval?.included_artifact_hashes
                  ?? workspace.release_candidate.included_artifacts
                ).map((item) => (
                  <div key={item.artifact_id}>
                    <strong>{item.artifact_id}</strong>
                    <code data-testid={`approval-artifact-${item.artifact_id}`}>
                      {item.content_hash}
                    </code>
                  </div>
                ))}
              </div>
            )}
            {workspace.approval_current ? (
              <span className="approval-check">✓</span>
            ) : (
              <button
                type="button"
                className="text-button"
                data-testid="record-final-study-approval"
                disabled={
                  !priorHumanApprovalsComplete
                  || !approvalRoles.has("study_director")
                  || openBlockers.length > 0
                  || busy !== null
                  || workspace.release_candidate == null
                }
                onClick={onFinalStudyApproval}
              >
                {busy === "final-study-approval" ? "Recording…" : "Record Final Study Approval"}
              </button>
            )}
          </section>

          <section className="panel export-card">
            <p className="eyebrow">Explicit action</p>
            <h3>Approved artifact export</h3>
            <div className="artifact-list">
              {workspace.export_artifacts.map((artifact) => (
                <div key={artifact.artifact_id}>
                  <span className={`artifact-icon ${artifact.status}`}>
                    {artifact.status === "exported" ? "✓" : ""}
                  </span>
                  <div>
                    {artifact.status === "exported" ? (
                      <a
                        className="artifact-download"
                        href={artifactDownloadUrl(workspace.study.study_id, artifact.artifact_id)}
                        download
                      >
                        <strong>{artifactLabel(artifact.kind)}</strong>
                        <code data-testid={`export-checksum-${artifact.artifact_id}`}>
                          Download · {artifact.checksum}
                        </code>
                      </a>
                    ) : (
                      <>
                        <strong>{artifactLabel(artifact.kind)}</strong>
                        <code>{artifact.path}</code>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <button
              className="button primary wide"
              type="button"
              disabled={workspace.release_gate.status !== "ready_for_export" || busy !== null}
              onClick={onExport}
              data-testid="export-package"
            >
              {workspace.release_gate.status === "exported"
                ? "Approved artifacts exported"
                : busy === "export"
                  ? "Exporting approved hashes…"
                  : "Export approved artifacts"}
            </button>
            <p className="fine-print">
              Export packages only Final Study Approval hashes. Status language stays at exported —
              never a regulator approval claim.
            </p>
          </section>
        </aside>
      </div>
    </section>
  );
}

function latestDispositionMap(workspace: Workspace) {
  const map = new Map<string, Workspace["dispositions"][number]>();
  for (const disposition of workspace.dispositions) {
    map.set(disposition.result_id, disposition);
  }
  return map;
}

function isResolved(decision: string | undefined): boolean {
  return ["corrected", "explained_in_nsdrg", "approved_exception"].includes(decision ?? "");
}

function scopeSection(result: ValidationResult, workspace: Workspace): string | null {
  if (result.scope_id.startsWith("S")) {
    return result.scope_id;
  }
  return workspace.claims.find((claim) => claim.claim_id === result.scope_id)?.section_id ?? null;
}

function humanize(value: string): string {
  return value.replaceAll("-", " ");
}

function stripMarker(value: string): string {
  return value.replace("[NEEDS REVIEW: ", "").replace("]", "");
}

function approvalLabel(role: ApprovalRole): string {
  return {
    pathologist: "Pathologist review",
    peer_reviewer: "Independent peer review",
    qau: "Quality Assurance Unit statement",
    study_director: "Study director approval",
  }[role];
}

function approvalDetail(role: ApprovalRole): string {
  return {
    pathologist: "Scientific findings and dispositions",
    peer_reviewer: "Independent pathology assessment",
    qau: "Inspection dates and report statement",
    study_director: "Final approval meaning and responsibility",
  }[role];
}

function artifactLabel(kind: string): string {
  return {
    pinned_run: "Pinned run manifest",
    data_validation_receipt: "Data validation receipt",
    section_draft_candidate: "Section draft candidate",
    section_draft: "Section draft",
    study_report_pdf: "Study report PDF",
    send_dataset_package: "Illustrative dataset archive",
    define_xml: "Illustrative define.xml",
    nsdrg: "Synthetic nSDRG PDF",
  }[kind] ?? kind;
}
