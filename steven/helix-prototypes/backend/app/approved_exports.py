from __future__ import annotations

import hashlib
import json
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import Literal

from .qualification import DEMO_LABEL, DEMO_NOTE, demo_notice, demo_packages_of, section_titles
from .run_plans import canonical_hash
from .schemas import (
    ExportArtifact,
    FinalStudyApproval,
    IncludedArtifact,
    ReleaseCandidate,
    SectionDraft,
    StoredSectionRun,
    StudyEvidencePackage,
)


@dataclass
class ExportProbe:
    agent_starts: int = 0
    calculation_runs: int = 0


_EXPORT_PROBE: ContextVar[ExportProbe | None] = ContextVar("helix_export_probe", default=None)


@dataclass(frozen=True, slots=True)
class MaterializedApprovedArtifact:
    artifact_id: str
    kind: Literal[
        "pinned_run",
        "section_draft_candidate",
        "section_draft",
        "data_validation_receipt",
    ]
    content_hash: str
    filename: str
    media_type: str
    content: bytes


class ApprovedExportError(ValueError):
    pass


def current_export_probe() -> ExportProbe | None:
    return _EXPORT_PROBE.get()


def install_export_probe(probe: ExportProbe) -> Token[ExportProbe | None]:
    return _EXPORT_PROBE.set(probe)


def reset_export_probe(token: Token[ExportProbe | None]) -> None:
    _EXPORT_PROBE.reset(token)


def note_agent_start() -> None:
    probe = _EXPORT_PROBE.get()
    if probe is not None:
        probe.agent_starts += 1


def note_calculation_run() -> None:
    probe = _EXPORT_PROBE.get()
    if probe is not None:
        probe.calculation_runs += 1


def encode_canonical(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def receipt_content_hash(receipt_payload: dict[str, object]) -> str:
    payload = dict(receipt_payload)
    payload.pop("idempotent_replay", None)
    return canonical_hash(payload)


def pending_approved_export_artifacts(candidate: ReleaseCandidate) -> list[ExportArtifact]:
    return [
        ExportArtifact(
            artifact_id=item.artifact_id,
            kind=item.kind,
            path=f"approved/{item.artifact_id}.json",
            checksum=None,
            status="pending",
        )
        for item in candidate.included_artifacts
    ]


def materialize_approved_artifacts(
    package: StudyEvidencePackage,
    approval: FinalStudyApproval,
    *,
    live: ReleaseCandidate,
    section_runs: list[StoredSectionRun],
    section_drafts: list[SectionDraft],
) -> list[MaterializedApprovedArtifact]:
    if approval.run_id != live.run_id or approval.manifest_hash != live.content_hash:
        raise ApprovedExportError("Final Study Approval does not match the live release candidate")
    recorded = {(item.artifact_id, item.content_hash) for item in approval.included_artifact_hashes}
    live_hashes = {(item.artifact_id, item.content_hash) for item in live.included_artifacts}
    if recorded != live_hashes:
        raise ApprovedExportError("Final Study Approval is stale relative to included artifact hashes")
    by_id = {item.artifact_id: item for item in live.included_artifacts}
    materialized: list[MaterializedApprovedArtifact] = []
    for approved in approval.included_artifact_hashes:
        item = by_id.get(approved.artifact_id)
        if item is None:
            raise ApprovedExportError(f"Unapproved artifact {approved.artifact_id}")
        if item.content_hash != approved.content_hash:
            raise ApprovedExportError(f"Changed artifact {approved.artifact_id}")
        if item.kind == "review_scaffold" or _looks_like_review_scaffold(item):
            raise ApprovedExportError("Review Scaffold revisions cannot be exported")
        content = _payload_bytes(
            package,
            item,
            section_runs=section_runs,
            section_drafts=section_drafts,
        )
        digest = f"sha256:{hashlib.sha256(content).hexdigest()}"
        if digest != item.content_hash:
            raise ApprovedExportError(
                f"Stored bytes for {item.artifact_id} do not match the approved content hash"
            )
        materialized.append(
            MaterializedApprovedArtifact(
                artifact_id=item.artifact_id,
                kind=item.kind,
                content_hash=item.content_hash,
                filename=f"{item.artifact_id}.json",
                media_type="application/json",
                content=content,
            )
        )
    if len(materialized) != len(approval.included_artifact_hashes):
        raise ApprovedExportError("Export must contain exactly the approved artifact set")
    return materialized


def exported_artifacts_from(
    materialized: list[MaterializedApprovedArtifact],
) -> list[ExportArtifact]:
    return [
        ExportArtifact(
            artifact_id=item.artifact_id,
            kind=item.kind,
            path=f"approved/{item.artifact_id}.json",
            checksum=item.content_hash,
            status="exported",
        )
        for item in materialized
    ]


def demo_export_value(
    package: StudyEvidencePackage,
    kind: str,
    value: object,
    *,
    section_package_id: str | None = None,
) -> object:
    """DEMO ONLY: label the exported bytes of a run frozen with HELIX_DEMO_UNQUALIFIED_PACKAGES.

    A strict run (no demo packages recorded on its freeze event) exports ``value`` unchanged.
    For a demo run the Pinned Run artifact carries a notice listing both sections as
    "Demo: not qualified", and any section artifact of those packages is wrapped with the
    same label. The release candidate hashes these exact bytes, so the Final Study Approval
    covers the label.
    """
    ids = demo_packages_of(package.pinned_run)
    if not ids:
        return value
    if kind == "pinned_run":
        return {"demo_notice": demo_notice(ids, section_titles()), "manifest": value}
    if kind in {"section_draft_candidate", "section_draft"} and section_package_id in ids:
        return {
            "demo_label": DEMO_LABEL,
            "demo_note": DEMO_NOTE,
            "section_package_id": section_package_id,
            "content": value,
        }
    return value


def _looks_like_review_scaffold(item: IncludedArtifact) -> bool:
    return item.artifact_id.startswith("RSR-") or "scaffold" in item.kind


def _payload_bytes(
    package: StudyEvidencePackage,
    item: IncludedArtifact,
    *,
    section_runs: list[StoredSectionRun],
    section_drafts: list[SectionDraft],
) -> bytes:
    if item.kind == "pinned_run":
        pinned = package.pinned_run
        if pinned is None or pinned.run_id != item.artifact_id:
            raise ApprovedExportError(f"Missing pinned run {item.artifact_id}")
        manifest = [entry.model_dump(mode="json") for entry in package.manifest]
        return encode_canonical(demo_export_value(package, "pinned_run", manifest))
    if item.kind == "data_validation_receipt":
        execution = next(
            (
                row
                for row in package.data_validation_executions
                if row.receipt.receipt_id == item.artifact_id
            ),
            None,
        )
        if execution is None:
            raise ApprovedExportError(f"Missing data validation receipt {item.artifact_id}")
        payload = execution.receipt.model_dump(mode="json")
        payload.pop("idempotent_replay", None)
        return encode_canonical(payload)
    if item.kind == "section_draft_candidate":
        run = next(
            (row for row in section_runs if row.candidate.candidate_id == item.artifact_id),
            None,
        )
        if run is None:
            raise ApprovedExportError(f"Missing section draft candidate {item.artifact_id}")
        return encode_canonical(
            demo_export_value(
                package,
                item.kind,
                run.candidate.model_dump(mode="json"),
                section_package_id=run.candidate.section_package_id,
            )
        )
    if item.kind == "section_draft":
        draft = next((row for row in section_drafts if row.draft_id == item.artifact_id), None)
        if draft is None:
            raise ApprovedExportError(f"Missing section draft {item.artifact_id}")
        run = next(
            (row for row in section_runs if row.candidate.candidate_id == draft.candidate_id),
            None,
        )
        if run is None:
            raise ApprovedExportError(f"Missing candidate for section draft {item.artifact_id}")
        return encode_canonical(
            demo_export_value(
                package,
                item.kind,
                run.candidate.content_blocks,
                section_package_id=run.candidate.section_package_id,
            )
        )
    raise ApprovedExportError(f"Unsupported export artifact kind {item.kind}")
