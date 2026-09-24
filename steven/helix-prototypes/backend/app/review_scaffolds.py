from datetime import UTC, datetime
from uuid import uuid4

from jsonschema import Draft202012Validator

from .run_plans import canonical_hash
from .schemas import SectionRunEligibility, StudyEvidencePackage
from .template_contracts import BODY_WEIGHT_PACKAGE_ID, DISCUSSION_PACKAGE_ID, blocked_result_ids

PLACEHOLDER = "[NEEDS REVIEW]"


def assemble_review_scaffold(
    package: StudyEvidencePackage,
    eligibilities: list[SectionRunEligibility],
    *,
    run_id: str,
    event_id: str,
    candidate_id: str | None = None,
) -> dict[str, object]:
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    prior = package.review_scaffold_revisions
    sequence = int(prior[-1]["sequence"]) + 1 if prior else 1
    predecessor_id = prior[-1]["revision_id"] if prior else None
    by_package = {item.section_package_id: item for item in eligibilities}
    impact_sets = [
        item.impact_set.model_dump(mode="json")
        for item in eligibilities
        if not item.eligible
    ]
    sections = [
        _section_entry(
            section.section_id,
            section.title,
            by_package,
            candidate_id,
        )
        for section in package.report_sections
    ]
    content: dict[str, object] = {
        "schema_version": "helix.review-scaffold-revision/v1",
        "status": "review_scaffold",
        "revision_id": f"RSR-{uuid4().hex[:12].upper()}",
        "run_id": run_id,
        "study_id": package.study.study_id,
        "sequence": sequence,
        "created_at": now,
        "triggering_event_id": event_id,
        "predecessor_id": predecessor_id,
        "overall_study_context": {
            "release_status": "blocked",
            "synthetic": True,
            "section_impact_sets": impact_sets,
        },
        "sections": sections,
        "section_impact_sets": impact_sets,
        "export_eligible": False,
    }
    content["content_hash"] = canonical_hash(
        {key: value for key, value in content.items() if key != "content_hash"}
    )
    return content


def record_if_changed(
    package: StudyEvidencePackage,
    revision: dict[str, object],
    schema: dict[str, object],
) -> StudyEvidencePackage:
    errors = list(Draft202012Validator(schema).iter_errors(revision))
    if errors:
        raise ValueError(errors[0].message)
    prior = package.review_scaffold_revisions
    if prior and _stable(prior[-1]) == _stable(revision):
        return package
    return package.model_copy(
        update={"review_scaffold_revisions": [*prior, revision]}
    )


def _stable(revision: dict[str, object]) -> object:
    ignored = {
        "revision_id",
        "created_at",
        "content_hash",
        "triggering_event_id",
        "sequence",
        "predecessor_id",
    }
    return canonical_hash({key: value for key, value in revision.items() if key not in ignored})


def _section_entry(
    section_id: str,
    heading: str,
    by_package: dict[str, SectionRunEligibility],
    candidate_id: str | None,
) -> dict[str, object]:
    display_id = {
        "S5": "5_2_3_body_weight",
        "S8": "5_3_discussion",
    }.get(section_id, section_id)
    package_id = {
        "S5": BODY_WEIGHT_PACKAGE_ID,
        "S8": DISCUSSION_PACKAGE_ID,
    }.get(section_id)
    eligibility = by_package.get(package_id) if package_id else None
    if eligibility is None:
        return _needs_review(display_id, heading, [f"PENDING-{section_id}"])
    if not eligibility.eligible:
        blockers = blocked_result_ids(eligibility.gate_results) or ["PRECONDITION-SECTION-ELIGIBILITY"]
        claim_ids = ["C-BW-HIGH"] if package_id == BODY_WEIGHT_PACKAGE_ID else []
        return _needs_review(display_id, heading, blockers, validated_claim_ids=claim_ids)
    if candidate_id and section_id == "S5":
        return _needs_review(
            display_id,
            heading,
            ["VR-004", f"PROMOTION-DISABLED-{BODY_WEIGHT_PACKAGE_ID}"],
            artifact_ids=[candidate_id],
            validated_claim_ids=["C-BW-HIGH"],
        )
    return {
        "section_id": display_id,
        "heading": heading,
        "render_state": "validated_content",
        "artifact_ids": [],
        "validated_claim_ids": [],
        "blocker_result_ids": [],
        "placeholder": None,
    }


def _needs_review(
    section_id: str,
    heading: str,
    blocker_result_ids: list[str],
    *,
    artifact_ids: list[str] | None = None,
    validated_claim_ids: list[str] | None = None,
) -> dict[str, object]:
    return {
        "section_id": section_id,
        "heading": heading,
        "render_state": "needs_review",
        "artifact_ids": artifact_ids or [],
        "validated_claim_ids": validated_claim_ids or [],
        "blocker_result_ids": blocker_result_ids,
        "placeholder": PLACEHOLDER,
    }
