import json

from app.provenance_compiler import allowed_claims_for, compile_provenance
from app.run_plans import canonical_hash
from app.schemas import Claim, ClaimStatus, ProvenanceEdge, SectionDraftCandidate

HASH = "sha256:" + "ab" * 32


def candidate(text: str = "Terminal high-dose body weight was 286.2 g.") -> SectionDraftCandidate:
    return SectionDraftCandidate.model_validate(
        {
            "schema_version": "helix.section-draft-candidate/v1",
            "status": "section_draft_candidate",
            "candidate_id": "SDC-PROV000001",
            "run_id": "SRUN-PROV000001",
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
                "skill_references_hash": HASH,
            },
        }
    )


def claims() -> dict:
    claim = Claim(
        claim_id="C-BW-HIGH",
        section_id="S5",
        field_id="terminal-body-weight-high",
        value=286.2,
        unit="g",
        grain="dose_group",
        status=ClaimStatus.VALIDATED,
        source_hashes=[HASH],
    )
    edge = ProvenanceEdge(
        edge_id="PE-C-BW-HIGH-1",
        claim_id="C-BW-HIGH",
        source_record_id="BW-HXL-M401-28",
        transform_id="mean-v1",
        source_pointer="A-BW#HXL-M401:DAY28",
        authority_tier=1,
        source_hash=HASH,
    )
    return allowed_claims_for([claim], [edge], {"C-BW-HIGH"})


def test_supported_span_binds_claim_and_artifact_hashes() -> None:
    item = candidate()
    receipt = compile_provenance(item, claims(), candidate_hash=canonical_hash(item.model_dump(mode="json")))
    assert receipt.status == "passed"
    assert receipt.enforcement_class == "hard_blocker"
    assert receipt.waivable is False
    assert receipt.bindings[0].claim_id == "C-BW-HIGH"
    claim_hash = canonical_hash(claims()["C-BW-HIGH"].claim.model_dump(mode="json"))
    assert receipt.bindings[0].claim_hash == claim_hash
    assert receipt.bindings[0].artifact_hash == HASH
    assert receipt.blockers == []


def test_unsupported_number_is_a_non_waivable_blocker_and_leaves_candidate_bytes() -> None:
    original = candidate("Terminal high-dose body weight was 286.2 g and 99.9 kg.")
    before = json.dumps(original.model_dump(mode="json"), sort_keys=True)
    receipt = compile_provenance(
        original,
        claims(),
        candidate_hash=canonical_hash(original.model_dump(mode="json")),
    )
    after = json.dumps(original.model_dump(mode="json"), sort_keys=True)
    assert receipt.status == "blocked"
    assert receipt.waivable is False
    assert receipt.blockers[0].code == "unsupported-content"
    assert before == after
