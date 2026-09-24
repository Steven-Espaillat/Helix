import json
import re
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.agents.codex_section_agent import AgentResult, CodexSectionAgent
from app.config import Settings
from app.database import create_database_engine
from app.main import create_app
from app.models import AuditEventRow, SectionRunRow
from app.repository import StudyPackageRepository
from app.schemas import SectionRunCommand
from app.section_runs import SectionRunService
from app.template_contracts import evaluate_template_contract

ROOT = Path(__file__).resolve().parents[2]
STUDY_ID = "STUDY-HLX-028"
COMMAND = {
    "section_package_id": "section.5_2_3_body_weight",
    "idempotency_key": "workbench-STUDY-HLX-028-body-weight-v1",
}


def by_package(workspace: dict[str, object], package_id: str) -> dict[str, object]:
    return next(
        item
        for item in workspace["section_run_eligibility"]
        if item["section_package_id"] == package_id
    )


def assert_ready(eligibility: dict[str, object], package_id: str) -> None:
    assert eligibility["section_package_id"] == package_id
    assert eligibility["eligible"] is True
    assert eligibility["reasons"] == []
    assert eligibility["gate_results"]
    assert all(item["status"] == "passed" for item in eligibility["gate_results"])
    assert all(item["waivable"] is False for item in eligibility["gate_results"])
    assert all(item["enforcement_class"] == "hard_blocker" for item in eligibility["gate_results"])
    assert eligibility["impact_set"] == {
        "origin_section_package_id": package_id,
        "direct": [package_id],
        "transitive": [],
    }


class FakeSectionAgent:
    def __init__(self, mode: str = "valid"):
        self.mode = mode
        self.calls = 0

    def run(self, *, envelope_id: str, prompt: str, output_schema: dict[str, object]) -> AgentResult:
        self.calls += 1
        if self.mode == "failure":
            raise RuntimeError("SDK unavailable")
        if self.mode == "malformed":
            return AgentResult(thread_id="thread-test-001", final_response="not json")
        candidate_id = re.search(r"candidate_id (SDC-[A-Z0-9-]+)", prompt).group(1)
        run_id = re.search(r"run_id (SRUN-[A-Z0-9-]+)", prompt).group(1)
        skill_hash = re.search(r"skill_hash to (sha256:[a-f0-9]{64})", prompt).group(1)
        claim_ids = ["C-NOT-ALLOWED"] if self.mode == "unapproved" else ["C-BW-HIGH"]
        span_claim_ids = claim_ids
        content: object = "Terminal high-dose body weight was 286.2 g."
        if self.mode == "uncovered_content":
            content = "Terminal high-dose body weight was 286.2 g. Unsupported factual assertion."
        if self.mode == "nested_unapproved":
            content = {
                "rows": [
                    {
                        "cells": [
                            {"text": "286.2 g", "claim_ids": ["C-NOT-ALLOWED"]},
                        ]
                    }
                ]
            }
        receipt = {
            "runtime": "codex_sdk",
            "thread_id": "thread-test-001",
            "skill_name": "helix-section-agent",
            "skill_hash": skill_hash,
        }
        if self.mode == "missing_receipt":
            receipt.pop("thread_id")
        candidate = {
            "schema_version": "helix.section-draft-candidate/v1",
            "status": "section_draft_candidate",
            "candidate_id": candidate_id,
            "run_id": run_id,
            "section_id": "5_2_3_body_weight",
            "section_package_id": "section.5_2_3_body_weight",
            "section_package_version": "0.1.0",
            "drafting_cycle_id": "CYCLE-BW-001",
            "attempt": 1,
            "validated_claim_ids": claim_ids,
            "content_blocks": [
                {
                    "block_id": "BW-P1",
                    "kind": "paragraph",
                    "content": content,
                    "factual_spans": (
                        []
                        if self.mode == "empty_factual_spans"
                        else [
                            {
                                "text": (
                                    "286.2 g"
                                    if isinstance(content, dict) or self.mode == "uncovered_content"
                                    else content
                                ),
                                "claim_ids": span_claim_ids,
                            }
                        ]
                    ),
                }
            ],
            "executor_receipt_ids": (
                ["EXEC-NOT-ALLOWED"]
                if self.mode == "unapproved_executor_receipt"
                else ([] if self.mode == "missing_executor_receipt" else ["EXEC-BW-SUMMARY-001"])
            ),
            "agent_receipt": receipt,
        }
        return AgentResult(thread_id="thread-test-001", final_response=json.dumps(candidate))


def governed_root(tmp_path: Path) -> Path:
    root = tmp_path / "helix"
    for relative in ["skills", ".agents"]:
        shutil.copytree(ROOT / relative, root / relative)
    (root / "backend" / "app" / "agents").mkdir(parents=True)
    for filename in ["validation.py", "body_weight.py", "agents/codex_section_agent.py"]:
        source = ROOT / "backend" / "app" / filename
        target = root / "backend" / "app" / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    shutil.copytree(ROOT / "backend" / "app" / "data", root / "backend" / "app" / "data")
    return root


def build_client(
    agent: FakeSectionAgent,
    *,
    repository_root: Path = ROOT,
    raise_server_exceptions: bool = True,
):
    settings = Settings(
        database_url="sqlite+pysqlite:///:memory:",
        seed_path=ROOT / "synthetic-e2e" / "helix-synthetic-bundle.json",
        codex_repository_root=repository_root,
        auto_seed=True,
    )
    engine = create_database_engine(settings)
    client = TestClient(
        create_app(settings, engine, section_agent=agent),
        raise_server_exceptions=raise_server_exceptions,
    )
    return client, engine


def validate(client: TestClient) -> None:
    response = client.post(f"/api/v1/studies/{STUDY_ID}/validation-runs", json={"planner": "fixture"})
    assert response.status_code == 201


def test_section_run_records_candidate_receipt_scaffold_and_exact_replay() -> None:
    agent = FakeSectionAgent()
    client, engine = build_client(agent)
    with client:
        before = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        assert by_package(before, "section.5_2_3_body_weight")["eligible"] is False
        validate(client)
        eligible = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        body_weight = by_package(eligible, "section.5_2_3_body_weight")
        discussion = by_package(eligible, "section.5_3_discussion")
        assert_ready(body_weight, "section.5_2_3_body_weight")
        assert_ready(discussion, "section.5_3_discussion")
        assert [item["section_package_id"] for item in eligible["section_run_eligibility"]] == [
            "section.5_2_3_body_weight",
            "section.5_3_discussion",
        ]
        assert eligible["review_scaffold_revisions"][0]["sequence"] == 1
        assert eligible["review_scaffold_revisions"][0]["section_impact_sets"] == []

        first = client.post(f"/api/v1/studies/{STUDY_ID}/section-runs", json=COMMAND)
        replay = client.post(f"/api/v1/studies/{STUDY_ID}/section-runs", json=COMMAND)
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()

        assert first.status_code == 201
        assert replay.status_code == 201
        assert replay.json() == first.json()
        assert agent.calls == 1
        receipt = first.json()
        assert receipt["agent_runtime"] == "codex_sdk"
        assert receipt["codex_thread_id"] == "thread-test-001"
        assert receipt["candidate_hash"].startswith("sha256:")
        assert receipt["envelope_hash"].startswith("sha256:")
        assert receipt["skill_hash"].startswith("sha256:")
        assert receipt["review_scaffold_revision"] == 2
        assert len(workspace["section_runs"]) == 1
        stored = workspace["section_runs"][0]
        assert stored["receipt"] == receipt
        assert stored["candidate"]["validated_claim_ids"] == ["C-BW-HIGH"]
        assert "286.2 g" in json.dumps(stored["candidate"])
        assert stored["review_scaffold"]["export_eligible"] is False
        assert "section_impact_sets" in stored["review_scaffold"]
        assert by_package(workspace, "section.5_3_discussion")["eligible"] is True
        body_weight_section = next(
            section
            for section in stored["review_scaffold"]["sections"]
            if section["section_id"] == "5_2_3_body_weight"
        )
        assert body_weight_section["render_state"] == "needs_review"
        assert body_weight_section["placeholder"] == "[NEEDS REVIEW]"
        assert body_weight_section["blocker_result_ids"] == [
            "VR-004",
            "PROMOTION-DISABLED-section.5_2_3_body_weight",
        ]
        assert stored["envelope"]["validated_claims"][0]["grain"] == "dose_group"
        assert "run_plan" not in stored["envelope"]
        assert "study_evidence_package" not in stored["envelope"]
        assert "records" not in stored["envelope"]
        assert stored["envelope"]["pinned_run_id"].startswith("RUN-")
        assert stored["envelope"]["manifest_hash"].startswith("sha256:")
        assert stored["envelope"]["structured_failures"] == [
            {
                "result_id": "VR-004",
                "code": "grain-sex-stratified",
                "message": "The draft groups n=10. The report field requires dose group by sex with n=5.",
            }
        ]
        assert workspace["release_gate"]["status"] == "blocked"
        assert all(
            item["candidate"]["status"] == "section_draft_candidate" for item in workspace["section_runs"]
        )

        conflict = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs",
            json={**COMMAND, "section_package_id": "section.other"},
        )
        assert conflict.status_code == 409

        with client.app.state.session_factory() as session:
            assert session.scalar(select(func.count()).select_from(SectionRunRow)) == 1
            assert (
                session.scalar(
                    select(func.count())
                    .select_from(AuditEventRow)
                    .where(AuditEventRow.event_type == "section_candidate_recorded")
                )
                == 1
            )
    engine.dispose()


def test_unknown_and_ineligible_section_packages_are_rejected_without_starting_codex() -> None:
    agent = FakeSectionAgent()
    client, engine = build_client(agent)
    with client:
        ineligible = client.post(f"/api/v1/studies/{STUDY_ID}/section-runs", json=COMMAND)
        unknown = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs",
            json={"section_package_id": "section.other", "idempotency_key": "unknown-package-key"},
        )
        assert ineligible.status_code == 409
        assert unknown.status_code == 404
        assert agent.calls == 0
    engine.dispose()


def test_same_key_with_different_study_command_conflicts() -> None:
    agent = FakeSectionAgent()
    client, engine = build_client(agent)
    with client:
        validate(client)
        assert client.post(f"/api/v1/studies/{STUDY_ID}/section-runs", json=COMMAND).status_code == 201
        response = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs",
            json={**COMMAND, "section_package_id": "section.other"},
        )
        assert response.status_code == 409
    engine.dispose()


def test_candidate_and_sdk_failures_leave_no_partial_state() -> None:
    for mode, expected_status in [
        ("malformed", 422),
        ("unapproved", 422),
        ("nested_unapproved", 422),
        ("empty_factual_spans", 422),
        ("uncovered_content", 422),
        ("unapproved_executor_receipt", 422),
        ("missing_executor_receipt", 422),
        ("missing_receipt", 422),
        ("failure", 503),
    ]:
        agent = FakeSectionAgent(mode)
        client, engine = build_client(agent)
        with client:
            validate(client)
            response = client.post(f"/api/v1/studies/{STUDY_ID}/section-runs", json=COMMAND)
            assert response.status_code == expected_status
            with client.app.state.session_factory() as session:
                assert session.scalar(select(func.count()).select_from(SectionRunRow)) == 0
                assert (
                    session.scalar(
                        select(func.count())
                        .select_from(AuditEventRow)
                        .where(AuditEventRow.event_type == "section_candidate_recorded")
                    )
                    == 0
                )
        engine.dispose()


def test_idempotency_rechecks_after_the_study_lock() -> None:
    agent = FakeSectionAgent()
    client, engine = build_client(agent)
    with client:
        validate(client)
        first = client.post(f"/api/v1/studies/{STUDY_ID}/section-runs", json=COMMAND)
        assert first.status_code == 201
        with client.app.state.session_factory() as session:
            row = session.scalar(select(SectionRunRow))
            service = SectionRunService(session, agent, ROOT)
            with patch.object(service.repository, "get_section_run", side_effect=[None, row]):
                replay = service.run(STUDY_ID, SectionRunCommand.model_validate(COMMAND))

        assert replay.model_dump(mode="json") == first.json()
        assert agent.calls == 1
    engine.dispose()


def test_transaction_failure_rolls_back_candidate_event_and_revision() -> None:
    agent = FakeSectionAgent()
    client, engine = build_client(agent, raise_server_exceptions=False)
    with client:
        validate(client)
        original_save = StudyPackageRepository.save

        def fail_on_candidate(self, package):
            if any(event.event == "section_candidate_recorded" for event in package.events):
                raise RuntimeError("forced transaction failure")
            return original_save(self, package)

        with patch.object(StudyPackageRepository, "save", fail_on_candidate):
            response = client.post(f"/api/v1/studies/{STUDY_ID}/section-runs", json=COMMAND)
        assert response.status_code == 500
        with client.app.state.session_factory() as session:
            assert session.scalar(select(func.count()).select_from(SectionRunRow)) == 0
            assert (
                session.scalar(
                    select(func.count())
                    .select_from(AuditEventRow)
                    .where(AuditEventRow.event_type == "section_candidate_recorded")
                )
                == 0
            )
    engine.dispose()


def test_pinned_run_rejects_manifest_and_governed_version_drift() -> None:
    agent = FakeSectionAgent()
    client, engine = build_client(agent)
    with client:
        validate(client)
        with client.app.state.session_factory() as session:
            repository = StudyPackageRepository(session)
            package = repository.get(STUDY_ID)
            original_checksum = package.manifest[0].checksum
            changed_manifest = [*package.manifest]
            changed_manifest[0] = changed_manifest[0].model_copy(update={"checksum": "sha256:" + "0" * 64})
            repository.save(package.model_copy(update={"manifest": changed_manifest}))
            session.commit()

        manifest_drift = client.post(f"/api/v1/studies/{STUDY_ID}/section-runs", json=COMMAND)
        assert manifest_drift.status_code == 409
        assert "manifest fingerprint" in manifest_drift.json()["detail"]

        with client.app.state.session_factory() as session:
            repository = StudyPackageRepository(session)
            package = repository.get(STUDY_ID)
            original_manifest = [*package.manifest]
            original_manifest[0] = original_manifest[0].model_copy(update={"checksum": original_checksum})
            repository.save(package.model_copy(update={"manifest": original_manifest}))
            session.commit()
        validate(client)

        original_file_hash = SectionRunService._file_hash

        def drifted_file_hash(path: Path) -> str:
            if path.name == "ontology.md":
                return "sha256:" + "0" * 64
            return original_file_hash(path)

        with patch.object(SectionRunService, "_file_hash", side_effect=drifted_file_hash):
            governed_drift = client.post(
                f"/api/v1/studies/{STUDY_ID}/section-runs",
                json={**COMMAND, "idempotency_key": "governed-version-drift"},
            )
        assert governed_drift.status_code == 409
        assert "governed-input fingerprint" in governed_drift.json()["detail"]
        assert agent.calls == 0
    engine.dispose()


def test_unpromoted_candidate_blocks_release_and_export() -> None:
    agent = FakeSectionAgent()
    client, engine = build_client(agent)
    with client:
        validation = client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-runs",
            json={"planner": "fixture"},
        )
        assert validation.status_code == 201
        assert client.post(f"/api/v1/studies/{STUDY_ID}/section-runs", json=COMMAND).status_code == 201
        blockers = [
            result
            for result in validation.json()["results"]
            if result["status"] == "fail" and result["severity"] == "blocker"
        ]
        for result in blockers:
            disposition = client.post(
                f"/api/v1/studies/{STUDY_ID}/validation-results/{result['result_id']}/dispositions",
                json={
                    "decision": ("approved_exception" if result["result_id"] == "VR-006" else "corrected"),
                    "reason": f"Synthetic disposition recorded for {result['rule_id']}.",
                    "reviewer": "Dr. Ada Path",
                },
            )
            assert disposition.status_code == 200

        for role, reviewer, meaning in [
            ("pathologist", "Dr. Ada Path", "Scientific review complete"),
            ("peer_reviewer", "Dr. Priya Peer", "Independent pathology review complete"),
            ("qau", "Morgan QA", "Quality assurance statement recorded"),
            ("study_director", "Dr. Sam Director", "Final report approval"),
        ]:
            approval = client.post(
                f"/api/v1/studies/{STUDY_ID}/approvals",
                json={"role": role, "reviewer": reviewer, "meaning": meaning},
            )
            assert approval.status_code == 200

        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        export = client.post(
            f"/api/v1/studies/{STUDY_ID}/exports",
            json={"actor": "Dr. Sam Director", "idempotency_key": "blocked-export-001"},
        )
        assert workspace["release_gate"]["status"] == "blocked"
        assert workspace["release_gate"]["blocking_result_ids"] == [
            "PROMOTION-DISABLED-section.5_2_3_body_weight"
        ]
        assert export.status_code == 409
    engine.dispose()


def test_inapplicable_section_package_is_excluded_and_cannot_execute(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    package_path = (
        root
        / "skills"
        / "helix-evidence-pipeline"
        / "packages"
        / "sections"
        / "5_2_3_body_weight"
        / "package.json"
    )
    definition = json.loads(package_path.read_text())
    definition["study_type_ids"] = ["INAPPLICABLE_STUDY_TYPE"]
    package_path.write_text(json.dumps(definition))
    agent = FakeSectionAgent()
    client, engine = build_client(agent, repository_root=root)

    with client:
        pinned = client.post(
            f"/api/v1/studies/{STUDY_ID}/pinned-runs",
            json={"actor": "Dr. Run Owner", "idempotency_key": "inapplicable-section"},
        )
        assert pinned.status_code == 201
        assert all(
            node["package_id"] != "section.5_2_3_body_weight" for node in pinned.json()["run_plan"]["nodes"]
        )
        validate(client)
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        eligibility = by_package(workspace, "section.5_2_3_body_weight")
        assert eligibility["eligible"] is False
        assert "The Section Package does not apply to the resolved study type" in eligibility["reasons"]

        response = client.post(f"/api/v1/studies/{STUDY_ID}/section-runs", json=COMMAND)
        assert response.status_code == 409
        assert agent.calls == 0
    engine.dispose()


def test_eligibility_distinguishes_input_claim_grain_from_required_output_grain() -> None:
    agent = FakeSectionAgent()
    client, engine = build_client(agent)
    package_definition = json.loads(
        (ROOT / "skills/helix-evidence-pipeline/packages/sections/5_2_3_body_weight/package.json").read_text()
    )
    required_claim = package_definition["required_claims"][0]
    assert required_claim["input_grain"] == "dose_group"
    assert required_claim["output_grain"] == "dose_group_x_sex"

    with client:
        validate(client)
        with client.app.state.session_factory() as session:
            service = SectionRunService(session, agent, ROOT)
            package = StudyPackageRepository(session).get(STUDY_ID)
            claim = next(item for item in package.claims if item.claim_id == "C-BW-HIGH")
            assert claim.grain == "dose_group"
            assert service.eligibility(package).eligible is True

            mismatched_claims = [
                item.model_copy(update={"grain": "study"}) if item.claim_id == "C-BW-HIGH" else item
                for item in package.claims
            ]
            eligibility = service.eligibility(package.model_copy(update={"claims": mismatched_claims}))

    assert eligibility.eligible is False
    assert "C-BW-HIGH does not match the Section Package input grain" in eligibility.reasons
    engine.dispose()


def test_template_contract_gates_inspect_the_pinned_template() -> None:
    template = json.loads((ROOT / "backend/app/data/report-template.json").read_text())
    section = next(item for item in template["sections"] if item["section_id"] == "S5")
    field = next(item for item in section["fields"] if item["field_id"] == "body-weight")
    field["expected_grain"] = "dose_group"
    package_definition = json.loads(
        (ROOT / "skills/helix-evidence-pipeline/packages/sections/5_2_3_body_weight/package.json").read_text()
    )

    failures = [
        item.message
        for item in evaluate_template_contract(package_definition, template)
        if item.status == "blocked"
    ]

    assert failures == ["Template Contract Gate body-weight-table-shape failed"]

    field["expected_grain"] = "dose_group_x_sex"
    package_definition["required_claims"][0]["output_grain"] = "dose_group"

    failures = [
        item.message
        for item in evaluate_template_contract(package_definition, template)
        if item.status == "blocked"
    ]

    assert failures == ["Template Contract Gate body-weight-table-shape failed"]


def test_codex_agent_passes_the_candidate_schema_to_the_sdk() -> None:
    calls = []

    class FakeThread:
        id = "thread-schema-001"

        def run(self, prompt, **kwargs):
            calls.append((prompt, kwargs))
            return SimpleNamespace(final_response="{}")

    class FakeCodex:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def thread_start(self, **kwargs):
            return FakeThread()

    schema = {"type": "object", "additionalProperties": False}
    module = SimpleNamespace(
        Codex=FakeCodex,
        Sandbox=SimpleNamespace(read_only="read-only"),
    )
    with patch.dict(sys.modules, {"openai_codex": module}):
        result = CodexSectionAgent(ROOT).run(
            envelope_id="ENV-1",
            prompt="thread={{CODEX_THREAD_ID}}",
            output_schema=schema,
        )

    assert result.thread_id == "thread-schema-001"
    assert calls == [
        (
            "thread=thread-schema-001",
            {"cwd": str(ROOT), "sandbox": "read-only", "output_schema": schema},
        )
    ]
