import json
import threading
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import QueuePool, StaticPool
from test_candidate_evaluations import draft
from test_human_directed_revision import inject_section_draft
from test_review_scaffold_versioning import approve, dispose
from test_section_runs import ROOT, STUDY_ID, FakeSectionAgent, build_client, governed_root, validate
from test_template_contract_gates import mutate_template

from app.contract_schema import draft202012_validator
from app.database import create_session_factory
from app.models import ExportFileRow, SectionRunRow
from app.repository import StudyPackageRepository
from app.run_plans import PinnedRunService
from app.schemas import (
    ArtifactLineage,
    FreezeRunCommand,
    FrozenRunInputs,
    PredecessorSnapshot,
    StudyRecords,
    SupersedingRunReceipt,
)
from app.section_runs import SectionRunService
from app.service import StudyService
from app.superseding_runs import (
    BODY_WEIGHT_PACKAGE_ID,
    DISCUSSION_PACKAGE_ID,
    PARSE_NODE_ID,
    VALIDATION_NODE_ID,
    parse_fingerprint_from,
    section_fingerprint_from,
    validation_fingerprint_from,
)

CONTRACTS = ROOT / "skills" / "helix-evidence-pipeline" / "contracts"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "invalid-receipts"
VALID = Path(__file__).resolve().parent / "fixtures" / "valid-receipts"
FRONTEND = ROOT / "frontend" / "src"
REASON = "Correct the locked body-weight source after authorized review"
SOURCE_CHECKSUM = "sha256:synthetic-a-bw-LOCK-2026-09-24-corr"


def load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text())


def validator_for(filename: str):
    return draft202012_validator(load_json(CONTRACTS / filename), CONTRACTS)


def workspace(client) -> dict[str, object]:
    response = client.get(f"/api/v1/studies/{STUDY_ID}/workspace")
    assert response.status_code == 200, response.text
    return response.json()


def supersede(client, predecessor_run_id: str, *, key: str = "supersede-study-hlx-028-v1"):
    response = client.post(
        f"/api/v1/studies/{STUDY_ID}/pinned-runs",
        json={
            "actor": "Dr. Run Owner",
            "idempotency_key": key,
            "supersession": {"predecessor_run_id": predecessor_run_id, "reason": REASON},
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def retarget_source(client, engine, root: Path, *, mutate_records: bool) -> None:
    session = create_session_factory(engine)()
    try:
        repository = StudyPackageRepository(session)
        package = repository.get(STUDY_ID)
        manifest = [item.model_copy() for item in package.manifest]
        index = next(i for i, item in enumerate(manifest) if item.artifact_id == "A-BW")
        manifest[index] = manifest[index].model_copy(update={"checksum": SOURCE_CHECKSUM})
        records = package.records
        if mutate_records:
            weights = list(records.body_weights)
            first = weights[0]
            numeric = first.value if isinstance(first.value, (int, float)) else 0
            weights[0] = first.model_copy(update={"value": float(numeric) + 0.1})
            records = records.model_copy(update={"body_weights": weights})
        repository.save(package.model_copy(update={"manifest": manifest, "records": records}))
        session.commit()
    finally:
        session.close()
    path = root / "backend" / "app" / "data" / "authorized-manifest.json"
    payload = json.loads(path.read_text())
    for entry in payload["entries"]:
        if entry["artifact_id"] == "A-BW":
            entry["checksum"] = SOURCE_CHECKSUM
    path.write_text(json.dumps(payload, indent=2) + "\n")


def mutate_discussion(root: Path) -> None:
    mutate_template(
        root,
        lambda template: next(
            item for item in template["sections"] if item["section_id"] == "S8"
        ).__setitem__("purpose", "Governance-corrected discussion purpose."),
    )


def mutate_validation_package(root: Path) -> None:
    path = (
        root
        / "skills"
        / "helix-evidence-pipeline"
        / "packages"
        / "data-validation"
        / "body-weight"
        / "package.json"
    )
    payload = json.loads(path.read_text())
    payload["rules"][0]["rule_version"] = "1.0.1"
    path.write_text(json.dumps(payload, indent=2) + "\n")


def capture_predecessor(engine) -> dict[str, object]:
    session = create_session_factory(engine)()
    try:
        repository = StudyPackageRepository(session)
        package = repository.get(STUDY_ID)
        return {
            "pinned_run": package.pinned_run.model_dump(mode="json") if package.pinned_run else None,
            "claims": [item.model_dump(mode="json") for item in package.claims],
            "validation_results": [item.model_dump(mode="json") for item in package.validation_results],
            "review_dispositions": [item.model_dump(mode="json") for item in package.review_dispositions],
            "approvals": [item.model_dump(mode="json") for item in package.approvals],
            "events": [item.model_dump(mode="json") for item in package.events],
            "data_validation_executions": [
                item.model_dump(mode="json") for item in package.data_validation_executions
            ],
            "review_scaffold_revisions": list(package.review_scaffold_revisions),
            "export_artifacts": [item.model_dump(mode="json") for item in package.export_artifacts],
            "workflow_state": package.workflow_state,
            "section_runs": [
                item.model_dump(mode="json") for item in repository.list_section_runs(STUDY_ID)
            ],
            "section_drafts": [
                item.model_dump(mode="json") for item in repository.list_section_drafts(STUDY_ID)
            ],
            "candidate_evaluations": [
                item.model_dump(mode="json") for item in repository.list_candidate_evaluations(STUDY_ID)
            ],
            "drafting_cycles": [
                item.model_dump(mode="json") for item in repository.list_drafting_cycles(STUDY_ID)
            ],
            "frozen_inputs": package.frozen_inputs.model_dump(mode="json") if package.frozen_inputs else None,
        }
    finally:
        session.close()


def test_correction_creates_new_run_with_predecessor_fields(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    client, engine = build_client(FakeSectionAgent(), repository_root=root)
    with client:
        validate(client)
        prior = workspace(client)["pinned_run"]
        retarget_source(client, engine, root, mutate_records=True)
        pinned = supersede(client, prior["run_id"])
        body = workspace(client)
        assert pinned["run_id"] != prior["run_id"]
        assert pinned["predecessor_run_id"] == prior["run_id"]
        assert pinned["supersession_reason"] == REASON
        assert body["pinned_run"]["run_id"] == pinned["run_id"]
        receipt = body["superseding_run_receipt"]
        assert receipt["predecessor_run_id"] == prior["run_id"]
        assert receipt["reason"] == REASON
        assert receipt["run_id"] == pinned["run_id"]
    engine.dispose()


def test_predecessor_remains_byte_for_byte_retrievable(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    agent = FakeSectionAgent()
    client, engine = build_client(agent, repository_root=root)
    with client:
        validate(client)
        recorded = draft(client, key="byte-for-byte-draft")
        inject_section_draft(engine, recorded)
        before = capture_predecessor(engine)
        retarget_source(client, engine, root, mutate_records=True)
        supersede(client, before["pinned_run"]["run_id"], key="byte-for-byte-supersede")
        body = workspace(client)
        snapshot = body["predecessor_snapshots"][0]
        assert snapshot["pinned_run"] == before["pinned_run"]
        assert snapshot["claims"] == before["claims"]
        assert snapshot["validation_results"] == before["validation_results"]
        assert snapshot["review_dispositions"] == before["review_dispositions"]
        assert snapshot["approvals"] == before["approvals"]
        assert snapshot["events"] == before["events"]
        assert snapshot["data_validation_executions"] == before["data_validation_executions"]
        assert snapshot["review_scaffold_revisions"] == before["review_scaffold_revisions"]
        assert snapshot["export_artifacts"] == before["export_artifacts"]
        assert snapshot["workflow_state"] == before["workflow_state"]
        assert snapshot["section_runs"] == before["section_runs"]
        assert snapshot["section_drafts"] == before["section_drafts"]
        assert snapshot["candidate_evaluations"] == before["candidate_evaluations"]
        assert snapshot["drafting_cycles"] == before["drafting_cycles"]
        assert snapshot["frozen_inputs"] == before["frozen_inputs"]
        assert body["pinned_run"]["run_id"] != before["pinned_run"]["run_id"]
        with client.app.state.session_factory() as session:
            rows = session.scalars(select(SectionRunRow)).all()
            assert [row.run_id for row in rows] == [recorded["run_id"]]
            assert rows[0].receipt["candidate_id"] == recorded["candidate_id"]
    engine.dispose()


EMPTY_RECORDS = {
    "animals": [],
    "body_weights": [],
    "clinical_observations": [],
    "food_consumption": [],
    "organ_weights": [],
    "microscopic_findings": [],
    "formulation": [],
}


def test_parse_reuse_only_for_identical_content() -> None:
    first = parse_fingerprint_from(StudyRecords.model_validate(EMPTY_RECORDS), [])
    same = parse_fingerprint_from(StudyRecords.model_validate(EMPTY_RECORDS), [])
    changed_records = StudyRecords.model_validate(
        {
            "animals": [],
            "body_weights": [
                {
                    "record_id": "BW-1",
                    "domain": "BW",
                    "timepoint": "DAY 28",
                    "test_code": "WEIGHT",
                    "value": 1.0,
                    "unit": "g",
                    "grain": "animal",
                    "source_pointer": "A-BW#1",
                }
            ],
            "clinical_observations": [],
            "food_consumption": [],
            "organ_weights": [],
            "microscopic_findings": [],
            "formulation": [],
        }
    )
    different = parse_fingerprint_from(changed_records, [])
    assert first == same
    assert first != different
    assert first.startswith("sha256:")
    assert len(first) == 71


def test_parse_reuse_flag_follows_source_identity(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    client, engine = build_client(FakeSectionAgent(), repository_root=root)
    with client:
        validate(client)
        prior = workspace(client)["pinned_run"]["run_id"]
        mutate_discussion(root)
        unchanged = supersede(client, prior, key="reuse-discussion-only")
        reused = workspace(client)["superseding_run_receipt"]["parse_reuse"]
        assert reused == [
            {"node_id": PARSE_NODE_ID, "content_hash": reused[0]["content_hash"], "reused": True}
        ]
        retarget_source(client, engine, root, mutate_records=True)
        supersede(client, unchanged["run_id"], key="reuse-source-change")
        changed = workspace(client)["superseding_run_receipt"]["parse_reuse"]
        assert changed[0]["node_id"] == PARSE_NODE_ID
        assert changed[0]["reused"] is False
        assert changed[0]["content_hash"] != reused[0]["content_hash"]
    engine.dispose()


def test_section_carry_forward_requires_identical_fingerprint_and_records_lineage(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    agent = FakeSectionAgent()
    client, engine = build_client(agent, repository_root=root)
    with client:
        validate(client)
        recorded = draft(client, key="carry-draft")
        inject_section_draft(engine, recorded)
        prior = workspace(client)
        prior_run = prior["pinned_run"]["run_id"]
        mutate_discussion(root)
        supersede(client, prior_run, key="carry-discussion-only")
        body = workspace(client)
        receipt = body["superseding_run_receipt"]
        carried = receipt["carried_forward"]
        kinds = {item["kind"] for item in carried}
        assert "section_draft_candidate" in kinds
        assert "section_draft" in kinds
        assert all(item["section_package_id"] == BODY_WEIGHT_PACKAGE_ID for item in carried)
        candidate = next(item for item in carried if item["kind"] == "section_draft_candidate")
        assert candidate["artifact_id"] == recorded["candidate_id"]
        assert candidate["lineage"]["predecessor_run_id"] == prior_run
        assert candidate["lineage"]["predecessor_artifact_id"] == recorded["candidate_id"]
        assert candidate["lineage"]["predecessor_content_hash"] == candidate["content_hash"]
        lineage_fp = candidate["lineage"]["predecessor_dependency_fingerprint"]
        assert lineage_fp == candidate["dependency_fingerprint"]
        assert candidate["dependency_fingerprint"].startswith("sha256:")
        assert DISCUSSION_PACKAGE_ID not in {item["section_package_id"] for item in carried}
        live_candidates = [item["receipt"]["candidate_id"] for item in body["section_runs"]]
        assert live_candidates == [recorded["candidate_id"]]
        assert [item["draft_id"] for item in body["section_drafts"]] == ["SD-REV000000001"]
        retarget_source(client, engine, root, mutate_records=True)
        supersede(client, body["pinned_run"]["run_id"], key="carry-source-change")
        after_source = workspace(client)
        assert after_source["superseding_run_receipt"]["carried_forward"] == []
        assert after_source["section_runs"] == []
        assert after_source["section_drafts"] == []
    engine.dispose()


def test_changed_source_or_governed_version_reruns_affected_nodes_only(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    agent = FakeSectionAgent()
    client, engine = build_client(agent, repository_root=root)
    with client:
        validate(client)
        draft(client, key="impact-draft")
        prior = workspace(client)["pinned_run"]["run_id"]
        mutate_discussion(root)
        discussion_only = supersede(client, prior, key="impact-discussion")
        discussion_receipt = workspace(client)["superseding_run_receipt"]
        assert discussion_receipt["rerun_node_ids"] == [DISCUSSION_PACKAGE_ID]
        assert PARSE_NODE_ID not in discussion_receipt["rerun_node_ids"]
        assert VALIDATION_NODE_ID not in discussion_receipt["rerun_node_ids"]
        assert discussion_receipt["impact_set"]["origin_section_package_id"] == DISCUSSION_PACKAGE_ID
        assert discussion_receipt["parse_reuse"][0]["reused"] is True

        mutate_validation_package(root)
        governed = supersede(client, discussion_only["run_id"], key="impact-governed")
        governed_receipt = workspace(client)["superseding_run_receipt"]
        assert PARSE_NODE_ID not in governed_receipt["rerun_node_ids"]
        assert VALIDATION_NODE_ID in governed_receipt["rerun_node_ids"]
        assert BODY_WEIGHT_PACKAGE_ID in governed_receipt["rerun_node_ids"]
        assert DISCUSSION_PACKAGE_ID in governed_receipt["rerun_node_ids"]
        assert governed_receipt["parse_reuse"][0]["reused"] is True
        assert governed_receipt["carried_forward"] == []

        retarget_source(client, engine, root, mutate_records=True)
        supersede(client, governed["run_id"], key="impact-source")
        source_receipt = workspace(client)["superseding_run_receipt"]
        assert source_receipt["rerun_node_ids"][:2] == [PARSE_NODE_ID, VALIDATION_NODE_ID]
        assert BODY_WEIGHT_PACKAGE_ID in source_receipt["rerun_node_ids"]
        assert DISCUSSION_PACKAGE_ID in source_receipt["rerun_node_ids"]
        assert source_receipt["parse_reuse"][0]["reused"] is False
    engine.dispose()


def test_new_run_issues_fresh_authority_when_reusing_an_artifact(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    agent = FakeSectionAgent()
    client, engine = build_client(agent, repository_root=root)
    with client:
        validate(client)
        recorded = draft(client, key="fresh-authority-draft")
        before = workspace(client)
        prior_scaffold = before["review_scaffold_revisions"][-1]["revision_id"]
        prior_dvp = [item["receipt"]["receipt_id"] for item in before["data_validation_executions"]]
        mutate_discussion(root)
        supersede(client, before["pinned_run"]["run_id"], key="fresh-authority-supersede")
        after = workspace(client)
        receipt = after["superseding_run_receipt"]
        assert receipt["carried_forward"]
        assert recorded["candidate_id"] in {item["artifact_id"] for item in receipt["carried_forward"]}
        assert receipt["fresh_validation_receipt_ids"]
        assert receipt["fresh_validation_receipt_ids"] != prior_dvp
        assert receipt["fresh_gate_ids"] == [after["release_gate"]["gate_id"]]
        assert after["release_gate"]["decided_at"] != before["release_gate"]["decided_at"]
        assert after["review_scaffold_revisions"][-1]["revision_id"] != prior_scaffold
        assert receipt["fresh_scaffold_revision"] == after["review_scaffold_revisions"][-1]["sequence"]
        assert after["approvals"] == []
        after_dvp = [item["receipt"]["receipt_id"] for item in after["data_validation_executions"]]
        assert after_dvp != prior_dvp
        assert after["candidate_evaluations"] == []
    engine.dispose()


def test_schemas_reject_incomplete_hashes_and_unknown_fields() -> None:
    cases = [
        ("artifact-lineage.schema.json", ArtifactLineage, "artifact-lineage.json"),
        ("superseding-run.schema.json", SupersedingRunReceipt, "superseding-run.json"),
    ]
    for schema_name, model, fixture_name in cases:
        payload = load_json(VALID / fixture_name)
        validator_for(schema_name).validate(payload)
        model.model_validate(payload)
        for variant in ["unknown-property.json", "missing-required.json", "incomplete-hash.json"]:
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

    snapshot_schema = "predecessor-snapshot.schema.json"
    snapshot = load_json(VALID / "predecessor-snapshot.json")
    validator_for(snapshot_schema).validate(snapshot)
    for variant in ["unknown-property.json", "missing-required.json", "incomplete-hash.json"]:
        path = FIXTURES / "predecessor-snapshot" / variant
        invalid = load_json(path)
        assert list(validator_for(snapshot_schema).iter_errors(invalid)), f"{path} must fail JSON Schema"


def test_live_snapshot_and_receipt_reject_unknown_fields_and_incomplete_hashes(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    client, engine = build_client(FakeSectionAgent(), repository_root=root)
    with client:
        validate(client)
        mutate_discussion(root)
        supersede(client, workspace(client)["pinned_run"]["run_id"], key="schema-live")
        body = workspace(client)
        snapshot = body["predecessor_snapshots"][0]
        receipt = body["superseding_run_receipt"]
        validator_for("predecessor-snapshot.schema.json").validate(snapshot)
        PredecessorSnapshot.model_validate(snapshot)
        validator_for("superseding-run.schema.json").validate(receipt)
        SupersedingRunReceipt.model_validate(receipt)
        mutated_snapshot = deepcopy(snapshot)
        mutated_snapshot["invented"] = True
        assert list(validator_for("predecessor-snapshot.schema.json").iter_errors(mutated_snapshot))
        try:
            PredecessorSnapshot.model_validate(mutated_snapshot)
            raise AssertionError("Pydantic accepted an unknown snapshot field")
        except ValidationError as error:
            assert "invented" in str(error)
        mutated_snapshot = deepcopy(snapshot)
        mutated_snapshot["snapshot_hash"] = "sha256:dead"
        assert list(validator_for("predecessor-snapshot.schema.json").iter_errors(mutated_snapshot))
        try:
            PredecessorSnapshot.model_validate(mutated_snapshot)
            raise AssertionError("Pydantic accepted an incomplete snapshot hash")
        except ValidationError:
            pass
        mutated_receipt = deepcopy(receipt)
        mutated_receipt["invented"] = True
        try:
            SupersedingRunReceipt.model_validate(mutated_receipt)
            raise AssertionError("Pydantic accepted an unknown receipt field")
        except ValidationError as error:
            assert "extra_forbidden" in str(error)
        if receipt["carried_forward"]:
            mutated_lineage = deepcopy(receipt["carried_forward"][0]["lineage"])
            mutated_lineage["predecessor_content_hash"] = "sha256:dead"
        else:
            mutated_lineage = {
                "predecessor_run_id": "RUN-X",
                "predecessor_artifact_id": "SDC-X",
                "predecessor_content_hash": "sha256:dead",
                "predecessor_dependency_fingerprint": "sha256:" + "a" * 64,
            }
        try:
            ArtifactLineage.model_validate(mutated_lineage)
            raise AssertionError("Pydantic accepted an incomplete lineage hash")
        except ValidationError:
            pass
    engine.dispose()


def test_fingerprint_unit_uses_template_slice_not_whole_template(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    client, engine = build_client(FakeSectionAgent(), repository_root=root)
    with client:
        validate(client)
        with client.app.state.session_factory() as session:
            frozen = StudyPackageRepository(session).get(STUDY_ID).frozen_inputs
        assert frozen is not None
        parse_fp = parse_fingerprint_from(frozen.records, frozen.manifest)
        validation_fp = validation_fingerprint_from(frozen, parse_fp)
        body_before = section_fingerprint_from(frozen, BODY_WEIGHT_PACKAGE_ID, validation_fp)
        discussion_before = section_fingerprint_from(frozen, DISCUSSION_PACKAGE_ID, validation_fp)
        mutate_discussion(root)
        current = FrozenRunInputs(
            records=frozen.records,
            manifest=frozen.manifest,
            template=json.loads((root / "backend" / "app" / "data" / "report-template.json").read_text()),
            validation_package=frozen.validation_package,
            section_packages=frozen.section_packages,
            skill_hash=frozen.skill_hash,
            suite_hash=frozen.suite_hash,
            executor_hash=frozen.executor_hash,
            validation_package_hash=frozen.validation_package_hash,
        )
        assert section_fingerprint_from(current, BODY_WEIGHT_PACKAGE_ID, validation_fp) == body_before
        assert section_fingerprint_from(current, DISCUSSION_PACKAGE_ID, validation_fp) != discussion_before
    engine.dispose()


def test_frontend_renders_predecessor_fields_from_workspace() -> None:
    journey = (FRONTEND / "components" / "StudyJourney.tsx").read_text()
    workbench = (FRONTEND / "components" / "HelixWorkbench.tsx").read_text()
    api = (FRONTEND / "lib" / "api.ts").read_text()
    assert "predecessor_run_id" in journey
    assert "superseding_run_receipt" in journey
    assert "carried_forward" in journey
    assert "data-testid=\"superseding-run\"" in journey
    assert "eligible =" not in journey
    assert "carried_forward.filter" not in api
    assert "predecessor_snapshots" not in workbench


SEED_BLOCKERS = {"VR-004", "VR-005", "VR-006"}


def test_supersession_clears_leftover_hybrid_validation_blockers(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    client, engine = build_client(FakeSectionAgent(), repository_root=root)
    with client:
        validate(client)
        before = workspace(client)
        assert SEED_BLOCKERS.issubset(set(before["release_gate"]["blocking_result_ids"]))
        mutate_discussion(root)
        supersede(client, before["pinned_run"]["run_id"], key="clear-hybrid-vr")
        after = workspace(client)
        leftover_fail_ids = {
            item["result_id"]
            for item in after["validations"]
            if item["result_id"] in SEED_BLOCKERS and item["status"] == "fail"
        }
        assert leftover_fail_ids == set()
        assert SEED_BLOCKERS.isdisjoint(set(after["release_gate"]["blocking_result_ids"]))
        snapshot_ids = {
            item["result_id"] for item in after["predecessor_snapshots"][0]["validation_results"]
        }
        assert SEED_BLOCKERS.issubset(snapshot_ids)

        retarget_source(client, engine, root, mutate_records=True)
        supersede(client, after["pinned_run"]["run_id"], key="remint-after-source")
        remint = client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-runs",
            json={"planner": "fixture"},
        )
        assert remint.status_code == 201, remint.text
        reminted_ids = {item["result_id"] for item in remint.json()["results"]}
        assert SEED_BLOCKERS.issubset(reminted_ids)
        fresh = workspace(client)
        assert any(item["result_id"] in SEED_BLOCKERS for item in fresh["validations"])
    engine.dispose()


def test_freeze_replays_uq_pinned_run_key_and_binds_fresh_authority(tmp_path: Path) -> None:
    database = tmp_path / "helix.db"
    root = governed_root(tmp_path)
    client, engine = build_client(
        FakeSectionAgent(),
        repository_root=root,
        database_url=f"sqlite+pysqlite:///{database}",
    )
    assert engine.url.database == str(database)
    assert isinstance(engine.pool, QueuePool)
    assert not isinstance(engine.pool, StaticPool)
    command = {
        "actor": "Dr. Run Owner",
        "idempotency_key": "integrity-replay-freeze-v1",
    }
    with client:
        first = client.post(f"/api/v1/studies/{STUDY_ID}/pinned-runs", json=command)
        assert first.status_code == 201, first.text
        real_get = StudyPackageRepository.get_pinned_run
        gets = {"n": 0}

        def miss_then_hit(self, study_id, key):
            gets["n"] += 1
            if gets["n"] <= 2:
                return None
            return real_get(self, study_id, key)

        def boom(self, **kwargs):
            raise IntegrityError(
                "INSERT",
                {},
                Exception("UNIQUE constraint failed: pinned_runs.study_id, pinned_runs.idempotency_key"),
            )

        with (
            patch.object(StudyPackageRepository, "get_pinned_run", miss_then_hit),
            patch.object(StudyPackageRepository, "add_pinned_run", boom),
        ):
            replay = client.post(f"/api/v1/studies/{STUDY_ID}/pinned-runs", json=command)
        assert replay.status_code == 201, replay.text
        assert replay.json()["run_id"] == first.json()["run_id"]
        body = workspace(client)
        assert body["pinned_run"]["run_id"] == first.json()["run_id"]

        mutate_discussion(root)
        prior = body["pinned_run"]["run_id"]
        barrier = threading.Barrier(2)
        results: list[str] = []
        errors: list[BaseException] = []
        factory = create_session_factory(engine)
        settings = client.app.state.settings

        def worker() -> None:
            session = factory()
            try:
                barrier.wait()
                pinned_runs = PinnedRunService(session, root)
                section_runs = SectionRunService(session, None, root)
                service = StudyService(session, settings, section_runs, pinned_runs)
                run = service.freeze_run(
                    STUDY_ID,
                    FreezeRunCommand(
                        actor="Dr. Run Owner",
                        idempotency_key="concurrent-supersede-v1",
                        supersession={"predecessor_run_id": prior, "reason": REASON},
                    ),
                )
                results.append(run.run_id)
            except BaseException as error:
                errors.append(error)
            finally:
                session.close()

        first_thread = threading.Thread(target=worker)
        second_thread = threading.Thread(target=worker)
        first_thread.start()
        second_thread.start()
        first_thread.join()
        second_thread.join()
        assert errors == [], errors
        assert results and results[0] == results[1]
        after = workspace(client)
        assert after["pinned_run"]["run_id"] == results[0]
        assert after["superseding_run_receipt"]["run_id"] == results[0]
        assert after["superseding_run_receipt"]["fresh_gate_ids"]
    engine.dispose()


def test_supersession_after_export_clears_successor_export_state(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    client, engine = build_client(FakeSectionAgent(), repository_root=root)
    with client:
        validate(client)
        dispose(client, "VR-004", "corrected", "Corrected the grain mismatch.")
        dispose(client, "VR-005", "corrected", "Corrected the severity mismatch.")
        dispose(client, "VR-006", "approved_exception", "NOAEL remains a human judgment.")
        approve(client, "pathologist", "Dr. Ada Path", "Scientific review complete")
        approve(client, "peer_reviewer", "Dr. Priya Peer", "Independent pathology review complete")
        approve(client, "qau", "Morgan QA", "Quality assurance statement recorded")
        approve(client, "study_director", "Dr. Sam Director", "Final report approval")
        signed = client.post(
            f"/api/v1/studies/{STUDY_ID}/final-study-approvals",
            json={"reviewer": "Dr. Sam Director", "idempotency_key": "supersede-after-export-fsa"},
        )
        assert signed.status_code == 200, signed.text
        exported = client.post(
            f"/api/v1/studies/{STUDY_ID}/exports",
            json={"actor": "Dr. Sam Director", "idempotency_key": "supersede-after-export-v1"},
        )
        assert exported.status_code == 200, exported.text
        before = workspace(client)
        assert before["release_gate"]["status"] == "exported"
        assert before["workflow_state"] == "exported"
        predecessor_exports = before["export_artifacts"]
        assert predecessor_exports and all(item["status"] == "exported" for item in predecessor_exports)
        with client.app.state.session_factory() as session:
            predecessor_files = {
                (row.artifact_id, row.checksum)
                for row in session.scalars(select(ExportFileRow)).all()
            }
        mutate_discussion(root)
        supersede(client, before["pinned_run"]["run_id"], key="post-export-supersede")
        after = workspace(client)
        assert after["workflow_state"] != "exported"
        assert after["release_gate"]["status"] != "exported"
        assert after["export_artifacts"]
        assert all(item["status"] == "pending" for item in after["export_artifacts"])
        assert all(item["checksum"] is None for item in after["export_artifacts"])
        snapshot = after["predecessor_snapshots"][0]
        assert snapshot["export_artifacts"] == predecessor_exports
        assert snapshot["workflow_state"] == "exported"
        with client.app.state.session_factory() as session:
            stored_files = {
                (row.artifact_id, row.checksum)
                for row in session.scalars(select(ExportFileRow)).all()
            }
        assert stored_files == predecessor_files
        remint = client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-runs",
            json={"planner": "fixture"},
        )
        assert remint.status_code == 201, remint.text
    engine.dispose()
