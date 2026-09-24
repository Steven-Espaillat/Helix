#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$(mktemp -t helix-tcr.XXXXXX).db"
API_LOG="$(mktemp -t helix-tcr-api.XXXXXX).log"
WORKSPACE="$(mktemp -t helix-tcr-workspace.XXXXXX.json)"
WAIVE="$(mktemp -t helix-tcr-waive.XXXXXX.json)"
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]]; then
    pkill -P "$API_PID" 2>/dev/null || true
    kill "$API_PID" 2>/dev/null || true
  fi
  rm -f "$DB" "$API_LOG" "$WORKSPACE" "$WAIVE"
}
trap cleanup EXIT

cd "$ROOT/backend"
HELIX_DATABASE_URL="sqlite+pysqlite:///$DB" \
HELIX_SEED_PATH="$ROOT/synthetic-e2e/helix-synthetic-bundle.json" \
uv run uvicorn app.main:app --host 127.0.0.1 --port 8012 >"$API_LOG" 2>&1 &
API_PID=$!

ready=false
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8012/health >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  cat "$API_LOG"
  exit 1
fi

curl -sf -X POST http://127.0.0.1:8012/api/v1/studies/STUDY-HLX-028/validation-runs \
  -H 'Content-Type: application/json' \
  -d '{"planner":"fixture"}' >/dev/null

curl -sf http://127.0.0.1:8012/api/v1/studies/STUDY-HLX-028/workspace >"$WORKSPACE"

waive_status="$(
  curl -s -o "$WAIVE" -w '%{http_code}' \
    -X POST http://127.0.0.1:8012/api/v1/studies/STUDY-HLX-028/validation-results/TCR-BW-FIELDS/dispositions \
    -H 'Content-Type: application/json' \
    -d '{"decision":"approved_exception","reason":"Browser override of a template contract failure.","reviewer":"Dr. Ada Path"}'
)"

python3 - "$WORKSPACE" "$WAIVE" "$waive_status" "$ROOT/evidence/template-contract-gates.json" <<'PY'
import json
import sys

workspace = json.loads(open(sys.argv[1]).read())
waive = json.loads(open(sys.argv[2]).read())
status = sys.argv[3]
target = sys.argv[4]
by_id = {item["section_package_id"]: item for item in workspace["section_run_eligibility"]}
body = by_id["section.5_2_3_body_weight"]
discussion = by_id["section.5_3_discussion"]
assert body["eligible"] is True
assert discussion["eligible"] is True
assert {item["check_kind"] for item in body["gate_results"]} == {
    "fields",
    "locations",
    "table_shapes",
    "labels",
    "units",
    "style_constraints",
}
assert all(item["status"] == "passed" for item in body["gate_results"])
assert all(item["waivable"] is False for item in body["gate_results"])
assert discussion["impact_set"]["direct"] == ["section.5_3_discussion"]
assert discussion["impact_set"]["transitive"] == []
assert workspace["review_scaffold_revisions"]
assert workspace["review_scaffold_revisions"][0]["section_impact_sets"] == []
assert status == "409"
assert "non-waivable" in waive["detail"]
payload = {
    "body_weight_eligibility": body,
    "discussion_eligibility": discussion,
    "review_scaffold_revision": workspace["review_scaffold_revisions"][-1]["sequence"],
    "waiver_status": int(status),
    "waiver_detail": waive["detail"],
}
open(target, "w").write(json.dumps(payload, indent=2) + "\n")
print(target)
PY
