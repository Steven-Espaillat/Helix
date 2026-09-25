import json
import logging
import re
from collections.abc import Iterable
from typing import Annotated, Any, Literal, Protocol

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

logger = logging.getLogger(__name__)

# Upstream error bodies are logged at most this long.
UPSTREAM_BODY_LOG_LIMIT = 2000
# Hard rule: no API key (or OpenAI's masked echo of one) reaches logs or clients.
# ``sk-`` keys include project/service-account/admin forms (``sk-proj-...``,
# ``sk-svcacct-...``) and OpenAI's own masked echo (``sk-proj-****abcd``), so the
# ``*`` mask character counts as part of the key.
_SECRET_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9_\-*.]{4,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-*]+"),
)


class PlannerUnavailableError(RuntimeError):
    pass


class PlannerUpstreamError(PlannerUnavailableError):
    """The planner endpoint answered with a non-2xx status.

    Carries the upstream status and OpenAI-style error fields (type, code,
    param, message) so callers and logs say *why*, never the credentials.
    """

    def __init__(
        self,
        status_code: int,
        *,
        error_type: str | None,
        code: str | None,
        param: str | None,
        message: str,
    ):
        self.status_code = status_code
        self.error_type = error_type
        self.code = code
        self.param = param
        self.upstream_message = message
        parts = [f"HTTP {status_code}"]
        if code or error_type:
            parts.append(code or error_type or "")
        if param:
            parts.append(f"param={param}")
        super().__init__(f"Planner endpoint rejected the request ({', '.join(parts)}): {message}")

    @property
    def http_status(self) -> int:
        """HELIX status for this upstream failure.

        An upstream 4xx means our request or credentials were refused, not that the
        planner is temporarily unavailable: 429 stays a typed 429 (retry later) and
        every other 4xx is a typed 502 Bad Gateway. Upstream 5xx stays 503.
        """
        if self.status_code == 429:
            return 429
        if 400 <= self.status_code < 500:
            return 502
        return 503

    def as_detail(self) -> dict[str, Any]:
        if self.status_code == 429:
            code = "planner_rate_limited"
        elif 400 <= self.status_code < 500:
            code = "planner_upstream_rejected"
        else:
            code = "planner_upstream_unavailable"
        return {
            "code": code,
            "message": str(self),
            "upstream_status": self.status_code,
            "upstream_type": self.error_type,
            "upstream_code": self.code,
            "upstream_param": self.param,
        }


class PlannerResponseError(PlannerUnavailableError):
    """The planner endpoint answered 2xx but the plan was missing or invalid."""


def _redact(text: str, secret: str | None) -> str:
    if secret:
        text = text.replace(secret, "[REDACTED]")
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return text


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


# JSON Schema keywords OpenAI structured outputs accept with "strict": true
# (https://platform.openai.com/docs/guides/structured-outputs#supported-schemas).
# Array length limits (minItems/maxItems) are supported, so AgentPlan's 1-12
# proposal contract is enforced upstream too. Anything else (oneOf,
# discriminator, title, ...) is dropped or rewritten; AgentPlan still validates
# the reply.
_STRICT_KEYWORDS = {
    "minItems",
    "maxItems",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "anyOf",
    "enum",
    "$ref",
    "$defs",
    "description",
}


def _strict_node(node: Any) -> Any:
    if isinstance(node, list):
        return [_strict_node(item) for item in node]
    if not isinstance(node, dict):
        return node
    extra = node.get("additionalProperties")
    if extra not in (None, False):
        # A dict[str, X] field emits additionalProperties: {schema}; strict mode would
        # silently turn it into a closed empty object, so refuse it loudly instead.
        raise ValueError("Strict planner schema cannot express open additionalProperties")
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key == "oneOf":
            out["anyOf"] = _strict_node(value)
        elif key == "const":
            out["enum"] = [value]
        elif key in ("properties", "$defs"):
            out[key] = {name: _strict_node(child) for name, child in value.items()}
        elif key in _STRICT_KEYWORDS:
            out[key] = _strict_node(value)
    if out.get("type") == "object" or "properties" in out:
        out["additionalProperties"] = False
        out["required"] = list(out.get("properties", {}))
    return out


def strict_plan_schema() -> dict[str, Any]:
    """AgentPlan's JSON Schema, rewritten for OpenAI strict structured outputs.

    Works for OpenAI (api.openai.com) and OpenAI-compatible gateways (the Azure
    path): the union becomes anyOf (strict mode rejects oneOf/discriminator),
    const becomes a one-value enum, and every object is closed with all
    properties required. Array length limits are kept; AgentPlan re-checks the reply.
    """
    return _strict_node(AgentPlan.model_json_schema())


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
        schema = strict_plan_schema()
        # No "temperature": newer OpenAI models (gpt-6-luna) reject any value
        # but the default ("temperature does not support 0 with this model").
        # Determinism comes from the strict schema plus deterministic tools.
        payload = {
            "model": self.settings.llm_model,
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
        url = f"{self.settings.llm_base_url.rstrip('/')}/chat/completions"
        try:
            response = httpx.post(
                url,
                headers={"Authorization": f"Bearer {self.settings.llm_api_key}"},
                json=payload,
                timeout=30,
            )
        except httpx.HTTPError as error:
            logger.warning("Planner request to %s failed before a response: %s", url, type(error).__name__)
            raise PlannerUnavailableError(f"Planner request failed: {type(error).__name__}") from error
        if response.status_code >= 400:
            raise self._upstream_error(url, response)
        try:
            content = response.json()["choices"][0]["message"]["content"]
            return AgentPlan.model_validate_json(content)
        except (KeyError, IndexError, TypeError, ValueError) as error:
            # Log only the size and the parse error, never the model output itself.
            logger.warning(
                "Planner %s returned an unusable plan (HTTP %s, %d bytes): %s",
                url,
                response.status_code,
                len(response.content),
                type(error).__name__,
            )
            raise PlannerResponseError(f"Planner returned an invalid plan: {type(error).__name__}") from error

    def _upstream_error(self, url: str, response: httpx.Response) -> PlannerUpstreamError:
        body = _redact(response.text[:UPSTREAM_BODY_LOG_LIMIT], self.settings.llm_api_key)
        # Log status and body only: never the request headers or the key.
        logger.warning("Planner endpoint %s returned HTTP %s: %s", url, response.status_code, body)
        error: dict[str, Any] = {}
        try:
            parsed = response.json()
            if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
                error = parsed["error"]
        except ValueError:
            pass

        def field(name: str) -> str | None:
            value = error.get(name)
            return _redact(str(value), self.settings.llm_api_key) if value is not None else None

        return PlannerUpstreamError(
            response.status_code,
            error_type=field("type"),
            code=field("code"),
            param=field("param"),
            message=field("message") or body[:300] or "no response body",
        )


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
