import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .contract_schema import draft202012_validator
from .cross_section_queries import execute_cross_section_query
from .drafting_cycles import CAP_BLOCKER_ID, MAX_ATTEMPTS
from .provenance_compiler import allowed_claims_for, compile_provenance
from .repository import StudyPackageRepository
from .run_plans import canonical_hash
from .schemas import (
    CandidateEvaluation,
    CandidateEvaluationCommand,
    CandidateEvaluationHashes,
    CrossSectionQueryCommand,
    CrossSectionQueryReceipt,
    NextAttemptDecision,
    ProvenanceReceipt,
    SectionDraftCandidate,
    StoredSectionRun,
    StudyEvidencePackage,
    StudyOutputEvaluationReceipt,
    TemplateConformanceReceipt,
    WorkflowEvent,
)
from .section_promotion import SectionPromotionService
from .section_runs import SectionRunService
from .study_output_evaluation import evaluate_study_output
from .template_conformance import evaluate_template_conformance


class CandidateEvaluationConflictError(RuntimeError):
    pass


class UnknownSectionRunError(ValueError):
    pass


class CandidateEvaluationService:
    def __init__(self, session: Session, repository_root: Path):
        self.session = session
        self.repository_root = repository_root
        self.repository = StudyPackageRepository(session)
        self.contracts = repository_root / "skills" / "helix-evidence-pipeline" / "contracts"

    def evaluate(
        self, study_id: str, run_id: str, command: CandidateEvaluationCommand
    ) -> CandidateEvaluation:
        request_hash = canonical_hash({"study_id": study_id, "run_id": run_id})
        prior = self._replay_evaluation(study_id, command.idempotency_key, request_hash)
        if prior is not None:
            return prior.model_copy(update={"idempotent_replay": True})
        run = self._run(study_id, run_id)
        package = self.repository.get(study_id, for_update=True)
        prior = self._replay_evaluation(study_id, command.idempotency_key, request_hash)
        if prior is not None:
            return prior.model_copy(update={"idempotent_replay": True})
        original_hash = canonical_hash(run.candidate.model_dump(mode="json"))
        evaluation = self._compile(package, run)
        stored = self.repository.get_section_run_by_id(study_id, run_id)
        if stored is None or stored.candidate is None:
            raise UnknownSectionRunError(f"Unknown section run {run_id}")
        if canonical_hash(stored.candidate) != original_hash:
            raise CandidateEvaluationConflictError("Evaluation must not rewrite the stored candidate")
        now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        event_id = f"EV-{uuid4().hex[:12].upper()}"
        extra_blockers = (
            (CAP_BLOCKER_ID,)
            if evaluation.next_attempt_decision.action == "stop_for_review"
            else ()
        )
        if extra_blockers:
            package = SectionRunService(self.session, None, self.repository_root).persist_contract_revision(
                package,
                run_id=run_id,
                event_id=event_id,
                candidate_id=evaluation.candidate_id,
                extra_blockers=extra_blockers,
            )
        event = WorkflowEvent(
            event_id=event_id,
            event="candidate_evaluated",
            actor="HELIX candidate evaluation",
            timestamp=now,
            outcome=evaluation.next_attempt_decision.action,
            details={
                "run_id": run_id,
                "evaluation_id": evaluation.evaluation_id,
                "candidate_id": evaluation.candidate_id,
                "candidate_hash": evaluation.candidate_hash,
            },
        )
        updated = package.model_copy(update={"events": [*package.events, event]})
        self.repository.save(updated)
        try:
            self.repository.add_candidate_evaluation(
                study_id=study_id,
                run_id=run_id,
                candidate_id=evaluation.candidate_id,
                idempotency_key=command.idempotency_key,
                request_hash=request_hash,
                evaluation=evaluation,
            )
        except IntegrityError as error:
            self.session.rollback()
            prior = self._replay_evaluation(study_id, command.idempotency_key, request_hash)
            if prior is not None:
                return prior.model_copy(update={"idempotent_replay": True})
            raise CandidateEvaluationConflictError(
                "A Candidate Attempt evaluation is already recorded"
            ) from error
        SectionPromotionService(self.session, self.repository_root).record_decision_for_evaluation(
            study_id,
            evaluation,
            run,
            updated,
        )
        self.repository.append_event(
            study_id=study_id,
            event_type=event.event,
            actor=event.actor,
            payload={"outcome": event.outcome, **event.details},
            idempotency_key=f"candidate-evaluation:{command.idempotency_key}",
        )
        self.session.commit()
        return evaluation

    def query(
        self, study_id: str, run_id: str, command: CrossSectionQueryCommand
    ) -> CrossSectionQueryReceipt:
        request_hash = canonical_hash(
            {"study_id": study_id, "run_id": run_id, "artifact_ids": command.artifact_ids}
        )
        prior = self._replay_query(study_id, command.idempotency_key, request_hash)
        if prior is not None:
            return prior
        run = self._run(study_id, run_id)
        package = self.repository.get(study_id, for_update=True)
        prior = self._replay_query(study_id, command.idempotency_key, request_hash)
        if prior is not None:
            return prior
        drafts = self._declared_drafts(package, run)
        receipt = execute_cross_section_query(
            run=run,
            artifact_ids=command.artifact_ids,
            claims=package.claims,
            drafts=drafts,
        )
        self.repository.add_cross_section_query(
            study_id=study_id,
            run_id=run_id,
            idempotency_key=command.idempotency_key,
            request_hash=request_hash,
            receipt=receipt,
        )
        self.session.commit()
        return receipt

    def _compile(self, package: StudyEvidencePackage, run: StoredSectionRun) -> CandidateEvaluation:
        candidate = run.candidate
        candidate_hash = canonical_hash(candidate.model_dump(mode="json"))
        if candidate_hash != run.receipt.candidate_hash:
            raise CandidateEvaluationConflictError("The stored candidate hash does not match the receipt")
        allowed_ids = set(candidate.validated_claim_ids)
        claims = allowed_claims_for(package.claims, package.provenance_edges, allowed_ids)
        provenance = compile_provenance(candidate, claims, candidate_hash=candidate_hash)
        package_definition = self._package_definition(run.receipt.section_package_id)
        suite = package_definition.get("study_output_eval_suite")
        if not isinstance(suite, dict):
            raise CandidateEvaluationConflictError("The Section Package is missing a study-output suite")
        study_output = evaluate_study_output(
            candidate,
            candidate_hash=candidate_hash,
            suite_id=str(suite["id"]),
            suite_version=str(suite["version"]),
            suite_path=self.repository_root / str(suite["path"]),
        )
        template = json.loads(
            (self.repository_root / "backend" / "app" / "data" / "report-template.json").read_text()
        )
        conformance = evaluate_template_conformance(
            candidate,
            package_definition,
            template,
            candidate_hash=candidate_hash,
        )
        self._validate_receipt(provenance, "provenance-receipt.schema.json")
        self._validate_receipt(study_output, "study-output-evaluation-receipt.schema.json")
        self._validate_receipt(conformance, "template-conformance-receipt.schema.json")
        decision = next_attempt_decision(candidate, provenance, study_output, conformance)
        evaluation = CandidateEvaluation(
            schema_version="helix.candidate-evaluation/v1",
            evaluation_id=f"CEV-{uuid4().hex[:12].upper()}",
            run_id=run.receipt.run_id,
            candidate_id=candidate.candidate_id,
            candidate_hash=candidate_hash,
            section_package_id=run.receipt.section_package_id,
            provenance_receipt=provenance,
            study_output_evaluation_receipt=study_output,
            template_conformance_receipt=conformance,
            next_attempt_decision=decision,
            hashes=CandidateEvaluationHashes(
                candidate=candidate_hash,
                provenance=canonical_hash(provenance.model_dump(mode="json")),
                study_output_evaluation=canonical_hash(study_output.model_dump(mode="json")),
                template_conformance=canonical_hash(conformance.model_dump(mode="json")),
                evaluation="sha256:" + "0" * 64,
            ),
        )
        payload = evaluation.model_dump(mode="json")
        payload["hashes"]["evaluation"] = canonical_hash(
            {key: value for key, value in payload.items() if key != "hashes"}
        )
        complete = CandidateEvaluation.model_validate(payload)
        self._validate_receipt(complete, "candidate-evaluation.schema.json")
        return complete

    def _run(self, study_id: str, run_id: str) -> StoredSectionRun:
        row = self.repository.get_section_run_by_id(study_id, run_id)
        if row is None or row.candidate is None or row.receipt is None:
            raise UnknownSectionRunError(f"Unknown section run {run_id}")
        return StoredSectionRun.model_validate(
            {
                "receipt": row.receipt,
                "candidate": row.candidate,
                "envelope": row.envelope,
                "review_scaffold": row.review_scaffold,
            }
        )

    def _replay_evaluation(
        self, study_id: str, idempotency_key: str, request_hash: str
    ) -> CandidateEvaluation | None:
        prior = self.repository.get_candidate_evaluation(study_id, idempotency_key)
        if prior is None:
            return None
        if prior.request_hash != request_hash:
            raise CandidateEvaluationConflictError(
                "The idempotency key was already used for another evaluation"
            )
        return CandidateEvaluation.model_validate(prior.evaluation)

    def _replay_query(
        self, study_id: str, idempotency_key: str, request_hash: str
    ) -> CrossSectionQueryReceipt | None:
        prior = self.repository.get_cross_section_query(study_id, idempotency_key)
        if prior is None:
            return None
        if prior.request_hash != request_hash:
            raise CandidateEvaluationConflictError(
                "The idempotency key was already used for another cross-section query"
            )
        return CrossSectionQueryReceipt.model_validate(prior.receipt)

    def _declared_drafts(
        self, package: StudyEvidencePackage, run: StoredSectionRun
    ) -> dict[str, tuple[SectionDraftCandidate, str]]:
        envelope = run.envelope
        section_package = envelope.get("section_package")
        package_id = (
            str(section_package.get("package_id"))
            if isinstance(section_package, dict)
            else run.receipt.section_package_id
        )
        definition = self._package_definition(package_id)
        declared = {str(item) for item in definition.get("depends_on", [])}
        drafts: dict[str, tuple[SectionDraftCandidate, str]] = {}
        for stored in self.repository.list_section_runs(package.study.study_id):
            if stored.receipt.section_package_id not in declared:
                continue
            drafts[stored.receipt.section_package_id] = (
                stored.candidate,
                stored.receipt.candidate_hash,
            )
        return drafts

    def _package_definition(self, section_package_id: str) -> dict[str, object]:
        token = section_package_id.removeprefix("section.")
        path = (
            self.repository_root
            / "skills"
            / "helix-evidence-pipeline"
            / "packages"
            / "sections"
            / token
            / "package.json"
        )
        return json.loads(path.read_text())

    def _validate_receipt(self, receipt, filename: str) -> None:
        schema = json.loads((self.contracts / filename).read_text())
        payload = receipt.model_dump(mode="json")
        errors = list(draft202012_validator(schema, self.contracts).iter_errors(payload))
        if errors:
            raise CandidateEvaluationConflictError(errors[0].message)


def next_attempt_decision(
    candidate: SectionDraftCandidate,
    provenance: ProvenanceReceipt,
    study_output: StudyOutputEvaluationReceipt,
    conformance: TemplateConformanceReceipt,
) -> NextAttemptDecision:
    blockers: list[str] = []
    reasons: list[str] = []
    if provenance.status == "blocked":
        blockers.append(provenance.receipt_id)
        reasons.append("Provenance compilation failed")
    if conformance.status == "blocked":
        blockers.append(conformance.receipt_id)
        reasons.append("Template Conformance failed")
    if study_output.status == "failed":
        reasons.append("Study Output Evaluation created review_required")
    if blockers:
        action = "retry" if candidate.attempt < MAX_ATTEMPTS else "stop_for_review"
        return NextAttemptDecision(
            action=action,
            attempt=candidate.attempt,
            max_attempts=MAX_ATTEMPTS,
            reasons=reasons,
            blocking_receipt_ids=blockers,
        )
    return NextAttemptDecision(
        action="hold",
        attempt=candidate.attempt,
        max_attempts=MAX_ATTEMPTS,
        reasons=reasons or ["Deterministic gates passed; promotion is out of scope"],
        blocking_receipt_ids=[],
    )
