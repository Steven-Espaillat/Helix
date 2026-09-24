#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/evidence/superseding-run-receipt.json"

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
from test_human_directed_revision import inject_section_draft
from test_section_runs import STUDY_ID, FakeSectionAgent, build_client, governed_root, validate
from test_superseding_runs import (
    BODY_WEIGHT_PACKAGE_ID,
    DISCUSSION_PACKAGE_ID,
    PARSE_NODE_ID,
    REASON,
    VALIDATION_NODE_ID,
    mutate_discussion,
    retarget_source,
    supersede,
    workspace,
)

tmp = Path("/tmp/helix-verify-superseding")
if tmp.exists():
    import shutil

    shutil.rmtree(tmp)
tmp.mkdir(parents=True)
root_copy = governed_root(tmp)
agent = FakeSectionAgent()
client, _engine = build_client(agent, repository_root=root_copy)
with client:
    validate(client)
    recorded = draft(client, key="verify-supersede-draft")
    inject_section_draft(_engine, recorded)
    before = workspace(client)
    predecessor_run_id = before["pinned_run"]["run_id"]
    predecessor_claims = before["claims"]
    predecessor_events = before["events"]
    predecessor_runs = [item["receipt"]["run_id"] for item in before["section_runs"]]
    mutate_discussion(root_copy)
    carried = supersede(client, predecessor_run_id, key="verify-supersede-discussion")
    after_carry = workspace(client)
    carry_receipt = after_carry["superseding_run_receipt"]
    snapshot = after_carry["predecessor_snapshots"][0]
    retarget_source(client, _engine, root_copy, mutate_records=True)
    source = supersede(client, carried["run_id"], key="verify-supersede-source")
    after_source = workspace(client)
    source_receipt = after_source["superseding_run_receipt"]

assert carried["predecessor_run_id"] == predecessor_run_id
assert carried["supersession_reason"] == REASON
assert carried["run_id"] != predecessor_run_id
assert snapshot["pinned_run"]["run_id"] == predecessor_run_id
assert snapshot["claims"] == predecessor_claims
assert snapshot["events"] == predecessor_events
assert [item["receipt"]["run_id"] for item in snapshot["section_runs"]] == predecessor_runs
assert carry_receipt["parse_reuse"][0]["reused"] is True
assert all(item["section_package_id"] == BODY_WEIGHT_PACKAGE_ID for item in carry_receipt["carried_forward"])
assert carry_receipt["carried_forward"][0]["lineage"]["predecessor_run_id"] == predecessor_run_id
assert carry_receipt["rerun_node_ids"] == [DISCUSSION_PACKAGE_ID]
assert carry_receipt["fresh_validation_receipt_ids"]
assert carry_receipt["fresh_gate_ids"]
assert carry_receipt["fresh_scaffold_revision"] >= 1
assert after_carry["approvals"] == []
assert source["run_id"] != carried["run_id"]
assert source_receipt["parse_reuse"][0]["reused"] is False
assert PARSE_NODE_ID in source_receipt["rerun_node_ids"]
assert VALIDATION_NODE_ID in source_receipt["rerun_node_ids"]
assert BODY_WEIGHT_PACKAGE_ID in source_receipt["rerun_node_ids"]
assert source_receipt["carried_forward"] == []
assert after_source["section_runs"] == []

payload = {
    "predecessor_run_id": predecessor_run_id,
    "successor_run_id": carried["run_id"],
    "source_successor_run_id": source["run_id"],
    "supersession_reason": REASON,
    "parse_reused_on_discussion_only": carry_receipt["parse_reuse"][0]["reused"],
    "carried_artifact_ids": [item["artifact_id"] for item in carry_receipt["carried_forward"]],
    "carried_lineage_run_id": carry_receipt["carried_forward"][0]["lineage"]["predecessor_run_id"],
    "discussion_rerun_node_ids": carry_receipt["rerun_node_ids"],
    "fresh_validation_receipt_ids": carry_receipt["fresh_validation_receipt_ids"],
    "fresh_gate_ids": carry_receipt["fresh_gate_ids"],
    "fresh_scaffold_revision": carry_receipt["fresh_scaffold_revision"],
    "source_parse_reused": source_receipt["parse_reuse"][0]["reused"],
    "source_rerun_node_ids": source_receipt["rerun_node_ids"],
    "predecessor_snapshot_hash": snapshot["snapshot_hash"],
}
target.write_text(json.dumps(payload, indent=2) + "\n")
print(json.dumps(payload, indent=2))
PY
