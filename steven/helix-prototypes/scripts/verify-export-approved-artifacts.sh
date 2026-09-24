#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/evidence/export-approved-artifacts-receipt.json"

cd "$ROOT/backend"
uv run python - "$ROOT" "$TARGET" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

from sqlalchemy import func, select

root = Path(sys.argv[1])
target = Path(sys.argv[2])
sys.path.insert(0, str(root / "backend"))
sys.path.insert(0, str(root / "backend" / "tests"))

from app.models import AuditEventRow, ExportFileRow
from test_final_study_approval import clear_blockers, record_fsa, record_roles
from test_section_runs import STUDY_ID, FakeSectionAgent, build_client

client, engine = build_client(FakeSectionAgent())
with client:
    blocked = client.post(
        f"/api/v1/studies/{STUDY_ID}/exports",
        json={"actor": "Dr. Sam Director", "idempotency_key": "verify-export-before"},
    )
    assert blocked.status_code == 409
    clear_blockers(client)
    record_roles(client)
    approved = record_fsa(client, key="verify-export-fsa")
    assert approved.status_code == 200, approved.text
    approval = approved.json()["final_study_approval"]
    assert approved.json()["release_gate"]["status"] == "ready_for_export"
    first = client.post(
        f"/api/v1/studies/{STUDY_ID}/exports",
        json={"actor": "Dr. Sam Director", "idempotency_key": "verify-export-v1"},
    )
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["status"] == "exported"
    assert body["approval_id"] == approval["approval_id"]
    assert body["manifest_hash"] == approval["manifest_hash"]
    assert body["instrumentation"] == {"agent_starts": 0, "calculation_runs": 0}
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
    replay = client.post(
        f"/api/v1/studies/{STUDY_ID}/exports",
        json={"actor": "Dr. Sam Director", "idempotency_key": "verify-export-v1"},
    )
    assert replay.status_code == 200
    assert replay.json()["idempotent_replay"] is True
    assert replay.json()["artifacts"] == body["artifacts"]
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
        assert downloads[row.artifact_id] == row.content
engine.dispose()

payload = {
    "study_id": STUDY_ID,
    "approval_id": approval["approval_id"],
    "manifest_hash": approval["manifest_hash"],
    "exported_artifact_ids": sorted(item["artifact_id"] for item in body["artifacts"]),
    "exported_artifact_count": len(body["artifacts"]),
    "matches_approval_hashes": True,
    "exact_replay_no_second_event": True,
    "instrumentation": body["instrumentation"],
    "postgres_byte_equality": True,
    "status_language": ["exported"],
}
target.write_text(json.dumps(payload, indent=2) + "\n")
print(json.dumps(payload, indent=2))
PY
