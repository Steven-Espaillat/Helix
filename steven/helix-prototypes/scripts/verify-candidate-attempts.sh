#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/evidence/candidate-attempts-receipt.json"

cd "$ROOT/backend"
uv run python - "$ROOT" "$TARGET" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
target = Path(sys.argv[2])
sys.path.insert(0, str(root / "backend"))
sys.path.insert(0, str(root / "backend" / "tests"))

from app.drafting_cycles import CAP_BLOCKER_ID
from test_candidate_attempts import evaluate
from test_section_runs import COMMAND, STUDY_ID, FakeSectionAgent, build_client, validate
from test_candidate_evaluations import draft

agent = FakeSectionAgent("unsupported_value")
client, _engine = build_client(agent)
with client:
    validate(client)
    first = draft(client, key="verify-attempt-1")
    too_soon = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs",
        json={**COMMAND, "idempotency_key": "verify-attempt-2-too-soon"},
    )
    eval1 = evaluate(client, first["run_id"], "verify-eval-1")
    second = draft(client, key="verify-attempt-2")
    replay_second = draft(client, key="verify-attempt-2")
    eval2 = evaluate(client, second["run_id"], "verify-eval-2")
    eval2_replay = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs/{second['run_id']}/evaluations",
        json={"idempotency_key": "verify-eval-2"},
    )
    third = draft(client, key="verify-attempt-3")
    eval3 = evaluate(client, third["run_id"], "verify-eval-3")
    fourth = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs",
        json={**COMMAND, "idempotency_key": "verify-attempt-4"},
    )
    duplicate_slot = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs",
        json={**COMMAND, "idempotency_key": "verify-attempt-3-other"},
    )
    workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()

hold_agent = FakeSectionAgent("conforming")
hold_client, _ = build_client(hold_agent)
with hold_client:
    validate(hold_client)
    held = draft(hold_client, key="verify-hold-1")
    hold_eval = evaluate(hold_client, held["run_id"], "verify-hold-eval")
    hold_retry = hold_client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs",
        json={**COMMAND, "idempotency_key": "verify-hold-2"},
    )

assert too_soon.status_code == 409, too_soon.text
assert eval1["next_attempt_decision"]["action"] == "retry"
assert second["candidate_id"] != first["candidate_id"]
assert replay_second == second
assert eval2_replay.status_code == 201
assert eval2_replay.json()["evaluation_id"] == eval2["evaluation_id"]
assert eval2_replay.json()["idempotent_replay"] is True
assert eval3["next_attempt_decision"]["action"] == "stop_for_review"
assert eval3["next_attempt_decision"]["attempt"] == 3
assert fourth.status_code == 409, fourth.text
assert "three Candidate Attempts" in fourth.json()["detail"]
assert duplicate_slot.status_code == 409, duplicate_slot.text
assert agent.calls == 3
assert [item["candidate"]["attempt"] for item in workspace["section_runs"]] == [1, 2, 3]
section = next(
    item
    for item in workspace["review_scaffold_revisions"][-1]["sections"]
    if item["section_id"] == "5_2_3_body_weight"
)
assert section["placeholder"] == "[NEEDS REVIEW]"
assert CAP_BLOCKER_ID in section["blocker_result_ids"]
assert hold_eval["next_attempt_decision"]["action"] == "hold"
assert hold_retry.status_code == 409
assert hold_agent.calls == 1

payload = {
    "attempts": [item["candidate"]["attempt"] for item in workspace["section_runs"]],
    "decisions": [item["next_attempt_decision"]["action"] for item in workspace["candidate_evaluations"]],
    "cap_blocker": CAP_BLOCKER_ID,
    "scaffold_placeholder": section["placeholder"],
    "agent_calls": agent.calls,
    "fourth_status": fourth.status_code,
    "replay_evaluation_id": eval2_replay.json()["evaluation_id"],
}
target.write_text(json.dumps(payload, indent=2) + "\n")
print(json.dumps(payload, indent=2))
PY
