#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/evidence/review-scaffold-receipt.json"

cd "$ROOT/backend"
uv run python - "$ROOT" "$TARGET" <<'PY'
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

root = Path(sys.argv[1])
target = Path(sys.argv[2])
sys.path.insert(0, str(root / "backend"))
sys.path.insert(0, str(root / "backend" / "tests"))

from app.review_scaffolds import ExportAdmissionError, admit_export_document
from test_candidate_evaluations import draft
from test_section_runs import STUDY_ID, FakeSectionAgent, build_client, validate

contracts = root / "skills" / "helix-evidence-pipeline" / "contracts"
rc_schema = json.loads((contracts / "release-candidate.schema.json").read_text())

agent = FakeSectionAgent("conforming")
client, _engine = build_client(agent)
with client:
    validate(client)
    after_validate = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()["review_scaffold_revisions"]
    recorded = draft(client, key="verify-review-scaffold-draft")
    after_draft = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()["review_scaffold_revisions"]
    evaluation = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/evaluations",
        json={"idempotency_key": "verify-review-scaffold-eval"},
    )
    after_eval = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()["review_scaffold_revisions"]
    replay_run = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs",
        json={
            "section_package_id": "section.5_2_3_body_weight",
            "idempotency_key": "verify-review-scaffold-draft",
        },
    )
    replay_eval = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/evaluations",
        json={"idempotency_key": "verify-review-scaffold-eval"},
    )
    after_replay = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()["review_scaffold_revisions"]
    disposition = client.post(
        f"/api/v1/studies/{STUDY_ID}/validation-results/VR-005/dispositions",
        json={
            "decision": "corrected",
            "reason": "Corrected the discussion severity mismatch.",
            "reviewer": "Dr. Ada Path",
        },
    )
    client.post(
        f"/api/v1/studies/{STUDY_ID}/validation-results/VR-004/dispositions",
        json={
            "decision": "corrected",
            "reason": "Corrected the grain mismatch.",
            "reviewer": "Dr. Ada Path",
        },
    )
    client.post(
        f"/api/v1/studies/{STUDY_ID}/validation-results/VR-006/dispositions",
        json={
            "decision": "approved_exception",
            "reason": "Approved the NOAEL exception.",
            "reviewer": "Dr. Ada Path",
        },
    )
    approval = client.post(
        f"/api/v1/studies/{STUDY_ID}/approvals",
        json={
            "role": "pathologist",
            "reviewer": "Dr. Ada Path",
            "meaning": "Scientific review complete",
        },
    )
    workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()

assert evaluation.status_code == 201, evaluation.text
assert replay_run.status_code == 201, replay_run.text
assert replay_eval.status_code == 201, replay_eval.text
assert disposition.status_code == 200, disposition.text
assert approval.status_code == 200, approval.text
assert [item["sequence"] for item in after_validate] == [1]
assert [item["sequence"] for item in after_draft] == [1, 2]
assert [item["sequence"] for item in after_eval] == [1, 2]
assert [item["sequence"] for item in after_replay] == [1, 2]
history = workspace["review_scaffold_revisions"]
assert [item["sequence"] for item in history] == list(range(1, len(history) + 1))
assert len(history) == 6
assert all(item["export_eligible"] is False for item in history)
needs_review = [
    section
    for revision in history
    for section in revision["sections"]
    if section["render_state"] == "needs_review"
]
assert needs_review
assert all(section["placeholder"] == "[NEEDS REVIEW]" for section in needs_review)
assert all(section["blocker_result_ids"] for section in needs_review)
admit_failed = False
try:
    admit_export_document(history[-1])
except ExportAdmissionError:
    admit_failed = True
assert admit_failed is True
assert list(Draft202012Validator(rc_schema).iter_errors(history[-1]))
payload = {
    "sequences": [item["sequence"] for item in history],
    "history_length": len(history),
    "replay_history_length": len(after_replay),
    "export_eligible": [item["export_eligible"] for item in history],
    "triggering_event_ids": [item["triggering_event_id"] for item in history],
    "admit_export_rejected": admit_failed,
}
target.write_text(json.dumps(payload, indent=2) + "\n")
print(target)
PY
