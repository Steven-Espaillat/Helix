import json
from pathlib import Path

from test_section_runs import COMMAND, STUDY_ID, FakeSectionAgent, build_client, governed_root, validate

from app.template_contracts import (
    BODY_WEIGHT_PACKAGE_ID,
    DISCUSSION_PACKAGE_ID,
    evaluate_template_contract,
    impact_set_for,
)

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_ROOT = ROOT / "frontend" / "src"
BODY_WEIGHT_PACKAGE = (
    ROOT
    / "skills"
    / "helix-evidence-pipeline"
    / "packages"
    / "sections"
    / "5_2_3_body_weight"
    / "package.json"
)
DISCUSSION_PACKAGE = (
    ROOT
    / "skills"
    / "helix-evidence-pipeline"
    / "packages"
    / "sections"
    / "5_3_discussion"
    / "package.json"
)
TEMPLATE_PATH = ROOT / "backend" / "app" / "data" / "report-template.json"


def load_packages() -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    return (
        json.loads(BODY_WEIGHT_PACKAGE.read_text()),
        json.loads(DISCUSSION_PACKAGE.read_text()),
        json.loads(TEMPLATE_PATH.read_text()),
    )


def by_package(workspace: dict[str, object], package_id: str) -> dict[str, object]:
    return next(
        item
        for item in workspace["section_run_eligibility"]
        if item["section_package_id"] == package_id
    )


def mutate_template(root: Path, mutate) -> None:
    path = root / "backend" / "app" / "data" / "report-template.json"
    template = json.loads(path.read_text())
    mutate(template)
    path.write_text(json.dumps(template))


def body_weight_field(template: dict[str, object]) -> dict[str, object]:
    section = next(item for item in template["sections"] if item["section_id"] == "S5")
    return next(item for item in section["fields"] if item["field_id"] == "body-weight")


def blocked_kinds(eligibility: dict[str, object]) -> set[str]:
    return {item["check_kind"] for item in eligibility["gate_results"] if item["status"] == "blocked"}


def test_template_contract_registry_covers_each_required_check_kind() -> None:
    body_weight, discussion, template = load_packages()
    body_results = evaluate_template_contract(body_weight, template)
    discussion_results = evaluate_template_contract(discussion, template)

    assert {item.check_kind for item in body_results} == {
        "fields",
        "locations",
        "table_shapes",
        "labels",
        "units",
        "style_constraints",
    }
    assert all(item.status == "passed" for item in body_results)
    assert all(item.waivable is False and item.enforcement_class == "hard_blocker" for item in body_results)
    assert [item.status for item in discussion_results] == ["passed"]
    assert impact_set_for(BODY_WEIGHT_PACKAGE_ID, [body_weight, discussion]).model_dump() == {
        "origin_section_package_id": BODY_WEIGHT_PACKAGE_ID,
        "direct": [BODY_WEIGHT_PACKAGE_ID],
        "transitive": [],
    }
    assert DISCUSSION_PACKAGE_ID not in impact_set_for(
        BODY_WEIGHT_PACKAGE_ID, [body_weight, discussion]
    ).direct
    assert DISCUSSION_PACKAGE_ID not in impact_set_for(
        BODY_WEIGHT_PACKAGE_ID, [body_weight, discussion]
    ).transitive
    dependent = {
        "package_id": "section.dependent",
        "depends_on": [BODY_WEIGHT_PACKAGE_ID],
    }
    with_dependent = impact_set_for(BODY_WEIGHT_PACKAGE_ID, [body_weight, discussion, dependent])
    assert with_dependent.direct == [BODY_WEIGHT_PACKAGE_ID]
    assert with_dependent.transitive == ["section.dependent"]


def test_each_missing_template_constraint_blocks_before_codex_starts(tmp_path: Path) -> None:
    cases = [
        (
            "fields",
            "TCR-BW-FIELDS",
            lambda template: body_weight_field(template).__setitem__("required", False),
        ),
        (
            "locations",
            "TCR-BW-LOCATION",
            lambda template: body_weight_field(template).__setitem__("location", ""),
        ),
        (
            "table_shapes",
            "TCR-BW-TABLE-SHAPE",
            lambda template: body_weight_field(template)["table_shape"].__setitem__("grain", "dose_group"),
        ),
        (
            "labels",
            "TCR-BW-LABEL",
            lambda template: body_weight_field(template).__setitem__("label", ""),
        ),
        (
            "units",
            "TCR-BW-UNIT",
            lambda template: body_weight_field(template).__setitem__("unit", "kg"),
        ),
        (
            "style_constraints",
            "TCR-BW-STYLE",
            lambda template: body_weight_field(template)["style_constraints"].__setitem__(
                "decimal_places", 2
            ),
        ),
    ]
    for check_kind, result_id, mutate in cases:
        root = governed_root(tmp_path / check_kind)
        mutate_template(root, mutate)
        agent = FakeSectionAgent()
        client, engine = build_client(agent, repository_root=root)
        with client:
            validate(client)
            workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
            body_weight = by_package(workspace, BODY_WEIGHT_PACKAGE_ID)
            discussion = by_package(workspace, DISCUSSION_PACKAGE_ID)
            blocked = next(item for item in body_weight["gate_results"] if item["result_id"] == result_id)

            assert body_weight["eligible"] is False
            assert blocked["status"] == "blocked"
            assert blocked["check_kind"] == check_kind
            assert blocked["waivable"] is False
            assert blocked["enforcement_class"] == "hard_blocker"
            assert check_kind in blocked_kinds(body_weight)
            assert discussion["eligible"] is True
            assert all(item["status"] == "passed" for item in discussion["gate_results"])

            response = client.post(f"/api/v1/studies/{STUDY_ID}/section-runs", json=COMMAND)
            revised = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
            scaffold = revised["review_scaffold_revisions"][-1]
            body_section = next(
                section for section in scaffold["sections"] if section["section_id"] == "5_2_3_body_weight"
            )
            discussion_section = next(
                section for section in scaffold["sections"] if section["section_id"] == "5_3_discussion"
            )
            impact = next(
                item
                for item in scaffold["section_impact_sets"]
                if item["origin_section_package_id"] == BODY_WEIGHT_PACKAGE_ID
            )

            assert response.status_code == 409
            assert agent.calls == 0
            assert result_id in body_section["blocker_result_ids"]
            assert body_section["placeholder"] == "[NEEDS REVIEW]"
            assert body_section["render_state"] == "needs_review"
            assert discussion_section["render_state"] == "validated_content"
            assert discussion_section["placeholder"] is None
            assert impact["direct"] == [BODY_WEIGHT_PACKAGE_ID]
            assert impact["transitive"] == []
            assert DISCUSSION_PACKAGE_ID not in impact["direct"]
            assert DISCUSSION_PACKAGE_ID not in impact["transitive"]
        engine.dispose()


def test_template_contract_failures_cannot_be_waived_from_the_browser(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    mutate_template(root, lambda template: body_weight_field(template).__setitem__("unit", "mg"))
    agent = FakeSectionAgent()
    client, engine = build_client(agent, repository_root=root)
    with client:
        validate(client)
        waived = client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-results/TCR-BW-UNIT/dispositions",
            json={
                "decision": "approved_exception",
                "reason": "Browser override of a template contract failure.",
                "reviewer": "Dr. Ada Path",
            },
        )
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        body_weight = by_package(workspace, BODY_WEIGHT_PACKAGE_ID)

        assert waived.status_code == 409
        assert "non-waivable" in waived.json()["detail"]
        assert body_weight["eligible"] is False
        assert agent.calls == 0
        assert by_package(workspace, DISCUSSION_PACKAGE_ID)["eligible"] is True
    engine.dispose()


def test_corrected_template_requires_a_new_run_not_a_browser_override(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    mutate_template(root, lambda template: body_weight_field(template).__setitem__("label", ""))
    blocked_agent = FakeSectionAgent()
    blocked_client, blocked_engine = build_client(blocked_agent, repository_root=root)
    with blocked_client:
        validate(blocked_client)
        assert by_package(
            blocked_client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json(),
            BODY_WEIGHT_PACKAGE_ID,
        )["eligible"] is False
        mutate_template(
            root,
            lambda template: body_weight_field(template).__setitem__("label", "Body weight"),
        )
        same_run = blocked_client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs",
            json=COMMAND,
        )
        waived = blocked_client.post(
            f"/api/v1/studies/{STUDY_ID}/validation-results/TCR-BW-LABEL/dispositions",
            json={
                "decision": "corrected",
                "reason": "Attempt to waive the blocked template contract from the browser.",
                "reviewer": "Dr. Ada Path",
            },
        )
        assert same_run.status_code == 409
        assert waived.status_code == 409
        assert blocked_agent.calls == 0
    blocked_engine.dispose()

    mutate_template(
        root,
        lambda template: body_weight_field(template).__setitem__(
            "label", "Body weight and changes by sex and dose"
        ),
    )
    fresh_agent = FakeSectionAgent()
    fresh_client, fresh_engine = build_client(fresh_agent, repository_root=root)
    with fresh_client:
        validate(fresh_client)
        workspace = fresh_client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        assert by_package(workspace, BODY_WEIGHT_PACKAGE_ID)["eligible"] is True
        assert by_package(workspace, DISCUSSION_PACKAGE_ID)["eligible"] is True
        assert fresh_client.post(f"/api/v1/studies/{STUDY_ID}/section-runs", json=COMMAND).status_code == 201
        assert fresh_agent.calls == 1
    fresh_engine.dispose()


def test_non_waivable_template_failure_clears_only_through_superseding_run(tmp_path: Path) -> None:
    root = governed_root(tmp_path)
    mutate_template(root, lambda template: body_weight_field(template).__setitem__("unit", "mg"))
    agent = FakeSectionAgent()
    client, engine = build_client(agent, repository_root=root)
    with client:
        validate(client)
        pinned = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()["pinned_run"]
        assert by_package(
            client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json(),
            BODY_WEIGHT_PACKAGE_ID,
        )["eligible"] is False
        mutate_template(root, lambda template: body_weight_field(template).__setitem__("unit", "g"))
        rejected = client.post(
            f"/api/v1/studies/{STUDY_ID}/pinned-runs",
            json={"actor": "Dr. Run Owner", "idempotency_key": "template-unit-fix-no-supersede"},
        )
        superseded = client.post(
            f"/api/v1/studies/{STUDY_ID}/pinned-runs",
            json={
                "actor": "Dr. Run Owner",
                "idempotency_key": "template-unit-fix",
                "supersession": {
                    "predecessor_run_id": pinned["run_id"],
                    "reason": "Restore parseable body-weight unit on the pinned template",
                },
            },
        )
        workspace = client.get(f"/api/v1/studies/{STUDY_ID}/workspace").json()
        body_weight = by_package(workspace, BODY_WEIGHT_PACKAGE_ID)

        assert rejected.status_code == 409
        assert superseded.status_code == 201
        assert superseded.json()["predecessor_run_id"] == pinned["run_id"]
        assert workspace["pinned_run"]["run_id"] != pinned["run_id"]
        assert body_weight["eligible"] is True
        assert by_package(workspace, DISCUSSION_PACKAGE_ID)["eligible"] is True
        assert client.post(
            f"/api/v1/studies/{STUDY_ID}/section-runs",
            json={**COMMAND, "idempotency_key": "after-supersede-body-weight"},
        ).status_code == 201
        assert agent.calls == 1
    engine.dispose()


def test_section_run_blocks_before_the_sdk_adapter_starts() -> None:
    source = (ROOT / "backend" / "app" / "section_runs.py").read_text()
    assert source.index("eligibility = self.eligibility_for") < source.index("self.agent.run(")
    assert source.index("if not eligibility.eligible") < source.index("self.agent.run(")
    assert source.index("evaluate_template_contract") < source.index("self.agent.run(")


def test_frontend_renders_backend_eligibility_and_does_not_compute_it() -> None:
    journey = (FRONTEND_ROOT / "components" / "StudyJourney.tsx").read_text()
    workbench = (FRONTEND_ROOT / "components" / "HelixWorkbench.tsx").read_text()
    api = (FRONTEND_ROOT / "lib" / "api.ts").read_text()
    report = (FRONTEND_ROOT / "components" / "ReportAssembly.tsx").read_text()

    assert "workspace.section_run_eligibility" in journey
    assert "item.eligible" in journey or "bodyWeightEligibility?.eligible" in journey
    assert "gate_results" in journey
    assert "check_kind" in journey
    assert "impact_set" in journey
    assert "review_scaffold_revisions" in journey
    assert "eligible =" not in journey
    assert "eligible:" not in journey
    assert "gate_results.filter" not in journey
    assert "claims.some" not in journey
    assert "template.sections" not in journey
    assert "eligible" not in workbench
    assert "gate_results" not in api
    assert "TCR-" not in report
    assert "runSectionAgent" in api
    assert "section_run_eligibility" not in api
