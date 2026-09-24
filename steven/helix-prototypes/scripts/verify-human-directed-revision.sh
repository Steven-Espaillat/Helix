#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/evidence/human-directed-revision-receipt.json"

cd "$ROOT/backend"
uv run python - "$ROOT" "$TARGET" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
target = Path(sys.argv[2])
sys.path.insert(0, str(root / "backend"))
sys.path.insert(0, str(root / "backend" / "tests"))

from test_candidate_attempts import evaluate
from test_candidate_evaluations import draft
from test_human_directed_revision import fail_attempts, revise
from test_review_scaffold_versioning import approve, dispose
from test_section_runs import COMMAND, STUDY_ID, FakeSectionAgent, build_client, validate

BODY_WEIGHT = "section.5_2_3_body_weight"
DISCUSSION = "section.5_3_discussion"

agent = FakeSectionAgent("unsupported_value")
client, _engine = build_client(agent)
with client:
    validate(client)
    first_cycle = fail_attempts(client, "verify")
    before = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
    discussion_before = next(
        item for item in before["section_run_eligibility"] if item["section_package_id"] == DISCUSSION
    )
    calls_before = agent.calls
    receipt = revise(client)
    after_revision = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
    calls_after_revision = agent.calls
    second = draft(client, key="verify-cycle-2-attempt-1")
    eval_new = evaluate(client, second["run_id"], "verify-cycle-2-eval-1")
    evaluate(client, draft(client, key="verify-cycle-2-attempt-2")["run_id"], "verify-cycle-2-eval-2")
    evaluate(client, draft(client, key="verify-cycle-2-attempt-3")["run_id"], "verify-cycle-2-eval-3")
    fourth = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs",
        json={**COMMAND, "idempotency_key": "verify-cycle-2-attempt-4"},
    )
    workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()

stale_agent = FakeSectionAgent("conforming_advisory_fail")
stale_client, _ = build_client(stale_agent)
with stale_client:
    validation = stale_client.post(
        f"/api/v1/studies/{STUDY_ID}/validation-runs",
        json={"planner": "fixture"},
    )
    recorded = draft(stale_client, key="verify-stale-attempt-1")
    evaluation = evaluate(stale_client, recorded["run_id"], "verify-stale-eval-1")
    soe_id = evaluation["study_output_evaluation_receipt"]["receipt_id"]
    disposed = dispose(
        stale_client,
        soe_id,
        "approved_exception",
        "Advisory study-output failure reviewed against the exact candidate.",
    )
    disposition_id = next(
        item["disposition_id"] for item in disposed["dispositions"] if item["result_id"] == soe_id
    )
    for result in validation.json()["results"]:
        if result["status"] == "fail" and result["severity"] == "blocker":
            dispose(
                stale_client,
                result["result_id"],
                "approved_exception" if result["result_id"] == "VR-006" else "corrected",
                f"Synthetic disposition recorded for {result['rule_id']}.",
            )
    approved = approve(stale_client, "pathologist", "Dr. Ada Path", "Scientific review complete")
    approval_id = next(item["approval_id"] for item in approved["approvals"] if item["role"] == "pathologist")
    stale_receipt = revise(stale_client, key="verify-stale-revise-v1")
    stale_context = stale_client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()[
        "review_scaffold_revisions"
    ][-1]["overall_study_context"]

prior = before["candidate_evaluations"][-1]
discussion_after = next(
    item
    for item in after_revision["section_run_eligibility"]
    if item["section_package_id"] == DISCUSSION
)
by_cycle = {}
for item in workspace["section_runs"]:
    by_cycle.setdefault(item["candidate"]["drafting_cycle_id"], []).append(item["candidate"]["attempt"])

assert receipt["cycle"]["predecessor_cycle_id"] == "CYCLE-BW-001"
assert receipt["cycle"]["cycle_id"] != "CYCLE-BW-001"
assert calls_after_revision == calls_before
assert after_revision["section_runs"] == before["section_runs"]
assert discussion_after["impact_set"] == discussion_before["impact_set"]
assert by_cycle["CYCLE-BW-001"] == [1, 2, 3]
assert by_cycle[receipt["cycle"]["cycle_id"]] == [1, 2, 3]
assert fourth.status_code == 409
assert "three Candidate Attempts" in fourth.json()["detail"]
assert eval_new["evaluation_id"] != prior["evaluation_id"]
assert eval_new["hashes"] != prior["hashes"]
assert disposition_id in stale_receipt["stale_disposition_ids"]
assert approval_id in stale_receipt["stale_approval_ids"]
assert disposition_id in stale_context["stale_disposition_ids"]
assert approval_id in stale_context["stale_approval_ids"]
assert all(item["receipt"]["section_package_id"] == BODY_WEIGHT for item in workspace["section_runs"])

payload = {
    "predecessor_cycle_id": receipt["cycle"]["predecessor_cycle_id"],
    "new_cycle_id": receipt["cycle"]["cycle_id"],
    "cycle_attempts": by_cycle,
    "revision_agent_calls": calls_after_revision - calls_before,
    "fourth_new_cycle_status": fourth.status_code,
    "fresh_evaluation_id": eval_new["evaluation_id"],
    "prior_evaluation_id": prior["evaluation_id"],
    "stale_disposition_ids": stale_receipt["stale_disposition_ids"],
    "stale_approval_ids": stale_receipt["stale_approval_ids"],
    "discussion_impact_unchanged": discussion_after["impact_set"] == discussion_before["impact_set"],
}
target.write_text(json.dumps(payload, indent=2) + "\n")
print(json.dumps(payload, indent=2))
PY
