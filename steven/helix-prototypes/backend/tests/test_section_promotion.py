import json
from dataclasses import replace
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.contract_schema import draft202012_validator
from app.schemas import BoundDisposition, PromotionCommand, SectionDraft
from app.section_promotion import (
    PromotionSnapshot,
    ReviewRequiredFact,
    build_section_draft,
    decide_promotion,
)

HASH_A = "sha256:" + "a" * 64
HASH_B = "sha256:" + "b" * 64
HASH_C = "sha256:" + "c" * 64
DEP_A = "sha256:" + "d" * 64
DEP_B = "sha256:" + "e" * 64
CONTRACTS = Path(__file__).resolve().parents[2] / "skills" / "helix-evidence-pipeline" / "contracts"


def current_disposition(**overrides: object) -> BoundDisposition:
    payload = {
        "disposition_id": "RD-CURRENT001",
        "result_id": "SOE-FAIL000001",
        "decision": "approved_exception",
        "artifact_hash": HASH_A,
        "dependency_fingerprint": DEP_A,
    }
    payload.update(overrides)
    return BoundDisposition.model_validate(payload)


def eligible_snapshot(**overrides: object) -> PromotionSnapshot:
    snapshot = PromotionSnapshot(
        candidate_id="SDC-PROMOTE0001",
        candidate_hash=HASH_A,
        content_hash=HASH_C,
        run_id="SRUN-PROMOTE0001",
        section_id="5_2_3_body_weight",
        package_maturity="complete",
        promotion_allowed=True,
        provenance_passed=True,
        conformance_passed=True,
        hard_blocker_ids=(),
        review_required=(),
        warnings=(),
        dependency_fingerprint=DEP_A,
        dispositions=(),
        gate_decision_ids=("PRV-PROMOTE0001", "TCF-PROMOTE0001"),
    )
    return replace(snapshot, **overrides)


def assert_schema(filename: str, payload: dict[str, object]) -> None:
    schema = json.loads((CONTRACTS / filename).read_text())
    errors = list(draft202012_validator(schema, CONTRACTS).iter_errors(payload))
    assert errors == [], errors


def test_all_true_snapshot_is_eligible_and_builds_a_schema_valid_draft() -> None:
    snapshot = eligible_snapshot()
    decision = decide_promotion(snapshot)
    assert decision.eligible is True
    assert decision.failed_condition_ids == []
    assert [item.condition_id for item in decision.conditions] == [
        "package_permission",
        "no_hard_blocker",
        "provenance_passed",
        "conformance_passed",
        "review_required_current",
    ]
    assert all(item.passed for item in decision.conditions)
    draft = build_section_draft(snapshot, decision, "2026-09-24T12:00:00Z")
    assert draft.status == "section_draft"
    assert draft.candidate_hash == HASH_A
    assert draft.content_hash == HASH_C
    assert "PRV-PROMOTE0001" in draft.gate_decision_ids
    assert "TCF-PROMOTE0001" in draft.gate_decision_ids
    assert draft.bound_dispositions == []
    SectionDraft.model_validate(draft.model_dump(mode="json"))
    assert_schema("section-draft.schema.json", draft.model_dump(mode="json"))
    assert_schema("section-promotion-decision.schema.json", decision.model_dump(mode="json"))


@pytest.mark.parametrize(
    ("overrides", "failed"),
    [
        ({"hard_blocker_ids": ("PRV-BLOCK",)}, "no_hard_blocker"),
        (
            {
                "review_required": (ReviewRequiredFact(result_id="SOE-FAIL000001"),),
                "dispositions": (),
            },
            "review_required_current",
        ),
        ({"provenance_passed": False}, "provenance_passed"),
        ({"conformance_passed": False}, "conformance_passed"),
        ({"package_maturity": "vertical_slice", "promotion_allowed": False}, "package_permission"),
        ({"promotion_allowed": False}, "package_permission"),
    ],
)
def test_each_false_condition_rejects_promotion(overrides: dict[str, object], failed: str) -> None:
    decision = decide_promotion(eligible_snapshot(**overrides))
    assert decision.eligible is False
    assert failed in decision.failed_condition_ids
    with pytest.raises(Exception, match="rejected"):
        build_section_draft(eligible_snapshot(**overrides), decision, "2026-09-24T12:00:00Z")


def test_warnings_do_not_block_an_otherwise_eligible_snapshot() -> None:
    decision = decide_promotion(eligible_snapshot(warnings=("Rounding display difference",)))
    assert decision.eligible is True
    assert decision.warnings == ["Rounding display difference"]


def test_current_disposition_satisfies_failed_review_required() -> None:
    snapshot = eligible_snapshot(
        review_required=(ReviewRequiredFact(result_id="SOE-FAIL000001"),),
        dispositions=(current_disposition(),),
    )
    decision = decide_promotion(snapshot)
    assert decision.eligible is True
    assert decision.current_disposition_ids == ["RD-CURRENT001"]
    draft = build_section_draft(snapshot, decision, "2026-09-24T12:00:00Z")
    assert draft.bound_dispositions[0].disposition_id == "RD-CURRENT001"
    assert draft.bound_dispositions[0].artifact_hash == HASH_A


def test_changed_candidate_hash_makes_the_disposition_stale() -> None:
    snapshot = eligible_snapshot(
        candidate_hash=HASH_B,
        review_required=(ReviewRequiredFact(result_id="SOE-FAIL000001"),),
        dispositions=(current_disposition(),),
    )
    decision = decide_promotion(snapshot)
    assert decision.eligible is False
    assert "review_required_current" in decision.failed_condition_ids


def test_changed_dependency_fingerprint_makes_the_disposition_stale() -> None:
    snapshot = eligible_snapshot(
        dependency_fingerprint=DEP_B,
        review_required=(ReviewRequiredFact(result_id="SOE-FAIL000001"),),
        dispositions=(current_disposition(),),
    )
    decision = decide_promotion(snapshot)
    assert decision.eligible is False
    assert "review_required_current" in decision.failed_condition_ids


def test_vertical_slice_rejects_even_when_every_other_condition_is_true() -> None:
    decision = decide_promotion(
        eligible_snapshot(package_maturity="vertical_slice", promotion_allowed=True)
    )
    assert decision.eligible is False
    assert decision.failed_condition_ids == ["package_permission"]
    package = next(item for item in decision.conditions if item.condition_id == "package_permission")
    assert package.reason == "vertical_slice packages cannot be promoted"


def test_promotion_command_rejects_client_authored_status() -> None:
    with pytest.raises(ValidationError):
        PromotionCommand.model_validate(
            {"idempotency_key": "promote-client-status", "status": "promoted"}
        )
    with pytest.raises(ValidationError):
        PromotionCommand.model_validate(
            {"idempotency_key": "promote-client-eligible", "eligible": True}
        )


def test_vertical_slice_api_rejects_promotion_and_records_backend_evidence() -> None:
    from test_candidate_evaluations import draft
    from test_section_runs import STUDY_ID, FakeSectionAgent, build_client, validate

    agent = FakeSectionAgent("conforming")
    client, _ = build_client(agent)
    with client:
        validate(client)
        recorded = draft(client, key="promote-vertical-slice")
        evaluation = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/evaluations",
            json={"idempotency_key": "evaluate-promote-vertical-slice"},
        )
        assert evaluation.status_code == 201, evaluation.text
        workspace_after_eval = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        promoted = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/promotions",
            json={"idempotency_key": "promote-vertical-slice-v1"},
        )
        replay = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/promotions",
            json={"idempotency_key": "promote-vertical-slice-v1"},
        )
        client_status = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/promotions",
            json={"idempotency_key": "promote-client-status", "status": "promoted"},
        )
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()

    assert promoted.status_code == 409, promoted.text
    assert replay.status_code == 409, replay.text
    assert "package_permission" in promoted.json()["detail"]
    assert client_status.status_code == 422
    assert workspace_after_eval["promotion_decisions"][-1]["eligible"] is False
    assert "package_permission" in workspace_after_eval["promotion_decisions"][-1]["failed_condition_ids"]
    decision = workspace["promotion_decisions"][-1]
    assert decision["eligible"] is False
    assert "package_permission" in decision["failed_condition_ids"]
    assert workspace["section_drafts"] == []
    package_condition = next(
        item for item in decision["conditions"] if item["condition_id"] == "package_permission"
    )
    assert package_condition["passed"] is False


def test_agent_and_codex_cannot_author_promotion_status() -> None:
    from test_section_runs import COMMAND, STUDY_ID, FakeSectionAgent, build_client, validate

    for mode in ("agent_promoted", "codex_promoted"):
        client, _ = build_client(FakeSectionAgent(mode))
        with client:
            validate(client)
            response = client.post(
                f"/api/v1/studies/{STUDY_ID}/section-runs",
                json={**COMMAND, "idempotency_key": f"{mode}-key"},
            )
        assert response.status_code == 422, response.text


def test_promptfoo_receipt_cannot_author_promotion_status() -> None:
    from app.schemas import StudyOutputEvaluationReceipt

    payload = {
        "schema_version": "helix.study-output-evaluation-receipt/v1",
        "receipt_id": "SOE-VALID000001",
        "candidate_id": "SDC-VALID000001",
        "candidate_hash": HASH_A,
        "suite_id": "helix-section-study-output",
        "suite_version": "0.1.0",
        "suite_hash": HASH_B,
        "status": "passed",
        "enforcement_class": "review_required",
        "waivable": False,
        "results": [{"assertion": "is-json", "status": "passed", "message": "ok"}],
        "promotion_status": "promoted",
    }
    with pytest.raises(ValidationError):
        StudyOutputEvaluationReceipt.model_validate(payload)

    mutated = json.loads(
        (Path(__file__).resolve().parent / "fixtures" / "valid-receipts" / "study-output.json").read_text()
    )
    mutated["promotion_status"] = "promoted"
    with pytest.raises(ValidationError):
        StudyOutputEvaluationReceipt.model_validate(mutated)


def test_soe_disposition_is_artifact_bound_and_vertical_slice_still_rejects() -> None:
    from test_candidate_evaluations import draft
    from test_section_runs import STUDY_ID, FakeSectionAgent, build_client, validate

    client, _ = build_client(FakeSectionAgent("conforming_advisory_fail"))
    with client:
        validate(client)
        recorded = draft(client, key="soe-disposition")
        evaluation = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/evaluations",
            json={"idempotency_key": "evaluate-soe-disposition"},
        )
        assert evaluation.status_code == 201, evaluation.text
        soe_id = evaluation.json()["study_output_evaluation_receipt"]["receipt_id"]
        disposition = client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-results/{soe_id}/dispositions",
            json={
                "decision": "approved_exception",
                "reason": "Advisory study-output failure reviewed against the exact candidate.",
                "reviewer": "Dr. Ada Path",
            },
        )
        assert disposition.status_code == 200, disposition.text
        body = disposition.json()
        bound = next(item for item in body["dispositions"] if item["result_id"] == soe_id)
        assert bound["artifact_hash"] == evaluation.json()["candidate_hash"]
        assert bound["dependency_fingerprint"].startswith("sha256:")
        latest = body["promotion_decisions"][-1]
        review = next(
            item for item in latest["conditions"] if item["condition_id"] == "review_required_current"
        )
        assert review["passed"] is True
        assert latest["current_disposition_ids"]
        assert "package_permission" in latest["failed_condition_ids"]
        promoted = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/promotions",
            json={"idempotency_key": "promote-after-soe-disposition"},
        )
        assert promoted.status_code == 409
        assert "package_permission" in promoted.json()["detail"]
        assert body["section_drafts"] == []


def test_discussion_and_body_weight_packages_are_unpromotable() -> None:
    from test_section_runs import ROOT

    from app.section_promotion import section_package_definition

    for package_id in ("section.5_2_3_body_weight", "section.5_3_discussion"):
        definition = section_package_definition(ROOT, package_id)
        assert definition["maturity"] == "vertical_slice"
        assert definition["promotion_allowed"] is False
        decision = decide_promotion(
            eligible_snapshot(
                package_maturity=str(definition["maturity"]),
                promotion_allowed=bool(definition["promotion_allowed"]),
            )
        )
        assert decision.eligible is False
        assert "package_permission" in decision.failed_condition_ids
