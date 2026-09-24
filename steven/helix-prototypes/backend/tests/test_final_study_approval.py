import json
from copy import deepcopy
from pathlib import Path

from pydantic import ValidationError
from test_candidate_evaluations import draft
from test_review_scaffold_versioning import approve, dispose
from test_section_runs import STUDY_ID, FakeSectionAgent, build_client, governed_root, validate
from test_superseding_runs import mutate_discussion, supersede, workspace

from app.contract_schema import draft202012_validator
from app.review_scaffolds import ExportAdmissionError, admit_export_document
from app.schemas import FinalStudyApproval, ReleaseCandidate

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "skills" / "helix-evidence-pipeline" / "contracts"
VALID = Path(__file__).resolve().parent / "fixtures" / "valid-receipts"
INVALID = Path(__file__).resolve().parent / "fixtures" / "invalid-receipts"

CASES = [
    ("release-candidate.schema.json", ReleaseCandidate, "release-candidate.json"),
    ("final-study-approval.schema.json", FinalStudyApproval, "final-study-approval.json"),
]

ROLES = [
    ("pathologist", "Dr. Ada Path", "Scientific review complete"),
    ("peer_reviewer", "Dr. Priya Peer", "Independent pathology review complete"),
    ("qau", "Morgan QA", "Quality assurance statement recorded"),
    ("study_director", "Dr. Sam Director", "Final report approval"),
]


def load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text())


def validator_for(filename: str):
    return draft202012_validator(load_json(CONTRACTS / filename), CONTRACTS)


def record_fsa(client, key: str = "final-study-approval-v1"):
    return client.post(
        f"/api/v1/studies/{STUDY_ID}/final-study-approvals",
        json={"reviewer": "Dr. Sam Director", "idempotency_key": key},
    )


def clear_blockers(client) -> None:
    validation = client.post(
        f"/api/v1/studies/{STUDY_ID}/validation-runs",
        json={"planner": "fixture"},
    )
    assert validation.status_code == 201, validation.text
    for result in validation.json()["results"]:
        if result["status"] == "fail" and result["severity"] == "blocker":
            dispose(
                client,
                result["result_id"],
                "approved_exception" if result["result_id"] == "VR-006" else "corrected",
                f"Synthetic disposition recorded for {result['rule_id']}.",
            )


def record_roles(client) -> dict[str, object]:
    body = {}
    for role, reviewer, meaning in ROLES:
        body = approve(client, role, reviewer, meaning)
    return body


def test_valid_receipt_fixtures_pass_schema_and_pydantic() -> None:
    for schema_name, model, fixture_name in CASES:
        payload = load_json(VALID / fixture_name)
        validator_for(schema_name).validate(payload)
        model.model_validate(payload)


def test_invalid_receipts_are_rejected_by_schema_and_pydantic() -> None:
    for schema_name, model, fixture_name in CASES:
        stem = fixture_name.replace(".json", "")
        for variant in ["unknown-property.json", "missing-required.json", "incomplete-hash.json"]:
            path = INVALID / stem / variant
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
    for schema_name, model, fixture_name in CASES:
        payload = deepcopy(load_json(VALID / fixture_name))
        payload["invented"] = True
        assert list(validator_for(schema_name).iter_errors(payload))
        try:
            model.model_validate(payload)
            raise AssertionError("Pydantic accepted an unknown property")
        except ValidationError:
            pass


def test_review_scaffold_still_fails_release_candidate_schema() -> None:
    client, engine = build_client(FakeSectionAgent())
    with client:
        validate(client)
        revisions = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()["review_scaffold_revisions"]
        assert revisions
        latest = revisions[-1]
        assert list(validator_for("release-candidate.schema.json").iter_errors(latest))
        failed = False
        try:
            admit_export_document(latest)
        except ExportAdmissionError:
            failed = True
        assert failed is True
    engine.dispose()


def test_final_study_approval_binds_manifest_and_included_hashes() -> None:
    client, engine = build_client(FakeSectionAgent())
    with client:
        clear_blockers(client)
        signed = record_roles(client)
        assert signed["release_gate"]["status"] == "ready_for_signature"
        assert signed["approval_current"] is False
        first = record_fsa(client)
        assert first.status_code == 200, first.text
        body = first.json()
        candidate = body["release_candidate"]
        approval = body["final_study_approval"]
        validator_for("release-candidate.schema.json").validate(candidate)
        validator_for("final-study-approval.schema.json").validate(approval)
        assert candidate["status"] == "release_candidate"
        assert candidate["export_eligible"] is True
        assert candidate["included_artifacts"]
        assert {item["artifact_id"] for item in candidate["included_artifacts"]}
        assert approval["manifest_hash"] == candidate["content_hash"]
        recorded = {
            (item["artifact_id"], item["content_hash"])
            for item in approval["included_artifact_hashes"]
        }
        included = {(item["artifact_id"], item["content_hash"]) for item in candidate["included_artifacts"]}
        assert recorded == included
        assert body["approval_current"] is True
        assert body["release_gate"]["status"] == "ready_for_export"
        replay = record_fsa(client)
        assert replay.status_code == 200, replay.text
        assert replay.json()["final_study_approval"]["approval_id"] == approval["approval_id"]
        conflict = record_fsa(client, key="final-study-approval-other")
        assert conflict.status_code == 409
        exported = client.post(
            f"/api/v1/studies/{STUDY_ID}/exports",
            json={"actor": "Dr. Sam Director", "idempotency_key": "fsa-export-001"},
        )
        assert exported.status_code == 200, exported.text
    engine.dispose()


def test_unresolved_state_prevents_final_study_approval() -> None:
    client, engine = build_client(FakeSectionAgent())
    with client:
        blocked = record_fsa(client)
        assert blocked.status_code == 409
        validate(client)
        after_validation = record_fsa(client)
        assert after_validation.status_code == 409
        client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-results/VR-004/dispositions",
            json={
                "decision": "corrected",
                "reason": "Corrected the grain mismatch.",
                "reviewer": "Dr. Ada Path",
            },
        )
        missing_roles = record_fsa(client)
        assert missing_roles.status_code == 409
        draft(client, key="fsa-unpromoted-draft")
        clear_blockers(client)
        record_roles(client)
        unpromoted = record_fsa(client, key="fsa-unpromoted")
        assert unpromoted.status_code == 409
        export = client.post(
            f"/api/v1/studies/{STUDY_ID}/exports",
            json={"actor": "Dr. Sam Director", "idempotency_key": "blocked-unpromoted-export"},
        )
        assert export.status_code == 409
    engine.dispose()


def test_included_hash_change_marks_approval_stale_and_blocks_export() -> None:
    client, engine = build_client(FakeSectionAgent())
    with client:
        clear_blockers(client)
        record_roles(client)
        approved = record_fsa(client, key="fsa-before-draft")
        assert approved.status_code == 200, approved.text
        assert approved.json()["approval_current"] is True
        draft(client, key="fsa-stale-draft")
        after = workspace(client)
        assert after["approval_current"] is False
        assert after["release_gate"]["status"] == "blocked"
        assert (
            after["final_study_approval"]["approval_id"]
            == approved.json()["final_study_approval"]["approval_id"]
        )
        export = client.post(
            f"/api/v1/studies/{STUDY_ID}/exports",
            json={"actor": "Dr. Sam Director", "idempotency_key": "stale-export"},
        )
        assert export.status_code == 409
        reused = record_fsa(client, key="fsa-before-draft")
        assert reused.status_code == 409
    engine.dispose()


def test_superseding_run_does_not_inherit_final_study_approval(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    client, engine = build_client(FakeSectionAgent(), repository_root=root)
    with client:
        clear_blockers(client)
        record_roles(client)
        approved = record_fsa(client, key="fsa-before-supersede")
        assert approved.status_code == 200, approved.text
        predecessor_id = approved.json()["final_study_approval"]["approval_id"]
        mutate_discussion(root)
        supersede(client, approved.json()["pinned_run"]["run_id"], key="fsa-supersede")
        after = workspace(client)
        assert after["final_study_approval"] is None
        assert after["approval_current"] is False
        snapshot = after["predecessor_snapshots"][0]
        assert snapshot["final_study_approval"]["approval_id"] == predecessor_id
        successor = record_fsa(client, key="fsa-successor")
        assert successor.status_code == 409
    engine.dispose()
