#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/evidence/section-promotion-receipt.json"

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
from test_section_runs import STUDY_ID, FakeSectionAgent, build_client, validate

agent = FakeSectionAgent("conforming")
client, _engine = build_client(agent)
with client:
    validate(client)
    recorded = draft(client, key="verify-promote-vertical-slice")
    evaluation = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/evaluations",
        json={"idempotency_key": "verify-evaluate-promote"},
    )
    client_status = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/promotions",
        json={"idempotency_key": "verify-promote-client-status", "status": "promoted"},
    )
    promoted = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/promotions",
        json={"idempotency_key": "verify-promote-v1"},
    )
    replay = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/promotions",
        json={"idempotency_key": "verify-promote-v1"},
    )
    workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()

advisory_agent = FakeSectionAgent("conforming_advisory_fail")
advisory_client, _ = build_client(advisory_agent)
with advisory_client:
    validate(advisory_client)
    advisory_run = draft(advisory_client, key="verify-promote-advisory")
    advisory = advisory_client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs/{advisory_run['run_id']}/evaluations",
        json={"idempotency_key": "verify-evaluate-advisory-promote"},
    )
    soe_id = advisory.json()["study_output_evaluation_receipt"]["receipt_id"]
    before = advisory_client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
    disposition = advisory_client.post(
        f"/api/v1/studies/{STUDY_ID}/validation-results/{soe_id}/dispositions",
        json={
            "decision": "approved_exception",
            "reason": "Advisory study-output failure reviewed against the exact candidate.",
            "reviewer": "Dr. Ada Path",
        },
    )
    stale = advisory_client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()

assert evaluation.status_code == 201, evaluation.text
assert client_status.status_code == 422, client_status.text
assert promoted.status_code == 409, promoted.text
assert replay.status_code == 409, replay.text
assert "package_permission" in promoted.json()["detail"]
decision = workspace["promotion_decisions"][-1]
assert decision["eligible"] is False
assert decision["candidate_hash"] == recorded["candidate_hash"]
assert "package_permission" in decision["failed_condition_ids"]
assert [item["condition_id"] for item in decision["conditions"]] == [
    "package_permission",
    "no_hard_blocker",
    "provenance_passed",
    "conformance_passed",
    "review_required_current",
]
assert workspace["section_drafts"] == []
before_review = next(
    item
    for item in before["promotion_decisions"][-1]["conditions"]
    if item["condition_id"] == "review_required_current"
)
assert before_review["passed"] is False
bound = next(item for item in disposition.json()["dispositions"] if item["result_id"] == soe_id)
assert bound["artifact_hash"] == advisory.json()["candidate_hash"]
after_review = next(
    item
    for item in stale["promotion_decisions"][-1]["conditions"]
    if item["condition_id"] == "review_required_current"
)
assert after_review["passed"] is True
assert "package_permission" in stale["promotion_decisions"][-1]["failed_condition_ids"]
assert stale["section_drafts"] == []
payload = {
    "candidate_hash": recorded["candidate_hash"],
    "evaluation_id": evaluation.json()["evaluation_id"],
    "client_authored_status": client_status.status_code,
    "promotion_status": promoted.status_code,
    "replay_status": replay.status_code,
    "decision": decision,
    "section_drafts": workspace["section_drafts"],
    "advisory_soe_status": advisory.json()["study_output_evaluation_receipt"]["status"],
    "disposition_artifact_hash": bound["artifact_hash"],
    "review_required_before": before_review,
    "review_required_after": after_review,
}
target.write_text(json.dumps(payload, indent=2) + "\n")
print(target)
PY
