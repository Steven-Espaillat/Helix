# DH-8 evidence: drive a local run to FSA through the API (human-freeze step included), then try export.
import json, sys, urllib.request
base = sys.argv[1] + "/api/v1/studies/STUDY-HLX-028"
out = {}
def call(method, path, body=None):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read())
s, run = call("POST", "/pinned-runs", {"actor": "Synthetic study owner (demo identity)", "idempotency_key": "dh8-evidence-freeze-1"})
out["freeze"] = {"status": s, "run_requested_details": run.get("event_history", [{}])[0].get("details") if s == 201 else run}
s, v = call("POST", "/validation-runs", {"planner": "fixture"}); out["validation"] = s
for r in v.get("results", []):
    if r["status"] == "fail" and r["severity"] == "blocker":
        d = "approved_exception" if r["result_id"] == "VR-006" else "corrected"
        call("POST", f"/validation-results/{r['result_id']}/dispositions", {"decision": d, "reason": f"Synthetic disposition recorded for {r['rule_id']}.", "reviewer": "Dr. Ada Path"})
for role, reviewer, meaning in [("pathologist", "Dr. Ada Path", "Scientific review complete"), ("peer_reviewer", "Dr. Priya Peer", "Independent pathology review complete"), ("qau", "Morgan QA", "Quality assurance statement recorded"), ("study_director", "Dr. Sam Director", "Final report approval")]:
    out[f"approval_{role}"] = call("POST", "/approvals", {"role": role, "reviewer": reviewer, "meaning": meaning})[0]
out["fsa"] = call("POST", "/final-study-approvals", {"reviewer": "Dr. Sam Director", "idempotency_key": "dh8-evidence-fsa-1"})[0]
s, w = call("GET", "/workspace"); out["release_gate_before_export"] = w["release_gate"]["status"]
if len(sys.argv) > 2 and sys.argv[2] == "export":
    s, e = call("POST", "/exports", {"actor": "Dr. Sam Director", "idempotency_key": "dh8-evidence-export-1"})
    out["export"] = {"status": s, "body": e if s != 200 else {"artifacts": len(e["artifacts"])}}
    s, w = call("GET", "/workspace")
    out["release_gate_after_export"] = w["release_gate"]["status"]
    out["export_artifacts_after"] = [a["status"] for a in w["export_artifacts"]]
print(json.dumps(out, indent=2))
