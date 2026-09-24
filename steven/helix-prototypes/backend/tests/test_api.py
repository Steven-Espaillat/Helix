import hashlib
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.config import Settings
from app.database import create_database_engine
from app.main import create_app
from app.models import AuditEventRow, ExportFileRow

ROOT = Path(__file__).resolve().parents[2]
STUDY_ID = "STUDY-HLX-028"


def build_client() -> tuple[TestClient, object]:
    settings = Settings(
        database_url="sqlite+pysqlite:///:memory:",
        seed_path=ROOT / "synthetic-e2e" / "helix-synthetic-bundle.json",
        auto_seed=True,
    )
    engine = create_database_engine(settings)
    return TestClient(create_app(settings, engine)), engine


def test_workspace_and_evidence_use_the_verified_bundle() -> None:
    client, _ = build_client()
    with client:
        health = client.get("/health")
        studies = client.get("/api/v1/studies")
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace")
        evidence = client.get(f"/api/v1/studies/{STUDY_ID}/claims/C-BW-HIGH/evidence")

    assert health.json() == {"status": "ok", "storage": "sqlite"}
    assert studies.status_code == 200
    assert studies.json()[0]["study_id"] == STUDY_ID
    assert workspace.status_code == 200
    data = workspace.json()
    assert data["label"] == "SYNTHETIC / NOT FOR SUBMISSION"
    assert data["summary"] == {
        "record_count": 1662,
        "source_count": 10,
        "provenance_count": 14,
        "blocker_count": 3,
        "resolved_blocker_count": 0,
        "section_count": 8,
    }
    assert data["release_gate"]["status"] == "blocked"
    assert len(data["manifest"]) == 10
    assert all(entry["locked"] and entry["authorized_by"] for entry in data["manifest"])
    assert len(data["report"]["template"]["sections"]) == 8
    assert (
        sum(
            field["required"]
            for section in data["report"]["template"]["sections"]
            for field in section["fields"]
        )
        == 37
    )

    assert evidence.status_code == 200
    chain = evidence.json()
    assert chain["claim"]["value"] == 286.2
    assert chain["recomputed_value"] == 286.2
    assert chain["exact_match"] is True
    assert len(chain["sources"]) == 10


def test_hybrid_validation_review_approval_and_export_flow() -> None:
    client, engine = build_client()
    with client:
        unavailable = client.get(f"/api/v1/studies/{STUDY_ID}/exports/OUT-REPORT")
        assert unavailable.status_code in {404, 409}
        unavailable_planner = client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-runs",
            json={"planner": "openai_compatible"},
        )
        assert unavailable_planner.status_code == 503
        validation = client.post(f"/api/v1/studies/{STUDY_ID}/validation-runs", json={"planner": "fixture"})
        assert validation.status_code == 201
        run = validation.json()
        assert run["llm_used"] is False
        assert run["planner_label"] == "Fixture planner for tool-contract testing"
        assert len(run["results"]) == 13
        blockers = [
            result
            for result in run["results"]
            if result["status"] == "fail" and result["severity"] == "blocker"
        ]
        assert [result["result_id"] for result in blockers] == ["VR-004", "VR-005", "VR-006"]
        assert any(result["kind"] == "agent_planned" for result in run["results"])

        invalid_disposition = client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-results/VR-004/dispositions",
            json={
                "decision": "approved_exception",
                "reason": "A grain mismatch requires a real correction.",
                "reviewer": "Dr. Ada Path",
            },
        )
        assert invalid_disposition.status_code == 409

        premature_approval = client.post(
            f"/api/v1/studies/{STUDY_ID}/approvals",
            json={"role": "pathologist", "reviewer": "Dr. Ada Path", "meaning": "Scientific review"},
        )
        assert premature_approval.status_code == 409

        for result in blockers:
            response = client.post(
                f"/api/v1/studies/{STUDY_ID}/validation-results/{result['result_id']}/dispositions",
                json={
                    "decision": ("approved_exception" if result["result_id"] == "VR-006" else "corrected"),
                    "reason": f"Synthetic disposition recorded for {result['rule_id']}.",
                    "reviewer": "Dr. Ada Path",
                },
            )
            assert response.status_code == 200

        reviewed = response.json()
        sex_claims = [
            claim for claim in reviewed["claims"] if claim["claim_id"] in {"C-BW-HIGH-M", "C-BW-HIGH-F"}
        ]
        assert len(sex_claims) == 2
        assert all(claim["grain"] == "dose_group_x_sex" for claim in sex_claims)
        corrected_evidence = client.get(f"/api/v1/studies/{STUDY_ID}/claims/C-BW-HIGH-M/evidence").json()
        assert corrected_evidence["exact_match"] is True
        assert len(corrected_evidence["sources"]) == 5
        pathology = next(
            section for section in reviewed["report"]["sections"] if section["section_id"] == "S7"
        )
        assert pathology["blocks"][0]["text"].startswith("Minimal hepatocellular hypertrophy")
        assert all(block["kind"] != "review_marker" for block in pathology["blocks"])

        rerun = client.post(f"/api/v1/studies/{STUDY_ID}/validation-runs", json={"planner": "fixture"})
        assert rerun.status_code == 201
        rerun_results = {result["result_id"]: result for result in rerun.json()["results"]}
        assert rerun_results["VR-004"]["status"] == "pass"
        assert rerun_results["VR-005"]["status"] == "pass"
        assert rerun_results["VR-006"]["status"] == "fail"
        premature_director = client.post(
            f"/api/v1/studies/{STUDY_ID}/approvals",
            json={
                "role": "study_director",
                "reviewer": "Dr. Sam Director",
                "meaning": "Final report approval",
            },
        )
        assert premature_director.status_code == 409

        roles = [
            ("pathologist", "Dr. Ada Path", "Scientific review complete"),
            ("peer_reviewer", "Dr. Priya Peer", "Independent pathology review complete"),
            ("qau", "Morgan QA", "Quality assurance statement recorded"),
            ("study_director", "Dr. Sam Director", "Final report approval"),
        ]
        for role, reviewer, meaning in roles:
            response = client.post(
                f"/api/v1/studies/{STUDY_ID}/approvals",
                json={"role": role, "reviewer": reviewer, "meaning": meaning},
            )
            assert response.status_code == 200
        approved = response.json()
        assert approved["release_gate"]["status"] == "ready_for_signature"
        assert approved["approval_current"] is False
        signed = client.post(
            f"/api/v1/studies/{STUDY_ID}/final-study-approvals",
            json={"reviewer": "Dr. Sam Director", "idempotency_key": "e2e-final-study-approval-v1"},
        )
        assert signed.status_code == 200, signed.text
        approved = signed.json()
        assert approved["release_gate"]["status"] == "ready_for_export"
        assert approved["approval_current"] is True
        assert (
            approved["final_study_approval"]["manifest_hash"]
            == approved["release_candidate"]["content_hash"]
        )
        assert all(section["status"] != "needs_review" for section in approved["report"]["sections"])
        clinical_pathology = next(
            section for section in approved["report"]["sections"] if section["section_id"] == "S6"
        )
        assert clinical_pathology["blocks"][0]["kind"] == "paragraph"

        command = {"actor": "Dr. Sam Director", "idempotency_key": "e2e-export-001"}
        first_export = client.post(f"/api/v1/studies/{STUDY_ID}/exports", json=command)
        second_export = client.post(f"/api/v1/studies/{STUDY_ID}/exports", json=command)
        final_workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace")

        assert first_export.status_code == 200, first_export.text
        first_body = first_export.json()
        assert first_body["idempotent_replay"] is False
        assert first_body["status"] == "exported"
        assert first_body["approval_id"] == approved["final_study_approval"]["approval_id"]
        assert first_body["manifest_hash"] == approved["final_study_approval"]["manifest_hash"]
        assert first_body["instrumentation"] == {"agent_starts": 0, "calculation_runs": 0}
        approved_hashes = {
            (item["artifact_id"], item["content_hash"])
            for item in approved["final_study_approval"]["included_artifact_hashes"]
        }
        exported_hashes = {
            (item["artifact_id"], item["checksum"]) for item in first_body["artifacts"]
        }
        assert exported_hashes == approved_hashes
        assert second_export.status_code == 200
        assert second_export.json()["idempotent_replay"] is True
        assert second_export.json()["artifacts"] == first_body["artifacts"]
        for artifact in first_body["artifacts"]:
            download = client.get(f"/api/v1/studies/{STUDY_ID}/exports/{artifact['artifact_id']}")
            assert download.status_code == 200
            digest = hashlib.sha256(download.content).hexdigest()
            assert artifact["checksum"] == f"sha256:{digest}"
            assert "attachment" in download.headers["content-disposition"]
            assert download.headers["content-type"].startswith("application/json")
        assert final_workspace.json()["release_gate"]["status"] == "exported"
        post_export_validation = client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-runs", json={"planner": "fixture"}
        )
        assert post_export_validation.status_code == 409
        assert client.get(f"/api/v1/studies/{STUDY_ID}/exports/OUT-REPORT").status_code in {404, 409}

        factory = client.app.state.session_factory
        with factory() as session:
            export_events = session.scalar(
                select(func.count())
                .select_from(AuditEventRow)
                .where(AuditEventRow.event_type == "explicit_export")
            )
            export_event = session.scalar(
                select(AuditEventRow).where(AuditEventRow.event_type == "explicit_export")
            )
            export_files = session.scalar(select(func.count()).select_from(ExportFileRow))
            rows = session.scalars(select(ExportFileRow)).all()
        assert export_events == 1
        assert export_event is not None and export_event.payload["outcome"] == "exported"
        assert export_files == len(first_body["artifacts"])
        for row in rows:
            assert row.checksum == f"sha256:{__import__('hashlib').sha256(row.content).hexdigest()}"
            assert (row.artifact_id, row.checksum) in approved_hashes

    engine.dispose()
