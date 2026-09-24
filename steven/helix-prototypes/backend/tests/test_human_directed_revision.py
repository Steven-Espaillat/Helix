import json
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator
from pydantic import ValidationError
from sqlalchemy import select
from test_candidate_attempts import evaluate
from test_candidate_evaluations import draft
from test_review_scaffold_versioning import approve, dispose
from test_section_runs import COMMAND, ROOT, STUDY_ID, FakeSectionAgent, build_client, validate

from app.contract_schema import draft202012_validator
from app.database import create_session_factory
from app.drafting_cycles import DRAFTING_CYCLE_ID
from app.models import SectionDraftRow, SectionRunRow
from app.repository import StudyPackageRepository
from app.schemas import (
    DraftingCycle,
    HumanDirectedRevisionCommand,
    HumanDirectedRevisionReceipt,
    SectionDraft,
)
from app.section_runs import SectionRunService

CONTRACTS = ROOT / "skills" / "helix-evidence-pipeline" / "contracts"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "invalid-receipts"
VALID = Path(__file__).resolve().parent / "fixtures" / "valid-receipts"
BODY_WEIGHT = "section.5_2_3_body_weight"
DISCUSSION = "section.5_3_discussion"
REVISION = {
    "section_package_id": BODY_WEIGHT,
    "actor": "Dr. Ada Path",
    "idempotency_key": "workbench-STUDY-HLX-028-revise-body-weight-v1",
}


def load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text())


def validator_for(filename: str) -> Draft202012Validator:
    return draft202012_validator(load_json(CONTRACTS / filename), CONTRACTS)


def revise(client, *, key: str = REVISION["idempotency_key"]):
    response = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-revisions",
        json={**REVISION, "idempotency_key": key},
    )
    assert response.status_code == 201, response.text
    return response.json()


def fail_attempts(client, prefix: str, count: int = 3) -> list[dict[str, object]]:
    receipts: list[dict[str, object]] = []
    for attempt in range(1, count + 1):
        receipt = draft(client, key=f"{prefix}-attempt-{attempt}")
        evaluate(client, receipt["run_id"], f"{prefix}-eval-{attempt}")
        receipts.append(receipt)
    return receipts


def inject_section_draft(engine, recorded: dict[str, object]) -> None:
    session = create_session_factory(engine)()
    try:
        repository = StudyPackageRepository(session)
        repository.add_section_draft(
            study_id=STUDY_ID,
            run_id=recorded["run_id"],
            candidate_id=recorded["candidate_id"],
            idempotency_key="revision-preserved-draft",
            request_hash="sha256:" + "3" * 64,
            draft=SectionDraft.model_validate(
                {
                    "schema_version": "helix.section-draft/v1",
                    "status": "section_draft",
                    "draft_id": "SD-REV000000001",
                    "run_id": recorded["run_id"],
                    "section_id": "5_2_3_body_weight",
                    "candidate_id": recorded["candidate_id"],
                    "candidate_hash": recorded["candidate_hash"],
                    "content_hash": recorded["candidate_hash"],
                    "promoted_at": "2026-09-24T12:00:00Z",
                    "gate_decision_ids": ["PRV-REV0000001"],
                    "bound_dispositions": [],
                }
            ),
        )
        session.commit()
    finally:
        session.close()


def test_first_draft_without_revision_uses_implicit_cycle() -> None:
    agent = FakeSectionAgent()
    client, engine = build_client(agent)
    with client:
        validate(client)
        recorded = draft(client, key="implicit-cycle-attempt-1")
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        assert recorded["candidate_id"]
        assert workspace["section_runs"][0]["candidate"]["drafting_cycle_id"] == DRAFTING_CYCLE_ID
        assert workspace["section_runs"][0]["candidate"]["attempt"] == 1
        assert workspace["drafting_cycles"][0]["cycle_id"] == DRAFTING_CYCLE_ID
        assert workspace["can_open_revision"] is False
    engine.dispose()


def test_revision_preserves_prior_candidates_and_injected_draft() -> None:
    agent = FakeSectionAgent("unsupported_value")
    client, engine = build_client(agent)
    with client:
        validate(client)
        first_cycle = fail_attempts(client, "preserve")
        inject_section_draft(engine, first_cycle[-1])
        before = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        receipt = revise(client)
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        assert receipt["cycle"]["predecessor_cycle_id"] == DRAFTING_CYCLE_ID
        assert receipt["cycle"]["cycle_id"] != DRAFTING_CYCLE_ID
        assert [item["receipt"]["run_id"] for item in workspace["section_runs"]] == [
            item["receipt"]["run_id"] for item in before["section_runs"]
        ]
        assert [item["receipt"]["candidate_id"] for item in workspace["section_runs"]] == [
            item["receipt"]["candidate_id"] for item in before["section_runs"]
        ]
        assert [item["draft_id"] for item in workspace["section_drafts"]] == ["SD-REV000000001"]
        with client.app.state.session_factory() as session:
            runs = session.scalars(select(SectionRunRow)).all()
            drafts = session.scalars(select(SectionDraftRow)).all()
            assert len(runs) == 3
            assert [row.candidate["candidate_id"] for row in runs if row.candidate] == [
                item["candidate_id"] for item in first_cycle
            ]
            assert len(drafts) == 1
            assert drafts[0].draft["draft_id"] == "SD-REV000000001"
    engine.dispose()


def test_new_cycle_has_its_own_three_attempt_cap() -> None:
    agent = FakeSectionAgent("unsupported_value")
    client, engine = build_client(agent)
    with client:
        validate(client)
        first_cycle = fail_attempts(client, "cap-one")
        receipt = revise(client)
        second_cycle = fail_attempts(client, "cap-two")
        fourth = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs",
            json={**COMMAND, "idempotency_key": "cap-two-attempt-4"},
        )
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        by_cycle = {}
        for item in workspace["section_runs"]:
            by_cycle.setdefault(item["candidate"]["drafting_cycle_id"], []).append(
                item["candidate"]["attempt"]
            )
        assert by_cycle[DRAFTING_CYCLE_ID] == [1, 2, 3]
        assert by_cycle[receipt["cycle"]["cycle_id"]] == [1, 2, 3]
        assert fourth.status_code == 409
        assert "three Candidate Attempts" in fourth.json()["detail"]
        assert len(workspace["section_runs"]) == 6
        assert [item["run_id"] for item in first_cycle] == [
            item["receipt"]["run_id"]
            for item in workspace["section_runs"]
            if item["candidate"]["drafting_cycle_id"] == DRAFTING_CYCLE_ID
        ]
        assert [item["run_id"] for item in second_cycle] == [
            item["receipt"]["run_id"]
            for item in workspace["section_runs"]
            if item["candidate"]["drafting_cycle_id"] == receipt["cycle"]["cycle_id"]
        ]
    engine.dispose()


def test_new_cycle_evaluation_mints_fresh_receipts() -> None:
    agent = FakeSectionAgent("unsupported_value")
    client, engine = build_client(agent)
    with client:
        validate(client)
        first_cycle = fail_attempts(client, "fresh")
        prior = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()["candidate_evaluations"][-1]
        revise(client)
        recorded = draft(client, key="fresh-cycle-2-attempt-1")
        evaluation = evaluate(client, recorded["run_id"], "fresh-cycle-2-eval-1")
        assert evaluation["evaluation_id"] != prior["evaluation_id"]
        assert evaluation["provenance_receipt"]["receipt_id"] != prior["provenance_receipt"]["receipt_id"]
        assert (
            evaluation["study_output_evaluation_receipt"]["receipt_id"]
            != prior["study_output_evaluation_receipt"]["receipt_id"]
        )
        assert (
            evaluation["template_conformance_receipt"]["receipt_id"]
            != prior["template_conformance_receipt"]["receipt_id"]
        )
        assert evaluation["hashes"] != prior["hashes"]
        assert evaluation["candidate_hash"] != prior["candidate_hash"]
        assert recorded["run_id"] != first_cycle[-1]["run_id"]
    engine.dispose()


def test_revision_does_not_rerun_discussion_or_invoke_codex() -> None:
    agent = FakeSectionAgent("unsupported_value")
    client, engine = build_client(agent)
    with client:
        validate(client)
        fail_attempts(client, "discussion")
        before = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        calls_before = agent.calls
        revise(client)
        after = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        assert agent.calls == calls_before
        assert [item["receipt"]["run_id"] for item in after["section_runs"]] == [
            item["receipt"]["run_id"] for item in before["section_runs"]
        ]
        discussion_before = next(
            item
            for item in before["section_run_eligibility"]
            if item["section_package_id"] == DISCUSSION
        )
        discussion_after = next(
            item
            for item in after["section_run_eligibility"]
            if item["section_package_id"] == DISCUSSION
        )
        assert discussion_after["impact_set"] == discussion_before["impact_set"]
        assert discussion_after["eligible"] == discussion_before["eligible"]
        assert discussion_after["gate_results"] == discussion_before["gate_results"]
        assert all(
            item["receipt"]["section_package_id"] == BODY_WEIGHT for item in after["section_runs"]
        )
    engine.dispose()


def test_revision_marks_bound_disposition_and_approval_stale() -> None:
    agent = FakeSectionAgent("conforming_advisory_fail")
    client, engine = build_client(agent)
    with client:
        validation = client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-runs",
            json={"planner": "fixture"},
        )
        assert validation.status_code == 201
        recorded = draft(client, key="stale-bind-attempt-1")
        evaluation = evaluate(client, recorded["run_id"], "stale-bind-eval-1")
        soe_id = evaluation["study_output_evaluation_receipt"]["receipt_id"]
        workspace = dispose(
            client,
            soe_id,
            "approved_exception",
            "Advisory study-output failure reviewed against the exact candidate.",
        )
        disposition_id = next(
            item["disposition_id"]
            for item in workspace["dispositions"]
            if item["result_id"] == soe_id
        )
        for result in validation.json()["results"]:
            if result["status"] == "fail" and result["severity"] == "blocker":
                dispose(
                    client,
                    result["result_id"],
                    "approved_exception" if result["result_id"] == "VR-006" else "corrected",
                    f"Synthetic disposition recorded for {result['rule_id']}.",
                )
        approved = approve(client, "pathologist", "Dr. Ada Path", "Scientific review complete")
        approval_id = next(
            item["approval_id"] for item in approved["approvals"] if item["role"] == "pathologist"
        )
        assert next(item for item in approved["approvals"] if item["approval_id"] == approval_id)[
            "artifact_hash"
        ]
        receipt = revise(client, key="stale-bind-revise-v1")
        latest = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()["review_scaffold_revisions"][-1]
        context = latest["overall_study_context"]
        assert disposition_id in receipt["stale_disposition_ids"]
        assert soe_id in receipt["stale_disposition_ids"]
        assert approval_id in receipt["stale_approval_ids"]
        assert disposition_id in context["stale_disposition_ids"]
        assert soe_id in context["stale_disposition_ids"]
        assert approval_id in context["stale_approval_ids"]
    engine.dispose()


def test_stored_cycle_impact_set_includes_injected_dependent(monkeypatch) -> None:
    original = SectionRunService._section_package_definitions

    def with_dependent(self):
        return [
            *original(self),
            {"package_id": "section.dependent", "depends_on": [BODY_WEIGHT]},
        ]

    monkeypatch.setattr(SectionRunService, "_section_package_definitions", with_dependent)
    agent = FakeSectionAgent("unsupported_value")
    client, engine = build_client(agent)
    with client:
        validate(client)
        fail_attempts(client, "impact")
        receipt = revise(client, key="impact-revise-v1")
        impact = receipt["cycle"]["impact_set"]
        assert BODY_WEIGHT in impact["direct"]
        assert "section.dependent" in impact["transitive"]
        assert DISCUSSION not in impact["direct"]
        assert DISCUSSION not in impact["transitive"]
        stored = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()["drafting_cycles"][-1]
        assert stored["impact_set"] == impact
        scaffold_sets = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()[
            "review_scaffold_revisions"
        ][-1]["section_impact_sets"]
        assert any(
            item["origin_section_package_id"] == BODY_WEIGHT
            and "section.dependent" in item["transitive"]
            for item in scaffold_sets
        )
    engine.dispose()


def test_hold_allows_revision_and_new_cycle_attempt() -> None:
    agent = FakeSectionAgent("conforming")
    client, engine = build_client(agent)
    with client:
        validate(client)
        held = draft(client, key="hold-revise-attempt-1")
        body = evaluate(client, held["run_id"], "hold-revise-eval-1")
        assert body["next_attempt_decision"]["action"] == "hold"
        blocked = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs",
            json={**COMMAND, "idempotency_key": "hold-revise-attempt-2"},
        )
        assert blocked.status_code == 409
        before = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        assert before["can_open_revision"] is True
        receipt = revise(client, key="hold-revise-v1")
        recorded = draft(client, key="hold-cycle-2-attempt-1")
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        assert recorded["run_id"] != held["run_id"]
        assert workspace["section_runs"][-1]["candidate"]["drafting_cycle_id"] == receipt["cycle"][
            "cycle_id"
        ]
        assert workspace["section_runs"][-1]["candidate"]["attempt"] == 1
        assert [item["receipt"]["run_id"] for item in workspace["section_runs"][:1]] == [
            item["receipt"]["run_id"] for item in before["section_runs"]
        ]
        assert workspace["can_open_revision"] is False
    engine.dispose()


def test_revision_rejects_empty_successor_stack() -> None:
    agent = FakeSectionAgent("unsupported_value")
    client, engine = build_client(agent)
    with client:
        validate(client)
        fail_attempts(client, "stack")
        first = revise(client, key="stack-revise-v1")
        stacked = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-revisions",
            json={**REVISION, "idempotency_key": "stack-revise-v2"},
        )
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        assert stacked.status_code == 409
        assert "current cycle" in stacked.json()["detail"]
        assert [item["cycle_id"] for item in workspace["drafting_cycles"]].count(
            first["cycle"]["cycle_id"]
        ) == 1
        assert workspace["can_open_revision"] is False
    engine.dispose()


def test_unknown_package_and_idempotent_replay() -> None:
    agent = FakeSectionAgent("unsupported_value")
    client, engine = build_client(agent)
    with client:
        validate(client)
        fail_attempts(client, "replay")
        unknown = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-revisions",
            json={**REVISION, "section_package_id": "section.unknown", "idempotency_key": "unknown-pkg"},
        )
        assert unknown.status_code == 404
        first = revise(client, key="replay-revise-v1")
        replay = revise(client, key="replay-revise-v1")
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        assert replay["idempotent_replay"] is True
        assert replay["cycle"]["cycle_id"] == first["cycle"]["cycle_id"]
        assert [item["cycle_id"] for item in workspace["drafting_cycles"]].count(
            first["cycle"]["cycle_id"]
        ) == 1
        mismatched = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-revisions",
            json={
                **REVISION,
                "actor": "Dr. Other Reviewer",
                "idempotency_key": "replay-revise-v1",
            },
        )
        assert mismatched.status_code == 409
    engine.dispose()


def test_command_and_cycle_schemas_reject_unknown_and_missing() -> None:
    cases = [
        (
            "human-directed-revision-command.schema.json",
            HumanDirectedRevisionCommand,
            "human-directed-revision-command.json",
        ),
        ("drafting-cycle.schema.json", DraftingCycle, "drafting-cycle.json"),
    ]
    for schema_name, model, fixture_name in cases:
        payload = load_json(VALID / fixture_name)
        validator_for(schema_name).validate(payload)
        model.model_validate(payload)
        for variant in ["unknown-property.json", "missing-required.json"]:
            path = FIXTURES / fixture_name.replace(".json", "") / variant
            invalid = load_json(path)
            schema_errors = list(validator_for(schema_name).iter_errors(invalid))
            pydantic_failed = False
            try:
                model.model_validate(invalid)
            except ValidationError:
                pydantic_failed = True
            assert schema_errors, f"{path} must fail JSON Schema"
            assert pydantic_failed, f"{path} must fail Pydantic"


def test_revision_receipt_rejects_unknown_properties() -> None:
    payload = {
        "cycle": load_json(VALID / "drafting-cycle.json"),
        "stale_disposition_ids": [],
        "stale_approval_ids": [],
        "review_scaffold_revision": 4,
        "invented": True,
    }
    mutated = deepcopy(payload)
    try:
        HumanDirectedRevisionReceipt.model_validate(mutated)
        raise AssertionError("Pydantic accepted an unknown property on the receipt")
    except ValidationError as error:
        assert "invented" in str(error)
        assert "extra_forbidden" in str(error)
