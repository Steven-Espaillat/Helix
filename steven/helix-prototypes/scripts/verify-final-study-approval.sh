#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/evidence/final-study-approval-receipt.json"

cd "$ROOT/backend"
uv run python - "$ROOT" "$TARGET" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
target = Path(sys.argv[2])
sys.path.insert(0, str(root / "backend"))
sys.path.insert(0, str(root / "backend" / "tests"))

from test_candidate_evaluations import draft
from test_final_study_approval import clear_blockers, record_fsa, record_roles
from test_section_runs import STUDY_ID, FakeSectionAgent, build_client, governed_root
from test_superseding_runs import mutate_discussion, supersede, workspace

tmp = Path("/tmp/helix-verify-final-study-approval")
if tmp.exists():
    import shutil

    shutil.rmtree(tmp)
tmp.mkdir(parents=True)

client, engine = build_client(FakeSectionAgent())
with client:
    clear_blockers(client)
    signed = record_roles(client)
    assert signed["release_gate"]["status"] == "ready_for_signature"
    assert signed["approval_current"] is False
    blocked_export = client.post(
        f"/api/v1/studies/{STUDY_ID}/exports",
        json={"actor": "Dr. Sam Director", "idempotency_key": "verify-fsa-export-before"},
    )
    assert blocked_export.status_code == 409
    first = record_fsa(client, key="verify-fsa-v1")
    assert first.status_code == 200, first.text
    body = first.json()
    candidate = body["release_candidate"]
    approval = body["final_study_approval"]
    assert candidate["status"] == "release_candidate"
    assert candidate["export_eligible"] is True
    assert approval["manifest_hash"] == candidate["content_hash"]
    recorded = {(item["artifact_id"], item["content_hash"]) for item in approval["included_artifact_hashes"]}
    included = {(item["artifact_id"], item["content_hash"]) for item in candidate["included_artifacts"]}
    assert recorded == included
    assert body["approval_current"] is True
    assert body["release_gate"]["status"] == "ready_for_export"
    replay = record_fsa(client, key="verify-fsa-v1")
    assert replay.status_code == 200
    assert replay.json()["final_study_approval"]["approval_id"] == approval["approval_id"]
    conflict = record_fsa(client, key="verify-fsa-other")
    assert conflict.status_code == 409
    draft(client, key="verify-fsa-stale-draft")
    stale = workspace(client)
    assert stale["approval_current"] is False
    assert stale["release_gate"]["status"] == "blocked"
    stale_export = client.post(
        f"/api/v1/studies/{STUDY_ID}/exports",
        json={"actor": "Dr. Sam Director", "idempotency_key": "verify-fsa-stale-export"},
    )
    assert stale_export.status_code == 409
engine.dispose()

root_copy = governed_root(tmp)
client, engine = build_client(FakeSectionAgent(), repository_root=root_copy)
with client:
    clear_blockers(client)
    record_roles(client)
    approved = record_fsa(client, key="verify-fsa-before-supersede")
    assert approved.status_code == 200, approved.text
    predecessor_id = approved.json()["final_study_approval"]["approval_id"]
    predecessor_run_id = approved.json()["pinned_run"]["run_id"]
    mutate_discussion(root_copy)
    supersede(client, predecessor_run_id, key="verify-fsa-supersede")
    after = workspace(client)
    assert after["final_study_approval"] is None
    assert after["approval_current"] is False
    assert after["predecessor_snapshots"][0]["final_study_approval"]["approval_id"] == predecessor_id
    successor = record_fsa(client, key="verify-fsa-successor")
    assert successor.status_code == 409
engine.dispose()

payload = {
    "study_id": STUDY_ID,
    "manifest_hash": approval["manifest_hash"],
    "approval_id": approval["approval_id"],
    "included_artifact_count": len(approval["included_artifact_hashes"]),
    "included_artifact_ids": sorted(item["artifact_id"] for item in approval["included_artifact_hashes"]),
    "exact_replay_reused_approval_id": True,
    "conflicting_key_status": 409,
    "stale_after_included_change": True,
    "stale_blocks_export": True,
    "superseding_run_clears_approval": True,
    "predecessor_snapshot_keeps_approval_id": predecessor_id,
    "language": ["ready_for_signature", "ready_for_export"],
}
target.write_text(json.dumps(payload, indent=2) + "\n")
print(json.dumps(payload, indent=2))
PY
