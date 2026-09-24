#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/evidence/candidate-evaluation-receipt.json"

cd "$ROOT/backend"
uv run python - "$ROOT" "$TARGET" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
target = Path(sys.argv[2])
sys.path.insert(0, str(root / "backend"))
sys.path.insert(0, str(root / "backend" / "tests"))

from test_candidate_evaluations import EVAL_COMMAND, QUERY_COMMAND, draft
from test_section_runs import STUDY_ID, FakeSectionAgent, build_client, validate

agent = FakeSectionAgent("conforming")
client, _engine = build_client(agent)
with client:
    validate(client)
    recorded = draft(client)
    first = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/evaluations",
        json=EVAL_COMMAND,
    )
    replay = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/evaluations",
        json=EVAL_COMMAND,
    )
    query = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/cross-section-queries",
        json=QUERY_COMMAND,
    )
    denied = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/cross-section-queries",
        json={
            "idempotency_key": "query-undeclared-verify",
            "artifact_ids": ["claim:C-NOAEL", "record:BW-HXL-M401-28"],
        },
    )
    unsupported_agent = FakeSectionAgent("unsupported_value")
    blocked_client, _ = build_client(unsupported_agent)
    with blocked_client:
        validate(blocked_client)
        blocked_run = draft(blocked_client, key="unsupported-verify")
        original = blocked_client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()["section_runs"][-1][
            "candidate"
        ]
        blocked = blocked_client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs/{blocked_run['run_id']}/evaluations",
            json={"idempotency_key": "evaluate-unsupported-verify"},
        )
        stored = blocked_client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()["section_runs"][-1][
            "candidate"
        ]
        waive = blocked_client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-results/{blocked.json()['provenance_receipt']['receipt_id']}/dispositions",
            json={
                "decision": "approved_exception",
                "reason": "Invented provenance must never be waivable.",
                "reviewer": "Dr. Ada Path",
            },
        )

    advisory_agent = FakeSectionAgent("conforming_advisory_fail")
    advisory_client, _ = build_client(advisory_agent)
    with advisory_client:
        validate(advisory_client)
        advisory_run = draft(advisory_client, key="advisory-verify")
        advisory = advisory_client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs/{advisory_run['run_id']}/evaluations",
            json={"idempotency_key": "evaluate-advisory-verify"},
        )

    workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()

assert first.status_code == 201, first.text
body = first.json()
assert replay.status_code == 201
assert replay.json()["evaluation_id"] == body["evaluation_id"]
assert replay.json()["idempotent_replay"] is True
assert body["candidate_hash"] == recorded["candidate_hash"]
assert body["hashes"]["candidate"] == recorded["candidate_hash"]
assert all(item["claim_hash"].startswith("sha256:") for item in body["provenance_receipt"]["bindings"])
assert all(item["artifact_hash"].startswith("sha256:") for item in body["provenance_receipt"]["bindings"])
assert {item["check_kind"] for item in body["template_conformance_receipt"]["results"]} == {
    "completeness",
    "table_coverage",
    "terminology",
    "units",
    "rounding",
    "approved_language",
}
assert body["template_conformance_receipt"]["status"] == "passed"
assert body["study_output_evaluation_receipt"]["enforcement_class"] == "review_required"
assert body["next_attempt_decision"]["action"] == "hold"
assert query.status_code == 201, query.text
assert query.json()["status"] == "returned"
assert query.json()["requested_artifact_ids"] == QUERY_COMMAND["artifact_ids"]
assert denied.json()["status"] == "rejected"
assert "claim:C-NOAEL" in denied.json()["rejected_artifact_ids"]
assert blocked.status_code == 201, blocked.text
assert blocked.json()["provenance_receipt"]["status"] == "blocked"
assert blocked.json()["provenance_receipt"]["waivable"] is False
assert stored == original
assert waive.status_code == 409
assert advisory.json()["study_output_evaluation_receipt"]["status"] == "failed"
assert advisory.json()["provenance_receipt"]["status"] == "passed"
assert advisory.json()["template_conformance_receipt"]["status"] == "passed"
assert advisory.json()["next_attempt_decision"]["blocking_receipt_ids"] == []
assert workspace["candidate_evaluations"][-1]["evaluation_id"] == body["evaluation_id"]
assert workspace["section_runs"][-1]["candidate"]["candidate_id"] == recorded["candidate_id"]
payload = {
    "candidate_hash": body["candidate_hash"],
    "evaluation": body,
    "query": query.json(),
    "undeclared_query": denied.json(),
    "unsupported": blocked.json(),
    "advisory": advisory.json(),
    "persisted_evaluation_id": workspace["candidate_evaluations"][-1]["evaluation_id"],
}
target.write_text(json.dumps(payload, indent=2) + "\n")
print(target)
PY
