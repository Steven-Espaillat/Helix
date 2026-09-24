// Reference fixture data for the parity kit ONLY (tests/parity).
// Copied verbatim from research/helix-e2e-workbench-v1.html (STAGES, FILES).
// Never import this from production code: production renders server state.

export const REFERENCE_STAGES = [
  { short: "Upload", name: "Upload and authorize inputs", gate: 1 },
  { short: "Parse", name: "Parse protocol, template and source data" },
  { short: "Resolve", name: "Resolve study type and pattern" },
  { short: "Extract", name: "Deterministic extraction" },
  { short: "Validate", name: "Deterministic validation" },
  { short: "Draft", name: "Structured section drafting" },
  { short: "Provenance", name: "Compile provenance" },
  { short: "Gates", name: "Traceability review", gate: 2 },
  { short: "Review & export", name: "Review, sign and export", gate: 3 },
] as const;

export const REFERENCE_FILES = [
  ["Protocol_HLX-028_v3.pdf", "PDF", "Protocol"],
  ["Sponsor_report_template_v5.docx", "DOCX", "Report template"],
  ["LIMS_body_weight.csv", "CSV", "Source data \u00b7 BW"],
  ["LIMS_clinical_observations.csv", "CSV", "Source data \u00b7 CL"],
  ["LIMS_food_consumption.csv", "CSV", "Source data \u00b7 FW"],
  ["Organ_weights.xlsx", "XLSX", "Source data \u00b7 OM"],
  ["Pathology_MI_findings.xlsx", "XLSX", "Pathology"],
  ["Formulation_analysis.pdf", "PDF", "Formulation"],
  ["Statistics_output.xlsx", "XLSX", "Statistics"],
  ["Report_pattern_P-28D-05.docx", "DOCX", "Approved pattern"],
] as const;
