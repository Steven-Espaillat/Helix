import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal
from uuid import uuid4

from .schemas import (
    ConformanceCheckKind,
    SectionDraftCandidate,
    TemplateConformanceReceipt,
    TemplateConformanceResult,
)

JsonObject = dict[str, object]
CheckFn = Callable[[SectionDraftCandidate, JsonObject, JsonObject], str | None]
NUMBER = re.compile(r"\d+(?:\.\d+)?")

BODY_WEIGHT_PACKAGE_ID = "section.5_2_3_body_weight"
DISCUSSION_PACKAGE_ID = "section.5_3_discussion"


@dataclass(frozen=True)
class ConformanceCheck:
    gate_id: str
    rule_id: str
    check_kind: ConformanceCheckKind
    evaluate: CheckFn


def evaluate_template_conformance(
    candidate: SectionDraftCandidate,
    package_definition: JsonObject,
    template: JsonObject,
    *,
    candidate_hash: str,
    receipt_id: str | None = None,
) -> TemplateConformanceReceipt:
    package_id = str(package_definition.get("package_id", ""))
    declared = [str(item) for item in package_definition.get("template_conformance_gate_ids", [])]
    catalog = [check for check in CONFORMANCE_CHECKS if check.gate_id in declared]
    if set(declared) != {check.gate_id for check in catalog}:
        results = [
            TemplateConformanceResult(
                gate_id="template-conformance-declared-gates",
                rule_id="TCF-DECLARED",
                check_kind="completeness",
                status="blocked",
                enforcement_class="hard_blocker",
                waivable=False,
                message="The section Template Conformance Gates are incomplete",
            )
        ]
    else:
        results = [_result(check, candidate, package_definition, template) for check in catalog]
    return TemplateConformanceReceipt(
        schema_version="helix.template-conformance-receipt/v1",
        receipt_id=receipt_id or f"TCF-{uuid4().hex[:12].upper()}",
        candidate_id=candidate.candidate_id,
        candidate_hash=candidate_hash,
        section_package_id=package_id,
        status="blocked" if any(item.status == "blocked" for item in results) else "passed",
        results=results,
    )


def _result(
    check: ConformanceCheck,
    candidate: SectionDraftCandidate,
    package: JsonObject,
    template: JsonObject,
) -> TemplateConformanceResult:
    failure = check.evaluate(candidate, package, template)
    return TemplateConformanceResult(
        gate_id=check.gate_id,
        rule_id=check.rule_id,
        check_kind=check.check_kind,
        status="blocked" if failure else "passed",
        enforcement_class="hard_blocker",
        waivable=False,
        message=failure or f"Template Conformance Gate {check.rule_id} passed",
    )


def _blob(candidate: SectionDraftCandidate) -> str:
    return json.dumps(candidate.content_blocks, ensure_ascii=False).lower()


def _texts(candidate: SectionDraftCandidate) -> list[str]:
    texts: list[str] = []
    for block in candidate.content_blocks:
        content = block.get("content")
        if isinstance(content, str):
            texts.append(content)
            continue
        if not isinstance(content, dict):
            continue
        rows = content.get("rows")
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("cells"), list):
                continue
            for cell in row["cells"]:
                if isinstance(cell, dict) and "text" in cell:
                    texts.append(str(cell["text"]))
    return texts


def _has_kind(candidate: SectionDraftCandidate, kind: Literal["paragraph", "table"]) -> bool:
    return any(block.get("kind") == kind for block in candidate.content_blocks)


def _style(template: JsonObject) -> JsonObject:
    for section in template.get("sections", []):
        if not isinstance(section, dict) or section.get("section_id") != "S5":
            continue
        for field in section.get("fields", []):
            if isinstance(field, dict) and field.get("field_id") == "body-weight":
                style = field.get("style_constraints")
                return style if isinstance(style, dict) else {}
    return {}


def _missing_completeness(
    candidate: SectionDraftCandidate, package: JsonObject, template: JsonObject
) -> str | None:
    if package.get("package_id") == DISCUSSION_PACKAGE_ID:
        if not _has_kind(candidate, "paragraph"):
            return "Template Conformance Gate discussion-content-completeness failed"
        return None
    if not _has_kind(candidate, "paragraph") or not _has_kind(candidate, "table"):
        return "Template Conformance Gate body-weight-content-completeness failed"
    return None


def _missing_table_coverage(
    candidate: SectionDraftCandidate, package: JsonObject, template: JsonObject
) -> str | None:
    texts = [item.lower() for item in _texts(candidate)]
    blob = " ".join(texts)
    if not _has_kind(candidate, "table"):
        return "Template Conformance Gate body-weight-output-table-shape failed"
    if not all(token in blob for token in ("mean", "sd", "n")):
        return "Template Conformance Gate body-weight-output-table-shape failed"
    if "high-dose" not in blob and "high dose" not in blob:
        return "Template Conformance Gate body-weight-output-table-shape failed"
    if not any(re.search(r"\b[mf]\b", text) for text in texts):
        return "Template Conformance Gate body-weight-output-table-shape failed"
    return None


def _missing_terminology(
    candidate: SectionDraftCandidate, package: JsonObject, template: JsonObject
) -> str | None:
    if "body weight" not in _blob(candidate):
        return "Template Conformance Gate body-weight-output-style failed"
    return None


def _missing_units(
    candidate: SectionDraftCandidate, package: JsonObject, template: JsonObject
) -> str | None:
    unit = str(_style(template).get("unit_display") or "g")
    for text in _texts(candidate):
        if NUMBER.search(text) and unit not in text:
            return "Template Conformance Gate body-weight-output-style failed"
    return None


def _missing_rounding(
    candidate: SectionDraftCandidate, package: JsonObject, template: JsonObject
) -> str | None:
    places = _style(template).get("decimal_places")
    if places != 1:
        return "Template Conformance Gate body-weight-output-style failed"
    for text in _texts(candidate):
        for number in NUMBER.findall(text):
            if "." in number and len(number.split(".", 1)[1]) != 1:
                return "Template Conformance Gate body-weight-output-style failed"
    return None


def _missing_approved_language(
    candidate: SectionDraftCandidate, package: JsonObject, template: JsonObject
) -> str | None:
    forbidden = _style(template).get("forbidden_terms")
    terms = forbidden if isinstance(forbidden, list) else package.get("drafting_constraints", {})
    if isinstance(terms, dict):
        terms = terms.get("forbidden_claims", [])
    blob = _blob(candidate)
    for term in terms if isinstance(terms, list) else []:
        if str(term).lower() in blob:
            return "Template Conformance Gate body-weight-output-style failed"
    return None


CONFORMANCE_CHECKS: tuple[ConformanceCheck, ...] = (
    ConformanceCheck(
        "body-weight-content-completeness",
        "TCF-BW-COMPLETENESS",
        "completeness",
        _missing_completeness,
    ),
    ConformanceCheck(
        "body-weight-output-table-shape",
        "TCF-BW-TABLE-COVERAGE",
        "table_coverage",
        _missing_table_coverage,
    ),
    ConformanceCheck(
        "body-weight-output-style",
        "TCF-BW-TERMINOLOGY",
        "terminology",
        _missing_terminology,
    ),
    ConformanceCheck(
        "body-weight-output-style",
        "TCF-BW-UNITS",
        "units",
        _missing_units,
    ),
    ConformanceCheck(
        "body-weight-output-style",
        "TCF-BW-ROUNDING",
        "rounding",
        _missing_rounding,
    ),
    ConformanceCheck(
        "body-weight-output-style",
        "TCF-BW-APPROVED-LANGUAGE",
        "approved_language",
        _missing_approved_language,
    ),
    ConformanceCheck(
        "discussion-content-completeness",
        "TCF-DISC-COMPLETENESS",
        "completeness",
        _missing_completeness,
    ),
)
