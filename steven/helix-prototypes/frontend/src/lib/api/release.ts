import type { ApprovalRole, Workspace } from "@/lib/types";

// Lane D (#23): release helpers for Human Gate 3. The server owns every decision (approval
// order, release gate, export); these values are presentation and the fixed demo policy.

export type ApprovalPolicy = {
  role: ApprovalRole;
  label: string;
  /** Plain-language button text for recording this role's sign-off. */
  buttonLabel: string;
  /** Fixed current meaning (4 to 200 chars). #27 replaces these with configured review-flow values. */
  meaning: string;
  /** Synthetic demo identity. Not an authenticated user or e-signature (#27 owns that gap). */
  reviewer: string;
};

export const APPROVAL_POLICY: Record<ApprovalRole, ApprovalPolicy> = {
  pathologist: {
    role: "pathologist",
    buttonLabel: "Sign pathologist review",
    label: "Pathologist review",
    meaning: "Scientific review complete",
    reviewer: "Dr. Avery Pathologist",
  },
  peer_reviewer: {
    role: "peer_reviewer",
    buttonLabel: "Sign peer review",
    label: "Pathologist peer review",
    meaning: "Independent peer review complete",
    reviewer: "Dr. Priya Reviewer",
  },
  qau: {
    role: "qau",
    buttonLabel: "Sign QAU statement",
    label: "QAU statement",
    meaning: "Quality assurance statement recorded",
    reviewer: "Morgan QA",
  },
  study_director: {
    role: "study_director",
    buttonLabel: "Sign study director approval",
    label: "Study director approval",
    meaning: "Final report approval",
    reviewer: "Dr. Sam Director",
  },
};

/** Any order among these three; the server requires all three before the study director. */
export const PRIOR_APPROVAL_ROLES: ApprovalRole[] = ["pathologist", "peer_reviewer", "qau"];
export const APPROVAL_ORDER: ApprovalRole[] = [...PRIOR_APPROVAL_ROLES, "study_director"];

export type ExportArtifact = Workspace["export_artifacts"][number];

export function artifactLabel(kind: string): string {
  return (
    {
      pinned_run: "Pinned run manifest",
      data_validation_receipt: "Data validation receipt",
      section_draft_candidate: "Section draft candidate",
      section_draft: "Section draft",
      study_report_pdf: "Completed study report (PDF)",
      send_dataset_package: "Illustrative dataset archive (ZIP)",
      define_xml: "Illustrative define.xml",
      nsdrg: "Synthetic nSDRG (PDF)",
    }[kind] ?? kind.replaceAll("_", " ")
  );
}

export type ArtifactProbe = { mediaType: string | null; bytes: number };

/**
 * Reads the server artifact once to report its media type from the download response's
 * Content-Type (never inferred from the kind). Pass `artifactDownloadUrl(...)`; only for
 * exported artifacts.
 */
export async function probeArtifact(downloadUrl: string): Promise<ArtifactProbe> {
  const response = await fetch(downloadUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Artifact download returned HTTP ${response.status}`);
  }
  const body = await response.arrayBuffer();
  return { mediaType: response.headers.get("Content-Type"), bytes: body.byteLength };
}
