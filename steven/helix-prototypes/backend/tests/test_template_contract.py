import json
from pathlib import Path

from app.template_contracts import evaluate_template_contract, impact_set_for

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "backend/app/data/report-template.json"
BODY_WEIGHT = ROOT / "skills/helix-evidence-pipeline/packages/sections/5_2_3_body_weight/package.json"
DISCUSSION = ROOT / "skills/helix-evidence-pipeline/packages/sections/5_3_discussion/package.json"


def _load(path: Path) -> dict[str, object]:
    return json.loads(path.read_text())


def _body_weight_field(template: dict[str, object]) -> dict[str, object]:
    section = next(item for item in template["sections"] if item["section_id"] == "S5")
    return next(item for item in section["fields"] if item["field_id"] == "body-weight")


def _blocked(results, gate_id: str, check_kind: str) -> None:
    match = next(
        item for item in results if item.gate_id == gate_id and item.check_kind == check_kind
    )
    assert match.status == "blocked"
    assert match.waivable is False
    assert match.enforcement_class == "hard_blocker"


def test_passing_template_contract_covers_every_declared_aspect() -> None:
    body_weight = evaluate_template_contract(_load(BODY_WEIGHT), _load(TEMPLATE))
    discussion = evaluate_template_contract(_load(DISCUSSION), _load(TEMPLATE))

    assert {item.status for item in body_weight} == {"passed"}
    assert {item.check_kind for item in body_weight} == {
        "fields",
        "locations",
        "table_shapes",
        "labels",
        "units",
        "style_constraints",
    }
    assert {item.status for item in discussion} == {"passed"}
    assert all(item.waivable is False for item in [*body_weight, *discussion])


def test_missing_field_location_shape_label_unit_and_style_each_block() -> None:
    template = _load(TEMPLATE)
    field = _body_weight_field(template)
    package = _load(BODY_WEIGHT)

    field["required"] = False
    _blocked(evaluate_template_contract(package, template), "body-weight-template-fields", "fields")

    field["required"] = True
    field["location"] = ""
    _blocked(evaluate_template_contract(package, template), "body-weight-template-fields", "locations")

    field["location"] = "Module 4.2.3.2 / 5.2.3 Body Weight"
    field["table_shape"]["grain"] = "dose_group"
    _blocked(evaluate_template_contract(package, template), "body-weight-table-shape", "table_shapes")

    field["table_shape"]["grain"] = "dose_group_x_sex"
    field["label"] = ""
    _blocked(evaluate_template_contract(package, template), "body-weight-style-policy", "labels")

    field["label"] = "Body weight and changes by sex and dose"
    field["unit"] = "kg"
    _blocked(evaluate_template_contract(package, template), "body-weight-style-policy", "units")

    field["unit"] = "g"
    field["style_constraints"]["decimal_places"] = 3
    _blocked(evaluate_template_contract(package, template), "body-weight-style-policy", "style_constraints")


def test_discussion_template_fields_block_independently_of_body_weight() -> None:
    template = _load(TEMPLATE)
    section = next(item for item in template["sections"] if item["section_id"] == "S8")
    noael = next(item for item in section["fields"] if item["field_id"] == "noael")
    noael["location"] = ""

    discussion = evaluate_template_contract(_load(DISCUSSION), template)
    body_weight = evaluate_template_contract(_load(BODY_WEIGHT), template)

    assert any(item.status == "blocked" for item in discussion)
    assert {item.status for item in body_weight} == {"passed"}


def test_impact_set_keeps_siblings_out_and_records_transitive_dependents() -> None:
    definitions = [
        {"package_id": "section.5_2_3_body_weight", "depends_on": ["validation.body_weight"]},
        {"package_id": "section.5_3_discussion", "depends_on": ["validation.body_weight"]},
        {"package_id": "section.dependent", "depends_on": ["section.5_2_3_body_weight"]},
    ]

    impact = impact_set_for("section.5_2_3_body_weight", definitions)

    assert impact.direct == ["section.5_2_3_body_weight"]
    assert impact.transitive == ["section.dependent"]
    assert "section.5_3_discussion" not in impact.direct
    assert "section.5_3_discussion" not in impact.transitive
