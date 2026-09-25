"""Nine-stage journey projection and run events (Steven-Espaillat/Helix#25).

Qualification boundary: shipped section packages are deliberately `pending`, so a real
freeze returns 422 on this base. Tests that need a Pinned Run use a *test-local* copy
of the governed tree under tmp_path whose section packages are marked qualified with a
hash of their own suite file. Shipped package data is never modified; the fixture only
exercises the journey/event contract and makes no qualification claim.
"""

import json
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.agents.codex_section_agent import CodexSectionAgent
from app.config import Settings
from app.database import create_database_engine, create_schema, create_session_factory
from app.main import create_app
from app.models import RunEventRow
from app.run_events import RUN_EVENT_ADAPTER, RunEventStore
from app.run_plans import PinnedRunService, file_hash
from app.schemas import DispositionCommand, FreezeRunCommand, ValidationRequest
from app.section_runs import SectionRunService
from app.seed import seed_database
from app.service import StudyService

ROOT = Path(__file__).resolve().parents[2]
STUDY_ID = "STUDY-HLX-028"
LABEL = "SYNTHETIC / NOT FOR SUBMISSION"
STAGE_IDS = [
    "upload",
    "parse",
    "resolve",
    "extract",
    "validate",
    "draft",
    "provenance",
    "traceability",
    "review-export",
]
FREEZE = {"actor": "Dr. Run Owner", "idempotency_key": "journey-freeze-v1"}
BASE = f"/api/v1/studies/{STUDY_ID}"


def qualified_fixture_root(tmp_path: Path, status: str = "passed") -> Path:
    """Copy the governed tree and set section-package qualification in the copy only."""
    root = tmp_path / "helix"
    for relative in ["skills", ".agents"]:
        shutil.copytree(ROOT / relative, root / relative)
    for filename in ["validation.py", "body_weight.py", "agents/codex_section_agent.py"]:
        target = root / "backend" / "app" / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "backend" / "app" / filename, target)
    shutil.copytree(ROOT / "backend" / "app" / "data", root / "backend" / "app" / "data")
    sections = root / "skills" / "helix-evidence-pipeline" / "packages" / "sections"
    for path in sorted(sections.glob("*/package.json")):
        definition = json.loads(path.read_text())
        skill = definition.get("skill") or definition.get("agentic_skill")
        if skill is None:
            continue
        skill["qualification_status"] = status
        if status == "passed":
            skill["qualification_hash"] = file_hash(root / skill["promptfoo_suite"]["path"])
        else:
            skill.pop("qualification_hash", None)
        path.write_text(json.dumps(definition, indent=2))
    return root


def build_client(repository_root: Path = ROOT, **overrides: object) -> tuple[TestClient, object]:
    settings = Settings(
        database_url="sqlite+pysqlite:///:memory:",
        seed_path=ROOT / "synthetic-e2e" / "helix-synthetic-bundle.json",
        codex_repository_root=repository_root,
        auto_seed=True,
        **{"run_event_stream_seconds": 0, **overrides},
    )
    engine = create_database_engine(settings)
    return TestClient(create_app(settings, engine)), engine


def journey(client: TestClient) -> dict:
    response = client.get(f"{BASE}/workspace")
    assert response.status_code == 200, response.text
    return response.json()["journey"]


def statuses(value: dict) -> dict[str, str]:
    return {stage["stage_id"]: stage["status"] for stage in value["stages"]}


def stage(value: dict, stage_id: str) -> dict:
    return next(item for item in value["stages"] if item["stage_id"] == stage_id)


def parse_frames(text: str) -> list[dict]:
    events = []
    for block in text.split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line and line[0] != ":")
        if "data" in lines:
            event = json.loads(lines["data"])
            assert lines["id"] == event["event_id"]
            assert lines["event"] == event["type"]
            events.append(event)
    return events


def stream(client: TestClient, run_id: str, cursor: str | None = None):
    headers = {"Last-Event-ID": cursor} if cursor else {}
    return client.get(f"{BASE}/pinned-runs/{run_id}/events", headers=headers)


def test_seeded_study_projects_upload_current_while_legacy_array_says_gate() -> None:
    client, engine = build_client()
    with client:
        workspace = client.get(f"{BASE}/workspace").json()
    projection = workspace["journey"]
    legacy_current = next(item for item in workspace["stages"] if item["status"] == "current")
    assert legacy_current["stage_id"] == "gate"
    assert workspace["pinned_run"] is None
    assert projection["label"] == LABEL
    assert projection["run"] is None
    assert projection["current_stage_id"] == "upload"
    assert [item["stage_id"] for item in projection["stages"]] == STAGE_IDS
    assert statuses(projection) == {sid: ("current" if sid == "upload" else "pending") for sid in STAGE_IDS}
    gate_numbers = [item["gate_number"] for item in projection["stages"]]
    assert gate_numbers == [1, None, None, None, None, None, None, 2, 3]
    assert [item["kind"] for item in projection["stages"]] == [
        "human_gate",
        *["agent_step"] * 6,
        "human_gate",
        "human_gate",
    ]
    assert [item["selectable"] for item in projection["stages"]] == [True] + [False] * 8
    upload = stage(projection, "upload")
    freeze_action = upload["actions"][-1]
    assert freeze_action["action_id"] == "manifest:freeze"
    assert freeze_action["status"] == "pending"
    assert freeze_action["command"] == f"POST {BASE}/pinned-runs"
    for item in projection["stages"]:
        assert item["short_label"] and item["name"] and item["summary"] and item["control_boundary"]
        assert item["input"]["title"] and item["output"]["title"]
    engine.dispose()


def test_qualification_gate_keeps_upload_current_and_writes_no_run_events(tmp_path: Path) -> None:
    client, engine = build_client(qualified_fixture_root(tmp_path, status="pending"))
    with client:
        before = journey(client)
        rejected = client.post(f"{BASE}/pinned-runs", json=FREEZE)
        after = journey(client)
        with Session(engine) as session:
            assert session.scalar(select(func.count()).select_from(RunEventRow)) == 0
    assert rejected.status_code == 422
    assert "invalid_package_qualification" in {item["code"] for item in rejected.json()["detail"]}
    assert after == before
    engine.dispose()


def test_every_projected_status_from_intake_to_export_with_gate_stops(tmp_path: Path) -> None:
    client, engine = build_client(qualified_fixture_root(tmp_path))
    seen: set[str] = set()
    with client:
        intake = journey(client)
        seen.update(statuses(intake).values())

        frozen = client.post(f"{BASE}/pinned-runs", json=FREEZE)
        assert frozen.status_code == 201, frozen.text
        run_id = frozen.json()["run_id"]
        after_freeze = journey(client)
        seen.update(statuses(after_freeze).values())
        assert after_freeze["run"]["run_id"] == run_id
        assert after_freeze["run"]["events_url"] == f"{BASE}/pinned-runs/{run_id}/events"
        assert statuses(after_freeze) == {
            "upload": "complete",
            "parse": "complete",
            "resolve": "complete",
            "extract": "complete",
            "validate": "current",
            "draft": "pending",
            "provenance": "pending",
            "traceability": "pending",
            "review-export": "pending",
        }

        validation = client.post(f"{BASE}/validation-runs", json={"planner": "fixture"})
        assert validation.status_code == 201, validation.text
        at_gate = journey(client)
        seen.update(statuses(at_gate).values())
        # Agent-owned steps stop at the Traceability gate; Review and export is not exposed.
        assert at_gate["current_stage_id"] == "traceability"
        assert statuses(at_gate)["provenance"] == "complete"
        assert statuses(at_gate)["traceability"] == "blocked"
        assert statuses(at_gate)["review-export"] == "pending"
        assert stage(at_gate, "review-export")["selectable"] is False
        validate_outcomes = {item["outcome"] for item in stage(at_gate, "validate")["actions"]}
        assert {"passed", "blocker"} <= validate_outcomes

        # A second agent run never passes the human gate.
        rerun = client.post(f"{BASE}/validation-runs", json={"planner": "fixture"})
        assert rerun.status_code == 201
        assert statuses(journey(client))["traceability"] == "blocked"

        premature = client.post(
            f"{BASE}/approvals",
            json={"role": "pathologist", "reviewer": "Dr. Ada Path", "meaning": "Scientific review"},
        )
        assert premature.status_code == 409

        blockers = [
            item["action_id"].removeprefix("disposition:")
            for item in stage(journey(client), "traceability")["actions"]
            if item["outcome"] == "blocker"
        ]
        assert blockers
        for result_id in blockers:
            response = client.post(
                f"{BASE}/validation-results/{result_id}/dispositions",
                json={
                    "decision": "approved_exception" if result_id == "VR-006" else "corrected",
                    "reason": f"Synthetic disposition for {result_id}.",
                    "reviewer": "Dr. Ada Path",
                },
            )
            assert response.status_code == 200, response.text
            assert response.json()["journey"]["run"]["latest_event_id"] is not None
        after_dispositions = journey(client)
        seen.update(statuses(after_dispositions).values())
        trace = stage(after_dispositions, "traceability")
        assert trace["status"] == "complete"
        # Dispositions remain distinguishable from passes.
        assert {item["outcome"] for item in trace["actions"]} == {"dispositioned"}
        assert all(item["status"] == "done" for item in trace["actions"])
        assert statuses(after_dispositions)["review-export"] == "current"
        assert stage(after_dispositions, "review-export")["selectable"] is True

        roles = [
            ("pathologist", "Dr. Ada Path", "Scientific review complete"),
            ("peer_reviewer", "Dr. Priya Peer", "Independent pathology review complete"),
            ("qau", "Morgan QA", "Quality assurance statement recorded"),
            ("study_director", "Dr. Sam Director", "Final report approval"),
        ]
        for role, reviewer, meaning in roles:
            approved = client.post(
                f"{BASE}/approvals", json={"role": role, "reviewer": reviewer, "meaning": meaning}
            )
            assert approved.status_code == 200, approved.text
        signed = client.post(
            f"{BASE}/final-study-approvals",
            json={"reviewer": "Dr. Sam Director", "idempotency_key": "journey-fsa-v1"},
        )
        assert signed.status_code == 200, signed.text
        ready = journey(client)
        final = stage(ready, "review-export")
        # Approvals make the final gate ready; they never export.
        assert final["status"] == "current"
        assert final["gate_status"] == "ready_for_export"
        assert {item["action_id"]: item["status"] for item in final["actions"]}["export"] == "pending"
        commands = {item["action_id"]: item["command"] for item in final["actions"]}
        assert commands["approval:pathologist"] == f"POST {BASE}/approvals"
        assert commands["final-study-approval"] == f"POST {BASE}/final-study-approvals"
        assert commands["export"] == f"POST {BASE}/exports"
        events_before_export = parse_frames(stream(client, run_id).text)
        assert "export_finished" not in {item["type"] for item in events_before_export}

        exported = client.post(
            f"{BASE}/exports", json={"actor": "Dr. Sam Director", "idempotency_key": "journey-export-v1"}
        )
        assert exported.status_code == 200, exported.text
        done = journey(client)
        seen.update(statuses(done).values())
        assert done["current_stage_id"] is None
        assert set(statuses(done).values()) == {"complete"}
        replay_export = client.post(
            f"{BASE}/exports", json={"actor": "Dr. Sam Director", "idempotency_key": "journey-export-v1"}
        )
        assert replay_export.status_code == 200

        # Reload restores the same projection without client memory.
        assert journey(client) == done

        events = parse_frames(stream(client, run_id).text)
    engine.dispose()

    assert {"complete", "current", "blocked", "pending"} <= seen
    assert [item["sequence"] for item in events] == list(range(1, len(events) + 1))
    assert len({item["event_id"] for item in events}) == len(events)
    assert all(item["label"] == LABEL and item["run_id"] == run_id for item in events)
    types = [item["type"] for item in events]
    gates = [(item["stage_id"], item["gate_number"]) for item in events if item["type"] == "gate_reached"]
    assert gates == [("traceability", 2), ("review-export", 3)]
    assert types.count("export_finished") == 1
    assert types[-2:] == ["stage_finished", "export_finished"]
    export_event = events[-1]
    assert export_event["artifact_count"] > 0
    finished = [item["stage_id"] for item in events if item["type"] == "stage_finished"]
    assert finished == STAGE_IDS
    started = [item["stage_id"] for item in events if item["type"] == "stage_started"]
    assert started == ["parse", "resolve", "extract", "validate", "draft", "provenance"]
    failed = [item for item in events if item["type"] == "command_failed"]
    assert [(item["command"], item["stage_id"]) for item in failed] == [("record_approval", "review-export")]
    flagged = [item for item in events if item["type"] == "action_finished" and item["flag"] == "blocker"]
    assert flagged
    dispositioned = [
        item for item in events if item["type"] == "action_finished" and item["outcome"] == "dispositioned"
    ]
    assert dispositioned and all(item["flag"] is None for item in dispositioned)
    # The traceability gate is reached before any disposition completes it.
    first_gate = types.index("gate_reached")
    assert first_gate < events.index(dispositioned[0])
    # Approvals never produce stage completion; only the export does.
    review_finish = next(
        index
        for index, item in enumerate(events)
        if item["type"] == "stage_finished" and item["stage_id"] == "review-export"
    )
    export_action = next(
        index
        for index, item in enumerate(events)
        if item["type"] == "action_finished" and item["action_id"] == "export"
    )
    assert export_action < review_finish


def test_last_event_id_replays_only_missed_events_and_expired_cursor_is_typed(tmp_path: Path) -> None:
    client, engine = build_client(qualified_fixture_root(tmp_path), run_event_retention=5)
    with client:
        run_id = client.post(f"{BASE}/pinned-runs", json=FREEZE).json()["run_id"]
        current = journey(client)["run"]
        latest_id = current["latest_event_id"]
        latest_sequence = current["latest_sequence"]
        assert latest_sequence > 5

        retained = parse_frames(stream(client, run_id).text)
        assert [item["sequence"] for item in retained] == list(
            range(latest_sequence - 4, latest_sequence + 1)
        )
        cursor = retained[1]["event_id"]
        missed = parse_frames(stream(client, run_id, cursor).text)
        assert [item["event_id"] for item in missed] == [item["event_id"] for item in retained[2:]]
        by_query = client.get(f"{BASE}/pinned-runs/{run_id}/events", params={"last_event_id": cursor})
        assert parse_frames(by_query.text) == missed
        assert parse_frames(stream(client, run_id, latest_id).text) == []

        expired = stream(client, run_id, f"{run_id}.E000001")
        assert expired.status_code == 409
        body = expired.json()
        assert body == {
            "label": LABEL,
            "code": "event_cursor_expired",
            "detail": body["detail"],
            "run_id": run_id,
            "run_version": current["run_version"],
            "latest_event_id": latest_id,
        }
        foreign = stream(client, run_id, "RUN-OTHER.E000001")
        assert foreign.status_code == 400
        assert foreign.json()["code"] == "invalid_event_cursor"
        unknown = stream(client, "RUN-UNKNOWN")
        assert unknown.status_code == 404
        assert stream(client, run_id).headers["content-type"].startswith("text/event-stream")
    engine.dispose()


def test_pause_and_resume_fixtures_serialize_replay_and_project(tmp_path: Path) -> None:
    """#26 owns pause/resume commands; these are test-local fixture events."""
    client, engine = build_client(qualified_fixture_root(tmp_path))
    with client:
        run_id = client.post(f"{BASE}/pinned-runs", json=FREEZE).json()["run_id"]
        cursor = journey(client)["run"]["latest_event_id"]
        with Session(engine) as session:
            RunEventStore(session).append(
                run_id=run_id,
                study_id=STUDY_ID,
                label=LABEL,
                event_type="run_paused",
                stage_id="validate",
                payload={"reason": "fixture pause"},
            )
            session.commit()
        paused = journey(client)
        assert stage(paused, "validate")["status"] == "paused"
        assert paused["latest_event"]["type"] == "run_paused"
        replayed = parse_frames(stream(client, run_id, cursor).text)
        assert [item["type"] for item in replayed] == ["run_paused"]
        assert replayed[0]["reason"] == "fixture pause"

        with Session(engine) as session:
            RunEventStore(session).append(
                run_id=run_id,
                study_id=STUDY_ID,
                label=LABEL,
                event_type="run_resumed",
                stage_id="validate",
            )
            session.commit()
        resumed = journey(client)
        assert stage(resumed, "validate")["status"] == "current"
        assert [item["type"] for item in parse_frames(stream(client, run_id, cursor).text)] == [
            "run_paused",
            "run_resumed",
        ]
    engine.dispose()


@pytest.mark.parametrize(
    ("event_type", "extra"),
    [
        ("stage_started", {}),
        ("stage_finished", {}),
        ("action_started", {"action_id": "a", "action_label": "A"}),
        ("action_finished", {"action_id": "a", "action_label": "A", "outcome": "blocker", "flag": "blocker"}),
        ("run_paused", {"reason": None}),
        ("run_resumed", {}),
        ("gate_reached", {"gate_number": 2}),
        ("command_failed", {"command": "export", "detail": "not ready"}),
        ("export_finished", {"artifact_count": 3}),
    ],
)
def test_every_run_event_type_round_trips(event_type: str, extra: dict) -> None:
    event = {
        "label": LABEL,
        "event_id": "RUN-ABC.E000001",
        "run_id": "RUN-ABC",
        "study_id": STUDY_ID,
        "sequence": 1,
        "stage_id": "traceability",
        "occurred_at": "2026-09-24T12:00:00Z",
        "type": event_type,
        **extra,
    }
    parsed = RUN_EVENT_ADAPTER.validate_python(event)
    dumped = RUN_EVENT_ADAPTER.dump_python(parsed, mode="json")
    assert RUN_EVENT_ADAPTER.validate_json(json.dumps(dumped)) == parsed
    assert dumped["type"] == event_type


def test_workspace_docs_separate_audit_history_from_live_stream() -> None:
    client, engine = build_client()
    with client:
        schema = client.get("/openapi.json").json()
    events_doc = schema["components"]["schemas"]["WorkspaceResponse"]["properties"]["events"]["description"]
    assert "audit history" in events_doc and "not the live" in events_doc
    route = schema["paths"]["/api/v1/studies/{study_id}/pinned-runs/{run_id}/events"]["get"]
    assert "audit" in route["description"]
    assert "409" in route["responses"]
    text = json.dumps(schema).lower()
    for claim in ["fda approved", "fda approval", "submission-ready", "submission ready", "compliant"]:
        assert claim not in text
    engine.dispose()


def test_uploaded_study_projects_upload_current_with_no_run() -> None:
    """An intake-uploaded study (no claims, never validated) starts at Upload, not later."""
    roster = (
        b"study_id,animal_id,group_number,group_name,sex,dose_mgkg_day,species,strain\n"
        b"S,A1,1,Control,M,0,Rat,SD\nS,A2,2,High,F,100,Rat,SD\n"
    )
    weights = b"study_id,animal_id,study_day,body_weight_g\nS,A1,1,100.5\nS,A2,1,90.5\n"
    client, engine = build_client()
    with client:
        created = client.post(
            "/api/v1/studies",
            data={
                "study_id": "STUDY-JOURNEY-UP",
                "route": "oral gavage",
                "protocol_version": "1.0",
                "authorized_by": "journey test",
            },
            files=[
                ("files", ("animal_roster.csv", roster, "text/csv")),
                ("files", ("body_weights.csv", weights, "text/csv")),
            ],
        )
        assert created.status_code == 201, created.text
        workspace = client.get("/api/v1/studies/STUDY-JOURNEY-UP/workspace").json()
    projection = workspace["journey"]
    assert workspace["release_gate"]["status"] == "blocked"
    assert projection["label"] == LABEL
    assert projection["run"] is None
    assert projection["current_stage_id"] == "upload"
    assert statuses(projection) == {sid: ("current" if sid == "upload" else "pending") for sid in STAGE_IDS}
    freeze_action = stage(projection, "upload")["actions"][-1]
    assert freeze_action["command"] == "POST /api/v1/studies/STUDY-JOURNEY-UP/pinned-runs"
    engine.dispose()


def test_reconnect_at_latest_cursor_emits_only_newer_events(tmp_path: Path) -> None:
    """Regression (PR #18 review r4098493500): an empty replay must poll from Last-Event-ID, not zero."""
    client, engine = build_client(
        qualified_fixture_root(tmp_path), run_event_stream_seconds=1.0, run_event_poll_seconds=0.1
    )
    with client:
        run_id = client.post(f"{BASE}/pinned-runs", json=FREEZE).json()["run_id"]
        cursor = journey(client)["run"]["latest_event_id"]
        assert int(cursor.rsplit(".E", 1)[1]) > 1

        # No newer events: the whole window must stay silent (no replay of retained events).
        assert parse_frames(stream(client, run_id, cursor).text) == []

        def append_later() -> None:
            time.sleep(0.3)
            with Session(engine) as session:
                RunEventStore(session).append(
                    run_id=run_id,
                    study_id=STUDY_ID,
                    label=LABEL,
                    event_type="run_paused",
                    stage_id="validate",
                    payload={"reason": "arrives after reconnect"},
                )
                session.commit()

        writer = threading.Thread(target=append_later)
        writer.start()
        received = parse_frames(stream(client, run_id, cursor).text)
        writer.join()
    engine.dispose()
    after = int(cursor.rsplit(".E", 1)[1])
    assert [item["type"] for item in received] == ["run_paused"]
    assert all(item["sequence"] > after for item in received)
    assert received[0]["sequence"] == after + 1


def test_run_conflict_and_unknown_package_record_command_failed(tmp_path: Path) -> None:
    """PR #18 review r4098493508: API-mapped run-command failures emit command_failed."""
    client, engine = build_client(qualified_fixture_root(tmp_path))
    with client:
        run_id = client.post(f"{BASE}/pinned-runs", json=FREEZE).json()["run_id"]
        cursor = journey(client)["run"]["latest_event_id"]
        conflict = client.post(f"{BASE}/pinned-runs", json={**FREEZE, "actor": "Someone Else"})
        assert conflict.status_code == 409, conflict.text
        unknown = client.post(
            f"{BASE}/data-validation-packages",
            json={
                "actor": "Dr. Run Owner",
                "package_id": "validation.does_not_exist",
                "idempotency_key": "journey-unknown-dvp",
            },
        )
        assert unknown.status_code == 404, unknown.text
        failed = parse_frames(stream(client, run_id, cursor).text)
    engine.dispose()
    assert [(item["type"], item["command"], item["stage_id"]) for item in failed] == [
        ("command_failed", "freeze_run", "upload"),
        ("command_failed", "run_data_validation", "extract"),
    ]


# --- Feed hardening (CoS/Tester review of PR #18) -------------------------------------


def _append(engine, run_id: str, reason: str, *, session: Session | None = None) -> None:
    owned = session is None
    active = session or Session(engine)
    try:
        RunEventStore(active).append(
            run_id=run_id,
            study_id=STUDY_ID,
            label=LABEL,
            event_type="run_paused",
            stage_id="validate",
            payload={"reason": reason},
        )
        if owned:
            active.commit()
    finally:
        if owned:
            active.close()


def test_mid_history_reconnect_delivers_exactly_the_missing_range(tmp_path: Path) -> None:
    client, engine = build_client(qualified_fixture_root(tmp_path))
    with client:
        run_id = client.post(f"{BASE}/pinned-runs", json=FREEZE).json()["run_id"]
        assert client.post(f"{BASE}/validation-runs", json={"planner": "fixture"}).status_code == 201
        latest = journey(client)["run"]["latest_sequence"]
        assert latest > 8
        everything = parse_frames(stream(client, run_id).text)
        assert [item["sequence"] for item in everything] == list(range(1, latest + 1))
        middle = latest // 2
        missing = parse_frames(stream(client, run_id, f"{run_id}.E{middle:06d}").text)
    engine.dispose()
    assert [item["sequence"] for item in missing] == list(range(middle + 1, latest + 1))
    assert missing == everything[middle:]


def test_silent_then_cursor_plus_one_reconnect_delivers_exactly_next_event_once(tmp_path: Path) -> None:
    """Reconnect with Last-Event-ID=N, stay silent, then N+1 arrives: deliver N+1 once, nothing else."""
    client, engine = build_client(
        qualified_fixture_root(tmp_path), run_event_stream_seconds=1.2, run_event_poll_seconds=0.1
    )
    with client:
        run_id = client.post(f"{BASE}/pinned-runs", json=FREEZE).json()["run_id"]
        cursor = journey(client)["run"]["latest_event_id"]
        n = int(cursor.rsplit(".E", 1)[1])

        def append_after_silence() -> None:
            time.sleep(0.5)  # several empty polls first
            _append(engine, run_id, "the next event after a silent reconnect")

        writer = threading.Thread(target=append_after_silence)
        writer.start()
        response = stream(client, run_id, cursor)
        writer.join()
    engine.dispose()
    received = parse_frames(response.text)
    assert "cursor_expired" not in response.text
    assert [item["sequence"] for item in received] == [n + 1]
    assert [item["event_id"] for item in received] == [f"{run_id}.E{n + 1:06d}"]


def test_cursor_at_oldest_minus_one_replays_and_oldest_minus_two_expires(tmp_path: Path) -> None:
    client, engine = build_client(qualified_fixture_root(tmp_path), run_event_retention=5)
    with client:
        run_id = client.post(f"{BASE}/pinned-runs", json=FREEZE).json()["run_id"]
        latest = journey(client)["run"]["latest_sequence"]
        oldest = latest - 4
        assert oldest > 2
        replayed = stream(client, run_id, f"{run_id}.E{oldest - 1:06d}")
        expired = stream(client, run_id, f"{run_id}.E{oldest - 2:06d}")
    engine.dispose()
    assert replayed.status_code == 200
    assert [item["sequence"] for item in parse_frames(replayed.text)] == list(range(oldest, latest + 1))
    assert expired.status_code == 409
    assert expired.json()["code"] == "event_cursor_expired"


@pytest.mark.parametrize("pruned", ["partial", "all"])
def test_prune_racing_replay_returns_409_not_a_silent_gap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, pruned: str
) -> None:
    """Inject a prune between replay's state read and its row read (deterministic race)."""
    client, engine = build_client(qualified_fixture_root(tmp_path))
    with client:
        run_id = client.post(f"{BASE}/pinned-runs", json=FREEZE).json()["run_id"]
        latest = journey(client)["run"]["latest_sequence"]
        assert latest > 6
        original_state = RunEventStore.state
        armed = {"on": True}

        def state_then_prune(self: RunEventStore, target: str):
            state = original_state(self, target)
            if armed["on"]:
                armed["on"] = False
                # A concurrent prune commits after the state (oldest_retained) was read.
                cutoff = 5 if pruned == "partial" else latest
                self.session.execute(
                    delete(RunEventRow).where(RunEventRow.run_id == target, RunEventRow.sequence <= cutoff)
                )
            return state

        monkeypatch.setattr(RunEventStore, "state", state_then_prune)
        response = stream(client, run_id, f"{run_id}.E000002")
    engine.dispose()
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "event_cursor_expired"


def test_poll_loop_cursor_expiry_emits_terminal_cursor_expired_frame(tmp_path: Path) -> None:
    client, engine = build_client(
        qualified_fixture_root(tmp_path), run_event_stream_seconds=1.2, run_event_poll_seconds=0.1
    )
    with client:
        run_id = client.post(f"{BASE}/pinned-runs", json=FREEZE).json()["run_id"]
        current = journey(client)["run"]
        cursor = current["latest_event_id"]
        n = current["latest_sequence"]

        def append_with_gap() -> None:
            time.sleep(0.3)
            with Session(engine) as session:
                _append(engine, run_id, "pruned before the poll saw it", session=session)
                _append(engine, run_id, "visible after the gap", session=session)
                session.execute(
                    delete(RunEventRow).where(RunEventRow.run_id == run_id, RunEventRow.sequence == n + 1)
                )
                session.commit()

        writer = threading.Thread(target=append_with_gap)
        writer.start()
        started = time.monotonic()
        response = stream(client, run_id, cursor)
        elapsed = time.monotonic() - started
        writer.join()
    engine.dispose()
    assert response.status_code == 200
    assert "run_paused" not in response.text  # nothing from after the gap leaks through
    blocks = [block for block in response.text.split("\n\n") if block.strip() and not block.startswith(":")]
    assert len(blocks) == 1
    lines = dict(line.split(": ", 1) for line in blocks[0].splitlines())
    assert lines["event"] == "cursor_expired"
    assert "id" not in lines
    body = json.loads(lines["data"])
    assert body["code"] == "event_cursor_expired"
    assert body["run_id"] == run_id
    assert body["label"] == LABEL
    assert elapsed < 1.1  # terminal: the stream ends at the expiry, not at the window


def _postgres_url(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    binaries = [
        shutil.which(name) or f"/opt/homebrew/bin/{name}" for name in ("initdb", "pg_ctl", "createdb")
    ]
    if not all(Path(item).exists() for item in binaries):
        pytest.skip("PostgreSQL binaries (initdb/pg_ctl/createdb) are not installed")
    initdb, pg_ctl, createdb = binaries
    data = tmp_path_factory.mktemp("pgdata")
    sockets = Path(tempfile.mkdtemp(prefix="pg", dir="/tmp"))  # unix socket paths are length-limited
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    subprocess.run([initdb, "-D", str(data), "-U", "helix", "-A", "trust"], check=True, capture_output=True)
    subprocess.run(
        [
            pg_ctl,
            "-D",
            str(data),
            "-l",
            str(data / "server.log"),
            "-o",
            f"-p {port} -k {sockets} -c listen_addresses=127.0.0.1",
            "-w",
            "start",
        ],
        check=True,
        capture_output=True,
    )
    try:
        subprocess.run(
            [createdb, "-h", "127.0.0.1", "-p", str(port), "-U", "helix", "helix"],
            check=True,
            capture_output=True,
        )
        yield f"postgresql+psycopg://helix@127.0.0.1:{port}/helix"
    finally:
        subprocess.run([pg_ctl, "-D", str(data), "-m", "immediate", "stop"], capture_output=True)
        shutil.rmtree(sockets, ignore_errors=True)


@pytest.fixture
def database_url(request: pytest.FixtureRequest, tmp_path: Path, tmp_path_factory: pytest.TempPathFactory):
    if request.param == "sqlite-file":
        yield f"sqlite+pysqlite:///{tmp_path / 'helix.db'}"
    else:
        yield from _postgres_url(tmp_path_factory)


@pytest.mark.parametrize("database_url", ["sqlite-file", "postgresql"], indirect=True)
def test_concurrent_commands_on_one_study_emit_gap_free_sequences_without_duplicates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, database_url: str
) -> None:
    """Two dispositions run in parallel threads with their own sessions.

    Thread A is delayed right before it takes the run-state lock, so B's command can
    commit in between. Facts must be read under the lock, or A emits stale diffs.
    """
    root = qualified_fixture_root(tmp_path)
    settings = Settings(
        database_url=database_url,
        seed_path=ROOT / "synthetic-e2e" / "helix-synthetic-bundle.json",
        codex_repository_root=root,
        auto_seed=True,
        run_event_stream_seconds=0,
    )
    engine = create_database_engine(settings)
    create_schema(engine)
    factory = create_session_factory(engine)

    def study_service(session: Session) -> StudyService:
        section_runs = SectionRunService(session, CodexSectionAgent(root), root)
        return StudyService(session, settings, section_runs, PinnedRunService(session, root))

    with factory() as session:
        seed_database(session, settings)
        session.commit()
    with factory() as session:
        run_id = study_service(session).freeze_run(STUDY_ID, FreezeRunCommand(**FREEZE)).run_id
    with factory() as session:
        study_service(session).run_validation(STUDY_ID, ValidationRequest(planner="fixture"))

    original_lock = RunEventStore._state_for_update

    def delayed_lock(self: RunEventStore, target_run: str, study_id: str):
        if threading.current_thread().name == "A":
            time.sleep(0.6)
        return original_lock(self, target_run, study_id)

    monkeypatch.setattr(RunEventStore, "_state_for_update", delayed_lock)
    errors: list[BaseException] = []

    def disposition(result_id: str) -> None:
        try:
            with factory() as session:
                study_service(session).disposition(
                    STUDY_ID,
                    result_id,
                    DispositionCommand(
                        decision="corrected",
                        reason=f"Concurrent disposition {result_id}.",
                        reviewer="Dr. Ada Path",
                    ),
                )
        except BaseException as exc:  # noqa: BLE001 - surfaced by the assertion below
            errors.append(exc)

    first = threading.Thread(target=disposition, args=("VR-004",), name="A")
    second = threading.Thread(target=disposition, args=("VR-005",), name="B")
    first.start()
    time.sleep(0.15)
    second.start()
    first.join(20)
    second.join(20)
    monkeypatch.setattr(RunEventStore, "_state_for_update", original_lock)
    assert not errors, errors

    with factory() as session:
        events = RunEventStore(session).replay(run_id, None)
    engine.dispose()
    sequences = [item["sequence"] for item in events]
    assert sequences == list(range(1, len(events) + 1))
    finished = [(item["action_id"], item["outcome"]) for item in events if item["type"] == "action_finished"]
    assert len(finished) == len(set(finished)), finished
    dispositioned = {action for action, outcome in finished if outcome == "dispositioned"}
    assert {"disposition:VR-004", "disposition:VR-005"} <= dispositioned


def test_open_event_stream_does_not_hold_the_sqlite_write_lock(tmp_path: Path) -> None:
    """DH-1: auto-run writes right after freeze while the events stream is open."""
    import sqlite3

    db = tmp_path / "helix.db"
    settings = Settings(
        database_url=f"sqlite+pysqlite:///{db}",
        seed_path=ROOT / "synthetic-e2e" / "helix-synthetic-bundle.json",
        codex_repository_root=qualified_fixture_root(tmp_path),
        auto_seed=True,
        run_event_stream_seconds=2,
    )
    client = TestClient(create_app(settings, create_database_engine(settings)))
    with client:
        run_id = client.post(f"{BASE}/pinned-runs", json=FREEZE).json()["run_id"]

        def consume() -> None:
            with client.stream("GET", f"{BASE}/pinned-runs/{run_id}/events") as response:
                for _ in response.iter_lines():
                    pass

        reader = threading.Thread(target=consume)
        reader.start()
        time.sleep(0.5)
        connection = sqlite3.connect(db, timeout=0.3, isolation_level=None)
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("ROLLBACK")
        finally:
            connection.close()
            reader.join()
