"""HELIX_DEMO_UNQUALIFIED_PACKAGES: demo-only handling of the pending 5.2.3 / 5.3 packages (Lane D).

DEMO ONLY, NOT QUALIFICATION. These tests use the shipped governed tree, where both section
packages are qualification_status "pending". Nothing here writes a status or hash into a
package file; the tests assert the files are byte-identical before and after.

Rules proven here:
- The flag is off by default. Off, every gate behaves exactly as without the flag.
- On, the flag skips only the 5.2.3 / 5.3 qualification gate of the human freeze. The freeze
  itself stays human-only: nothing freezes, validates, or drafts until a person calls
  POST /pinned-runs.
- On, the workspace payload labels both sections "Demo: not qualified"; the packages stay
  "pending" and no hash is fabricated.
- Export fails closed for a demo-frozen run (DH-7, #68): 409 with the refusal detail, and no
  artifact is materialized or recorded. Strict runs and flag-off export are unchanged.
"""

import hashlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from test_final_study_approval import clear_blockers, record_fsa, record_roles
from test_journey_run_events import qualified_fixture_root

from app import qualification
from app.config import Settings
from app.database import create_database_engine
from app.main import create_app
from app.manifest_authorization import HUMAN_FREEZE_REQUIRED
from app.models import PinnedRunRow
from app.qualification import (
    DEMO_EVENT_DETAIL,
    DEMO_EXPORT_REFUSAL,
    DEMO_LABEL,
    DEMO_NOT_QUALIFIED,
    DEMO_UNQUALIFIED_PACKAGE_IDS,
    demo_frozen_export_refusal,
)

ROOT = Path(__file__).resolve().parents[2]
STUDY_ID = "STUDY-HLX-028"
BASE = f"/api/v1/studies/{STUDY_ID}"
SECTIONS = ROOT / "skills" / "helix-evidence-pipeline" / "packages" / "sections"
PACKAGE_FILES = sorted(SECTIONS.glob("*/package.json"))
FREEZE = {"actor": "Dr. Run Owner", "idempotency_key": "demo-freeze-v1"}


def build_client(
    *, demo: bool | None, root: Path = ROOT, database_url: str = "sqlite+pysqlite:///:memory:"
) -> tuple[TestClient, object]:
    """demo=None builds Settings without naming the flag at all (today's default)."""
    overrides = {} if demo is None else {"demo_unqualified_packages": demo}
    settings = Settings(
        database_url=database_url,
        seed_path=ROOT / "synthetic-e2e" / "helix-synthetic-bundle.json",
        codex_repository_root=root,
        auto_seed=True,
        run_event_stream_seconds=0,
        **overrides,
    )
    engine = create_database_engine(settings)
    return TestClient(create_app(settings, engine)), engine


def package_file_digests(root: Path = ROOT) -> dict[str, str]:
    sections = root / "skills" / "helix-evidence-pipeline" / "packages" / "sections"
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(sections.glob("*/package.json"))
    }


def assert_packages_pending_without_hash() -> None:
    for path in PACKAGE_FILES:
        skill = json.loads(path.read_text())["skill"]
        assert skill["qualification_status"] == "pending", path
        assert "qualification_hash" not in skill, path
        assert "qualification_id" not in skill, path


def freeze(client: TestClient, key: str = FREEZE["idempotency_key"]):
    return client.post(f"{BASE}/pinned-runs", json={**FREEZE, "idempotency_key": key})


def export(client: TestClient):
    return client.post(
        f"{BASE}/exports", json={"actor": "Dr. Sam Director", "idempotency_key": "demo-export-v1"}
    )


def pinned_run_count(engine: object) -> int:
    from sqlalchemy.orm import Session

    with Session(engine) as session:
        return int(session.scalar(select(func.count()).select_from(PinnedRunRow)) or 0)


# --- the flag -----------------------------------------------------------------------------


def test_flag_is_off_by_default_and_read_from_its_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HELIX_DEMO_UNQUALIFIED_PACKAGES", raising=False)
    assert Settings(_env_file=None).demo_unqualified_packages is False
    monkeypatch.setenv("HELIX_DEMO_UNQUALIFIED_PACKAGES", "1")
    assert Settings(_env_file=None).demo_unqualified_packages is True
    assert DEMO_UNQUALIFIED_PACKAGE_IDS == ("section.5_2_3_body_weight", "section.5_3_discussion")


# --- flag off: strict, exactly as before ------------------------------------------------


@pytest.mark.parametrize("demo", [None, False], ids=["unset", "explicit-off"])
def test_flag_off_keeps_the_strict_422_for_both_pending_packages(demo: bool | None) -> None:
    before = package_file_digests()
    client, engine = build_client(demo=demo)
    with client:
        frozen = freeze(client, "demo-off-v1")
        workspace = client.get(f"{BASE}/workspace").json()
    engine.dispose()
    assert frozen.status_code == 422
    assert frozen.json()["detail"] == [
        {
            "code": "invalid_package_qualification",
            "subject": package_id,
            "message": "Agentic package qualification has not passed",
        }
        for package_id in DEMO_UNQUALIFIED_PACKAGE_IDS
    ]
    assert workspace["pinned_run"] is None
    assert workspace["demo_unqualified_packages"] == []
    assert DEMO_LABEL not in json.dumps(workspace)
    assert package_file_digests() == before
    assert_packages_pending_without_hash()


def test_flag_off_is_identical_to_today_for_a_qualified_tree(tmp_path: Path) -> None:
    """Flag unset vs explicitly off vs on, over a qualified tree: the same run, byte for byte.

    With every package qualified there is nothing for the flag to skip, so even flag-on must
    freeze the exact strict run: same run id, same receipt, no demo detail, no labels.
    """
    root = qualified_fixture_root(tmp_path)
    before = package_file_digests(root)
    results = {}
    for name, demo in {"unset": None, "off": False, "on": True}.items():
        client, engine = build_client(demo=demo, root=root)
        with client:
            frozen = freeze(client)
            assert frozen.status_code == 201, frozen.text
            workspace = client.get(f"{BASE}/workspace").json()
        engine.dispose()
        run = frozen.json()
        assert DEMO_EVENT_DETAIL not in run["event_history"][0]["details"]
        assert workspace["demo_unqualified_packages"] == []
        assert DEMO_LABEL not in json.dumps(workspace)
        results[name] = (run["run_id"], run["receipt"], run["governed_inputs"])
    assert results["unset"] == results["off"] == results["on"]
    assert package_file_digests(root) == before


def test_flag_off_failed_qualification_is_unchanged(tmp_path: Path) -> None:
    root = qualified_fixture_root(tmp_path, status="failed")
    for demo in (False, True):
        client, engine = build_client(demo=demo, root=root)
        with client:
            frozen = freeze(client, f"failed-{demo}")
        engine.dispose()
        # "failed" is never skipped, flag or not.
        assert frozen.status_code == 422, frozen.text
        subjects = [item["subject"] for item in frozen.json()["detail"]]
        assert subjects == list(DEMO_UNQUALIFIED_PACKAGE_IDS)


# --- flag on: the freeze stays human-only ------------------------------------------------


@pytest.mark.parametrize("demo", [True, False], ids=["flag-on", "flag-off"])
def test_flag_on_never_freezes_by_itself_and_still_requires_the_human_freeze(demo: bool) -> None:
    """Automated commands before the human freeze get 409 human_freeze_required, flag on or off."""
    client, engine = build_client(demo=demo)
    with client:
        loaded = client.get(f"{BASE}/workspace").json()
        validation = client.post(f"{BASE}/validation-runs", json={"planner": "fixture"})
        data_validation = client.post(
            f"{BASE}/data-validation-packages",
            json={
                "actor": "Dr. Run Owner",
                "package_id": "validation.body_weight",
                "idempotency_key": "demo-dv-before-freeze-1",
            },
        )
        exported = export(client)
        after_attempts = client.get(f"{BASE}/workspace").json()
        runs_before_human = pinned_run_count(engine)

        frozen = freeze(client)
        workspace = client.get(f"{BASE}/workspace").json()
    engine.dispose()

    # Loading the workspace with the flag on creates nothing.
    assert loaded["pinned_run"] is None
    # Agent-side commands refuse with the typed human-freeze error; they never freeze.
    for response in (validation, data_validation):
        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == HUMAN_FREEZE_REQUIRED
    assert exported.status_code in {409, 422}, exported.text
    assert after_attempts["pinned_run"] is None
    assert runs_before_human == 0
    assert after_attempts["journey"] == loaded["journey"]

    # Only the explicit human command freezes, and it records the actor and the skip.
    if not demo:
        # Flag off on the shipped pending tree: the human freeze keeps the strict 422.
        assert frozen.status_code == 422, frozen.text
        assert workspace["pinned_run"] is None
        return
    assert frozen.status_code == 201, frozen.text
    run_requested = frozen.json()["event_history"][0]
    assert run_requested["actor"] == FREEZE["actor"]
    assert run_requested["details"][DEMO_EVENT_DETAIL] == ",".join(DEMO_UNQUALIFIED_PACKAGE_IDS)
    assert workspace["pinned_run"]["run_id"] == frozen.json()["run_id"]


def test_flag_on_non_demo_package_still_needs_qualification(tmp_path: Path) -> None:
    """Only 5.2.3 and 5.3 are skipped. A third pending section package still blocks the run."""
    root = qualified_fixture_root(tmp_path, status="pending")
    sections = root / "skills" / "helix-evidence-pipeline" / "packages" / "sections"
    other_dir = sections / "9_9_other_section"
    other_dir.mkdir()
    other = json.loads((sections / "5_3_discussion" / "package.json").read_text())
    other.update(
        package_id="section.9_9_other_section", section_id="9_9_other_section", title="Other section"
    )
    assert other["skill"]["qualification_status"] == "pending"
    (other_dir / "package.json").write_text(json.dumps(other, indent=2))

    client, engine = build_client(demo=True, root=root)
    with client:
        frozen = freeze(client, "other-v1")
    engine.dispose()
    assert frozen.status_code == 422, frozen.text
    subjects = [
        item["subject"] for item in frozen.json()["detail"] if item["code"] == "invalid_package_qualification"
    ]
    assert subjects == ["section.9_9_other_section"]


def test_flag_on_scope_is_exactly_the_two_named_packages(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(qualification, "DEMO_UNQUALIFIED_PACKAGE_IDS", ("section.5_2_3_body_weight",))
    client, engine = build_client(demo=True)
    with client:
        frozen = freeze(client, "no-53-v1")
    engine.dispose()
    assert frozen.status_code == 422
    assert [item["subject"] for item in frozen.json()["detail"]] == ["section.5_3_discussion"]


# --- flag on: labels, pending packages, no fabricated hashes ------------------------------


def test_flag_on_freeze_records_no_qualification_hash_and_keeps_packages_pending() -> None:
    before = package_file_digests()
    client, engine = build_client(demo=True)
    with client:
        frozen = freeze(client)
        workspace = client.get(f"{BASE}/workspace").json()
    engine.dispose()
    assert frozen.status_code == 201, frozen.text
    run = frozen.json()
    text = json.dumps(run)
    assert "qualification_hash" not in text
    assert "skill_hash" not in text
    # Governed inputs are real file hashes of real files, the same identities as a strict run.
    for item in run["governed_inputs"]:
        path = ROOT / item["path"] if "path" in item else None
        if path is not None and path.is_file():
            assert item["content_hash"] == "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    labels = workspace["demo_unqualified_packages"]
    assert [item["section_package_id"] for item in labels] == list(DEMO_UNQUALIFIED_PACKAGE_IDS)
    assert {item["label"] for item in labels} == {DEMO_LABEL}
    assert {item["qualification_status"] for item in labels} == {"pending"}
    assert [item["prototype_section_id"] for item in labels] == ["S5", "S8"]
    assert package_file_digests() == before
    assert_packages_pending_without_hash()


def test_flag_on_exports_with_both_packages_pending_and_labels_ui_payload_and_report() -> None:
    """DH-7 (#68): flipped. A demo-frozen run is fully approved but export fails closed with 409."""
    before = package_file_digests()
    client, engine = build_client(demo=True)
    with client:
        before_run = client.get(f"{BASE}/workspace").json()
        assert freeze(client).status_code == 201
        clear_blockers(client)
        record_roles(client)
        approved = record_fsa(client, key="demo-fsa-v1")
        assert approved.status_code == 200, approved.text
        ready = client.get(f"{BASE}/workspace").json()
        exported = export(client)
        replay = export(client)
        workspace = client.get(f"{BASE}/workspace").json()
    engine.dispose()

    for payload in (before_run, workspace):
        labels = payload["demo_unqualified_packages"]
        assert [item["section_package_id"] for item in labels] == list(DEMO_UNQUALIFIED_PACKAGE_IDS)
        assert {item["label"] for item in labels} == {DEMO_LABEL}
        assert {item["qualification_status"] for item in labels} == {"pending"}

    # Fails closed with the existing 409 error envelope and the refusal detail.
    assert ready["release_gate"]["status"] == "ready_for_export"
    for response in (exported, replay):
        assert response.status_code == 409, response.text
        assert response.json() == {"detail": REFUSAL_DETAIL}
    # Nothing is materialized or recorded: the gate, artifacts and state are untouched.
    assert workspace["release_gate"] == ready["release_gate"]
    assert workspace["export_artifacts"] == ready["export_artifacts"]
    assert all(item["status"] != "exported" for item in workspace["export_artifacts"])
    assert workspace["workflow_state"] == ready["workflow_state"]
    # The journey stages do not move; the refusal is only audited as the latest run event.
    assert workspace["journey"]["current_stage_id"] == ready["journey"]["current_stage_id"]
    assert workspace["journey"]["stages"] == ready["journey"]["stages"]
    refused = workspace["journey"]["latest_event"]
    assert refused["command"] == "export"
    assert refused["detail"] == DEMO_EXPORT_REFUSAL

    assert package_file_digests() == before
    assert_packages_pending_without_hash()


REFUSAL_DETAIL = {"code": DEMO_NOT_QUALIFIED, "message": DEMO_EXPORT_REFUSAL}


def export_demo_run_before_the_guard(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[str, dict]:
    """A demo-frozen run exported by the parent release (no guard), in a persistent DB."""
    import app.approved_exports as approved_exports_module
    import app.service as service_module

    database_url = f"sqlite+pysqlite:///{tmp_path / 'legacy.db'}"
    with monkeypatch.context() as legacy:
        legacy.setattr(approved_exports_module, "demo_frozen_export_refusal", lambda _run: None)
        legacy.setattr(service_module, "demo_frozen_export_refusal", lambda _run: None)
        client, engine = build_client(demo=True, database_url=database_url)
        with client:
            assert freeze(client, "legacy-freeze-v1").status_code == 201
            clear_blockers(client)
            record_roles(client)
            assert record_fsa(client, key="legacy-fsa-v1").status_code == 200
            exported = export(client)
            assert exported.status_code == 200, exported.text
            downloaded = {
                item["artifact_id"]: client.get(f"{BASE}/exports/{item['artifact_id']}").status_code
                for item in exported.json()["artifacts"]
            }
        engine.dispose()
    assert set(downloaded.values()) == {200}  # the legacy hole the guard now closes
    return database_url, exported.json()


@pytest.mark.parametrize("demo", [True, False], ids=["flag-on", "flag-off"])
def test_legacy_demo_export_replay_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, demo: bool
) -> None:
    """P1 (Tester / Codex l8TeY): a replay with a new key no longer returns the legacy 200."""
    database_url, _receipt = export_demo_run_before_the_guard(tmp_path, monkeypatch)
    client, engine = build_client(demo=demo, database_url=database_url)
    with client:
        replay_new_key = client.post(
            f"{BASE}/exports", json={"actor": "Dr. Sam Director", "idempotency_key": "legacy-replay-v2"}
        )
        replay_same_key = export(client)
    engine.dispose()
    for response in (replay_new_key, replay_same_key):
        assert response.status_code == 409, response.text
        assert response.json() == {"detail": REFUSAL_DETAIL}


@pytest.mark.parametrize("demo", [True, False], ids=["flag-on", "flag-off"])
def test_legacy_demo_export_download_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, demo: bool
) -> None:
    """P1 (Tester / Codex l8TeY): stored bytes of a demo-frozen run are never served again."""
    database_url, receipt = export_demo_run_before_the_guard(tmp_path, monkeypatch)
    client, engine = build_client(demo=demo, database_url=database_url)
    with client:
        downloads = [client.get(f"{BASE}/exports/{item['artifact_id']}") for item in receipt["artifacts"]]
    engine.dispose()
    assert downloads
    for response in downloads:
        assert response.status_code == 409, response.text
        assert response.json() == {"detail": REFUSAL_DETAIL}
        assert DEMO_LABEL.encode() not in response.content


def test_demo_frozen_export_refusal_is_keyed_on_the_frozen_run_not_the_flag(tmp_path: Path) -> None:
    """Flag on over a qualified tree skips nothing, so the run is strict and exports 200."""
    client, engine = build_client(demo=True, root=qualified_fixture_root(tmp_path))
    with client:
        frozen = freeze(client, "qualified-flag-on-v1")
        assert frozen.status_code == 201, frozen.text
        assert DEMO_EVENT_DETAIL not in frozen.json()["event_history"][0]["details"]
        clear_blockers(client)
        record_roles(client)
        assert record_fsa(client, key="qualified-flag-on-fsa-v1").status_code == 200
        exported = export(client)
        workspace = client.get(f"{BASE}/workspace").json()
    engine.dispose()
    assert exported.status_code == 200, exported.text
    assert workspace["release_gate"]["status"] == "exported"
    assert workspace["demo_unqualified_packages"] == []


def test_demo_frozen_export_refusal_helper() -> None:
    class Event:
        def __init__(self, details: dict[str, str]):
            self.event = "run_requested"
            self.details = details

    class Run:
        def __init__(self, details: dict[str, str]):
            self.event_history = [Event(details)]

    assert demo_frozen_export_refusal(None) is None
    assert demo_frozen_export_refusal(Run({})) is None
    assert demo_frozen_export_refusal(Run({DEMO_EVENT_DETAIL: ""})) is None
    demo_run = Run({DEMO_EVENT_DETAIL: "section.5_3_discussion"})
    assert demo_frozen_export_refusal(demo_run) == DEMO_EXPORT_REFUSAL


def test_flag_off_export_bytes_carry_no_demo_label(tmp_path: Path) -> None:
    """Strict run on a qualified tree: the export path is unchanged (no notice, no wrapper)."""
    client, engine = build_client(demo=False, root=qualified_fixture_root(tmp_path))
    with client:
        assert freeze(client).status_code == 201
        clear_blockers(client)
        record_roles(client)
        assert record_fsa(client, key="strict-fsa-v1").status_code == 200
        exported = export(client)
        assert exported.status_code == 200, exported.text
        artifacts = {
            item["kind"]: client.get(f"{BASE}/exports/{item['artifact_id']}").content
            for item in exported.json()["artifacts"]
        }
    engine.dispose()
    for content in artifacts.values():
        assert DEMO_LABEL.encode() not in content
    manifest = json.loads(artifacts["pinned_run"])
    assert isinstance(manifest, list)  # the bare manifest, exactly as before the flag existed
