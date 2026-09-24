from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal, NewType

from pydantic import BaseModel, ConfigDict, Field

StudyId = Annotated[str, Field(pattern=r"^STUDY-[A-Z0-9-]+$")]
ClaimId = Annotated[str, Field(pattern=r"^C-[A-Z0-9-]+$")]
ValidationResultId = Annotated[str, Field(pattern=r"^VR-[A-Z0-9-]+$")]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


Sha256 = Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
SkillDocumentHash = NewType("SkillDocumentHash", str)
SkillReferencesHash = NewType("SkillReferencesHash", str)


class ManifestEntry(StrictModel):
    artifact_id: str
    kind: str
    name: str
    version: str
    authority_tier: int = Field(ge=1, le=6)
    checksum: str
    locked: bool
    authorized_by: str


class DoseGroup(StrictModel):
    group_id: str
    label: str
    dose: float
    study_id: str
    dose_unit: str
    sexes: list[Literal["M", "F"]]
    planned_n_per_sex: int = Field(gt=0)


class Study(StrictModel):
    study_id: StudyId
    study_type_id: str
    species: str
    route: str
    duration_days: int = Field(gt=0)
    study_start: str
    protocol_version: str
    dose_groups: list[DoseGroup]


class Animal(StrictModel):
    animal_id: str
    study_id: str
    group_id: str
    sex: Literal["M", "F"]
    randomization_id: str


class Measurement(StrictModel):
    record_id: str
    domain: str
    animal_id: str | None = None
    group_id: str | None = None
    timepoint: str
    test_code: str
    value: float | str
    unit: str | None
    grain: str
    source_pointer: str


class MicroscopicFinding(StrictModel):
    finding_id: str
    domain: Literal["MI"]
    animal_id: str
    tissue: str
    finding: str
    severity: str
    controlled_term: str
    source_pointer: str


class StudyRecords(StrictModel):
    animals: list[Animal]
    body_weights: list[Measurement]
    clinical_observations: list[Measurement]
    food_consumption: list[Measurement]
    organ_weights: list[Measurement]
    microscopic_findings: list[MicroscopicFinding]
    formulation: list[Measurement]


class SectionStatus(StrEnum):
    VALIDATED = "validated"
    NEEDS_REVIEW = "needs_review"
    REVIEWED = "reviewed"


class ReportSection(StrictModel):
    section_id: str
    template_id: str
    title: str
    required_fields: int
    status: SectionStatus


class ClaimStatus(StrEnum):
    PENDING = "pending"
    VALIDATED = "validated"
    NEEDS_REVIEW = "needs_review"
    APPROVED = "approved"


class Claim(StrictModel):
    claim_id: ClaimId
    section_id: str
    field_id: str
    value: float | None
    unit: str
    grain: str
    status: ClaimStatus
    claim_type: str | None = None
    grain_key: dict[str, str] = Field(default_factory=dict)
    source_hashes: list[str] = Field(default_factory=list)
    transform_id: str | None = None
    transform_version: str | None = None
    rule_versions: dict[str, str] = Field(default_factory=dict)
    package_id: str | None = None
    package_version: str | None = None
    executor_id: str | None = None
    executor_version: str | None = None


class ProvenanceEdge(StrictModel):
    edge_id: str
    claim_id: str
    source_record_id: str
    transform_id: str
    source_pointer: str
    authority_tier: int = Field(ge=1, le=6)
    source_hash: str | None = None
    transform_version: str | None = None


class ValidationStatus(StrEnum):
    PASS = "pass"
    WARN = "warn"
    FAIL = "fail"
    SKIPPED = "skipped"


class ValidationKind(StrEnum):
    DETERMINISTIC = "deterministic"
    AGENT_PLANNED = "agent_planned"


class ValidationResult(StrictModel):
    result_id: ValidationResultId
    rule_id: str
    scope_id: str
    severity: Literal["info", "warning", "blocker"]
    status: ValidationStatus
    evidence_ids: list[str]
    message: str
    rule_version: str
    kind: ValidationKind = ValidationKind.DETERMINISTIC
    tool_name: str | None = None
    enforcement_class: Literal["hard_blocker", "review_required", "warning"] | None = None
    waivable: bool | None = None
    package_id: str | None = None
    executor_id: str | None = None


class DispositionDecision(StrEnum):
    OPEN = "open"
    CORRECTED = "corrected"
    EXPLAINED_IN_NSDRG = "explained_in_nsdrg"
    APPROVED_EXCEPTION = "approved_exception"
    REJECTED = "rejected"


RESOLVED_DISPOSITIONS = frozenset(
    {
        DispositionDecision.CORRECTED,
        DispositionDecision.EXPLAINED_IN_NSDRG,
        DispositionDecision.APPROVED_EXCEPTION,
    }
)


class ReviewDisposition(StrictModel):
    disposition_id: str
    result_id: str
    decision: DispositionDecision
    reason: str | None
    reviewer: str | None
    timestamp: str | None
    artifact_id: str | None = None
    artifact_hash: Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")] | None = None
    dependency_fingerprint: Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")] | None = None


class ApprovalRole(StrEnum):
    PATHOLOGIST = "pathologist"
    PEER_REVIEWER = "peer_reviewer"
    QAU = "qau"
    STUDY_DIRECTOR = "study_director"


class Approval(StrictModel):
    approval_id: str
    role: ApprovalRole
    reviewer: str
    meaning: str
    timestamp: str
    artifact_hash: Sha256 | None = None
    dependency_fingerprint: Sha256 | None = None


class GateStatus(StrEnum):
    BLOCKED = "blocked"
    READY_FOR_REVIEW = "ready_for_review"
    READY_FOR_SIGNATURE = "ready_for_signature"
    READY_FOR_EXPORT = "ready_for_export"
    EXPORTED = "exported"


class GateDecision(StrictModel):
    gate_id: str
    gate_type: Literal["section", "release"]
    status: GateStatus
    blocking_result_ids: list[str]
    decided_at: str


class ExportArtifact(StrictModel):
    artifact_id: str
    kind: str
    path: str
    checksum: str | None
    status: Literal["pending", "exported"]


class WorkflowEvent(StrictModel):
    event_id: str
    event: str
    actor: str
    timestamp: str
    outcome: str
    details: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


class RetrievalIndexEntry(StrictModel):
    chunk_id: str
    study_id: StudyId
    study_type_id: str
    artifact_id: str
    artifact_version: str
    source_kind: str
    authority_tier: int = Field(ge=1, le=6)
    report_section_id: str
    grain: str
    lock_manifest_id: str


class StudyEvidencePackage(StrictModel):
    package_id: str
    label: Literal["SYNTHETIC / NOT FOR SUBMISSION"]
    workflow_state: str
    manifest: list[ManifestEntry]
    study: Study
    records: StudyRecords
    report_sections: list[ReportSection]
    claims: list[Claim]
    provenance_edges: list[ProvenanceEdge]
    validation_results: list[ValidationResult]
    review_dispositions: list[ReviewDisposition]
    approvals: list[Approval] = Field(default_factory=list)
    gate_decisions: list[GateDecision]
    export_artifacts: list[ExportArtifact]
    retrieval_index: list[RetrievalIndexEntry]
    events: list[WorkflowEvent]
    pinned_run: "PinnedRun | None" = None
    data_validation_executions: list["DataValidationExecution"] = Field(default_factory=list)
    review_scaffold_revisions: list[dict[str, object]] = Field(default_factory=list)
    superseded_pinned_runs: list["PinnedRun"] = Field(default_factory=list)
    predecessor_snapshots: list["PredecessorSnapshot"] = Field(default_factory=list)
    superseding_run_receipt: "SupersedingRunReceipt | None" = None
    frozen_inputs: "FrozenRunInputs | None" = None
    release_candidate: "ReleaseCandidate | None" = None
    final_study_approval: "FinalStudyApproval | None" = None


class PlannerMode(StrEnum):
    FIXTURE = "fixture"
    OPENAI_COMPATIBLE = "openai_compatible"


class DataValidationCommand(StrictModel):
    actor: str = Field(min_length=2, max_length=120)
    idempotency_key: str = Field(min_length=8, max_length=160)
    package_id: str = Field(default="validation.body_weight", min_length=1, max_length=120)


class DataValidationRuleResult(StrictModel):
    result_id: ValidationResultId
    rule_id: str
    rule_version: str
    enforcement_class: Literal["hard_blocker", "review_required", "warning"]
    status: ValidationStatus
    scope_id: str
    evidence_ids: list[str]
    message: str
    waivable: bool
    package_id: str
    executor_id: str


class SectionClaimReference(StrictModel):
    section_id: str
    section_package_id: str
    title: str
    claim_id: ClaimId
    executor_receipt_id: str


class DataValidationReceipt(StrictModel):
    receipt_id: str
    run_id: str
    package_id: str
    package_version: str
    package_hash: Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
    node_id: str
    executor_id: str
    executor_version: str
    executor_hash: Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
    rule_bundle_id: str
    rule_ids: list[str]
    source_artifact_id: str
    source_hash: str
    governed_versions: dict[str, str]
    input_fingerprint: Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
    claim_ids: list[str]
    result_ids: list[str]
    event_id: str
    status: Literal["passed", "blocked"]
    idempotent_replay: bool = False


class DataValidationExecution(StrictModel):
    receipt: DataValidationReceipt
    claims: list[Claim]
    results: list[DataValidationRuleResult]
    provenance_edges: list[ProvenanceEdge]
    section_references: list[SectionClaimReference]
    event: WorkflowEvent


class ValidationRequest(StrictModel):
    planner: PlannerMode = PlannerMode.FIXTURE


class ValidationRun(StrictModel):
    run_id: str
    study_id: str
    planner: PlannerMode
    llm_used: bool
    planner_label: str
    rule_bundle_version: str
    results: list[ValidationResult]
    created_at: datetime


class DispositionCommand(StrictModel):
    decision: Literal[
        DispositionDecision.CORRECTED,
        DispositionDecision.EXPLAINED_IN_NSDRG,
        DispositionDecision.APPROVED_EXCEPTION,
    ]
    reason: str = Field(min_length=8, max_length=500)
    reviewer: str = Field(min_length=2, max_length=120)


class ApprovalCommand(StrictModel):
    role: ApprovalRole
    reviewer: str = Field(min_length=2, max_length=120)
    meaning: str = Field(min_length=4, max_length=200)


class FinalStudyApprovalCommand(StrictModel):
    reviewer: str = Field(min_length=2, max_length=120)
    idempotency_key: str = Field(min_length=8, max_length=160)


class IncludedArtifact(StrictModel):
    artifact_id: str = Field(min_length=1)
    kind: Literal[
        "pinned_run",
        "section_draft_candidate",
        "section_draft",
        "data_validation_receipt",
    ]
    content_hash: Sha256


class DraftingCycleRef(StrictModel):
    section_package_id: str = Field(min_length=1)
    cycle_id: Annotated[str, Field(pattern=r"^CYCLE-[A-Z0-9-]+$")]


class ReleaseCandidate(StrictModel):
    schema_version: Literal["helix.release-candidate/v1"]
    status: Literal["release_candidate"]
    export_eligible: Literal[True]
    run_id: str = Field(min_length=1)
    study_id: str = Field(min_length=1)
    included_artifacts: list[IncludedArtifact] = Field(min_length=1)
    current_drafting_cycles: list[DraftingCycleRef]
    content_hash: Sha256


class ApprovedArtifactHash(StrictModel):
    artifact_id: str = Field(min_length=1)
    content_hash: Sha256


class FinalStudyApproval(StrictModel):
    schema_version: Literal["helix.final-study-approval/v1"]
    approval_id: Annotated[str, Field(pattern=r"^FSA-[A-Z0-9-]+$")]
    run_id: str = Field(min_length=1)
    study_id: str = Field(min_length=1)
    reviewer: str = Field(min_length=2, max_length=120)
    recorded_at: str
    manifest_hash: Sha256
    included_artifact_hashes: list[ApprovedArtifactHash] = Field(min_length=1)
    idempotency_key: str = Field(min_length=8, max_length=160)


class ExportCommand(StrictModel):
    actor: str = Field(min_length=2, max_length=120)
    idempotency_key: str = Field(min_length=8, max_length=120)


class RegulatoryReference(StrictModel):
    reference_id: str
    title: str
    citation: str
    url: str
    authority: Literal["regulation", "guidance", "standard", "test_guideline"]
    binding: bool


class TemplateTableShape(StrictModel):
    grain: str
    row_axis: str
    column_axis: str
    value_columns: list[str] = Field(min_length=1)


class TemplateStyleConstraints(StrictModel):
    decimal_places: int = Field(ge=0, le=6)
    unit_display: str
    forbidden_terms: list[str] = Field(default_factory=list)


class ReportFieldTemplate(StrictModel):
    field_id: str
    label: str
    required: bool
    expected_grain: str
    human_judgment: bool
    source_expectation: str
    regulatory_reference_ids: list[str]
    location: str | None = None
    unit: str | None = None
    table_shape: TemplateTableShape | None = None
    style_constraints: TemplateStyleConstraints | None = None


class ReportSectionTemplate(StrictModel):
    section_id: str
    title: str
    purpose: str
    fields: list[ReportFieldTemplate]


class ReportTemplate(StrictModel):
    template_id: str
    name: str
    version: str
    study_type_id: str
    ctd_location: str
    disclaimer: str
    references: list[RegulatoryReference]
    sections: list[ReportSectionTemplate]


class ReportBlock(StrictModel):
    block_id: str
    kind: Literal["paragraph", "claim", "review_marker"]
    text: str
    claim_id: str | None = None
    provenance_count: int = 0


class AssembledSection(StrictModel):
    section_id: str
    title: str
    status: SectionStatus
    required_field_count: int
    fields: list[ReportFieldTemplate]
    blocks: list[ReportBlock]


class ReportAssembly(StrictModel):
    template: ReportTemplate
    sections: list[AssembledSection]


class SourceRecord(StrictModel):
    record_id: str
    domain: str
    source_pointer: str
    value: float | str
    unit: str | None
    grain: str
    attributes: dict[str, str | int | float | None]


class EvidenceChain(StrictModel):
    claim: Claim
    sources: list[SourceRecord]
    transform_id: str | None
    recomputed_value: float | None
    exact_match: bool | None
    validations: list[ValidationResult]
    report_text: str
    source_hashes: list[str] = Field(default_factory=list)
    transform_version: str | None = None
    rule_versions: dict[str, str] = Field(default_factory=dict)
    lineage: list[ProvenanceEdge] = Field(default_factory=list)


class Stage(StrictModel):
    stage_id: str
    name: str
    owner: Literal["agent", "human", "hybrid"]
    status: Literal["complete", "current", "blocked", "pending"]
    summary: str
    input_title: str
    input_detail: str
    output_title: str
    output_detail: str
    boundary: str
    checks: list[str]


class WorkspaceSummary(StrictModel):
    record_count: int
    source_count: int
    provenance_count: int
    blocker_count: int
    resolved_blocker_count: int
    section_count: int


class PlannerCapability(StrictModel):
    mode: PlannerMode
    available: bool
    label: str
    detail: str


class StudyListItem(StrictModel):
    study_id: str
    study_type_id: str
    title: str
    workflow_state: str
    release_status: GateStatus
    label: str


class SupersessionRef(StrictModel):
    predecessor_run_id: str = Field(min_length=1, max_length=80)
    reason: str = Field(min_length=8, max_length=240)


class FreezeRunCommand(StrictModel):
    actor: str = Field(min_length=2, max_length=120)
    idempotency_key: str = Field(min_length=8, max_length=160)
    supersession: SupersessionRef | None = None


class PlanningEvidence(StrictModel):
    code: str
    subject: str
    message: str


class GovernedArtifact(StrictModel):
    kind: str
    artifact_id: str
    version: str
    path: str
    content_hash: Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]


class StudyTypeResolution(StrictModel):
    status: Literal["resolved", "needs_review"]
    study_type_id: str | None
    mapping_version: str
    mapping_hash: Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
    protocol_fields: dict[str, str | int]
    evidence: list[PlanningEvidence]


class RunPlanNode(StrictModel):
    node_id: str
    node_type: Literal[
        "parse",
        "study_type_resolution",
        "data_validation",
        "template_contract",
        "section_agent",
        "provenance",
        "study_output_evaluation",
        "template_conformance",
        "section_promotion",
        "review_scaffold",
    ]
    package_id: str | None = None
    package_version: str | None = None
    depends_on: list[str]
    input_fingerprint: Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
    status: Literal["pending", "blocked"]
    evidence: list[PlanningEvidence]


class RunPlan(StrictModel):
    schema_version: Literal["helix.run-plan/v1"]
    run_plan_id: str
    run_id: str
    version: int = Field(ge=1)
    fingerprint: Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
    created_at: str
    manifest_hash: Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
    governed_versions: dict[str, str]
    nodes: list[RunPlanNode]


class RunReceipt(StrictModel):
    receipt_id: str
    run_id: str
    manifest_hash: Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
    run_plan_fingerprint: Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
    governed_inputs_fingerprint: Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
    event_id: str


class PinnedRun(StrictModel):
    run_id: str
    study_id: str
    status: Literal["planned", "needs_review"]
    created_at: str
    manifest_hash: Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
    governed_inputs: list[GovernedArtifact]
    study_type_resolution: StudyTypeResolution
    run_plan: RunPlan
    receipt: RunReceipt
    event_history: list[WorkflowEvent]
    predecessor_run_id: str | None = None
    supersession_reason: str | None = None


class SectionRunCommand(StrictModel):
    section_package_id: str = Field(min_length=1, max_length=120)
    idempotency_key: str = Field(min_length=8, max_length=160)


class HumanDirectedRevisionCommand(StrictModel):
    section_package_id: str = Field(min_length=1, max_length=120)
    actor: str = Field(min_length=2, max_length=120)
    idempotency_key: str = Field(min_length=8, max_length=160)


class TemplateContractGateResult(StrictModel):
    gate_id: str
    section_package_id: str
    result_id: str
    status: Literal["passed", "blocked"]
    enforcement_class: Literal["hard_blocker"]
    waivable: Literal[False]
    check_kind: Literal["fields", "locations", "table_shapes", "labels", "units", "style_constraints"]
    message: str


class SectionImpactSet(StrictModel):
    origin_section_package_id: str
    direct: list[str]
    transitive: list[str]


class DraftingCycle(StrictModel):
    schema_version: Literal["helix.drafting-cycle/v1"]
    cycle_id: Annotated[str, Field(pattern=r"^CYCLE-[A-Z0-9-]+$")]
    run_id: str
    section_package_id: str
    predecessor_cycle_id: Annotated[str, Field(pattern=r"^CYCLE-[A-Z0-9-]+$")] | None
    max_attempts: Literal[3]
    impact_set: SectionImpactSet
    opened_at: str
    opened_by: str
    triggering_event_id: str


class HumanDirectedRevisionReceipt(StrictModel):
    cycle: DraftingCycle
    stale_disposition_ids: list[str]
    stale_approval_ids: list[str]
    review_scaffold_revision: int
    idempotent_replay: bool = False


class SectionRunEligibility(StrictModel):
    section_package_id: str
    eligible: bool
    reasons: list[str]
    gate_results: list[TemplateContractGateResult]
    impact_set: SectionImpactSet


class CodexAgentReceipt(StrictModel):
    runtime: Literal["codex_sdk"]
    thread_id: str
    skill_name: Literal["helix-section-agent"]
    skill_hash: Sha256
    skill_references_hash: Sha256


class SectionDraftCandidate(StrictModel):
    schema_version: Literal["helix.section-draft-candidate/v1"]
    status: Literal["section_draft_candidate"]
    candidate_id: Annotated[str, Field(pattern=r"^SDC-[A-Z0-9-]+$")]
    run_id: str
    section_id: str
    section_package_id: str
    section_package_version: str
    drafting_cycle_id: str
    attempt: int = Field(ge=1, le=3)
    validated_claim_ids: list[str] = Field(min_length=1)
    content_blocks: list[dict[str, object]] = Field(min_length=1)
    executor_receipt_ids: list[str]
    agent_receipt: CodexAgentReceipt


class SectionRunReceipt(StrictModel):
    run_id: str
    section_id: str
    section_package_id: str
    status: Literal["candidate_recorded"]
    candidate_id: str
    candidate_hash: str
    envelope_hash: str
    agent_runtime: Literal["codex_sdk"]
    codex_thread_id: str
    skill_name: Literal["helix-section-agent"]
    skill_hash: Sha256
    skill_references_hash: Sha256
    review_scaffold_revision: int
    idempotent_replay: bool = False


class StoredSectionRun(StrictModel):
    receipt: SectionRunReceipt
    candidate: SectionDraftCandidate
    envelope: dict[str, object]
    review_scaffold: dict[str, object]


class CandidateEvaluationCommand(StrictModel):
    idempotency_key: str = Field(min_length=8, max_length=160)


class CrossSectionQueryCommand(StrictModel):
    artifact_ids: list[str] = Field(min_length=1)
    idempotency_key: str = Field(min_length=8, max_length=160)


class ProvenanceBinding(StrictModel):
    location: str = Field(min_length=1)
    text: str = Field(min_length=1)
    claim_id: str = Field(min_length=1)
    claim_hash: Sha256
    artifact_hash: Sha256


class ProvenanceBlocker(StrictModel):
    code: str = Field(min_length=1)
    location: str = Field(min_length=1)
    text: str = Field(min_length=1)
    message: str = Field(min_length=1)


class ProvenanceReceipt(StrictModel):
    schema_version: Literal["helix.provenance-receipt/v1"]
    receipt_id: Annotated[str, Field(pattern=r"^PRV-[A-Z0-9-]+$")]
    candidate_id: Annotated[str, Field(pattern=r"^SDC-[A-Z0-9-]+$")]
    candidate_hash: Sha256
    status: Literal["passed", "blocked"]
    enforcement_class: Literal["hard_blocker"]
    waivable: Literal[False]
    bindings: list[ProvenanceBinding]
    blockers: list[ProvenanceBlocker]


class StudyOutputAssertionResult(StrictModel):
    assertion: str = Field(min_length=1)
    status: Literal["passed", "failed"]
    message: str = Field(min_length=1)


class StudyOutputEvaluationReceipt(StrictModel):
    schema_version: Literal["helix.study-output-evaluation-receipt/v1"]
    receipt_id: Annotated[str, Field(pattern=r"^SOE-[A-Z0-9-]+$")]
    candidate_id: Annotated[str, Field(pattern=r"^SDC-[A-Z0-9-]+$")]
    candidate_hash: Sha256
    suite_id: str = Field(min_length=1)
    suite_version: str = Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")
    suite_hash: Sha256
    status: Literal["passed", "failed"]
    enforcement_class: Literal["review_required"]
    waivable: bool
    results: list[StudyOutputAssertionResult] = Field(min_length=1)


ConformanceCheckKind = Literal[
    "completeness",
    "table_coverage",
    "terminology",
    "units",
    "rounding",
    "approved_language",
]


class TemplateConformanceResult(StrictModel):
    gate_id: str = Field(min_length=1)
    rule_id: str = Field(min_length=1)
    check_kind: ConformanceCheckKind
    status: Literal["passed", "blocked"]
    enforcement_class: Literal["hard_blocker"]
    waivable: Literal[False]
    message: str = Field(min_length=1)


class TemplateConformanceReceipt(StrictModel):
    schema_version: Literal["helix.template-conformance-receipt/v1"]
    receipt_id: Annotated[str, Field(pattern=r"^TCF-[A-Z0-9-]+$")]
    candidate_id: Annotated[str, Field(pattern=r"^SDC-[A-Z0-9-]+$")]
    candidate_hash: Sha256
    section_package_id: str = Field(min_length=1)
    status: Literal["passed", "blocked"]
    results: list[TemplateConformanceResult] = Field(min_length=1)


class CrossSectionReturnedArtifact(StrictModel):
    artifact_id: str = Field(min_length=1)
    kind: Literal["fact", "claim", "section_draft"]
    hash: Sha256


class CrossSectionQueryReceipt(StrictModel):
    schema_version: Literal["helix.cross-section-query-receipt/v1"]
    query_id: Annotated[str, Field(pattern=r"^CSQ-[A-Z0-9-]+$")]
    run_id: str = Field(min_length=1)
    section_package_id: str = Field(min_length=1)
    requested_artifact_ids: list[str] = Field(min_length=1)
    returned: list[CrossSectionReturnedArtifact]
    rejected_artifact_ids: list[str]
    status: Literal["returned", "rejected"]
    message: str | None = None


class NextAttemptDecision(StrictModel):
    action: Literal["retry", "stop_for_review", "hold"]
    attempt: int = Field(ge=1, le=3)
    max_attempts: Literal[3]
    reasons: list[str]
    blocking_receipt_ids: list[str]


class CandidateEvaluationHashes(StrictModel):
    candidate: Sha256
    provenance: Sha256
    study_output_evaluation: Sha256
    template_conformance: Sha256
    evaluation: Sha256


class CandidateEvaluation(StrictModel):
    schema_version: Literal["helix.candidate-evaluation/v1"]
    evaluation_id: Annotated[str, Field(pattern=r"^CEV-[A-Z0-9-]+$")]
    run_id: str = Field(min_length=1)
    candidate_id: Annotated[str, Field(pattern=r"^SDC-[A-Z0-9-]+$")]
    candidate_hash: Sha256
    section_package_id: str = Field(min_length=1)
    provenance_receipt: ProvenanceReceipt
    study_output_evaluation_receipt: StudyOutputEvaluationReceipt
    template_conformance_receipt: TemplateConformanceReceipt
    next_attempt_decision: NextAttemptDecision
    hashes: CandidateEvaluationHashes
    idempotent_replay: bool = False


class PromotionCommand(StrictModel):
    idempotency_key: str = Field(min_length=8, max_length=160)


class BoundDisposition(StrictModel):
    disposition_id: str = Field(min_length=1)
    result_id: str = Field(min_length=1)
    decision: str = Field(min_length=1)
    artifact_hash: Sha256
    dependency_fingerprint: Sha256


class ConditionDecision(StrictModel):
    condition_id: Literal[
        "package_permission",
        "no_hard_blocker",
        "provenance_passed",
        "conformance_passed",
        "review_required_current",
    ]
    passed: bool
    reason: str | None = None
    evidence_ids: list[str]


class PromotionDecision(StrictModel):
    schema_version: Literal["helix.section-promotion-decision/v1"]
    eligible: bool
    candidate_id: Annotated[str, Field(pattern=r"^SDC-[A-Z0-9-]+$")]
    candidate_hash: Sha256
    run_id: str = Field(min_length=1)
    conditions: list[ConditionDecision] = Field(min_length=5, max_length=5)
    failed_condition_ids: list[
        Literal[
            "package_permission",
            "no_hard_blocker",
            "provenance_passed",
            "conformance_passed",
            "review_required_current",
        ]
    ]
    warnings: list[str]
    current_disposition_ids: list[str]
    gate_decision_ids: list[str]


class FrozenRunInputs(StrictModel):
    records: StudyRecords
    manifest: list[ManifestEntry]
    template: dict[str, object]
    validation_package: dict[str, object]
    section_packages: dict[str, dict[str, object]]
    skill_hash: Sha256
    suite_hash: Sha256
    executor_hash: Sha256
    validation_package_hash: Sha256


class ArtifactLineage(StrictModel):
    predecessor_run_id: str = Field(min_length=1, max_length=80)
    predecessor_artifact_id: str = Field(min_length=1)
    predecessor_content_hash: Sha256
    predecessor_dependency_fingerprint: Sha256


class ParseReuse(StrictModel):
    node_id: str = Field(min_length=1)
    content_hash: Sha256
    reused: bool


class CarriedForwardArtifact(StrictModel):
    kind: Literal["section_draft_candidate", "section_draft"]
    section_package_id: str = Field(min_length=1)
    artifact_id: str = Field(min_length=1)
    content_hash: Sha256
    dependency_fingerprint: Sha256
    lineage: ArtifactLineage
    stored_run: StoredSectionRun | None = None
    section_draft: "SectionDraft | None" = None


class PredecessorSnapshot(StrictModel):
    schema_version: Literal["helix.predecessor-snapshot/v1"]
    snapshot_hash: Sha256
    pinned_run: PinnedRun
    frozen_inputs: FrozenRunInputs
    claims: list[Claim]
    provenance_edges: list[ProvenanceEdge]
    validation_results: list[ValidationResult]
    data_validation_executions: list[DataValidationExecution]
    gate_decisions: list[GateDecision]
    review_dispositions: list[ReviewDisposition]
    approvals: list[Approval]
    events: list[WorkflowEvent]
    review_scaffold_revisions: list[dict[str, object]]
    export_artifacts: list[ExportArtifact]
    workflow_state: str
    section_runs: list[StoredSectionRun]
    section_drafts: list["SectionDraft"]
    candidate_evaluations: list[CandidateEvaluation]
    drafting_cycles: list[DraftingCycle]
    release_candidate: "ReleaseCandidate | None" = None
    final_study_approval: "FinalStudyApproval | None" = None

class SupersedingRunReceipt(StrictModel):
    schema_version: Literal["helix.superseding-run/v1"]
    run_id: str = Field(min_length=1)
    predecessor_run_id: str = Field(min_length=1)
    predecessor_snapshot_hash: Sha256
    reason: str = Field(min_length=8, max_length=240)
    parse_reuse: list[ParseReuse]
    carried_forward: list[CarriedForwardArtifact]
    rerun_node_ids: list[str]
    impact_set: SectionImpactSet
    fresh_validation_receipt_ids: list[str]
    fresh_gate_ids: list[str]
    fresh_scaffold_revision: int = Field(ge=0)


class SectionDraft(StrictModel):
    schema_version: Literal["helix.section-draft/v1"]
    status: Literal["section_draft"]
    draft_id: Annotated[str, Field(pattern=r"^SD-[A-Z0-9-]+$")]
    run_id: str = Field(min_length=1)
    section_id: str = Field(min_length=1)
    candidate_id: Annotated[str, Field(pattern=r"^SDC-[A-Z0-9-]+$")]
    candidate_hash: Sha256
    content_hash: Sha256
    promoted_at: str
    gate_decision_ids: list[str] = Field(min_length=1)
    bound_dispositions: list[BoundDisposition]


class WorkspaceResponse(StrictModel):
    label: str
    study: Study
    manifest: list[ManifestEntry]
    workflow_state: str
    stages: list[Stage]
    summary: WorkspaceSummary
    claims: list[Claim]
    validations: list[ValidationResult]
    dispositions: list[ReviewDisposition]
    approvals: list[Approval]
    release_gate: GateDecision
    export_artifacts: list[ExportArtifact]
    report: ReportAssembly
    events: list[WorkflowEvent]
    planner_capabilities: list[PlannerCapability]
    pinned_run: PinnedRun | None
    data_validation_executions: list[DataValidationExecution]
    section_run_eligibility: list[SectionRunEligibility]
    section_runs: list[StoredSectionRun]
    candidate_evaluations: list[CandidateEvaluation] = Field(default_factory=list)
    promotion_decisions: list[PromotionDecision] = Field(default_factory=list)
    section_drafts: list[SectionDraft] = Field(default_factory=list)
    cross_section_queries: list[CrossSectionQueryReceipt] = Field(default_factory=list)
    review_scaffold_revisions: list[dict[str, object]] = Field(default_factory=list)
    drafting_cycles: list[DraftingCycle] = Field(default_factory=list)
    can_open_revision: bool = False
    predecessor_snapshots: list[PredecessorSnapshot] = Field(default_factory=list)
    superseding_run_receipt: SupersedingRunReceipt | None = None
    release_candidate: ReleaseCandidate | None = None
    final_study_approval: FinalStudyApproval | None = None
    approval_current: bool = False


class ExportInstrumentation(StrictModel):
    agent_starts: int = Field(ge=0)
    calculation_runs: int = Field(ge=0)


class ExportReceipt(StrictModel):
    study_id: str
    status: Literal["exported"]
    exported_at: str
    approval_id: str
    manifest_hash: Sha256
    artifacts: list[ExportArtifact]
    idempotent_replay: bool
    instrumentation: ExportInstrumentation


FrozenRunInputs.model_rebuild()
CarriedForwardArtifact.model_rebuild()
PredecessorSnapshot.model_rebuild()
StudyEvidencePackage.model_rebuild()
WorkspaceResponse.model_rebuild()
