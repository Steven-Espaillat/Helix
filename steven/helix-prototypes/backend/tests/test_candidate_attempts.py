from unittest.mock import patch

from sqlalchemy import select
from test_candidate_evaluations import draft
from test_section_runs import COMMAND, ROOT, STUDY_ID, FakeSectionAgent, build_client, validate

from app.drafting_cycles import CAP_BLOCKER_ID, MAX_ATTEMPTS
from app.models import CandidateEvaluationRow, SectionRunRow
from app.repository import StudyPackageRepository
from app.schemas import SectionRunCommand
from app.section_runs import SectionRunService


def evaluate(client, run_id: str, key: str):
    response = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs/{run_id}/evaluations",
        json={"idempotency_key": key},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_attempts_one_and_two_start_only_after_provenance_failure() -> None:
    agent = FakeSectionAgent("unsupported_value")
    client, engine = build_client(agent)
    with client:
        validate(client)
        first = draft(client, key="cycle-attempt-1")
        blocked = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs",
            json={**COMMAND, "idempotency_key": "cycle-attempt-2-too-soon"},
        )
        assert blocked.status_code == 409
        assert "Evaluate the current Candidate Attempt" in blocked.json()["detail"]
        assert agent.calls == 1

        body = evaluate(client, first["run_id"], "cycle-eval-1")
        assert body["next_attempt_decision"]["action"] == "retry"
        assert body["next_attempt_decision"]["attempt"] == 1

        second = draft(client, key="cycle-attempt-2")
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        attempts = [item["candidate"]["attempt"] for item in workspace["section_runs"]]
        assert attempts == [1, 2]
        assert second["candidate_id"] != first["candidate_id"]
        assert agent.calls == 2
        retry_failures = workspace["section_runs"][1]["envelope"]["structured_failures"]
        assert any(item["result_id"].startswith("PRV-") for item in retry_failures)
    engine.dispose()


def test_hold_does_not_start_a_second_invocation() -> None:
    agent = FakeSectionAgent("conforming")
    client, engine = build_client(agent)
    with client:
        validate(client)
        held = draft(client, key="hold-attempt-1")
        body = evaluate(client, held["run_id"], "hold-eval-1")
        assert body["next_attempt_decision"]["action"] == "hold"
        refused = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs",
            json={**COMMAND, "idempotency_key": "hold-attempt-2"},
        )
        assert refused.status_code == 409
        assert "provenance or conformance failure" in refused.json()["detail"]
        assert agent.calls == 1
    engine.dispose()


def test_retry_with_changed_governed_input_is_rejected() -> None:
    agent = FakeSectionAgent("unsupported_value")
    client, engine = build_client(agent)
    with client:
        validate(client)
        first = draft(client, key="fingerprint-attempt-1")
        evaluate(client, first["run_id"], "fingerprint-eval-1")
        with client.app.state.session_factory() as session:
            repository = StudyPackageRepository(session)
            package = repository.get(STUDY_ID)
            claims = [
                item.model_copy(update={"value": 1.0}) if item.claim_id == "C-BW-HIGH" else item
                for item in package.claims
            ]
            repository.save(package.model_copy(update={"claims": claims}))
            session.commit()
        refused = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs",
            json={**COMMAND, "idempotency_key": "fingerprint-attempt-2"},
        )
        assert refused.status_code == 409
        assert "governed inputs" in refused.json()["detail"]
        assert agent.calls == 1
    engine.dispose()


def test_attempt_three_stops_automation_and_records_needs_review() -> None:
    agent = FakeSectionAgent("unsupported_value")
    client, engine = build_client(agent)
    with client:
        validate(client)
        body = None
        for attempt in (1, 2, 3):
            receipt = draft(client, key=f"cap-attempt-{attempt}")
            body = evaluate(client, receipt["run_id"], f"cap-eval-{attempt}")
            assert body["next_attempt_decision"]["attempt"] == attempt
            assert body["next_attempt_decision"]["max_attempts"] == MAX_ATTEMPTS
        assert body is not None
        assert body["next_attempt_decision"]["action"] == "stop_for_review"
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        section = next(
            item
            for item in workspace["review_scaffold_revisions"][-1]["sections"]
            if item["section_id"] == "5_2_3_body_weight"
        )
        assert section["placeholder"] == "[NEEDS REVIEW]"
        assert CAP_BLOCKER_ID in section["blocker_result_ids"]
        fourth = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs",
            json={**COMMAND, "idempotency_key": "cap-attempt-4"},
        )
        assert fourth.status_code == 409
        assert "three Candidate Attempts" in fourth.json()["detail"]
        assert agent.calls == 3
        assert [item["candidate"]["attempt"] for item in workspace["section_runs"]] == [1, 2, 3]
    engine.dispose()


def test_exact_replay_returns_stored_attempt_without_consuming_another() -> None:
    agent = FakeSectionAgent("unsupported_value")
    client, engine = build_client(agent)
    with client:
        validate(client)
        first = draft(client, key="replay-attempt-1")
        evaluate(client, first["run_id"], "replay-eval-1")
        second = draft(client, key="replay-attempt-2")
        replay = draft(client, key="replay-attempt-2")
        eval_body = evaluate(client, second["run_id"], "replay-eval-2")
        eval_replay = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs/{second['run_id']}/evaluations",
            json={"idempotency_key": "replay-eval-2"},
        )
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        assert replay == second
        assert eval_replay.status_code == 201
        assert eval_replay.json()["evaluation_id"] == eval_body["evaluation_id"]
        assert eval_replay.json()["idempotent_replay"] is True
        assert agent.calls == 2
        assert [item["candidate"]["attempt"] for item in workspace["section_runs"]] == [1, 2]
        assert len(workspace["candidate_evaluations"]) == 2
    engine.dispose()


def test_concurrent_duplicate_commands_share_one_attempt_and_decision() -> None:
    agent = FakeSectionAgent("unsupported_value")
    client, engine = build_client(agent)
    with client:
        validate(client)
        first = draft(client, key="race-attempt-1")
        evaluate(client, first["run_id"], "race-eval-1")
        winner = draft(client, key="race-attempt-2")
        duplicate = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs",
            json={**COMMAND, "idempotency_key": "race-attempt-2-other"},
        )
        assert duplicate.status_code == 409
        assert agent.calls == 2
        eval_body = evaluate(client, winner["run_id"], "race-eval-2")
        eval_replay = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs/{winner['run_id']}/evaluations",
            json={"idempotency_key": "race-eval-2"},
        )
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        attempts = [item["candidate"]["attempt"] for item in workspace["section_runs"]]
        decisions = [item["next_attempt_decision"] for item in workspace["candidate_evaluations"]]
        assert attempts == [1, 2]
        assert [item["attempt"] for item in decisions] == [1, 2]
        assert eval_replay.json()["evaluation_id"] == eval_body["evaluation_id"]
        assert eval_replay.json()["next_attempt_decision"] == eval_body["next_attempt_decision"]
        with client.app.state.session_factory() as session:
            row = session.scalar(select(SectionRunRow).where(SectionRunRow.attempt == 2))
            assert row is not None
            assert row.run_id == winner["run_id"]
            evaluations = session.scalars(
                select(CandidateEvaluationRow).where(CandidateEvaluationRow.run_id == winner["run_id"])
            ).all()
            assert len(evaluations) == 1
    engine.dispose()


def test_idempotent_section_run_rechecks_after_the_study_lock() -> None:
    agent = FakeSectionAgent("unsupported_value")
    client, engine = build_client(agent)
    with client:
        validate(client)
        first = draft(client, key="lock-attempt-1")
        with client.app.state.session_factory() as session:
            service = SectionRunService(session, agent, ROOT)
            row = session.scalar(select(SectionRunRow))
            with patch.object(service.repository, "get_section_run", side_effect=[None, row]):
                replay = service.run(
                    STUDY_ID,
                    SectionRunCommand.model_validate({**COMMAND, "idempotency_key": "lock-attempt-1"}),
                )
        assert replay.model_dump(mode="json") == first
        assert agent.calls == 1
    engine.dispose()
