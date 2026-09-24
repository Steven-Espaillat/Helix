import json
from collections.abc import Iterable
from typing import Annotated, Literal, Protocol

import httpx
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from .approved_exports import note_calculation_run
from .config import Settings
from .reporting import assemble_report, claim_report_text, load_report_template
from .schemas import (
    StudyEvidencePackage,
    ValidationKind,
    ValidationResult,
    ValidationStatus,
)

RULE_BUNDLE_VERSION = "helix-rules-1.0.0"


class PlannerUnavailableError(RuntimeError):
    pass


class ProposalBase(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GroundedNumericClaim(ProposalBase):
    tool: Literal["grounded_numeric_claim"]
    claim_id: str


class SourceSeverityMatch(ProposalBase):
    tool: Literal["source_severity_match"]
    claim_id: str


class HumanJudgmentRequired(ProposalBase):
    tool: Literal["human_judgment_required"]
    claim_id: str


CheckProposal = Annotated[
    GroundedNumericClaim | SourceSeverityMatch | HumanJudgmentRequired,
    Field(discriminator="tool"),
]


class AgentPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposals: list[CheckProposal] = Field(min_length=1, max_length=12)


class CheckPlanner(Protocol):
    label: str
    llm_used: bool

    def plan(self, package: StudyEvidencePackage) -> AgentPlan: ...


class FixturePlanner:
    label = "Fixture planner for tool-contract testing"
    llm_used = False

    def plan(self, package: StudyEvidencePackage) -> AgentPlan:
        return AgentPlan(
            proposals=[
                GroundedNumericClaim(tool="grounded_numeric_claim", claim_id="C-BW-HIGH"),
                SourceSeverityMatch(tool="source_severity_match", claim_id="C-MI-LIVER"),
                HumanJudgmentRequired(tool="human_judgment_required", claim_id="C-NOAEL"),
            ]
        )


class OpenAICompatiblePlanner:
    label = "OpenAI-compatible structured planner"
    llm_used = True

    def __init__(self, settings: Settings):
        if not settings.llm_api_key:
            raise PlannerUnavailableError("HELIX_LLM_API_KEY is not configured")
        self.settings = settings

    def plan(self, package: StudyEvidencePackage) -> AgentPlan:
        schema = AgentPlan.model_json_schema()
        payload = {
            "model": self.settings.llm_model,
            "temperature": 0,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Select validation tools for a synthetic nonclinical report. "
                        "Only propose checks. Deterministic code executes them."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "label": package.label,
                            "claims": [claim.model_dump(mode="json") for claim in package.claims],
                            "report_blocks": [
                                block.model_dump(mode="json")
                                for section in assemble_report(package).sections
                                for block in section.blocks
                            ],
                            "allowed_tools": [
                                "grounded_numeric_claim",
                                "source_severity_match",
                                "human_judgment_required",
                            ],
                        }
                    ),
                },
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "helix_check_plan", "strict": True, "schema": schema},
            },
        }
        try:
            response = httpx.post(
                f"{self.settings.llm_base_url.rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {self.settings.llm_api_key}"},
                json=payload,
                timeout=30,
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            return AgentPlan.model_validate_json(content)
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as error:
            raise PlannerUnavailableError(f"Planner request failed: {error}") from error


def deterministic_results(package: StudyEvidencePackage) -> list[ValidationResult]:
    note_calculation_run()
    claim_by_id = {claim.claim_id: claim for claim in package.claims}
    bw_records = package.records.body_weights
    terminal_ids = {animal.animal_id for animal in package.records.animals if animal.group_id == "G4"}
    terminal_records = [
        record for record in bw_records if record.animal_id in terminal_ids and record.timepoint == "DAY 28"
    ]
    terminal_values = [float(record.value) for record in terminal_records]
    recomputed_mean = round(sum(terminal_values) / len(terminal_values), 1)
    body_weight_claim = claim_by_id["C-BW-HIGH"]
    numeric_claims = [claim for claim in package.claims if claim.value is not None]
    numeric_claims_with_edges = {
        edge.claim_id
        for edge in package.provenance_edges
        if edge.claim_id in {c.claim_id for c in numeric_claims}
    }
    sex_claim_ids = {"C-BW-HIGH-M", "C-BW-HIGH-F"}
    sex_claims = [claim_by_id[claim_id] for claim_id in sex_claim_ids if claim_id in claim_by_id]
    sex_stratified = len(sex_claims) == 2 and all(
        claim.grain == "dose_group_x_sex"
        and sum(edge.claim_id == claim.claim_id for edge in package.provenance_edges) == 5
        for claim in sex_claims
    )
    severity_reconciled = (
        "minimal hepatocellular hypertrophy" in claim_report_text(package, "C-MI-LIVER").lower()
    )
    template = load_report_template()
    required_ids = {
        field.field_id for section in template.sections for field in section.fields if field.required
    }
    return [
        _result(
            "VR-DET-001",
            "synthetic-label",
            package.package_id,
            "blocker",
            package.label == "SYNTHETIC / NOT FOR SUBMISSION",
            [package.package_id],
            "The package is visibly labeled SYNTHETIC / NOT FOR SUBMISSION.",
        ),
        _result(
            "VR-DET-002",
            "manifest-locked",
            package.package_id,
            "blocker",
            all(entry.locked and entry.checksum and entry.authorized_by for entry in package.manifest),
            [entry.artifact_id for entry in package.manifest],
            f"All {len(package.manifest)} inputs are authorized, checksummed, and frozen.",
        ),
        _result(
            "VR-DET-003",
            "bw-key-unique",
            "BW",
            "blocker",
            len({record.record_id for record in bw_records}) == len(bw_records),
            ["A-BW"],
            f"All {len(bw_records)} body-weight record keys are unique.",
        ),
        _result(
            "VR-DET-004",
            "claim-value-reconciliation",
            "C-BW-HIGH",
            "blocker",
            body_weight_claim.value == recomputed_mean,
            [record.record_id for record in terminal_records],
            (
                f"The stored terminal mean {body_weight_claim.value:.1f} g equals the deterministic "
                f"mean {recomputed_mean:.1f} g from {len(terminal_records)} records."
            ),
        ),
        _result(
            "VR-DET-005",
            "numeric-claim-provenance",
            package.package_id,
            "blocker",
            all(claim.claim_id in numeric_claims_with_edges for claim in numeric_claims),
            [edge.edge_id for edge in package.provenance_edges],
            "Every numeric claim has at least one provenance edge.",
        ),
        _result(
            "VR-004",
            "grain-sex-stratified",
            "S5",
            "blocker",
            sex_stratified,
            sorted(sex_claim_ids) if sex_stratified else ["C-BW-HIGH"],
            (
                "The corrected report has separate n=5 male and female claims."
                if sex_stratified
                else "The draft groups n=10. The report field requires dose group by sex with n=5."
            ),
        ),
        _result(
            "VR-005",
            "mi-severity-reconcile",
            "C-MI-LIVER",
            "blocker",
            severity_reconciled,
            [
                finding.finding_id
                for finding in package.records.microscopic_findings
                if finding.finding == "Hepatocellular hypertrophy"
            ],
            (
                "The report severity matches the locked minimal microscopic findings."
                if severity_reconciled
                else "The pattern draft says moderate. The locked microscopic findings say minimal."
            ),
        ),
        _result(
            "VR-006",
            "noael-human-judgment",
            "C-NOAEL",
            "blocker",
            False,
            [],
            "NOAEL selection requires qualified scientific interpretation and peer review.",
        ),
        _result(
            "VR-DET-009",
            "regulatory-template-coverage",
            template.template_id,
            "blocker",
            len(required_ids) == 37,
            sorted(required_ids),
            "The structured template maps 37 required fields to regulation or study guidance.",
        ),
        _result(
            "VR-DET-010",
            "submission-support-artifacts",
            package.package_id,
            "blocker",
            {artifact.kind for artifact in package.export_artifacts}
            == {"study_report_pdf", "send_dataset_package", "define_xml", "nsdrg"},
            [artifact.artifact_id for artifact in package.export_artifacts],
            "The release package declares four synthetic submission-support artifact slots.",
        ),
    ]


def execute_agent_plan(package: StudyEvidencePackage, plan: AgentPlan) -> list[ValidationResult]:
    results: list[ValidationResult] = []
    seen: set[tuple[str, str]] = set()
    for proposal in plan.proposals:
        key = (proposal.tool, proposal.claim_id)
        if key in seen:
            continue
        seen.add(key)
        index = len(results) + 1
        if isinstance(proposal, GroundedNumericClaim):
            results.append(_agent_numeric_result(package, proposal.claim_id, index))
        elif isinstance(proposal, SourceSeverityMatch):
            results.append(_agent_severity_result(package, proposal.claim_id, index))
        else:
            results.append(_agent_judgment_result(package, proposal.claim_id, index))
    return results


def parse_agent_plan(raw: object) -> AgentPlan:
    return TypeAdapter(AgentPlan).validate_python(raw)


def all_results(package: StudyEvidencePackage, planner: CheckPlanner) -> list[ValidationResult]:
    return [*deterministic_results(package), *execute_agent_plan(package, planner.plan(package))]


def blocking_failures(results: Iterable[ValidationResult]) -> list[ValidationResult]:
    return [
        result
        for result in results
        if result.status == ValidationStatus.FAIL and result.severity == "blocker"
    ]


def _agent_numeric_result(package: StudyEvidencePackage, claim_id: str, index: int) -> ValidationResult:
    claim = next((item for item in package.claims if item.claim_id == claim_id), None)
    edges = [edge for edge in package.provenance_edges if edge.claim_id == claim_id]
    passed = claim is not None and claim.value is not None and bool(edges)
    return _result(
        f"VR-AGENT-{index:03d}",
        "agent-grounded-numeric-claim",
        claim_id,
        "info",
        passed,
        [edge.edge_id for edge in edges],
        f"The planner selected numeric grounding. Deterministic lookup found {len(edges)} provenance edges.",
        kind=ValidationKind.AGENT_PLANNED,
        tool_name="grounded_numeric_claim",
    )


def _agent_severity_result(package: StudyEvidencePackage, claim_id: str, index: int) -> ValidationResult:
    source_severities = {
        finding.severity
        for finding in package.records.microscopic_findings
        if finding.finding == "Hepatocellular hypertrophy"
    }
    report_text = claim_report_text(package, claim_id).lower()
    passed = len(source_severities) == 1 and next(iter(source_severities)) in report_text
    return _result(
        f"VR-AGENT-{index:03d}",
        "agent-source-severity-match",
        claim_id,
        "warning",
        passed,
        sorted(source_severities),
        (
            "The planner selected severity grounding. Deterministic text comparison matched the source."
            if passed
            else "The planner selected severity grounding. Deterministic text comparison found a mismatch."
        ),
        kind=ValidationKind.AGENT_PLANNED,
        tool_name="source_severity_match",
    )


def _agent_judgment_result(package: StudyEvidencePackage, claim_id: str, index: int) -> ValidationResult:
    claim = next((item for item in package.claims if item.claim_id == claim_id), None)
    passed = claim is not None and claim.value is None and claim.status.value in {"needs_review", "approved"}
    return _result(
        f"VR-AGENT-{index:03d}",
        "agent-human-judgment-guard",
        claim_id,
        "info",
        passed,
        [claim_id] if claim else [],
        (
            "The planner selected the judgment guard. The deterministic tool confirmed that "
            "NOAEL remains unfilled and requires a human disposition."
        ),
        kind=ValidationKind.AGENT_PLANNED,
        tool_name="human_judgment_required",
    )


def _result(
    result_id: str,
    rule_id: str,
    scope_id: str,
    severity: Literal["info", "warning", "blocker"],
    passed: bool,
    evidence_ids: list[str],
    message: str,
    *,
    kind: ValidationKind = ValidationKind.DETERMINISTIC,
    tool_name: str | None = None,
) -> ValidationResult:
    return ValidationResult(
        result_id=result_id,
        rule_id=rule_id,
        scope_id=scope_id,
        severity=severity,
        status=ValidationStatus.PASS if passed else ValidationStatus.FAIL,
        evidence_ids=evidence_ids,
        message=message,
        rule_version=RULE_BUNDLE_VERSION,
        kind=kind,
        tool_name=tool_name,
    )
