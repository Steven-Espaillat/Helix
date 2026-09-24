from test_section_runs import COMMAND, STUDY_ID, FakeSectionAgent, build_client, validate

EVAL_COMMAND = {"idempotency_key": "evaluate-STUDY-HLX-028-body-weight-v1"}
QUERY_COMMAND = {
    "idempotency_key": "query-STUDY-HLX-028-body-weight-v1",
    "artifact_ids": ["claim:C-BW-HIGH", "validation.body_weight"],
}


def draft(client, *, key: str = COMMAND["idempotency_key"]):
    response = client.post(
        f"/api/v1/studies/{STUDY_ID}/section-runs",
        json={"section_package_id": COMMAND["section_package_id"], "idempotency_key": key},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_conforming_candidate_evaluation_binds_hashes_and_persists_three_receipts() -> None:
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
                "idempotency_key": "query-undeclared",
                "artifact_ids": ["claim:C-NOAEL", "record:BW-HXL-M401-28"],
            },
        )
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()

        assert first.status_code == 201, first.text
        body = first.json()
        assert replay.status_code == 201
        assert replay.json()["evaluation_id"] == body["evaluation_id"]
        assert replay.json()["idempotent_replay"] is True
        assert body["candidate_hash"] == recorded["candidate_hash"]
        assert body["hashes"]["candidate"] == recorded["candidate_hash"]
        provenance = body["provenance_receipt"]
        assert provenance["status"] == "passed"
        assert provenance["waivable"] is False
        assert provenance["bindings"]
        assert all(item["claim_id"] == "C-BW-HIGH" for item in provenance["bindings"])
        assert all(item["claim_hash"].startswith("sha256:") for item in provenance["bindings"])
        assert all(item["artifact_hash"].startswith("sha256:") for item in provenance["bindings"])
        conformance = body["template_conformance_receipt"]
        assert {item["check_kind"] for item in conformance["results"]} == {
            "completeness",
            "table_coverage",
            "terminology",
            "units",
            "rounding",
            "approved_language",
        }
        assert conformance["status"] == "passed"
        study = body["study_output_evaluation_receipt"]
        assert study["status"] == "passed"
        assert study["enforcement_class"] == "review_required"
        assert body["next_attempt_decision"]["action"] == "hold"
        assert workspace["section_runs"][-1]["candidate"]["candidate_id"] == recorded["candidate_id"]
        assert workspace["candidate_evaluations"][-1]["evaluation_id"] == body["evaluation_id"]
        assert query.status_code == 201, query.text
        assert query.json()["status"] == "returned"
        assert query.json()["requested_artifact_ids"] == QUERY_COMMAND["artifact_ids"]
        assert {item["artifact_id"] for item in query.json()["returned"]} == set(
            QUERY_COMMAND["artifact_ids"]
        )
        assert all(item["hash"].startswith("sha256:") for item in query.json()["returned"])
        assert denied.status_code == 201
        assert denied.json()["status"] == "rejected"
        assert "claim:C-NOAEL" in denied.json()["rejected_artifact_ids"]
        assert workspace["cross_section_queries"]


def test_unsupported_content_blocks_provenance_and_preserves_the_candidate() -> None:
    agent = FakeSectionAgent("unsupported_value")
    client, _engine = build_client(agent)
    with client:
        validate(client)
        recorded = draft(client, key="unsupported-key")
        original = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()["section_runs"][-1][
            "candidate"
        ]
        response = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/evaluations",
            json={"idempotency_key": "evaluate-unsupported"},
        )
        stored = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()["section_runs"][-1][
            "candidate"
        ]
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["provenance_receipt"]["status"] == "blocked"
        assert body["provenance_receipt"]["waivable"] is False
        assert body["provenance_receipt"]["enforcement_class"] == "hard_blocker"
        assert body["next_attempt_decision"]["action"] == "retry"
        assert stored == original
        waive = client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-results/{body['provenance_receipt']['receipt_id']}/dispositions",
            json={
                "decision": "approved_exception",
                "reason": "Invented provenance must never be waivable.",
                "reviewer": "Dr. Ada Path",
            },
        )
        assert waive.status_code == 409
        assert "non-waivable" in waive.json()["detail"]
        waive_conformance = client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-results/{body['template_conformance_receipt']['receipt_id']}/dispositions",
            json={
                "decision": "approved_exception",
                "reason": "Template Conformance failures are non-waivable.",
                "reviewer": "Dr. Ada Path",
            },
        )
        assert waive_conformance.status_code == 409
        assert "non-waivable" in waive_conformance.json()["detail"]


def test_study_output_failure_creates_review_required_without_changing_deterministic_gates() -> None:
    agent = FakeSectionAgent("conforming_advisory_fail")
    client, _engine = build_client(agent)
    with client:
        validate(client)
        recorded = draft(client, key="advisory-key")
        response = client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs/{recorded['run_id']}/evaluations",
            json={"idempotency_key": "evaluate-advisory"},
        )
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["study_output_evaluation_receipt"]["status"] == "failed"
        assert body["study_output_evaluation_receipt"]["enforcement_class"] == "review_required"
        assert body["provenance_receipt"]["status"] == "passed"
        assert body["template_conformance_receipt"]["status"] == "passed"
        assert body["next_attempt_decision"]["action"] == "hold"
        assert "review_required" in " ".join(body["next_attempt_decision"]["reasons"])
        assert body["next_attempt_decision"]["blocking_receipt_ids"] == []
