import json
from pathlib import Path

from app.schemas import SectionDraftCandidate
from app.template_conformance import evaluate_template_conformance

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = json.loads(
    (
        ROOT
        / "skills"
        / "helix-evidence-pipeline"
        / "packages"
        / "sections"
        / "5_2_3_body_weight"
        / "package.json"
    ).read_text()
)
TEMPLATE = json.loads((ROOT / "backend" / "app" / "data" / "report-template.json").read_text())
HASH = "sha256:" + "ab" * 32
RULE_IDS = {
    "completeness": "TCF-BW-COMPLETENESS",
    "table_coverage": "TCF-BW-TABLE-COVERAGE",
    "terminology": "TCF-BW-TERMINOLOGY",
    "units": "TCF-BW-UNITS",
    "rounding": "TCF-BW-ROUNDING",
    "approved_language": "TCF-BW-APPROVED-LANGUAGE",
}


def candidate(blocks: list[dict[str, object]]) -> SectionDraftCandidate:
    return SectionDraftCandidate.model_validate(
        {
            "schema_version": "helix.section-draft-candidate/v1",
            "status": "section_draft_candidate",
            "candidate_id": "SDC-TCF000001",
            "run_id": "SRUN-TCF000001",
            "section_id": "5_2_3_body_weight",
            "section_package_id": "section.5_2_3_body_weight",
            "section_package_version": "0.1.0",
            "drafting_cycle_id": "CYCLE-BW-001",
            "attempt": 1,
            "validated_claim_ids": ["C-BW-HIGH"],
            "content_blocks": blocks,
            "executor_receipt_ids": ["EXEC-BW-SUMMARY-001"],
            "agent_receipt": {
                "runtime": "codex_sdk",
                "thread_id": "thread-test-001",
                "skill_name": "helix-section-agent",
                "skill_hash": HASH,
                "skill_references_hash": HASH,
            },
        }
    )


def conforming_blocks() -> list[dict[str, object]]:
    cells = [
        {"text": "high-dose", "claim_ids": ["C-BW-HIGH"]},
        {"text": "M", "claim_ids": ["C-BW-HIGH"]},
        {"text": "mean", "claim_ids": ["C-BW-HIGH"]},
        {"text": "sd", "claim_ids": ["C-BW-HIGH"]},
        {"text": "n", "claim_ids": ["C-BW-HIGH"]},
        {"text": "286.2 g", "claim_ids": ["C-BW-HIGH"]},
    ]
    paragraph = "Terminal high-dose body weight was 286.2 g."
    return [
        {
            "block_id": "BW-P1",
            "kind": "paragraph",
            "content": paragraph,
            "factual_spans": [{"text": paragraph, "claim_ids": ["C-BW-HIGH"]}],
        },
        {
            "block_id": "BW-T1",
            "kind": "table",
            "content": {"rows": [{"cells": cells}]},
            "factual_spans": [{"text": cell["text"], "claim_ids": ["C-BW-HIGH"]} for cell in cells],
        },
    ]


def test_conformance_returns_stable_rule_ids_for_every_check_kind() -> None:
    receipt = evaluate_template_conformance(
        candidate(conforming_blocks()),
        PACKAGE,
        TEMPLATE,
        candidate_hash="sha256:" + "cd" * 32,
    )
    assert {item.check_kind: item.rule_id for item in receipt.results} == RULE_IDS
    assert receipt.status == "passed"
    assert all(
        item.waivable is False and item.enforcement_class == "hard_blocker" for item in receipt.results
    )


def test_missing_table_blocks_completeness_and_table_coverage() -> None:
    paragraph = "Terminal high-dose body weight was 286.2 g."
    receipt = evaluate_template_conformance(
        candidate(
            [
                {
                    "block_id": "BW-P1",
                    "kind": "paragraph",
                    "content": paragraph,
                    "factual_spans": [{"text": paragraph, "claim_ids": ["C-BW-HIGH"]}],
                }
            ]
        ),
        PACKAGE,
        TEMPLATE,
        candidate_hash="sha256:" + "cd" * 32,
    )
    blocked = {item.check_kind for item in receipt.results if item.status == "blocked"}
    assert "completeness" in blocked
    assert "table_coverage" in blocked
    assert receipt.status == "blocked"
