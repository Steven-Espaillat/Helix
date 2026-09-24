from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from .schemas import SectionImpactSet, TemplateContractGateResult

CheckKind = Literal["fields", "locations", "table_shapes", "labels", "units", "style_constraints"]
JsonObject = dict[str, object]

BODY_WEIGHT_PACKAGE_ID = "section.5_2_3_body_weight"
DISCUSSION_PACKAGE_ID = "section.5_3_discussion"
BODY_WEIGHT_SECTION_ID = "S5"
BODY_WEIGHT_FIELD_ID = "body-weight"
DISCUSSION_SECTION_ID = "S8"


@dataclass(frozen=True)
class GateCheck:
    gate_id: str
    result_id: str
    check_kind: CheckKind
    section_id: str
    field_id: str | None
    evaluate: Callable[[JsonObject, JsonObject], str | None]


def evaluate_template_contract(
    package_definition: JsonObject,
    template: JsonObject,
) -> list[TemplateContractGateResult]:
    package_id = str(package_definition.get("package_id", ""))
    declared = [str(item) for item in package_definition.get("template_contract_gate_ids", [])]
    catalog = [check for check in GATE_CHECKS if check.gate_id in declared]
    if set(declared) != {check.gate_id for check in catalog}:
        return [
            TemplateContractGateResult(
                gate_id="template-contract-declared-gates",
                section_package_id=package_id,
                result_id=_result_id(package_id, "DECLARED"),
                status="blocked",
                enforcement_class="hard_blocker",
                waivable=False,
                check_kind="fields",
                message="The section Template Contract Gates are incomplete",
            )
        ]
    return [
        _result(check, package_id, check.evaluate(package_definition, template))
        for check in catalog
    ]


def impact_set_for(
    origin_package_id: str,
    package_definitions: list[JsonObject],
) -> SectionImpactSet:
    dependents: dict[str, list[str]] = {}
    for definition in package_definitions:
        package_id = str(definition["package_id"])
        for dependency in definition.get("depends_on", []):
            dependents.setdefault(str(dependency), []).append(package_id)
    direct = [origin_package_id]
    transitive: list[str] = []
    seen = {origin_package_id}
    queue = [origin_package_id]
    while queue:
        current = queue.pop(0)
        for child in dependents.get(current, []):
            if child in seen:
                continue
            seen.add(child)
            transitive.append(child)
            queue.append(child)
    return SectionImpactSet(
        origin_section_package_id=origin_package_id,
        direct=direct,
        transitive=transitive,
    )


def blocked_result_ids(results: list[TemplateContractGateResult]) -> list[str]:
    return [item.result_id for item in results if item.status == "blocked"]


def _result(check: GateCheck, package_id: str, failure: str | None) -> TemplateContractGateResult:
    return TemplateContractGateResult(
        gate_id=check.gate_id,
        section_package_id=package_id,
        result_id=check.result_id,
        status="blocked" if failure else "passed",
        enforcement_class="hard_blocker",
        waivable=False,
        check_kind=check.check_kind,
        message=failure or f"Template Contract Gate {check.gate_id} passed",
    )


def _result_id(package_id: str, suffix: str) -> str:
    token = "BW" if package_id == BODY_WEIGHT_PACKAGE_ID else "DISC"
    return f"TCR-{token}-{suffix}"


def _section(template: JsonObject, section_id: str) -> JsonObject | None:
    sections = template.get("sections")
    if not isinstance(sections, list):
        return None
    match = next(
        (item for item in sections if isinstance(item, dict) and item.get("section_id") == section_id),
        None,
    )
    return match if isinstance(match, dict) else None


def _field(template: JsonObject, section_id: str, field_id: str) -> JsonObject | None:
    section = _section(template, section_id)
    if section is None:
        return None
    fields = section.get("fields")
    if not isinstance(fields, list):
        return None
    match = next(
        (item for item in fields if isinstance(item, dict) and item.get("field_id") == field_id),
        None,
    )
    return match if isinstance(match, dict) else None


def _missing_field(package: JsonObject, template: JsonObject) -> str | None:
    field = _field(template, BODY_WEIGHT_SECTION_ID, BODY_WEIGHT_FIELD_ID)
    if field is None or field.get("required") is not True:
        return "Template Contract Gate body-weight-template-fields failed"
    return None


def _missing_location(package: JsonObject, template: JsonObject) -> str | None:
    field = _field(template, BODY_WEIGHT_SECTION_ID, BODY_WEIGHT_FIELD_ID)
    location = field.get("location") if field else None
    template_location = template.get("ctd_location")
    if not isinstance(template_location, str) or not template_location.strip():
        return "Template Contract Gate body-weight-template-fields failed"
    if not isinstance(location, str) or not location.strip():
        return "Template Contract Gate body-weight-template-fields failed"
    return None


def _missing_table_shape(package: JsonObject, template: JsonObject) -> str | None:
    field = _field(template, BODY_WEIGHT_SECTION_ID, BODY_WEIGHT_FIELD_ID)
    required_claim = next(
        (
            item
            for item in package.get("required_claims", [])
            if isinstance(item, dict)
            and item.get("claim_selector") == "C-BW-HIGH"
            and item.get("required") is True
        ),
        None,
    )
    shape = field.get("table_shape") if field else None
    if not isinstance(shape, dict) or required_claim is None:
        return "Template Contract Gate body-weight-table-shape failed"
    grain = shape.get("grain")
    value_columns = shape.get("value_columns")
    if (
        grain != "dose_group_x_sex"
        or field.get("expected_grain") != grain
        or required_claim.get("output_grain") != grain
        or shape.get("row_axis") != "dose_group"
        or shape.get("column_axis") != "sex"
        or not isinstance(value_columns, list)
        or value_columns != ["mean", "sd", "n"]
    ):
        return "Template Contract Gate body-weight-table-shape failed"
    return None


def _missing_label(package: JsonObject, template: JsonObject) -> str | None:
    field = _field(template, BODY_WEIGHT_SECTION_ID, BODY_WEIGHT_FIELD_ID)
    label = field.get("label") if field else None
    if not isinstance(label, str) or not label.strip():
        return "Template Contract Gate body-weight-style-policy failed"
    return None


def _missing_unit(package: JsonObject, template: JsonObject) -> str | None:
    field = _field(template, BODY_WEIGHT_SECTION_ID, BODY_WEIGHT_FIELD_ID)
    unit = field.get("unit") if field else None
    style = field.get("style_constraints") if field else None
    style_unit = style.get("unit_display") if isinstance(style, dict) else None
    if unit != "g" or style_unit != "g":
        return "Template Contract Gate body-weight-style-policy failed"
    return None


def _missing_style(package: JsonObject, template: JsonObject) -> str | None:
    field = _field(template, BODY_WEIGHT_SECTION_ID, BODY_WEIGHT_FIELD_ID)
    section = _section(template, BODY_WEIGHT_SECTION_ID)
    style = field.get("style_constraints") if field else None
    if field is None or section is None or not isinstance(style, dict):
        return "Template Contract Gate body-weight-style-policy failed"
    forbidden = style.get("forbidden_terms")
    if (
        not section.get("purpose")
        or not field.get("source_expectation")
        or not field.get("regulatory_reference_ids")
        or style.get("decimal_places") != 1
        or not isinstance(forbidden, list)
        or "treatment related" not in forbidden
    ):
        return "Template Contract Gate body-weight-style-policy failed"
    return None


def _missing_discussion_fields(package: JsonObject, template: JsonObject) -> str | None:
    section = _section(template, DISCUSSION_SECTION_ID)
    if section is None:
        return "Template Contract Gate discussion-template-fields failed"
    fields = section.get("fields")
    if not isinstance(fields, list):
        return "Template Contract Gate discussion-template-fields failed"
    required_ids = {"data-summary-analysis", "discussion", "study-conclusions", "noael"}
    present = {
        item.get("field_id")
        for item in fields
        if isinstance(item, dict)
        and item.get("required") is True
        and isinstance(item.get("label"), str)
        and item.get("label")
        and isinstance(item.get("location"), str)
        and item.get("location")
    }
    if not required_ids.issubset(present):
        return "Template Contract Gate discussion-template-fields failed"
    return None


GATE_CHECKS: tuple[GateCheck, ...] = (
    GateCheck(
        "body-weight-template-fields",
        "TCR-BW-FIELDS",
        "fields",
        BODY_WEIGHT_SECTION_ID,
        BODY_WEIGHT_FIELD_ID,
        _missing_field,
    ),
    GateCheck(
        "body-weight-template-fields",
        "TCR-BW-LOCATION",
        "locations",
        BODY_WEIGHT_SECTION_ID,
        BODY_WEIGHT_FIELD_ID,
        _missing_location,
    ),
    GateCheck(
        "body-weight-table-shape",
        "TCR-BW-TABLE-SHAPE",
        "table_shapes",
        BODY_WEIGHT_SECTION_ID,
        BODY_WEIGHT_FIELD_ID,
        _missing_table_shape,
    ),
    GateCheck(
        "body-weight-style-policy",
        "TCR-BW-LABEL",
        "labels",
        BODY_WEIGHT_SECTION_ID,
        BODY_WEIGHT_FIELD_ID,
        _missing_label,
    ),
    GateCheck(
        "body-weight-style-policy",
        "TCR-BW-UNIT",
        "units",
        BODY_WEIGHT_SECTION_ID,
        BODY_WEIGHT_FIELD_ID,
        _missing_unit,
    ),
    GateCheck(
        "body-weight-style-policy",
        "TCR-BW-STYLE",
        "style_constraints",
        BODY_WEIGHT_SECTION_ID,
        BODY_WEIGHT_FIELD_ID,
        _missing_style,
    ),
    GateCheck(
        "discussion-template-fields",
        "TCR-DISC-FIELDS",
        "fields",
        DISCUSSION_SECTION_ID,
        None,
        _missing_discussion_fields,
    ),
)
