import json
from pathlib import Path

from app.schemas import SectionDraftCandidate
from app.study_output_evaluation import evaluate_study_output, load_suite_asserts

ROOT = Path(__file__).resolve().parents[2]
SUITE = ROOT / ".agents" / "skills" / "helix-section-agent" / "evals" / "study-output.yaml"
HASH = "sha256:" + "ab" * 32


def candidate(text: str) -> SectionDraftCandidate:
    return SectionDraftCandidate.model_validate(
        {
            "schema_version": "helix.section-draft-candidate/v1",
            "status": "section_draft_candidate",
            "candidate_id": "SDC-SOE000001",
            "run_id": "SRUN-SOE000001",
            "section_id": "5_2_3_body_weight",
            "section_package_id": "section.5_2_3_body_weight",
            "section_package_version": "0.1.0",
            "drafting_cycle_id": "CYCLE-BW-001",
            "attempt": 1,
            "validated_claim_ids": ["C-BW-HIGH"],
            "content_blocks": [
                {
                    "block_id": "BW-P1",
                    "kind": "paragraph",
                    "content": text,
                    "factual_spans": [{"text": text, "claim_ids": ["C-BW-HIGH"]}],
                }
            ],
            "executor_receipt_ids": ["EXEC-BW-SUMMARY-001"],
            "agent_receipt": {
                "runtime": "codex_sdk",
                "thread_id": "thread-test-001",
                "skill_name": "helix-section-agent",
                "skill_hash": HASH,
            },
        }
    )


def evaluate(item: SectionDraftCandidate):
    return evaluate_study_output(
        item,
        candidate_hash="sha256:" + "cd" * 32,
        suite_id="helix-section-study-output",
        suite_version="0.1.0",
        suite_path=SUITE,
    )


def test_study_output_suite_is_loaded_from_the_promptfoo_yaml() -> None:
    asserts = load_suite_asserts(SUITE)
    assert ("is-json", None) in asserts
    assert ("contains", "section_draft_candidate") in asserts
    assert ("not-contains", "approved") in asserts


def test_study_output_failure_is_review_required_not_a_deterministic_gate() -> None:
    receipt = evaluate(candidate("Terminal high-dose body weight was 286.2 g and is approved."))
    assert receipt.status == "failed"
    assert receipt.enforcement_class == "review_required"
    assert any(item.status == "failed" and "approved" in item.assertion for item in receipt.results)


def test_study_output_pass_does_not_claim_deterministic_authority() -> None:
    receipt = evaluate(candidate("Terminal high-dose body weight was 286.2 g."))
    assert receipt.status == "passed"
    assert receipt.enforcement_class == "review_required"
    assert json.dumps(receipt.model_dump(mode="json")).count("hard_blocker") == 0
