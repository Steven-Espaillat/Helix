import hashlib

from sqlalchemy import func, select
from test_candidate_evaluations import draft
from test_final_study_approval import clear_blockers, record_fsa, record_roles
from test_review_scaffold_versioning import dispose
from test_section_runs import STUDY_ID, FakeSectionAgent, build_client
from test_superseding_runs import workspace

from app.models import AuditEventRow, ExportFileRow
from app.review_scaffolds import ExportAdmissionError, admit_export_document


def export(client, key: str = "export-approved-v1"):
    return client.post(
        f"/api/v1/studies/{STUDY_ID}/exports",
        json={"actor": "Dr. Sam Director", "idempotency_key": key},
    )


def test_export_unavailable_until_ready_for_export() -> None:
    client, engine = build_client(FakeSectionAgent())
    with client:
        blocked = export(client, key="before-ready")
        assert blocked.status_code == 409
        clear_blockers(client)
        signed = record_roles(client)
        assert signed["release_gate"]["status"] == "ready_for_signature"
        still_blocked = export(client, key="before-fsa")
        assert still_blocked.status_code == 409
        approved = record_fsa(client, key="export-ready-fsa")
        assert approved.status_code == 200
        assert approved.json()["release_gate"]["status"] == "ready_for_export"
        assert approved.json()["export_artifacts"]
        assert all(item["status"] == "pending" for item in approved.json()["export_artifacts"])
        pending_ids = {item["artifact_id"] for item in approved.json()["export_artifacts"]}
        approval_ids = {
            item["artifact_id"]
            for item in approved.json()["final_study_approval"]["included_artifact_hashes"]
        }
        assert pending_ids == approval_ids
    engine.dispose()


def test_stale_changed_unapproved_and_scaffold_reject_export() -> None:
    client, engine = build_client(FakeSectionAgent())
    with client:
        clear_blockers(client)
        record_roles(client)
        approved = record_fsa(client, key="export-stale-fsa")
        assert approved.status_code == 200
        draft(client, key="export-stale-draft")
        stale = workspace(client)
        assert stale["approval_current"] is False
        assert export(client, key="export-stale").status_code == 409

        revisions = stale["review_scaffold_revisions"]
        assert revisions
        failed = False
        try:
            admit_export_document(revisions[-1])
        except ExportAdmissionError:
            failed = True
        assert failed is True
    engine.dispose()

    client, engine = build_client(FakeSectionAgent())
    with client:
        clear_blockers(client)
        record_roles(client)
        approved = record_fsa(client, key="export-unapproved-fsa")
        assert approved.status_code == 200
        body = approved.json()
        approval_ids = {
            item["artifact_id"]
            for item in body["final_study_approval"]["included_artifact_hashes"]
        }
        assert "OUT-REPORT" not in approval_ids
        unapproved = client.get(f"/api/v1/studies/{STUDY_ID}/exports/OUT-REPORT")
        assert unapproved.status_code in {404, 409}
    engine.dispose()


def test_export_matches_approval_replay_and_instrumentation() -> None:
    client, engine = build_client(FakeSectionAgent())
    with client:
        clear_blockers(client)
        record_roles(client)
        approved = record_fsa(client, key="export-exact-fsa")
        assert approved.status_code == 200
        approval = approved.json()["final_study_approval"]
        first = export(client, key="export-exact-v1")
        assert first.status_code == 200, first.text
        body = first.json()
        assert body["status"] == "exported"
        assert body["approval_id"] == approval["approval_id"]
        assert body["manifest_hash"] == approval["manifest_hash"]
        assert body["instrumentation"] == {"agent_starts": 0, "calculation_runs": 0}
        assert "FDA" not in first.text
        approved_set = {
            (item["artifact_id"], item["content_hash"])
            for item in approval["included_artifact_hashes"]
        }
        exported_set = {(item["artifact_id"], item["checksum"]) for item in body["artifacts"]}
        assert exported_set == approved_set
        downloads = {}
        for artifact in body["artifacts"]:
            response = client.get(f"/api/v1/studies/{STUDY_ID}/exports/{artifact['artifact_id']}")
            assert response.status_code == 200
            digest = f"sha256:{hashlib.sha256(response.content).hexdigest()}"
            assert digest == artifact["checksum"]
            downloads[artifact["artifact_id"]] = response.content

        replay = export(client, key="export-exact-v1")
        assert replay.status_code == 200
        assert replay.json()["idempotent_replay"] is True
        assert replay.json()["artifacts"] == body["artifacts"]
        for artifact_id, content in downloads.items():
            again = client.get(f"/api/v1/studies/{STUDY_ID}/exports/{artifact_id}")
            assert again.content == content

        factory = client.app.state.session_factory
        with factory() as session:
            export_events = session.scalar(
                select(func.count())
                .select_from(AuditEventRow)
                .where(AuditEventRow.event_type == "explicit_export")
            )
            rows = list(session.scalars(select(ExportFileRow)))
        assert export_events == 1
        assert len(rows) == len(body["artifacts"])
        for row in rows:
            digest = f"sha256:{hashlib.sha256(row.content).hexdigest()}"
            assert row.checksum == digest
            assert (row.artifact_id, row.checksum) in approved_set
            assert downloads[row.artifact_id] == row.content

        assert workspace(client)["release_gate"]["status"] == "exported"
    engine.dispose()


def test_export_rejects_when_blockers_return() -> None:
    client, engine = build_client(FakeSectionAgent())
    with client:
        validation = client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-runs",
            json={"planner": "fixture"},
        )
        assert validation.status_code == 201
        for result in validation.json()["results"]:
            if result["status"] == "fail" and result["severity"] == "blocker":
                dispose(
                    client,
                    result["result_id"],
                    "approved_exception" if result["result_id"] == "VR-006" else "corrected",
                    f"Synthetic disposition recorded for {result['rule_id']}.",
                )
        record_roles(client)
        assert record_fsa(client, key="export-blocker-fsa").status_code == 200
        assert export(client, key="export-ok").status_code == 200
    engine.dispose()
