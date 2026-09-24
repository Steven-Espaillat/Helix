import hashlib
import json
from pathlib import Path

from .schemas import (
    ArtifactLineage,
    CandidateEvaluation,
    CarriedForwardArtifact,
    DraftingCycle,
    ExportArtifact,
    FrozenRunInputs,
    ManifestEntry,
    ParseReuse,
    PinnedRun,
    PredecessorSnapshot,
    SectionDraft,
    SectionImpactSet,
    StoredSectionRun,
    StudyEvidencePackage,
    StudyRecords,
    SupersedingRunReceipt,
)
from .template_contracts import impact_set_for


def canonical_hash(value: object) -> str:
    encoded = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def file_hash(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


PARSE_NODE_ID = "parse.body_weights"
VALIDATION_NODE_ID = "validation.body_weight"
SOURCE_ARTIFACT_ID = "A-BW"
BODY_WEIGHT_PACKAGE_ID = "section.5_2_3_body_weight"
DISCUSSION_PACKAGE_ID = "section.5_3_discussion"
BODY_WEIGHT_RELATIVE = Path(
    "skills/helix-evidence-pipeline/packages/data-validation/body-weight/package.json"
)
EXECUTOR_RELATIVE = Path("backend/app/body_weight.py")
TEMPLATE_RELATIVE = Path("backend/app/data/report-template.json")
SKILL_RELATIVE = Path(".agents/skills/helix-section-agent/SKILL.md")
SUITE_RELATIVE = Path(".agents/skills/helix-section-agent/evals/promptfooconfig.yaml")
SECTION_RELATIVE = {
    BODY_WEIGHT_PACKAGE_ID: Path(
        "skills/helix-evidence-pipeline/packages/sections/5_2_3_body_weight/package.json"
    ),
    DISCUSSION_PACKAGE_ID: Path(
        "skills/helix-evidence-pipeline/packages/sections/5_3_discussion/package.json"
    ),
}
SECTION_TEMPLATE_ID = {
    BODY_WEIGHT_PACKAGE_ID: "S5",
    DISCUSSION_PACKAGE_ID: "S8",
}


def capture_frozen_inputs(package: StudyEvidencePackage, repository_root: Path) -> FrozenRunInputs:
    return FrozenRunInputs(
        records=package.records,
        manifest=list(package.manifest),
        template=_load_json(repository_root / TEMPLATE_RELATIVE),
        validation_package=_load_json(repository_root / BODY_WEIGHT_RELATIVE),
        section_packages={
            package_id: _load_json(repository_root / relative)
            for package_id, relative in SECTION_RELATIVE.items()
        },
        skill_hash=file_hash(repository_root / SKILL_RELATIVE),
        suite_hash=file_hash(repository_root / SUITE_RELATIVE),
        executor_hash=file_hash(repository_root / EXECUTOR_RELATIVE),
        validation_package_hash=file_hash(repository_root / BODY_WEIGHT_RELATIVE),
    )


def parse_fingerprint_from(
    records: StudyRecords,
    manifest: list[ManifestEntry],
) -> str:
    return canonical_hash(
        {
            "node_id": PARSE_NODE_ID,
            "records": canonical_hash([item.model_dump(mode="json") for item in records.body_weights]),
            "source": _source_checksum(manifest),
        }
    )


def validation_fingerprint_from(inputs: FrozenRunInputs, parse_fp: str) -> str:
    return canonical_hash(
        {
            "node_id": VALIDATION_NODE_ID,
            "parse": parse_fp,
            "package": inputs.validation_package_hash,
            "executor": inputs.executor_hash,
            "rules": [
                {"rule_id": item["rule_id"], "rule_version": item["rule_version"]}
                for item in inputs.validation_package.get("rules", [])
            ],
        }
    )


def section_fingerprint_from(inputs: FrozenRunInputs, section_package_id: str, validation_fp: str) -> str:
    section_id = SECTION_TEMPLATE_ID[section_package_id]
    slice_payload = next(
        (item for item in inputs.template.get("sections", []) if item.get("section_id") == section_id),
        None,
    )
    package_payload = inputs.section_packages[section_package_id]
    return canonical_hash(
        {
            "node_id": section_package_id,
            "validation": validation_fp,
            "package": package_payload,
            "template_slice": slice_payload,
            "skill": inputs.skill_hash,
            "suite": inputs.suite_hash,
        }
    )


def snapshot_predecessor(
    package: StudyEvidencePackage,
    *,
    frozen_inputs: FrozenRunInputs,
    section_runs: list[StoredSectionRun],
    section_drafts: list[SectionDraft],
    candidate_evaluations: list[CandidateEvaluation],
    drafting_cycles: list[DraftingCycle],
) -> PredecessorSnapshot:
    if package.pinned_run is None:
        raise RuntimeError("Supersession requires a current Pinned Run")
    payload = {
        "schema_version": "helix.predecessor-snapshot/v1",
        "pinned_run": package.pinned_run.model_dump(mode="json"),
        "frozen_inputs": frozen_inputs.model_dump(mode="json"),
        "claims": [item.model_dump(mode="json") for item in package.claims],
        "provenance_edges": [item.model_dump(mode="json") for item in package.provenance_edges],
        "validation_results": [item.model_dump(mode="json") for item in package.validation_results],
        "data_validation_executions": [
            item.model_dump(mode="json") for item in package.data_validation_executions
        ],
        "gate_decisions": [item.model_dump(mode="json") for item in package.gate_decisions],
        "review_dispositions": [item.model_dump(mode="json") for item in package.review_dispositions],
        "approvals": [item.model_dump(mode="json") for item in package.approvals],
        "events": [item.model_dump(mode="json") for item in package.events],
        "review_scaffold_revisions": list(package.review_scaffold_revisions),
        "export_artifacts": [item.model_dump(mode="json") for item in package.export_artifacts],
        "workflow_state": package.workflow_state,
        "section_runs": [item.model_dump(mode="json") for item in section_runs],
        "section_drafts": [item.model_dump(mode="json") for item in section_drafts],
        "candidate_evaluations": [item.model_dump(mode="json") for item in candidate_evaluations],
        "drafting_cycles": [item.model_dump(mode="json") for item in drafting_cycles],
        "release_candidate": (
            package.release_candidate.model_dump(mode="json") if package.release_candidate else None
        ),
        "final_study_approval": (
            package.final_study_approval.model_dump(mode="json") if package.final_study_approval else None
        ),
    }
    return PredecessorSnapshot.model_validate({**payload, "snapshot_hash": canonical_hash(payload)})


def plan_supersession(
    *,
    snapshot: PredecessorSnapshot,
    successor: PinnedRun,
    current_inputs: FrozenRunInputs,
    section_definitions: list[dict[str, object]],
    reason: str,
) -> SupersedingRunReceipt:
    prior = snapshot.frozen_inputs
    current_parse = parse_fingerprint_from(current_inputs.records, current_inputs.manifest)
    prior_parse = parse_fingerprint_from(prior.records, prior.manifest)
    current_validation = validation_fingerprint_from(current_inputs, current_parse)
    prior_validation = validation_fingerprint_from(prior, prior_parse)
    rerun: list[str] = []
    if current_parse != prior_parse:
        rerun.append(PARSE_NODE_ID)
    if current_validation != prior_validation:
        rerun.append(VALIDATION_NODE_ID)
    origins: list[str] = []
    carried: list[CarriedForwardArtifact] = []
    for section_package_id in (BODY_WEIGHT_PACKAGE_ID, DISCUSSION_PACKAGE_ID):
        current_fp = section_fingerprint_from(current_inputs, section_package_id, current_validation)
        prior_fp = section_fingerprint_from(prior, section_package_id, prior_validation)
        if current_fp != prior_fp:
            rerun.append(section_package_id)
            origins.append(section_package_id)
            continue
        stored = _latest_section_run(snapshot.section_runs, section_package_id)
        if stored is None:
            continue
        candidate_hash = _sha(stored.receipt.candidate_hash)
        carried.append(
            CarriedForwardArtifact(
                kind="section_draft_candidate",
                section_package_id=section_package_id,
                artifact_id=stored.candidate.candidate_id,
                content_hash=candidate_hash,
                dependency_fingerprint=current_fp,
                lineage=ArtifactLineage(
                    predecessor_run_id=snapshot.pinned_run.run_id,
                    predecessor_artifact_id=stored.candidate.candidate_id,
                    predecessor_content_hash=candidate_hash,
                    predecessor_dependency_fingerprint=prior_fp,
                ),
                stored_run=stored,
            )
        )
        draft = next(
            (item for item in snapshot.section_drafts if item.candidate_id == stored.candidate.candidate_id),
            None,
        )
        if draft is not None:
            carried.append(
                CarriedForwardArtifact(
                    kind="section_draft",
                    section_package_id=section_package_id,
                    artifact_id=draft.draft_id,
                    content_hash=draft.content_hash,
                    dependency_fingerprint=current_fp,
                    lineage=ArtifactLineage(
                        predecessor_run_id=snapshot.pinned_run.run_id,
                        predecessor_artifact_id=draft.draft_id,
                        predecessor_content_hash=draft.content_hash,
                        predecessor_dependency_fingerprint=prior_fp,
                    ),
                    section_draft=draft,
                )
            )
    impact = _combined_impact(origins, section_definitions)
    for item in [*impact.direct, *impact.transitive]:
        if item not in rerun:
            rerun.append(item)
    return SupersedingRunReceipt(
        schema_version="helix.superseding-run/v1",
        run_id=successor.run_id,
        predecessor_run_id=snapshot.pinned_run.run_id,
        predecessor_snapshot_hash=snapshot.snapshot_hash,
        reason=reason,
        parse_reuse=[
            ParseReuse(node_id=PARSE_NODE_ID, content_hash=current_parse, reused=current_parse == prior_parse)
        ],
        carried_forward=carried,
        rerun_node_ids=rerun,
        impact_set=impact,
        fresh_validation_receipt_ids=[],
        fresh_gate_ids=[],
        fresh_scaffold_revision=0,
    )


def apply_supersession(
    package: StudyEvidencePackage,
    *,
    successor: PinnedRun,
    snapshot: PredecessorSnapshot,
    receipt: SupersedingRunReceipt,
    frozen_inputs: FrozenRunInputs,
) -> StudyEvidencePackage:
    return package.model_copy(
        update={
            "pinned_run": successor,
            "superseded_pinned_runs": [*package.superseded_pinned_runs, snapshot.pinned_run],
            "predecessor_snapshots": [*package.predecessor_snapshots, snapshot],
            "superseding_run_receipt": receipt,
            "frozen_inputs": frozen_inputs,
            "data_validation_executions": [],
            "review_dispositions": [],
            "approvals": [],
            "gate_decisions": [],
            "events": [],
            "review_scaffold_revisions": [],
            # Fresh validations: leftover seed VR-* FAIL rows would still block
            # derive_release_gate after dispositions are wiped. Remint empty here;
            # freeze_run records a new DVP receipt, and POST /validation-runs can
            # remint hybrid results against the successor without the burned
            # validation-freeze-{study_id} key.
            "validation_results": [],
            # Export is out of slice 9 AC, but carrying EXPORTED artifacts / workflow
            # would show GATE EXPORTED on the new run_id and block amendment.
            # Clear successor export state. Predecessor bytes stay in the snapshot.
            "export_artifacts": pending_export_artifacts(package.export_artifacts),
            "workflow_state": (
                "gated" if package.workflow_state == "exported" else package.workflow_state
            ),
            "release_candidate": None,
            "final_study_approval": None,
        }
    )


def pending_export_artifacts(artifacts: list[ExportArtifact]) -> list[ExportArtifact]:
    return [item.model_copy(update={"status": "pending", "checksum": None}) for item in artifacts]


def with_fresh_authority(
    package: StudyEvidencePackage,
    *,
    pinned_run: PinnedRun,
    validation_receipt_ids: list[str],
    gate_ids: list[str],
    scaffold_revision: int,
) -> StudyEvidencePackage:
    assert_bound_pinned_run(package, pinned_run)
    receipt = package.superseding_run_receipt
    if receipt is None:
        return package
    updated = package.model_copy(
        update={
            "approvals": [],
            "release_candidate": None,
            "final_study_approval": None,
            "superseding_run_receipt": receipt.model_copy(
                update={
                    "fresh_validation_receipt_ids": validation_receipt_ids,
                    "fresh_gate_ids": gate_ids,
                    "fresh_scaffold_revision": scaffold_revision,
                }
            ),
        }
    )
    assert_bound_pinned_run(updated, pinned_run)
    return updated


def assert_bound_pinned_run(package: StudyEvidencePackage, pinned_run: PinnedRun) -> None:
    if package.pinned_run is None or package.pinned_run.run_id != pinned_run.run_id:
        raise RuntimeError("Post-freeze authority must bind to the frozen Pinned Run")


def _source_checksum(manifest: list[ManifestEntry]) -> str:
    artifact = next((item for item in manifest if item.artifact_id == SOURCE_ARTIFACT_ID), None)
    if artifact is None:
        return canonical_hash(None)
    return artifact.checksum


def _latest_section_run(
    runs: list[StoredSectionRun],
    section_package_id: str,
) -> StoredSectionRun | None:
    matches = [item for item in runs if item.receipt.section_package_id == section_package_id]
    return matches[-1] if matches else None


def _combined_impact(
    origins: list[str],
    section_definitions: list[dict[str, object]],
) -> SectionImpactSet:
    if not origins:
        return SectionImpactSet(
            origin_section_package_id=BODY_WEIGHT_PACKAGE_ID,
            direct=[],
            transitive=[],
        )
    direct: list[str] = []
    transitive: list[str] = []
    for origin in origins:
        impact = impact_set_for(origin, section_definitions)
        for item in impact.direct:
            if item not in direct:
                direct.append(item)
        for item in impact.transitive:
            if item not in transitive and item not in direct:
                transitive.append(item)
    return SectionImpactSet(
        origin_section_package_id=origins[0],
        direct=direct,
        transitive=transitive,
    )


def _sha(value: str) -> str:
    if value.startswith("sha256:") and len(value.removeprefix("sha256:")) == 64:
        return value
    return canonical_hash(value)


def _load_json(path: Path) -> dict[str, object]:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise ValueError(f"{path} is not a JSON object")
    return payload
