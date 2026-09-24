import json
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator
from pydantic import ValidationError

from app.contract_schema import draft202012_validator
from app.schemas import (
    CandidateEvaluation,
    CrossSectionQueryReceipt,
    ProvenanceReceipt,
    StudyOutputEvaluationReceipt,
    TemplateConformanceReceipt,
)

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "skills" / "helix-evidence-pipeline" / "contracts"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "invalid-receipts"

RECEIPT_CASES = [
    ("provenance-receipt.schema.json", ProvenanceReceipt, "provenance.json"),
    (
        "study-output-evaluation-receipt.schema.json",
        StudyOutputEvaluationReceipt,
        "study-output.json",
    ),
    (
        "template-conformance-receipt.schema.json",
        TemplateConformanceReceipt,
        "template-conformance.json",
    ),
    ("cross-section-query-receipt.schema.json", CrossSectionQueryReceipt, "cross-section-query.json"),
    ("candidate-evaluation.schema.json", CandidateEvaluation, "candidate-evaluation.json"),
]


def load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text())


def validator_for(filename: str) -> Draft202012Validator:
    return draft202012_validator(load_json(CONTRACTS / filename), CONTRACTS)


def test_valid_receipt_fixtures_pass_schema_and_pydantic() -> None:
    for schema_name, model, fixture_name in RECEIPT_CASES:
        payload = load_json(FIXTURES.parent / "valid-receipts" / fixture_name)
        validator_for(schema_name).validate(payload)
        model.model_validate(payload)


def test_invalid_receipts_are_rejected_by_schema_and_pydantic() -> None:
    for schema_name, model, fixture_name in RECEIPT_CASES:
        for variant in ["unknown-property.json", "missing-required.json"]:
            path = FIXTURES / fixture_name.replace(".json", "") / variant
            payload = load_json(path)
            schema_errors = list(validator_for(schema_name).iter_errors(payload))
            pydantic_failed = False
            try:
                model.model_validate(payload)
            except ValidationError:
                pydantic_failed = True
            assert schema_errors, f"{path} must fail JSON Schema"
            assert pydantic_failed, f"{path} must fail Pydantic"


def test_unknown_property_is_rejected_from_a_valid_receipt() -> None:
    payload = load_json(FIXTURES.parent / "valid-receipts" / "provenance.json")
    mutated = deepcopy(payload)
    mutated["invented"] = True
    assert list(validator_for("provenance-receipt.schema.json").iter_errors(mutated))
    try:
        ProvenanceReceipt.model_validate(mutated)
        raise AssertionError("Pydantic accepted an unknown property")
    except ValidationError:
        pass


NESTED_RECEIPT_FIELDS = (
    "provenance_receipt",
    "study_output_evaluation_receipt",
    "template_conformance_receipt",
)


def test_unknown_nested_receipt_properties_fail_schema_and_pydantic() -> None:
    payload = load_json(FIXTURES.parent / "valid-receipts" / "candidate-evaluation.json")
    validator = validator_for("candidate-evaluation.schema.json")
    for field in NESTED_RECEIPT_FIELDS:
        mutated = deepcopy(payload)
        nested = mutated[field]
        assert isinstance(nested, dict)
        nested["invented"] = True
        schema_errors = list(validator.iter_errors(mutated))
        assert schema_errors, f"JSON Schema must reject unknown properties on {field}"
        named = [(list(error.path), error.message) for error in schema_errors]
        assert any(
            path == [field] and "invented" in message for path, message in named
        ), f"JSON Schema must name {field}.invented, got {named}"
        try:
            CandidateEvaluation.model_validate(mutated)
            raise AssertionError(f"Pydantic accepted an unknown property on {field}")
        except ValidationError as error:
            assert "invented" in str(error)
            assert "extra_forbidden" in str(error)
