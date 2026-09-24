import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from types import SimpleNamespace
from uuid import uuid4

from jsonschema import Draft202012Validator

from .drafting_cycles import CAP_BLOCKER_ID
from .repository import StudyPackageRepository
from .run_plans import canonical_hash
from .schemas import (
    BoundDisposition,
    CandidateEvaluation,
    ReviewDisposition,
    SectionDraft,
    SectionRunEligibility,
    StudyEvidencePackage,
)
from .section_promotion import (
    _disposition_current,
    dependency_fingerprint_for,
    section_package_definition,
)
from .template_contracts import BODY_WEIGHT_PACKAGE_ID, DISCUSSION_PACKAGE_ID, blocked_result_ids

PLACEHOLDER = "[NEEDS REVIEW]"
SCAFFOLD_SCHEMA_VERSION = "helix.review-scaffold-revision/v1"
IDENTITY_FIELDS = frozenset(
    {
        "revision_id",
        "created_at",
        "content_hash",
        "triggering_event_id",
        "sequence",
        "predecessor_id",
        "run_id",
    }
)
NEW_CONTEXT_KEYS = ("dispositions", "approvals", "stale_disposition_ids")

_STUDY_LOCKS: dict[str, Lock] = {}
_STUDY_LOCKS_GUARD = Lock()


class ExportAdmissionError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class SectionProjection:
    section_id: str
    heading: str
    render_state: str
    artifact_ids: tuple[str, ...]
    validated_claim_ids: tuple[str, ...]
    blocker_result_ids: tuple[str, ...]
    placeholder: str | None


@dataclass(frozen=True, slots=True)
class DispositionBinding:
    disposition_id: str
    result_id: str
    decision: str
    artifact_id: str | None
    artifact_hash: str | None
    dependency_fingerprint: str | None
    stale: bool


@dataclass(frozen=True, slots=True)
class ApprovalBinding:
    approval_id: str
    role: str


@dataclass(frozen=True, slots=True)
class ReviewObservation:
    study_id: str
    release_status: str
    sections: tuple[SectionProjection, ...]
    impact_sets: tuple[Mapping[str, object], ...]
    dispositions: tuple[DispositionBinding, ...]
    approvals: tuple[ApprovalBinding, ...]
    stale_result_ids: tuple[str, ...]


def persist(
    repository: StudyPackageRepository,
    package: StudyEvidencePackage,
    *,
    event_id: str,
    contracts: Path,
    eligibilities: list[SectionRunEligibility],
    repository_root: Path,
) -> StudyEvidencePackage:
    schema = json.loads((contracts / "review-scaffold-revision.schema.json").read_text())
    study_id = package.study.study_id
    with _lock_for(study_id):
        prior = repository.review_scaffold_revisions(study_id)
        working = package.model_copy(update={"review_scaffold_revisions": prior})
        visible = assemble_visible(observe(working, eligibilities, repository, repository_root))
        updated = append_if_changed(working, visible, event_id=event_id, schema=schema)
        if updated.review_scaffold_revisions != prior:
            repository.replace_review_scaffold_revisions(study_id, updated.review_scaffold_revisions)
        return updated


def observe(
    package: StudyEvidencePackage,
    eligibilities: list[SectionRunEligibility],
    repository: StudyPackageRepository,
    repository_root: Path,
) -> ReviewObservation:
    study_id = package.study.study_id
    by_package = {item.section_package_id: item for item in eligibilities}
    impact_sets = tuple(
        item.impact_set.model_dump(mode="json") for item in eligibilities if not item.eligible
    )
    candidates = {
        package_id: candidate
        for package_id, candidate in repository.list_recorded_candidates(study_id)
    }
    evaluations = repository.list_candidate_evaluations(study_id)
    drafts = {item.section_id: item for item in repository.list_section_drafts(study_id)}
    current_hash, current_fingerprint = _current_binding(package, candidates, repository_root)
    dispositions = _latest_dispositions(package, current_hash, current_fingerprint)
    stale_result_ids = tuple(item.result_id for item in dispositions if item.stale)
    approvals = _latest_approvals(package)
    sections = tuple(
        _section_projection(
            section.section_id,
            section.title,
            by_package,
            candidates,
            evaluations,
            drafts,
            stale_result_ids,
        )
        for section in package.report_sections
    )
    return ReviewObservation(
        study_id=study_id,
        release_status="blocked",
        sections=sections,
        impact_sets=impact_sets,
        dispositions=dispositions,
        approvals=approvals,
        stale_result_ids=stale_result_ids,
    )


def assemble_visible(observation: ReviewObservation) -> dict[str, object]:
    return {
        "schema_version": SCAFFOLD_SCHEMA_VERSION,
        "status": "review_scaffold",
        "study_id": observation.study_id,
        "overall_study_context": {
            "release_status": observation.release_status,
            "synthetic": True,
            "section_impact_sets": list(observation.impact_sets),
            "dispositions": [_disposition_payload(item) for item in observation.dispositions],
            "approvals": [
                {"approval_id": item.approval_id, "role": item.role} for item in observation.approvals
            ],
            "stale_disposition_ids": list(observation.stale_result_ids),
        },
        "sections": [_section_payload(item) for item in observation.sections],
        "section_impact_sets": list(observation.impact_sets),
        "export_eligible": False,
    }


def append_if_changed(
    package: StudyEvidencePackage,
    visible: dict[str, object],
    *,
    event_id: str,
    schema: Mapping[str, object],
) -> StudyEvidencePackage:
    prior = package.review_scaffold_revisions
    if prior and _visible_digest(prior[-1]) == _visible_digest(visible):
        return package
    revision = _envelope(package, visible, event_id=event_id)
    _validate_revision(revision, schema)
    _refuse_if_exportable(revision)
    return package.model_copy(update={"review_scaffold_revisions": [*prior, revision]})


def admit_export_document(document: Mapping[str, object]) -> None:
    if document.get("status") == "review_scaffold":
        raise ExportAdmissionError("Release candidates cannot have status review_scaffold")
    if document.get("export_eligible") is not True:
        raise ExportAdmissionError("Admitted export documents must set export_eligible true")
    if document.get("schema_version") == SCAFFOLD_SCHEMA_VERSION:
        raise ExportAdmissionError("Review Scaffold schema_version is not an export document")


def _envelope(
    package: StudyEvidencePackage,
    visible: dict[str, object],
    *,
    event_id: str,
) -> dict[str, object]:
    prior = package.review_scaffold_revisions
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    pinned = package.pinned_run
    content: dict[str, object] = {
        **visible,
        "revision_id": f"RSR-{uuid4().hex[:12].upper()}",
        "run_id": pinned.run_id if pinned is not None else package.study.study_id,
        "sequence": int(prior[-1]["sequence"]) + 1 if prior else 1,
        "created_at": now,
        "triggering_event_id": event_id,
        "predecessor_id": prior[-1]["revision_id"] if prior else None,
    }
    content["content_hash"] = canonical_hash(
        {key: value for key, value in content.items() if key != "content_hash"}
    )
    return content


def _section_projection(
    section_id: str,
    heading: str,
    by_package: dict[str, SectionRunEligibility],
    candidates: dict[str, dict[str, object]],
    evaluations: list[object],
    drafts: dict[str, SectionDraft],
    stale_result_ids: tuple[str, ...],
) -> SectionProjection:
    display_id = {
        "S5": "5_2_3_body_weight",
        "S8": "5_3_discussion",
    }.get(section_id, section_id)
    package_id = {
        "S5": BODY_WEIGHT_PACKAGE_ID,
        "S8": DISCUSSION_PACKAGE_ID,
    }.get(section_id)
    draft = drafts.get(display_id)
    candidate = candidates.get(package_id) if package_id else None
    extra_blockers = _extra_blockers(candidate, evaluations, stale_result_ids if section_id == "S5" else ())
    if draft is not None:
        artifact_ids = tuple(
            dict.fromkeys(
                [*( [str(candidate["candidate_id"])] if candidate is not None else [] ), draft.draft_id]
            )
        )
        return SectionProjection(
            section_id=display_id,
            heading=heading,
            render_state="section_draft",
            artifact_ids=artifact_ids,
            validated_claim_ids=("C-BW-HIGH",) if package_id == BODY_WEIGHT_PACKAGE_ID else (),
            blocker_result_ids=extra_blockers,
            placeholder=None,
        )
    entry = _section_entry(
        section_id,
        heading,
        by_package,
        str(candidate["candidate_id"]) if candidate is not None else None,
        extra_blockers,
    )
    return SectionProjection(
        section_id=str(entry["section_id"]),
        heading=str(entry["heading"]),
        render_state=str(entry["render_state"]),
        artifact_ids=tuple(entry["artifact_ids"]),
        validated_claim_ids=tuple(entry["validated_claim_ids"]),
        blocker_result_ids=tuple(entry["blocker_result_ids"]),
        placeholder=entry["placeholder"] if isinstance(entry["placeholder"], str) else None,
    )


def _section_entry(
    section_id: str,
    heading: str,
    by_package: dict[str, SectionRunEligibility],
    candidate_id: str | None,
    extra_blockers: tuple[str, ...] = (),
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
            ["VR-004", f"PROMOTION-DISABLED-{BODY_WEIGHT_PACKAGE_ID}", *extra_blockers],
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
        "blocker_result_ids": list(dict.fromkeys(blocker_result_ids)),
        "placeholder": PLACEHOLDER,
    }


def _extra_blockers(
    candidate: dict[str, object] | None,
    evaluations: Sequence[CandidateEvaluation],
    stale_result_ids: tuple[str, ...],
) -> tuple[str, ...]:
    blockers: list[str] = []
    if candidate is not None:
        candidate_id = str(candidate["candidate_id"])
        latest = next(
            (item for item in reversed(evaluations) if item.candidate_id == candidate_id),
            None,
        )
        if latest is not None and latest.next_attempt_decision.action == "stop_for_review":
            blockers.append(CAP_BLOCKER_ID)
    blockers.extend(stale_result_ids)
    return tuple(dict.fromkeys(blockers))


def _latest_dispositions(
    package: StudyEvidencePackage,
    current_hash: str | None,
    current_fingerprint: str | None,
) -> tuple[DispositionBinding, ...]:
    latest: dict[str, ReviewDisposition] = {}
    for item in package.review_dispositions:
        latest[item.result_id] = item
    return tuple(
        DispositionBinding(
            disposition_id=item.disposition_id,
            result_id=item.result_id,
            decision=item.decision.value,
            artifact_id=item.artifact_id,
            artifact_hash=item.artifact_hash,
            dependency_fingerprint=item.dependency_fingerprint,
            stale=_disposition_stale(item, current_hash, current_fingerprint),
        )
        for item in latest.values()
    )


def _disposition_stale(
    item: ReviewDisposition,
    current_hash: str | None,
    current_fingerprint: str | None,
) -> bool:
    if not item.artifact_hash or not item.dependency_fingerprint:
        return False
    if current_hash is None or current_fingerprint is None:
        return True
    return not _disposition_current(
        BoundDisposition(
            disposition_id=item.disposition_id,
            result_id=item.result_id,
            decision=item.decision.value,
            artifact_hash=item.artifact_hash,
            dependency_fingerprint=item.dependency_fingerprint,
        ),
        SimpleNamespace(candidate_hash=current_hash, dependency_fingerprint=current_fingerprint),
    )


def _latest_approvals(package: StudyEvidencePackage) -> tuple[ApprovalBinding, ...]:
    latest: dict[str, ApprovalBinding] = {}
    for item in package.approvals:
        latest[item.role.value] = ApprovalBinding(approval_id=item.approval_id, role=item.role.value)
    return tuple(latest.values())


def _current_binding(
    package: StudyEvidencePackage,
    candidates: dict[str, dict[str, object]],
    repository_root: Path,
) -> tuple[str | None, str | None]:
    candidate = candidates.get(BODY_WEIGHT_PACKAGE_ID)
    if candidate is None:
        return None, None
    definition = section_package_definition(repository_root, BODY_WEIGHT_PACKAGE_ID)
    fingerprint = dependency_fingerprint_for(
        package, [str(item) for item in definition.get("depends_on", [])]
    )
    return canonical_hash(candidate), fingerprint


def _visible_digest(revision: Mapping[str, object]) -> str:
    payload = {key: value for key, value in revision.items() if key not in IDENTITY_FIELDS}
    context = payload.get("overall_study_context")
    if isinstance(context, dict):
        normalized = dict(context)
        for key in NEW_CONTEXT_KEYS:
            if key not in normalized:
                normalized[key] = []
        payload = {**payload, "overall_study_context": normalized}
    return canonical_hash(payload)


def _validate_revision(revision: dict[str, object], schema: Mapping[str, object]) -> None:
    errors = list(Draft202012Validator(schema).iter_errors(revision))
    if errors:
        raise ValueError(errors[0].message)


def _refuse_if_exportable(revision: Mapping[str, object]) -> None:
    try:
        admit_export_document(revision)
    except ExportAdmissionError:
        return
    raise ValueError("Review Scaffold revisions cannot be admitted for export")


def _disposition_payload(item: DispositionBinding) -> dict[str, object]:
    return {
        "disposition_id": item.disposition_id,
        "result_id": item.result_id,
        "decision": item.decision,
        "artifact_id": item.artifact_id,
        "artifact_hash": item.artifact_hash,
        "dependency_fingerprint": item.dependency_fingerprint,
        "stale": item.stale,
    }


def _section_payload(item: SectionProjection) -> dict[str, object]:
    return {
        "section_id": item.section_id,
        "heading": item.heading,
        "render_state": item.render_state,
        "artifact_ids": list(item.artifact_ids),
        "validated_claim_ids": list(item.validated_claim_ids),
        "blocker_result_ids": list(item.blocker_result_ids),
        "placeholder": item.placeholder,
    }


def _lock_for(study_id: str) -> Lock:
    with _STUDY_LOCKS_GUARD:
        return _STUDY_LOCKS.setdefault(study_id, Lock())
