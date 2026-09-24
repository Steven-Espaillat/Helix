import json
import re
import threading
import time
from pathlib import Path

from jsonschema import Draft202012Validator
from sqlalchemy.pool import QueuePool, StaticPool
from test_candidate_evaluations import draft
from test_section_runs import ROOT, STUDY_ID, FakeSectionAgent, build_client, validate

from app.database import create_session_factory
from app.repository import StudyPackageRepository
from app.review_scaffolds import ExportAdmissionError, admit_export_document
from app.schemas import DispositionDecision, ReviewDisposition, SectionDraft
from app.section_runs import SectionRunService

CONTRACTS = ROOT / "skills" / "helix-evidence-pipeline" / "contracts"
REVISION_SCHEMA = json.loads((CONTRACTS / "review-scaffold-revision.schema.json").read_text())
RC_SCHEMA = json.loads((CONTRACTS / "release-candidate.schema.json").read_text())
CONTENT_HASH = re.compile(r"^sha256:[a-f0-9]{64}$")
PLACEHOLDER = "[NEEDS REVIEW]"


def revisions(client) -> list[dict[str, object]]:
    return client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()["review_scaffold_revisions"]


def evaluate(client, run_id: str, key: str) -> dict[str, object]:
    response = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs/{run_id}/evaluations",
        json={"idempotency_key": key},
    )
    assert response.status_code == 201, response.text
    return response.json()


def dispose(client, result_id: str, decision: str, reason: str) -> dict[str, object]:
    response = client.post(
        f"/api/v1/studies/{STUDY_ID}/validation-results/{result_id}/dispositions",
        json={"decision": decision, "reason": reason, "reviewer": "Dr. Ada Path"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def approve(client, role: str, reviewer: str, meaning: str) -> dict[str, object]:
    response = client.post(
        f"/api/v1/studies/{STUDY_ID}/approvals",
        json={"role": role, "reviewer": reviewer, "meaning": meaning},
    )
    assert response.status_code == 200, response.text
    return response.json()


def assert_revision(revision: dict[str, object], *, predecessor: str | None) -> None:
    errors = list(Draft202012Validator(REVISION_SCHEMA).iter_errors(revision))
    assert errors == [], errors[0].message if errors else "valid"
    assert revision["predecessor_id"] == predecessor
    assert revision["triggering_event_id"]
    assert CONTENT_HASH.match(str(revision["content_hash"]))
    assert revision["created_at"]
    assert revision["export_eligible"] is False
    for section in revision["sections"]:
        assert isinstance(section["artifact_ids"], list)
        if section["render_state"] == "needs_review":
            assert section["placeholder"] == PLACEHOLDER
            assert section["blocker_result_ids"]


def assert_consecutive(items: list[dict[str, object]]) -> None:
    sequences = [int(item["sequence"]) for item in items]
    assert sequences == list(range(1, len(sequences) + 1)), sequences
    assert len(sequences) == len(set(sequences)), sequences


def test_two_concurrent_pictures_allocate_consecutive_sequences(tmp_path: Path) -> None:
    database = tmp_path / "helix.db"
    client, engine = build_client(
        FakeSectionAgent(),
        database_url=f"sqlite+pysqlite:///{database}",
    )
    assert engine.url.database == str(database)
    assert isinstance(engine.pool, QueuePool)
    assert not isinstance(engine.pool, StaticPool)
    with client:
        validate(client)
        factory = create_session_factory(engine)
        session = factory()
        try:
            repository = StudyPackageRepository(session)
            package = repository.get(STUDY_ID, for_update=True)
            service = SectionRunService(session, None, ROOT)
            service.persist_contract_revision(package, event_id="EV-SAME-PICTURE-A")
            service.persist_contract_revision(package, event_id="EV-SAME-PICTURE-B")
            session.commit()
        finally:
            session.close()
        assert [int(item["sequence"]) for item in revisions(client)] == [1]
        barrier = threading.Barrier(2)
        errors: list[BaseException] = []

        def write(result_id: str, decision: DispositionDecision, event_id: str) -> None:
            session = factory()
            try:
                barrier.wait()
                repository = StudyPackageRepository(session)
                package = repository.get(STUDY_ID, for_update=True)
                package = package.model_copy(
                    update={
                        "review_dispositions": [
                            *package.review_dispositions,
                            ReviewDisposition(
                                disposition_id=f"RD-{result_id}-CONCURRENT",
                                result_id=result_id,
                                decision=decision,
                                reason=f"Concurrent picture for {result_id}",
                                reviewer="Dr. Ada Path",
                                timestamp="2026-09-24T12:00:00Z",
                            ),
                        ]
                    }
                )
                updated = SectionRunService(session, None, ROOT).persist_contract_revision(
                    package,
                    event_id=event_id,
                )
                time.sleep(0.1)
                repository.save(updated)
                session.commit()
            except BaseException as error:
                errors.append(error)
            finally:
                session.close()

        first = threading.Thread(
            target=write,
            args=("VR-005", DispositionDecision.CORRECTED, "EV-CONCURRENT-A"),
        )
        second = threading.Thread(
            target=write,
            args=("VR-006", DispositionDecision.APPROVED_EXCEPTION, "EV-CONCURRENT-B"),
        )
        first.start()
        second.start()
        first.join()
        second.join()
        assert errors == [], errors
        stored = revisions(client)
        assert_consecutive(stored)
        assert [int(item["sequence"]) for item in stored] == [1, 2, 3]
        assert {"EV-CONCURRENT-A", "EV-CONCURRENT-B"}.issubset(
            {item["triggering_event_id"] for item in stored}
        )
        predecessor = None
        for revision in stored:
            assert_revision(revision, predecessor=predecessor)
            predecessor = str(revision["revision_id"])
    engine.dispose()


def test_replays_and_identical_persist_do_not_append() -> None:
    client, engine = build_client(FakeSectionAgent("conforming"))
    with client:
        validate(client)
        after_validation = revisions(client)
        assert len(after_validation) == 1
        validate(client)
        assert [item["sequence"] for item in revisions(client)] == [1]
        recorded = draft(client, key="versioning-draft")
        after_draft = revisions(client)
        assert [item["sequence"] for item in after_draft] == [1, 2]
        evaluate(client, recorded["run_id"], "versioning-eval")
        after_eval = revisions(client)
        assert [item["sequence"] for item in after_eval] == [1, 2]
        replay_run = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs",
            json={
                "section_package_id": "section.5_2_3_body_weight",
                "idempotency_key": "versioning-draft",
            },
        )
        replay_eval = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/evaluations",
            json={"idempotency_key": "versioning-eval"},
        )
        assert replay_run.status_code == 201
        assert replay_eval.status_code == 201
        assert [item["sequence"] for item in revisions(client)] == [1, 2]
        session = create_session_factory(engine)()
        try:
            repository = StudyPackageRepository(session)
            package = repository.get(STUDY_ID, for_update=True)
            SectionRunService(session, None, ROOT).persist_contract_revision(
                package,
                event_id="EV-IDENTICAL-NEW-EVENT",
            )
            session.commit()
        finally:
            session.close()
        assert [item["sequence"] for item in revisions(client)] == [1, 2]
        for revision in revisions(client):
            assert_revision(
                revision,
                predecessor=None if revision["sequence"] == 1 else after_validation[0]["revision_id"],
            )
    engine.dispose()


def test_every_revision_is_schema_valid_non_exportable_and_needs_review_literal() -> None:
    client, engine = build_client(FakeSectionAgent("conforming"))
    with client:
        validate(client)
        recorded = draft(client, key="schema-draft")
        evaluate(client, recorded["run_id"], "schema-eval")
        stored = revisions(client)
        predecessor = None
        for revision in stored:
            assert_revision(revision, predecessor=predecessor)
            predecessor = str(revision["revision_id"])
            admit_failed = False
            try:
                admit_export_document(revision)
            except ExportAdmissionError:
                admit_failed = True
            assert admit_failed is True
            rc_errors = list(Draft202012Validator(RC_SCHEMA).iter_errors(revision))
            assert rc_errors, "release-candidate schema must reject a stored Review Scaffold"
    engine.dispose()


def test_disposition_and_approval_append_and_identical_disposition_does_not() -> None:
    client, engine = build_client(FakeSectionAgent("conforming"))
    with client:
        validate(client)
        draft(client, key="disposition-draft")
        before = len(revisions(client))
        first = dispose(
            client,
            "VR-005",
            "corrected",
            "Corrected the discussion severity mismatch.",
        )
        after_first = first["review_scaffold_revisions"]
        assert len(after_first) == before + 1
        second = dispose(
            client,
            "VR-005",
            "corrected",
            "Corrected the discussion severity mismatch.",
        )
        assert len(second["review_scaffold_revisions"]) == len(after_first)
        dispose(client, "VR-004", "corrected", "Corrected the grain mismatch.")
        dispose(client, "VR-006", "approved_exception", "Approved the NOAEL exception.")
        before_approval = len(revisions(client))
        approved = approve(client, "pathologist", "Dr. Ada Path", "Scientific review complete")
        assert len(approved["review_scaffold_revisions"]) == before_approval + 1
        stored = approved["review_scaffold_revisions"]
        assert_consecutive(stored)
        predecessor = None
        for revision in stored:
            assert_revision(revision, predecessor=predecessor)
            predecessor = str(revision["revision_id"])
    engine.dispose()


def test_soe_disposition_then_new_candidate_marks_stale() -> None:
    client, engine = build_client(FakeSectionAgent("conforming_advisory_fail"))
    with client:
        validate(client)
        recorded = draft(client, key="stale-soe-draft")
        evaluation = evaluate(client, recorded["run_id"], "stale-soe-eval")
        soe_id = evaluation["study_output_evaluation_receipt"]["receipt_id"]
        dispose(
            client,
            soe_id,
            "approved_exception",
            "Advisory study-output failure reviewed against the exact candidate.",
        )
        after_disposition = revisions(client)
        factory = create_session_factory(engine)
        session = factory()
        try:
            repository = StudyPackageRepository(session)
            prior = repository.get_section_run_by_id(STUDY_ID, recorded["run_id"])
            assert prior is not None and prior.candidate is not None
            row = repository.add_section_run(
                run_id="SRUN-STALE000001",
                study_id=STUDY_ID,
                section_package_id="section.5_2_3_body_weight",
                drafting_cycle_id=str(prior.candidate.get("drafting_cycle_id") or "CYCLE-BW-001"),
                attempt=2,
                idempotency_key="stale-second-candidate",
                request_hash="sha256:" + "1" * 64,
                envelope=prior.envelope,
            )
            candidate = dict(prior.candidate)
            candidate["candidate_id"] = "SDC-STALE000001"
            candidate["attempt"] = 2
            row.candidate = candidate
            session.flush()
            package = repository.get(STUDY_ID, for_update=True)
            SectionRunService(session, None, ROOT).persist_contract_revision(
                package,
                event_id="EV-STALE-CANDIDATE",
            )
            session.commit()
        finally:
            session.close()
        stored = revisions(client)
        assert len(stored) == len(after_disposition) + 1
        latest = stored[-1]
        assert soe_id in latest["overall_study_context"]["stale_disposition_ids"]
        body_weight = next(
            item for item in latest["sections"] if item["section_id"] == "5_2_3_body_weight"
        )
        assert soe_id in body_weight["blocker_result_ids"]
        assert body_weight["placeholder"] == PLACEHOLDER
        assert_revision(latest, predecessor=str(after_disposition[-1]["revision_id"]))
    engine.dispose()


def test_injected_section_draft_emits_section_draft_and_promote_still_409() -> None:
    client, engine = build_client(FakeSectionAgent("conforming"))
    with client:
        validate(client)
        recorded = draft(client, key="fixture-draft-run")
        evaluate(client, recorded["run_id"], "fixture-draft-eval")
        session = create_session_factory(engine)()
        try:
            repository = StudyPackageRepository(session)
            repository.add_section_draft(
                study_id=STUDY_ID,
                run_id=recorded["run_id"],
                candidate_id=recorded["candidate_id"],
                idempotency_key="fixture-section-draft",
                request_hash="sha256:" + "2" * 64,
                draft=SectionDraft.model_validate(
                    {
                        "schema_version": "helix.section-draft/v1",
                        "status": "section_draft",
                        "draft_id": "SD-FIXTURE00001",
                        "run_id": recorded["run_id"],
                        "section_id": "5_2_3_body_weight",
                        "candidate_id": recorded["candidate_id"],
                        "candidate_hash": recorded["candidate_hash"],
                        "content_hash": recorded["candidate_hash"],
                        "promoted_at": "2026-09-24T12:00:00Z",
                        "gate_decision_ids": ["PRV-FIXTURE0001"],
                        "bound_dispositions": [],
                    }
                ),
            )
            package = repository.get(STUDY_ID, for_update=True)
            SectionRunService(session, None, ROOT).persist_contract_revision(
                package,
                event_id="EV-FIXTURE-DRAFT",
            )
            session.commit()
        finally:
            session.close()
        latest = revisions(client)[-1]
        body_weight = next(
            item for item in latest["sections"] if item["section_id"] == "5_2_3_body_weight"
        )
        assert body_weight["render_state"] == "section_draft"
        assert "SD-FIXTURE00001" in body_weight["artifact_ids"]
        assert body_weight["placeholder"] is None
        promoted = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/promotions",
            json={"idempotency_key": "fixture-promote-still-409"},
        )
        assert promoted.status_code == 409
        assert "package_permission" in promoted.json()["detail"]
    engine.dispose()
