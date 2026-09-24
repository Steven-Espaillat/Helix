import json
from pathlib import Path

from .contract_schema import draft202012_validator
from .run_plans import canonical_hash
from .schemas import (
    ApprovedArtifactHash,
    DraftingCycle,
    DraftingCycleRef,
    FinalStudyApproval,
    IncludedArtifact,
    ReleaseCandidate,
    SectionDraft,
    StoredSectionRun,
    StudyEvidencePackage,
)

CONTRACTS = Path(__file__).resolve().parents[2] / "skills" / "helix-evidence-pipeline" / "contracts"
KIND_ORDER = {
    "pinned_run": 0,
    "data_validation_receipt": 1,
    "section_draft_candidate": 2,
    "section_draft": 3,
}


class MissingReleaseCandidateError(ValueError):
    pass


def compile_release_candidate(
    package: StudyEvidencePackage,
    *,
    section_runs: list[StoredSectionRun],
    section_drafts: list[SectionDraft],
    drafting_cycles: list[DraftingCycle],
) -> ReleaseCandidate:
    pinned = package.pinned_run
    if pinned is None:
        raise MissingReleaseCandidateError("Freeze the authorized manifest first")
    included: list[IncludedArtifact] = [
        IncludedArtifact(
            artifact_id=pinned.run_id,
            kind="pinned_run",
            content_hash=pinned.manifest_hash,
        )
    ]
    for execution in package.data_validation_executions:
        included.append(
            IncludedArtifact(
                artifact_id=execution.receipt.receipt_id,
                kind="data_validation_receipt",
                content_hash=execution.receipt.input_fingerprint,
            )
        )
    latest_runs: dict[str, StoredSectionRun] = {}
    for run in section_runs:
        latest_runs[run.receipt.section_package_id] = run
    for run in latest_runs.values():
        included.append(
            IncludedArtifact(
                artifact_id=run.candidate.candidate_id,
                kind="section_draft_candidate",
                content_hash=run.receipt.candidate_hash,
            )
        )
    for draft in section_drafts:
        included.append(
            IncludedArtifact(
                artifact_id=draft.draft_id,
                kind="section_draft",
                content_hash=draft.content_hash,
            )
        )
    included.sort(key=lambda item: (KIND_ORDER[item.kind], item.artifact_id))
    latest_cycles: dict[str, DraftingCycle] = {}
    for cycle in drafting_cycles:
        latest_cycles[cycle.section_package_id] = cycle
    cycles = [
        DraftingCycleRef(section_package_id=package_id, cycle_id=cycle.cycle_id)
        for package_id, cycle in sorted(latest_cycles.items())
    ]
    payload = {
        "schema_version": "helix.release-candidate/v1",
        "status": "release_candidate",
        "export_eligible": True,
        "run_id": pinned.run_id,
        "study_id": package.study.study_id,
        "included_artifacts": [item.model_dump(mode="json") for item in included],
        "current_drafting_cycles": [item.model_dump(mode="json") for item in cycles],
    }
    candidate = ReleaseCandidate.model_validate({**payload, "content_hash": canonical_hash(payload)})
    validate_release_candidate(candidate)
    return candidate


def approval_is_current(
    approval: FinalStudyApproval | None,
    live: ReleaseCandidate | None,
) -> bool:
    if approval is None or live is None:
        return False
    if approval.run_id != live.run_id:
        return False
    if approval.manifest_hash != live.content_hash:
        return False
    recorded = {(item.artifact_id, item.content_hash) for item in approval.included_artifact_hashes}
    live_hashes = {(item.artifact_id, item.content_hash) for item in live.included_artifacts}
    return recorded == live_hashes


def hashes_for(candidate: ReleaseCandidate) -> list[ApprovedArtifactHash]:
    return [
        ApprovedArtifactHash(artifact_id=item.artifact_id, content_hash=item.content_hash)
        for item in candidate.included_artifacts
    ]


def approval_request_hash(
    study_id: str,
    reviewer: str,
    candidate: ReleaseCandidate,
) -> str:
    return canonical_hash(
        {
            "study_id": study_id,
            "reviewer": reviewer,
            "manifest_hash": candidate.content_hash,
            "included": [item.model_dump(mode="json") for item in hashes_for(candidate)],
        }
    )


def recorded_request_hash(approval: FinalStudyApproval) -> str:
    return canonical_hash(
        {
            "study_id": approval.study_id,
            "reviewer": approval.reviewer,
            "manifest_hash": approval.manifest_hash,
            "included": [item.model_dump(mode="json") for item in approval.included_artifact_hashes],
        }
    )


def validate_release_candidate(candidate: ReleaseCandidate) -> None:
    payload = candidate.model_dump(mode="json")
    schema = _load_schema("release-candidate.schema.json")
    draft202012_validator(schema, CONTRACTS).validate(payload)
    ReleaseCandidate.model_validate(payload)


def validate_final_study_approval(approval: FinalStudyApproval) -> None:
    payload = approval.model_dump(mode="json")
    schema = _load_schema("final-study-approval.schema.json")
    draft202012_validator(schema, CONTRACTS).validate(payload)
    FinalStudyApproval.model_validate(payload)


def _load_schema(filename: str) -> dict[str, object]:
    return json.loads((CONTRACTS / filename).read_text())
