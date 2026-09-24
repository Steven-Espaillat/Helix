import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from uuid import uuid4

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .contract_schema import draft202012_validator
from .repository import StudyPackageRepository
from .run_plans import canonical_hash
from .schemas import (
    RESOLVED_DISPOSITIONS,
    BoundDisposition,
    CandidateEvaluation,
    ConditionDecision,
    PromotionCommand,
    PromotionDecision,
    ReviewDisposition,
    SectionDraft,
    StoredSectionRun,
    StudyEvidencePackage,
)

ConditionId = Literal[
    "package_permission",
    "no_hard_blocker",
    "provenance_passed",
    "conformance_passed",
    "review_required_current",
]

RESOLVED_DECISIONS = frozenset(item.value for item in RESOLVED_DISPOSITIONS)


class PromotionRejectedError(RuntimeError):
    def __init__(self, decision: PromotionDecision):
        failed = ", ".join(decision.failed_condition_ids) or "unknown"
        super().__init__(f"Section promotion rejected: {failed}")
        self.decision = decision


class PromotionConflictError(RuntimeError):
    pass


class UnknownPromotionTargetError(ValueError):
    pass


@dataclass(frozen=True)
class ReviewRequiredFact:
    result_id: str


@dataclass(frozen=True)
class PromotionSnapshot:
    candidate_id: str
    candidate_hash: str
    content_hash: str
    run_id: str
    section_id: str
    package_maturity: str
    promotion_allowed: bool
    provenance_passed: bool
    conformance_passed: bool
    hard_blocker_ids: tuple[str, ...]
    review_required: tuple[ReviewRequiredFact, ...]
    warnings: tuple[str, ...]
    dependency_fingerprint: str
    dispositions: tuple[BoundDisposition, ...]
    gate_decision_ids: tuple[str, ...]


def decide_promotion(snapshot: PromotionSnapshot) -> PromotionDecision:
    conditions = [_check_package, _check_hard_blocker, _check_provenance, _check_conformance, _check_review]
    decided = [check(snapshot) for check in conditions]
    failed = [item.condition_id for item in decided if not item.passed]
    current = [
        item
        for item in snapshot.dispositions
        if _disposition_current(item, snapshot)
    ]
    return PromotionDecision(
        schema_version="helix.section-promotion-decision/v1",
        eligible=not failed,
        candidate_id=snapshot.candidate_id,
        candidate_hash=snapshot.candidate_hash,
        run_id=snapshot.run_id,
        conditions=decided,
        failed_condition_ids=failed,
        warnings=list(snapshot.warnings),
        current_disposition_ids=[item.disposition_id for item in current],
        gate_decision_ids=list(snapshot.gate_decision_ids),
    )


def snapshot_from_evaluation(
    *,
    evaluation: CandidateEvaluation,
    candidate_content_hash: str,
    section_id: str,
    package_maturity: str,
    promotion_allowed: bool,
    dependency_fingerprint: str,
    dispositions: Sequence[ReviewDisposition],
    extra_hard_blocker_ids: Sequence[str] = (),
) -> PromotionSnapshot:
    hard_blockers: list[str] = [
        *extra_hard_blocker_ids,
        *evaluation.next_attempt_decision.blocking_receipt_ids,
    ]
    if evaluation.provenance_receipt.status == "blocked":
        hard_blockers.append(evaluation.provenance_receipt.receipt_id)
        hard_blockers.extend(item.code for item in evaluation.provenance_receipt.blockers)
    if evaluation.template_conformance_receipt.status == "blocked":
        hard_blockers.append(evaluation.template_conformance_receipt.receipt_id)
        hard_blockers.extend(
            item.rule_id
            for item in evaluation.template_conformance_receipt.results
            if item.status == "blocked"
        )
    review_required: tuple[ReviewRequiredFact, ...] = ()
    if evaluation.study_output_evaluation_receipt.status == "failed":
        review_required = (
            ReviewRequiredFact(result_id=evaluation.study_output_evaluation_receipt.receipt_id),
        )
    bound = tuple(
        BoundDisposition(
            disposition_id=item.disposition_id,
            result_id=item.result_id,
            decision=item.decision.value,
            artifact_hash=item.artifact_hash or "",
            dependency_fingerprint=item.dependency_fingerprint or "",
        )
        for item in dispositions
        if item.artifact_hash and item.dependency_fingerprint
    )
    return PromotionSnapshot(
        candidate_id=evaluation.candidate_id,
        candidate_hash=evaluation.candidate_hash,
        content_hash=candidate_content_hash,
        run_id=evaluation.run_id,
        section_id=section_id,
        package_maturity=package_maturity,
        promotion_allowed=promotion_allowed,
        provenance_passed=evaluation.provenance_receipt.status == "passed",
        conformance_passed=evaluation.template_conformance_receipt.status == "passed",
        hard_blocker_ids=tuple(dict.fromkeys(hard_blockers)),
        review_required=review_required,
        warnings=(),
        dependency_fingerprint=dependency_fingerprint,
        dispositions=bound,
        gate_decision_ids=(
            evaluation.provenance_receipt.receipt_id,
            evaluation.template_conformance_receipt.receipt_id,
        ),
    )


def build_section_draft(
    snapshot: PromotionSnapshot,
    decision: PromotionDecision,
    promoted_at: str,
) -> SectionDraft:
    if not decision.eligible:
        raise PromotionRejectedError(decision)
    current = [item for item in snapshot.dispositions if _disposition_current(item, snapshot)]
    gate_ids = list(dict.fromkeys(snapshot.gate_decision_ids))
    payload = {
        "schema_version": "helix.section-draft/v1",
        "status": "section_draft",
        "draft_id": f"SD-{uuid4().hex[:12].upper()}",
        "run_id": snapshot.run_id,
        "section_id": snapshot.section_id,
        "candidate_id": snapshot.candidate_id,
        "candidate_hash": snapshot.candidate_hash,
        "content_hash": snapshot.content_hash,
        "promoted_at": promoted_at,
        "gate_decision_ids": gate_ids,
        "bound_dispositions": [item.model_dump(mode="json") for item in current],
    }
    return SectionDraft.model_validate(payload)


def dependency_fingerprint_for(
    package: StudyEvidencePackage,
    depends_on: Sequence[str],
) -> str:
    hashes: dict[str, str] = {}
    for execution in package.data_validation_executions:
        if execution.receipt.package_id in depends_on:
            hashes[execution.receipt.package_id] = execution.receipt.input_fingerprint
    return canonical_hash(hashes)


def _check_package(snapshot: PromotionSnapshot) -> ConditionDecision:
    if snapshot.package_maturity == "vertical_slice":
        return ConditionDecision(
            condition_id="package_permission",
            passed=False,
            reason="vertical_slice packages cannot be promoted",
            evidence_ids=[],
        )
    if not snapshot.promotion_allowed:
        return ConditionDecision(
            condition_id="package_permission",
            passed=False,
            reason="The Section Package does not allow promotion",
            evidence_ids=[],
        )
    return ConditionDecision(condition_id="package_permission", passed=True, reason=None, evidence_ids=[])


def _check_hard_blocker(snapshot: PromotionSnapshot) -> ConditionDecision:
    if snapshot.hard_blocker_ids:
        return ConditionDecision(
            condition_id="no_hard_blocker",
            passed=False,
            reason="A hard_blocker is present",
            evidence_ids=list(snapshot.hard_blocker_ids),
        )
    return ConditionDecision(condition_id="no_hard_blocker", passed=True, reason=None, evidence_ids=[])


def _check_provenance(snapshot: PromotionSnapshot) -> ConditionDecision:
    if not snapshot.provenance_passed:
        return ConditionDecision(
            condition_id="provenance_passed",
            passed=False,
            reason="Provenance compilation did not pass",
            evidence_ids=[],
        )
    return ConditionDecision(condition_id="provenance_passed", passed=True, reason=None, evidence_ids=[])


def _check_conformance(snapshot: PromotionSnapshot) -> ConditionDecision:
    if not snapshot.conformance_passed:
        return ConditionDecision(
            condition_id="conformance_passed",
            passed=False,
            reason="Template Conformance did not pass",
            evidence_ids=[],
        )
    return ConditionDecision(condition_id="conformance_passed", passed=True, reason=None, evidence_ids=[])


def _check_review(snapshot: PromotionSnapshot) -> ConditionDecision:
    missing: list[str] = []
    current_ids: list[str] = []
    for fact in snapshot.review_required:
        match = next(
            (
                item
                for item in reversed(snapshot.dispositions)
                if item.result_id == fact.result_id and _disposition_current(item, snapshot)
            ),
            None,
        )
        if match is None:
            missing.append(fact.result_id)
        else:
            current_ids.append(match.disposition_id)
    if missing:
        return ConditionDecision(
            condition_id="review_required_current",
            passed=False,
            reason="A review_required result lacks a current artifact-bound disposition",
            evidence_ids=missing,
        )
    return ConditionDecision(
        condition_id="review_required_current",
        passed=True,
        reason=None,
        evidence_ids=current_ids,
    )


def _disposition_current(item: BoundDisposition, snapshot: PromotionSnapshot) -> bool:
    return (
        item.decision in RESOLVED_DECISIONS
        and item.artifact_hash == snapshot.candidate_hash
        and item.dependency_fingerprint == snapshot.dependency_fingerprint
    )


class SectionPromotionService:
    def __init__(self, session: Session, repository_root: Path):
        self.session = session
        self.repository_root = repository_root
        self.contracts = repository_root / "skills" / "helix-evidence-pipeline" / "contracts"
        self.repository = StudyPackageRepository(session)

    def promote(self, study_id: str, run_id: str, command: PromotionCommand) -> SectionDraft:
        request_hash = canonical_hash({"study_id": study_id, "run_id": run_id})
        prior_draft = self.repository.get_section_draft(study_id, command.idempotency_key)
        if prior_draft is not None:
            if prior_draft.request_hash != request_hash:
                raise PromotionConflictError("The idempotency key was already used for another promotion")
            return SectionDraft.model_validate(prior_draft.draft)
        decision_key = f"decision:{command.idempotency_key}"
        prior_decision = self.repository.get_promotion_decision(study_id, decision_key)
        if prior_decision is not None:
            if prior_decision.request_hash != request_hash:
                raise PromotionConflictError("The idempotency key was already used for another promotion")
            stored = PromotionDecision.model_validate(prior_decision.decision)
            if not stored.eligible:
                raise PromotionRejectedError(stored)
            raise PromotionConflictError("A Section Draft is already recorded for this candidate")
        evaluations = self.repository.list_candidate_evaluations(study_id)
        evaluation = next((item for item in reversed(evaluations) if item.run_id == run_id), None)
        if evaluation is None:
            raise UnknownPromotionTargetError(f"Unknown evaluation for section run {run_id}")
        run_row = self.repository.get_section_run_by_id(study_id, run_id)
        if run_row is None or run_row.candidate is None or run_row.receipt is None:
            raise UnknownPromotionTargetError(f"Unknown section run {run_id}")
        run = StoredSectionRun.model_validate(
            {
                "receipt": run_row.receipt,
                "candidate": run_row.candidate,
                "envelope": run_row.envelope,
                "review_scaffold": run_row.review_scaffold,
            }
        )
        package = self.repository.get(study_id, for_update=True)
        prior_draft = self.repository.get_section_draft(study_id, command.idempotency_key)
        if prior_draft is not None:
            if prior_draft.request_hash != request_hash:
                raise PromotionConflictError("The idempotency key was already used for another promotion")
            return SectionDraft.model_validate(prior_draft.draft)
        definition = section_package_definition(self.repository_root, evaluation.section_package_id)
        snapshot = snapshot_from_evaluation(
            evaluation=evaluation,
            candidate_content_hash=canonical_hash(run.candidate.content_blocks),
            section_id=run.candidate.section_id,
            package_maturity=str(definition.get("maturity", "")),
            promotion_allowed=definition.get("promotion_allowed") is True,
            dependency_fingerprint=dependency_fingerprint_for(
                package, [str(item) for item in definition.get("depends_on", [])]
            ),
            dispositions=package.review_dispositions,
        )
        decision = decide_promotion(snapshot)
        self.repository.add_promotion_decision(
            study_id=study_id,
            run_id=run_id,
            candidate_id=evaluation.candidate_id,
            idempotency_key=decision_key,
            request_hash=request_hash,
            decision=decision,
        )
        if not decision.eligible:
            self.session.commit()
            raise PromotionRejectedError(decision)
        now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        draft = build_section_draft(snapshot, decision, now)
        self._validate_draft(draft)
        try:
            self.repository.add_section_draft(
                study_id=study_id,
                run_id=run_id,
                candidate_id=draft.candidate_id,
                idempotency_key=command.idempotency_key,
                request_hash=request_hash,
                draft=draft,
            )
        except IntegrityError as error:
            self.session.rollback()
            prior = self.repository.get_section_draft(study_id, command.idempotency_key)
            if prior is not None:
                return SectionDraft.model_validate(prior.draft)
            raise PromotionConflictError("A Section Draft is already recorded for this candidate") from error
        self.session.commit()
        return draft

    def record_decision_for_evaluation(
        self,
        study_id: str,
        evaluation: CandidateEvaluation,
        run: StoredSectionRun,
        package: StudyEvidencePackage,
        idempotency_key: str | None = None,
    ) -> PromotionDecision:
        definition = section_package_definition(self.repository_root, evaluation.section_package_id)
        snapshot = snapshot_from_evaluation(
            evaluation=evaluation,
            candidate_content_hash=canonical_hash(run.candidate.content_blocks),
            section_id=run.candidate.section_id,
            package_maturity=str(definition.get("maturity", "")),
            promotion_allowed=definition.get("promotion_allowed") is True,
            dependency_fingerprint=dependency_fingerprint_for(
                package, [str(item) for item in definition.get("depends_on", [])]
            ),
            dispositions=package.review_dispositions,
        )
        decision = decide_promotion(snapshot)
        self.repository.add_promotion_decision(
            study_id=study_id,
            run_id=evaluation.run_id,
            candidate_id=evaluation.candidate_id,
            idempotency_key=idempotency_key or f"evaluation-decision:{evaluation.evaluation_id}",
            request_hash=canonical_hash(
                {
                    "evaluation_id": evaluation.evaluation_id,
                    "idempotency_key": idempotency_key or "evaluation",
                }
            ),
            decision=decision,
        )
        return decision

    def _validate_draft(self, draft: SectionDraft) -> None:
        schema = json.loads((self.contracts / "section-draft.schema.json").read_text())
        payload = draft.model_dump(mode="json")
        errors = list(draft202012_validator(schema, self.contracts).iter_errors(payload))
        if errors:
            raise PromotionConflictError(errors[0].message)


def section_package_definition(repository_root: Path, section_package_id: str) -> dict[str, object]:
    token = section_package_id.removeprefix("section.")
    path = (
        repository_root
        / "skills"
        / "helix-evidence-pipeline"
        / "packages"
        / "sections"
        / token
        / "package.json"
    )
    return json.loads(path.read_text())
