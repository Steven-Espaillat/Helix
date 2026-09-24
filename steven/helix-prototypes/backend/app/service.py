import hashlib
import logging
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any, cast
from uuid import uuid4

from sqlalchemy import event
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .approved_exports import (
    ApprovedExportError,
    ExportProbe,
    exported_artifacts_from,
    install_export_probe,
    materialize_approved_artifacts,
    pending_approved_export_artifacts,
    reset_export_probe,
)
from .artifacts import GeneratedArtifact
from .config import Settings
from .data_validation import (
    DataValidationConflictError,
    DataValidationService,
    UnknownValidationPackageError,
    as_validation_results,
    policy_for,
)
from .drafting_cycles import current_cycle, cycle_exhausted, load_recorded_attempts
from .journey import JourneyFacts, project_journey
from .release_candidates import (
    MissingReleaseCandidateError,
    approval_is_current,
    approval_request_hash,
    compile_release_candidate,
    hashes_for,
    recorded_request_hash,
    validate_final_study_approval,
)
from .reporting import assemble_report, claim_report_text
from .repository import StudyNotFoundError, StudyPackageRepository
from .review_scaffolds import ExportAdmissionError, admit_export_document
from .run_events import RUN_EVENT_ADAPTER, RunEventStore
from .run_plans import PinnedRunService, RunConflictError
from .schemas import (
    RESOLVED_DISPOSITIONS,
    Approval,
    ApprovalCommand,
    ApprovalRole,
    Claim,
    ClaimStatus,
    DataValidationCommand,
    DataValidationExecution,
    DispositionCommand,
    DispositionDecision,
    EvidenceChain,
    ExportArtifact,
    ExportCommand,
    ExportInstrumentation,
    ExportReceipt,
    FinalStudyApproval,
    FinalStudyApprovalCommand,
    FreezeRunCommand,
    GateDecision,
    GateStatus,
    PinnedRun,
    PlannerCapability,
    PlannerMode,
    ProvenanceEdge,
    ReleaseCandidate,
    ReviewDisposition,
    SectionStatus,
    SourceRecord,
    Stage,
    StoredSectionRun,
    StudyEvidencePackage,
    StudyListItem,
    ValidationRequest,
    ValidationResult,
    ValidationRun,
    ValidationStatus,
    WorkbenchJourney,
    WorkflowEvent,
    WorkspaceResponse,
    WorkspaceSummary,
)
from .section_promotion import (
    SectionPromotionService,
    dependency_fingerprint_for,
    section_package_definition,
)
from .section_runs import (
    SECTION_PACKAGE_ID,
    SectionRunService,
    governed_versions_fingerprint,
    manifest_fingerprint,
)
from .superseding_runs import assert_bound_pinned_run, with_fresh_authority
from .template_contracts import BODY_WEIGHT_PACKAGE_ID
from .validation import (
    FixturePlanner,
    OpenAICompatiblePlanner,
    all_results,
    blocking_failures,
)

REQUIRED_APPROVALS = {
    ApprovalRole.PATHOLOGIST,
    ApprovalRole.PEER_REVIEWER,
    ApprovalRole.QAU,
    ApprovalRole.STUDY_DIRECTOR,
}
ALLOWED_DISPOSITIONS = {
    "VR-004": {DispositionDecision.CORRECTED},
    "VR-005": {DispositionDecision.CORRECTED},
    "VR-006": {DispositionDecision.APPROVED_EXCEPTION},
}


_UNSET = object()
LOGGER = logging.getLogger(__name__)


class WorkflowConflictError(RuntimeError):
    pass


class InvalidCommandError(ValueError):
    pass


class StudyService:
    def __init__(
        self,
        session: Session,
        settings: Settings,
        section_runs: SectionRunService,
        pinned_runs: PinnedRunService,
    ):
        self.session = session
        self.settings = settings
        self.repository = StudyPackageRepository(session)
        self.section_runs = section_runs
        self.pinned_runs = pinned_runs
        self.data_validation = DataValidationService(session, pinned_runs, settings.codex_repository_root)
        self.run_events = RunEventStore(session, retention=settings.run_event_retention)

    def workspace(self, study_id: str) -> WorkspaceResponse:
        package = self.repository.get(study_id)
        return self._workspace(package)

    def list_studies(self) -> list[StudyListItem]:
        return [
            StudyListItem(
                study_id=package.study.study_id,
                study_type_id=package.study.study_type_id,
                title=f"{package.study.duration_days}-day {package.study.route} toxicity study",
                workflow_state=package.workflow_state,
                release_status=self._release_gate(package).status,
                label=package.label,
            )
            for package in self.repository.list_packages()
        ]

    # --- Journey-projected commands (Steven-Espaillat/Helix#25) ---
    # Each public command runs its original implementation, then appends run events derived
    # from the persisted state. Failed run-scoped commands record a persisted command_failed.

    def freeze_run(self, study_id: str, command: FreezeRunCommand) -> PinnedRun:
        return self._journey_command(
            study_id, "freeze_run", "upload", lambda: self._freeze_run_command(study_id, command)
        )

    def run_data_validation(self, study_id: str, command: DataValidationCommand) -> DataValidationExecution:
        return self._journey_command(
            study_id,
            "run_data_validation",
            "extract",
            lambda: self._run_data_validation_command(study_id, command),
        )

    def run_validation(self, study_id: str, request: ValidationRequest) -> ValidationRun:
        return self._journey_command(
            study_id, "run_validation", "validate", lambda: self._run_validation_command(study_id, request)
        )

    def disposition(self, study_id: str, result_id: str, command: DispositionCommand) -> WorkspaceResponse:
        return self._journey_command(
            study_id,
            "record_disposition",
            "traceability",
            lambda: self._disposition_command(study_id, result_id, command),
        )

    def approve(self, study_id: str, command: ApprovalCommand) -> WorkspaceResponse:
        return self._journey_command(
            study_id, "record_approval", "review-export", lambda: self._approve_command(study_id, command)
        )

    def record_final_study_approval(
        self,
        study_id: str,
        command: FinalStudyApprovalCommand,
    ) -> WorkspaceResponse:
        return self._journey_command(
            study_id,
            "record_final_study_approval",
            "review-export",
            lambda: self._record_final_study_approval_command(study_id, command),
        )

    def export(self, study_id: str, command: ExportCommand) -> ExportReceipt:
        return self._journey_command(
            study_id, "export", "review-export", lambda: self._export_command(study_id, command)
        )

    def _journey_command[ResultT](
        self,
        study_id: str,
        command_name: str,
        stage_id: str,
        operation: Callable[[], ResultT],
    ) -> ResultT:
        """Run a command so every commit it makes also appends its run events atomically.

        A ``before_commit`` hook syncs run events inside each transaction the command
        commits, so events and the state change they describe commit (or roll back)
        together. Failed run-scoped commands record ``command_failed`` afterwards.
        """

        def sync_before_commit(_session: Session) -> None:
            self._sync_run_events_in_transaction(study_id)

        event.listen(self.session, "before_commit", sync_before_commit)
        try:
            return operation()
        except (
            WorkflowConflictError,
            InvalidCommandError,
            DataValidationConflictError,
            UnknownValidationPackageError,
            RunConflictError,
        ) as error:
            event.remove(self.session, "before_commit", sync_before_commit)
            self.session.rollback()
            try:
                self._record_command_failure(study_id, command_name, stage_id, str(error))
            except SQLAlchemyError:
                self.session.rollback()
                LOGGER.exception("Could not record command_failed for %s on %s", command_name, study_id)
            raise
        finally:
            if event.contains(self.session, "before_commit", sync_before_commit):
                event.remove(self.session, "before_commit", sync_before_commit)

    def _sync_run_events_in_transaction(self, study_id: str) -> None:
        """Append run events for persisted transitions, inside the caller's open transaction.

        The run-state row lock is taken before the package facts are read, so a concurrent
        sync can never diff stale facts against newer recorded state. The caller commits.
        """
        self.session.flush()
        current = self.repository.get(study_id).pinned_run
        if current is None:
            return
        self.run_events.lock_state(current.run_id, study_id)
        package = self.repository.get(study_id)
        if package.pinned_run is None or package.pinned_run.run_id != current.run_id:
            return
        self.run_events.sync(project_journey(self._journey_facts(package)))

    def _record_command_failure(self, study_id: str, command_name: str, stage_id: str, detail: str) -> None:
        try:
            package = self.repository.get(study_id)
        except StudyNotFoundError:
            return
        if package.pinned_run is None:
            return
        self.run_events.record_failure(
            run_id=package.pinned_run.run_id,
            study_id=study_id,
            label=package.label,
            stage_id=stage_id,
            command=command_name,
            detail=detail,
        )
        self.session.commit()

    def replay_run_events(self, study_id: str, run_id: str, cursor: str | None) -> list[dict[str, Any]]:
        package = self.repository.get(study_id)
        known = {item.run_id for item in package.superseded_pinned_runs}
        if package.pinned_run is not None:
            known.add(package.pinned_run.run_id)
        if run_id not in known:
            raise InvalidCommandError(f"Unknown Pinned Run {run_id}")
        return self.run_events.replay(run_id, cursor)

    def run_event_context(self, study_id: str, run_id: str) -> tuple[str, str]:
        """Return (label, run_version) for typed stream errors."""
        package = self.repository.get(study_id)
        runs = [*package.superseded_pinned_runs]
        if package.pinned_run is not None:
            runs.append(package.pinned_run)
        run = next((item for item in runs if item.run_id == run_id), None)
        return package.label, run.run_plan.fingerprint if run is not None else ""

    def _journey(
        self,
        package: StudyEvidencePackage,
        gate: GateDecision | None = None,
        live: ReleaseCandidate | None | object = _UNSET,
    ) -> WorkbenchJourney:
        return project_journey(self._journey_facts(package, gate, live))

    def _with_event_state(self, facts: JourneyFacts, run_id: str) -> JourneyFacts:
        latest = self.run_events.latest(run_id)
        return replace(
            facts,
            paused=self.run_events.is_paused(run_id),
            marks=self.run_events.marks(run_id),
            latest_event=RUN_EVENT_ADAPTER.validate_python(latest) if latest is not None else None,
            latest_sequence=int(latest["sequence"]) if latest is not None else 0,
        )

    def _journey_facts(
        self,
        package: StudyEvidencePackage,
        gate: GateDecision | None = None,
        live: ReleaseCandidate | None | object = _UNSET,
    ) -> JourneyFacts:
        if live is _UNSET:
            live = self._live_release_candidate(package)
        live_candidate = cast(ReleaseCandidate | None, live)
        gate = gate or self._release_gate(package, live=live_candidate)
        run = package.pinned_run
        validation_ran = False
        if run is not None:
            created = _parse_timestamp(run.created_at)
            validation_ran = any(
                event.event == "validation_run" and _parse_timestamp(event.timestamp) >= created
                for event in package.events
            )
        exported = (
            package.workflow_state == "exported"
            and bool(package.export_artifacts)
            and all(artifact.status == "exported" for artifact in package.export_artifacts)
        )
        facts = JourneyFacts(
            label=package.label,
            study_id=package.study.study_id,
            manifest=package.manifest,
            record_count=sum(len(records) for records in package.records.model_dump().values()),
            pinned_run=run,
            dvp_executions=package.data_validation_executions,
            validation_ran=validation_ran,
            validation_results=package.validation_results,
            report_sections=package.report_sections,
            provenance_edge_count=len(package.provenance_edges),
            gate=gate,
            dispositions=package.review_dispositions,
            approvals=package.approvals,
            final_study_approval_current=approval_is_current(package.final_study_approval, live_candidate),
            exported=exported,
            export_artifact_count=len(package.export_artifacts) if exported else 0,
        )
        return self._with_event_state(facts, run.run_id) if run is not None else facts

    def _freeze_run_command(self, study_id: str, command: FreezeRunCommand) -> PinnedRun:
        pinned_run = self.pinned_runs.freeze(study_id, command, commit=False)
        execution = None
        if pinned_run.status == "planned":
            execution = self.data_validation.execute(
                study_id,
                DataValidationCommand(
                    actor=command.actor,
                    package_id="validation.body_weight",
                    idempotency_key=f"dvp-{pinned_run.run_id}-validation.body_weight",
                ),
                commit=False,
            )
        package = self.repository.get(study_id, for_update=True)
        assert_bound_pinned_run(package, pinned_run)
        if package.superseding_run_receipt is not None:
            event_id = (
                pinned_run.event_history[0].event_id
                if pinned_run.event_history
                else f"EV-{uuid4().hex[:12].upper()}"
            )
            package = self.section_runs.persist_contract_revision(package, event_id=event_id)
            assert_bound_pinned_run(package, pinned_run)
            gate = self._release_gate(package)
            package = with_fresh_authority(
                package,
                pinned_run=pinned_run,
                validation_receipt_ids=[execution.receipt.receipt_id] if execution is not None else [],
                gate_ids=[gate.gate_id],
                scaffold_revision=(
                    int(package.review_scaffold_revisions[-1]["sequence"])
                    if package.review_scaffold_revisions
                    else 0
                ),
            )
            self.repository.save(package)
            assert_bound_pinned_run(package, pinned_run)
        self.session.commit()
        return pinned_run

    def _run_data_validation_command(
        self, study_id: str, command: DataValidationCommand
    ) -> DataValidationExecution:
        return self.data_validation.execute(study_id, command)

    def _run_validation_command(self, study_id: str, request: ValidationRequest) -> ValidationRun:
        package = self.repository.get(study_id)
        if package.pinned_run is None:
            pinned_run = self.pinned_runs.freeze(
                study_id,
                FreezeRunCommand(
                    actor="HELIX validation service",
                    idempotency_key=f"validation-freeze-{study_id}",
                ),
            )
        else:
            pinned_run = package.pinned_run
        if pinned_run.status != "planned":
            raise WorkflowConflictError("The Pinned Run requires study-type review")
        execution = self.data_validation.execute(
            study_id,
            DataValidationCommand(
                actor="HELIX validation service",
                package_id="validation.body_weight",
                idempotency_key=f"dvp-{pinned_run.run_id}-validation.body_weight",
            ),
        )
        package = self.repository.get(study_id, for_update=True)
        self._ensure_mutable(package)
        planner = self._planner(request.planner)
        results = all_results(package, planner)
        now = datetime.now(UTC)
        run = ValidationRun(
            run_id=f"RUN-{uuid4().hex[:12].upper()}",
            study_id=study_id,
            planner=request.planner,
            llm_used=planner.llm_used,
            planner_label=planner.label,
            rule_bundle_version="helix-rules-1.0.0",
            results=results,
            created_at=now,
        )
        existing_disposition_ids = {item.result_id for item in package.review_dispositions}
        dispositions = [*package.review_dispositions]
        for result in blocking_failures(results):
            if result.result_id not in existing_disposition_ids:
                dispositions.append(
                    ReviewDisposition(
                        disposition_id=f"RD-{uuid4().hex[:12].upper()}",
                        result_id=result.result_id,
                        decision=DispositionDecision.OPEN,
                        reason=None,
                        reviewer=None,
                        timestamp=None,
                    )
                )
        event = self._event(
            "validation_run",
            "HELIX validation service",
            "complete",
            {
                "run_id": run.run_id,
                "planner": request.planner.value,
                "llm_used": planner.llm_used,
                "data_validation_receipt_id": execution.receipt.receipt_id,
            },
        )
        updated = package.model_copy(
            update={
                "validation_results": results,
                "review_dispositions": dispositions,
                "events": [*package.events, event],
            }
        )
        updated = self._with_derived_gate(updated, event.timestamp)
        self.repository.save(updated)
        self.repository.save_validation_run(run)
        self.repository.append_event(
            study_id=study_id,
            event_type=event.event,
            actor=event.actor,
            payload={
                "outcome": event.outcome,
                **event.details,
                "manifest_hash": manifest_fingerprint(updated),
                "governed_versions_hash": governed_versions_fingerprint(pinned_run),
            },
            idempotency_key=f"validation:{run.run_id}",
            occurred_at=now,
        )
        updated = self.section_runs.persist_contract_revision(
            updated,
            event_id=event.event_id,
        )
        self.repository.save(updated)
        self.session.commit()
        return run

    def evidence(self, study_id: str, claim_id: str) -> EvidenceChain:
        package = self.repository.get(study_id)
        claim, edges = self._claim_and_edges(package, claim_id)
        if claim is None:
            raise InvalidCommandError(f"Unknown claim {claim_id}")
        record_map = self._source_record_map(package)
        sources = [record_map[edge.source_record_id] for edge in edges if edge.source_record_id in record_map]
        transform_ids = {edge.transform_id for edge in edges}
        recomputed_value: float | None = None
        exact_match: bool | None = None
        if claim.claim_type == "body_weight.mean" or claim.field_id.startswith("terminal-body-weight-high"):
            if sources:
                recomputed_value = round(sum(float(source.value) for source in sources) / len(sources), 1)
                exact_match = recomputed_value == claim.value
        elif claim.field_id.startswith("standard-deviation-"):
            if len(sources) > 1:
                values = [float(source.value) for source in sources]
                mean = sum(values) / len(values)
                recomputed_value = round(
                    (sum((value - mean) ** 2 for value in values) / (len(values) - 1)) ** 0.5,
                    1,
                )
                exact_match = recomputed_value == claim.value
        elif claim_id == "C-MI-LIVER":
            recomputed_value = float(len(sources))
            exact_match = recomputed_value == claim.value
        validations = [
            result
            for result in self._workspace_validations(package)
            if result.scope_id in {claim_id, claim.section_id, claim.package_id or ""}
            or claim_id in result.evidence_ids
        ]
        return EvidenceChain(
            claim=claim,
            sources=sources,
            transform_id=next(iter(transform_ids)) if len(transform_ids) == 1 else claim.transform_id,
            recomputed_value=recomputed_value,
            exact_match=exact_match,
            validations=validations,
            report_text=self._claim_text(package, claim),
            source_hashes=claim.source_hashes
            or [edge.source_hash or "" for edge in edges if edge.source_hash],
            transform_version=claim.transform_version,
            rule_versions=claim.rule_versions,
            lineage=edges,
        )

    def _disposition_command(
        self, study_id: str, result_id: str, command: DispositionCommand
    ) -> WorkspaceResponse:
        if result_id.startswith(("TCR-", "PRV-", "TCF-")):
            raise WorkflowConflictError(
                "Template and provenance failures are non-waivable. "
                "Correct governed input through a superseding run or a new candidate."
            )
        if result_id.startswith("SOE-"):
            return self._record_soe_disposition(study_id, result_id, command)
        package = self.repository.get(study_id, for_update=True)
        self._ensure_mutable(package)
        dvp_match = next(
            (
                (execution, result)
                for execution in package.data_validation_executions
                for result in execution.results
                if result.result_id == result_id
            ),
            None,
        )
        if dvp_match is not None:
            execution, dvp_result = dvp_match
            if dvp_result.enforcement_class == "hard_blocker":
                raise WorkflowConflictError("hard_blocker results cannot be waived")
            if (
                dvp_result.status != ValidationStatus.FAIL
                or not policy_for(dvp_result.enforcement_class).dispositionable
            ):
                raise WorkflowConflictError("Only blocking failures can receive a review disposition")
            return self._record_dvp_disposition(package, study_id, execution, result_id, command)
        result = next((item for item in package.validation_results if item.result_id == result_id), None)
        if result is None:
            raise InvalidCommandError(f"Unknown validation result {result_id}")
        if result.status != ValidationStatus.FAIL or result.severity != "blocker":
            raise WorkflowConflictError("Only blocking failures can receive a review disposition")
        allowed_decisions = ALLOWED_DISPOSITIONS.get(result_id, set())
        if command.decision not in allowed_decisions:
            allowed = ", ".join(sorted(decision.value for decision in allowed_decisions)) or "none"
            raise WorkflowConflictError(
                f"Disposition {command.decision.value} is not allowed for {result_id}; expected {allowed}"
            )
        prior = [item for item in package.review_dispositions if item.result_id == result_id]
        if prior and (
            prior[-1].decision == command.decision
            and prior[-1].reason == command.reason
            and prior[-1].reviewer == command.reviewer
        ):
            return self._workspace(package)
        timestamp = self._now()
        disposition = ReviewDisposition(
            disposition_id=f"RD-{uuid4().hex[:12].upper()}",
            result_id=result_id,
            decision=command.decision,
            reason=command.reason,
            reviewer=command.reviewer,
            timestamp=timestamp,
        )
        event = self._event(
            "validation_disposition",
            command.reviewer,
            command.decision.value,
            {"result_id": result_id, "reason": command.reason},
            timestamp=timestamp,
        )
        sections = [section.model_copy() for section in package.report_sections]
        claims, provenance_edges = self._apply_claim_correction(package, result_id, command.decision)
        scope_to_section = {"S5": "S5", "C-MI-LIVER": "S7", "C-NOAEL": "S8"}
        affected_section = scope_to_section.get(result.scope_id)
        if affected_section:
            sections = [
                section.model_copy(update={"status": SectionStatus.REVIEWED})
                if section.section_id == affected_section
                else section
                for section in sections
            ]
        claims = [
            claim.model_copy(update={"status": ClaimStatus.APPROVED})
            if claim.claim_id == result.scope_id
            else claim
            for claim in claims
        ]
        updated = package.model_copy(
            update={
                "review_dispositions": [*package.review_dispositions, disposition],
                "report_sections": sections,
                "claims": claims,
                "provenance_edges": provenance_edges,
                "events": [*package.events, event],
            }
        )
        updated = self._with_derived_gate(updated, timestamp)
        updated = self.section_runs.persist_contract_revision(updated, event_id=event.event_id)
        self.repository.save(updated)
        self.repository.append_event(
            study_id=study_id,
            event_type=event.event,
            actor=event.actor,
            payload={"outcome": event.outcome, **event.details},
            idempotency_key=f"disposition:{disposition.disposition_id}",
            occurred_at=datetime.fromisoformat(timestamp.replace("Z", "+00:00")),
        )
        self.session.commit()
        return self._workspace(updated)

    def _record_dvp_disposition(
        self,
        package: StudyEvidencePackage,
        study_id: str,
        execution: DataValidationExecution,
        result_id: str,
        command: DispositionCommand,
    ) -> WorkspaceResponse:
        artifact_id = execution.receipt.receipt_id
        prior = [item for item in package.review_dispositions if item.result_id == result_id]
        if prior and (
            prior[-1].decision == command.decision
            and prior[-1].reason == command.reason
            and prior[-1].reviewer == command.reviewer
            and prior[-1].artifact_id == artifact_id
        ):
            return self._workspace(package)
        timestamp = self._now()
        disposition = ReviewDisposition(
            disposition_id=f"RD-{uuid4().hex[:12].upper()}",
            result_id=result_id,
            decision=command.decision,
            reason=command.reason,
            reviewer=command.reviewer,
            timestamp=timestamp,
            artifact_id=artifact_id,
        )
        event = self._event(
            "validation_disposition",
            command.reviewer,
            command.decision.value,
            {
                "result_id": result_id,
                "reason": command.reason,
                "artifact_id": artifact_id,
            },
            timestamp=timestamp,
        )
        updated = package.model_copy(
            update={
                "review_dispositions": [*package.review_dispositions, disposition],
                "events": [*package.events, event],
            }
        )
        updated = self._with_derived_gate(updated, timestamp)
        updated = self.section_runs.persist_contract_revision(updated, event_id=event.event_id)
        self.repository.save(updated)
        self.repository.append_event(
            study_id=study_id,
            event_type=event.event,
            actor=event.actor,
            payload={"outcome": event.outcome, **event.details},
            idempotency_key=f"disposition:{disposition.disposition_id}",
            occurred_at=datetime.fromisoformat(timestamp.replace("Z", "+00:00")),
        )
        self.session.commit()
        return self._workspace(updated)

    def _record_soe_disposition(
        self,
        study_id: str,
        result_id: str,
        command: DispositionCommand,
    ) -> WorkspaceResponse:
        package = self.repository.get(study_id, for_update=True)
        self._ensure_mutable(package)
        evaluation = next(
            (
                item
                for item in reversed(self.repository.list_candidate_evaluations(study_id))
                if item.study_output_evaluation_receipt.receipt_id == result_id
            ),
            None,
        )
        if evaluation is None:
            raise InvalidCommandError(f"Unknown validation result {result_id}")
        if evaluation.study_output_evaluation_receipt.status != "failed":
            raise WorkflowConflictError("Only blocking failures can receive a review disposition")
        definition = section_package_definition(
            self.settings.codex_repository_root,
            evaluation.section_package_id,
        )
        fingerprint = dependency_fingerprint_for(
            package, [str(item) for item in definition.get("depends_on", [])]
        )
        prior = [item for item in package.review_dispositions if item.result_id == result_id]
        if prior and (
            prior[-1].decision == command.decision
            and prior[-1].reason == command.reason
            and prior[-1].reviewer == command.reviewer
            and prior[-1].artifact_hash == evaluation.candidate_hash
            and prior[-1].dependency_fingerprint == fingerprint
        ):
            return self._workspace(package)
        timestamp = self._now()
        disposition = ReviewDisposition(
            disposition_id=f"RD-{uuid4().hex[:12].upper()}",
            result_id=result_id,
            decision=command.decision,
            reason=command.reason,
            reviewer=command.reviewer,
            timestamp=timestamp,
            artifact_id=evaluation.candidate_id,
            artifact_hash=evaluation.candidate_hash,
            dependency_fingerprint=fingerprint,
        )
        event = self._event(
            "validation_disposition",
            command.reviewer,
            command.decision.value,
            {
                "result_id": result_id,
                "reason": command.reason,
                "artifact_id": evaluation.candidate_id,
                "artifact_hash": evaluation.candidate_hash,
            },
            timestamp=timestamp,
        )
        updated = package.model_copy(
            update={
                "review_dispositions": [*package.review_dispositions, disposition],
                "events": [*package.events, event],
            }
        )
        updated = self._with_derived_gate(updated, timestamp)
        updated = self.section_runs.persist_contract_revision(updated, event_id=event.event_id)
        self.repository.save(updated)
        self.repository.append_event(
            study_id=study_id,
            event_type=event.event,
            actor=event.actor,
            payload={"outcome": event.outcome, **event.details},
            idempotency_key=f"disposition:{disposition.disposition_id}",
            occurred_at=datetime.fromisoformat(timestamp.replace("Z", "+00:00")),
        )
        run_row = self.repository.get_section_run_by_id(study_id, evaluation.run_id)
        if run_row is not None and run_row.candidate is not None:
            run = StoredSectionRun.model_validate(
                {
                    "receipt": run_row.receipt,
                    "candidate": run_row.candidate,
                    "envelope": run_row.envelope,
                    "review_scaffold": run_row.review_scaffold,
                }
            )
            promotions = SectionPromotionService(self.session, self.settings.codex_repository_root)
            promotions.record_decision_for_evaluation(
                study_id,
                evaluation,
                run,
                updated,
                idempotency_key=f"disposition-decision:{disposition.disposition_id}",
            )
        self.session.commit()
        return self._workspace(updated)

    def _approve_command(self, study_id: str, command: ApprovalCommand) -> WorkspaceResponse:
        package = self.repository.get(study_id, for_update=True)
        self._ensure_mutable(package)
        gate = self._release_gate(package)
        if any(result_id.startswith("VR-") for result_id in gate.blocking_result_ids):
            raise WorkflowConflictError("Resolve all blocking validation results before recording approvals")
        if any(
            approval.role == command.role
            and approval.reviewer == command.reviewer
            and approval.meaning == command.meaning
            for approval in package.approvals
        ):
            return self._workspace(package)
        if command.role == ApprovalRole.STUDY_DIRECTOR:
            existing_roles = {approval.role for approval in package.approvals}
            required_first = REQUIRED_APPROVALS - {ApprovalRole.STUDY_DIRECTOR}
            if not required_first.issubset(existing_roles):
                raise WorkflowConflictError(
                    "Pathologist, peer reviewer, and Quality Assurance Unit records are required first"
                )
        timestamp = self._now()
        artifact_hash = None
        dependency_fingerprint = None
        body_weight = next(
            (
                run
                for run in reversed(self.repository.list_section_runs(study_id))
                if run.receipt.section_package_id == BODY_WEIGHT_PACKAGE_ID
            ),
            None,
        )
        if body_weight is not None:
            definition = section_package_definition(
                self.settings.codex_repository_root,
                BODY_WEIGHT_PACKAGE_ID,
            )
            artifact_hash = body_weight.receipt.candidate_hash
            dependency_fingerprint = dependency_fingerprint_for(
                package, [str(item) for item in definition.get("depends_on", [])]
            )
        approval = Approval(
            approval_id=f"APR-{uuid4().hex[:12].upper()}",
            role=command.role,
            reviewer=command.reviewer,
            meaning=command.meaning,
            timestamp=timestamp,
            artifact_hash=artifact_hash,
            dependency_fingerprint=dependency_fingerprint,
        )
        sections = [section.model_copy() for section in package.report_sections]
        if command.role == ApprovalRole.STUDY_DIRECTOR:
            sections = [
                section.model_copy(update={"status": SectionStatus.REVIEWED})
                if section.status == SectionStatus.NEEDS_REVIEW
                else section
                for section in sections
            ]
        event = self._event(
            "approval_recorded",
            command.reviewer,
            "complete",
            {"role": command.role.value, "meaning": command.meaning},
            timestamp=timestamp,
        )
        updated = package.model_copy(
            update={
                "approvals": [*package.approvals, approval],
                "report_sections": sections,
                "events": [*package.events, event],
            }
        )
        updated = self._with_derived_gate(updated, timestamp)
        updated = self.section_runs.persist_contract_revision(updated, event_id=event.event_id)
        self.repository.save(updated)
        self.repository.append_event(
            study_id=study_id,
            event_type=event.event,
            actor=event.actor,
            payload={"outcome": event.outcome, **event.details},
            idempotency_key=f"approval:{approval.approval_id}",
            occurred_at=datetime.fromisoformat(timestamp.replace("Z", "+00:00")),
        )
        self.session.commit()
        return self._workspace(updated)

    def _record_final_study_approval_command(
        self,
        study_id: str,
        command: FinalStudyApprovalCommand,
    ) -> WorkspaceResponse:
        package = self.repository.get(study_id, for_update=True)
        self._ensure_mutable(package)
        live = self._live_release_candidate(package)
        if live is None:
            raise WorkflowConflictError("Freeze the authorized manifest before Final Study Approval")
        request_hash = approval_request_hash(study_id, command.reviewer, live)
        existing = package.final_study_approval
        if existing is not None:
            same_key = existing.idempotency_key == command.idempotency_key
            same_hash = recorded_request_hash(existing) == request_hash
            if same_key and same_hash:
                return self._workspace(package)
            if same_key:
                raise WorkflowConflictError("The idempotency key was already used for another command")
            if approval_is_current(existing, live):
                raise WorkflowConflictError(
                    "Final Study Approval is already recorded for this release candidate"
                )
        gate = self._release_gate(package)
        if gate.blocking_result_ids:
            raise WorkflowConflictError("Unresolved sections, gates, or dispositions prevent approval")
        approval_roles = {item.role for item in package.approvals}
        if not REQUIRED_APPROVALS.issubset(approval_roles):
            raise WorkflowConflictError("Configured reviewer prerequisites prevent approval")
        if any(section.status == SectionStatus.NEEDS_REVIEW for section in package.report_sections):
            raise WorkflowConflictError("Unresolved sections prevent approval")
        timestamp = self._now()
        approval = FinalStudyApproval(
            schema_version="helix.final-study-approval/v1",
            approval_id=f"FSA-{uuid4().hex[:12].upper()}",
            run_id=live.run_id,
            study_id=study_id,
            reviewer=command.reviewer,
            recorded_at=timestamp,
            manifest_hash=live.content_hash,
            included_artifact_hashes=hashes_for(live),
            idempotency_key=command.idempotency_key,
        )
        validate_final_study_approval(approval)
        event = self._event(
            "final_study_approval_recorded",
            command.reviewer,
            "complete",
            {
                "approval_id": approval.approval_id,
                "manifest_hash": approval.manifest_hash,
                "run_id": approval.run_id,
            },
            timestamp=timestamp,
        )
        updated = package.model_copy(
            update={
                "release_candidate": live,
                "final_study_approval": approval,
                "export_artifacts": pending_approved_export_artifacts(live),
                "events": [*package.events, event],
            }
        )
        updated = self._with_derived_gate(updated, timestamp)
        updated = self.section_runs.persist_contract_revision(updated, event_id=event.event_id)
        self.repository.save(updated)
        self.repository.append_event(
            study_id=study_id,
            event_type=event.event,
            actor=event.actor,
            payload={"outcome": event.outcome, **event.details},
            idempotency_key=f"final-study-approval:{command.idempotency_key}",
            occurred_at=datetime.fromisoformat(timestamp.replace("Z", "+00:00")),
        )
        self.session.commit()
        return self._workspace(updated)

    def _export_command(self, study_id: str, command: ExportCommand) -> ExportReceipt:
        package = self.repository.get(study_id, for_update=True)
        storage_key = f"export:{command.idempotency_key}"
        prior_event = self.repository.get_event_by_idempotency_key(study_id, storage_key)
        already_exported = bool(package.export_artifacts) and all(
            artifact.status == "exported" for artifact in package.export_artifacts
        )
        approval = package.final_study_approval
        if prior_event is not None or already_exported:
            if approval is None:
                raise WorkflowConflictError("Exported package is missing Final Study Approval")
            return ExportReceipt(
                study_id=study_id,
                status="exported",
                exported_at=self._exported_at(package),
                approval_id=approval.approval_id,
                manifest_hash=approval.manifest_hash,
                artifacts=package.export_artifacts,
                idempotent_replay=True,
                instrumentation=ExportInstrumentation(agent_starts=0, calculation_runs=0),
            )
        gate = self._release_gate(package)
        if gate.status != GateStatus.READY_FOR_EXPORT:
            raise WorkflowConflictError("The release gate is not ready for export")
        live = self._live_release_candidate(package)
        if approval is None or live is None or not approval_is_current(approval, live):
            raise WorkflowConflictError("Final Study Approval is stale and blocks export")
        for revision in package.review_scaffold_revisions:
            try:
                admit_export_document(revision)
            except ExportAdmissionError:
                continue
            raise WorkflowConflictError("A Review Scaffold revision was admitted for export")
        probe = ExportProbe()
        token = install_export_probe(probe)
        try:
            section_runs = self.repository.list_section_runs(study_id)
            section_drafts = self.repository.list_section_drafts(study_id)
            try:
                materialized = materialize_approved_artifacts(
                    package,
                    approval,
                    live=live,
                    section_runs=section_runs,
                    section_drafts=section_drafts,
                )
            except ApprovedExportError as error:
                raise WorkflowConflictError(str(error)) from error
            if probe.agent_starts or probe.calculation_runs:
                raise WorkflowConflictError(
                    "Export started an agent or ran a deterministic calculation"
                )
            timestamp = self._now()
            artifacts = exported_artifacts_from(materialized)
            event = self._event(
                "explicit_export",
                command.actor,
                "exported",
                {
                    "artifact_count": len(artifacts),
                    "approval_id": approval.approval_id,
                    "manifest_hash": approval.manifest_hash,
                    "agent_starts": probe.agent_starts,
                    "calculation_runs": probe.calculation_runs,
                },
                timestamp=timestamp,
            )
            updated = package.model_copy(
                update={
                    "workflow_state": "exported",
                    "export_artifacts": artifacts,
                    "events": [*package.events, event],
                }
            )
            updated = self._with_derived_gate(updated, timestamp)
            self.repository.save(updated)
            for item in materialized:
                self.repository.save_export_file(
                    study_id=study_id,
                    artifact_id=item.artifact_id,
                    filename=item.filename,
                    media_type=item.media_type,
                    checksum=item.content_hash,
                    content=item.content,
                )
            self.repository.append_event(
                study_id=study_id,
                event_type=event.event,
                actor=event.actor,
                payload={"outcome": event.outcome, **event.details},
                idempotency_key=storage_key,
                occurred_at=datetime.fromisoformat(timestamp.replace("Z", "+00:00")),
            )
            self.session.commit()
            return ExportReceipt(
                study_id=study_id,
                status="exported",
                exported_at=timestamp,
                approval_id=approval.approval_id,
                manifest_hash=approval.manifest_hash,
                artifacts=artifacts,
                idempotent_replay=False,
                instrumentation=ExportInstrumentation(
                    agent_starts=probe.agent_starts,
                    calculation_runs=probe.calculation_runs,
                ),
            )
        finally:
            reset_export_probe(token)

    def artifact(self, study_id: str, artifact_id: str) -> GeneratedArtifact:
        package = self.repository.get(study_id)
        artifact = next((item for item in package.export_artifacts if item.artifact_id == artifact_id), None)
        if artifact is None:
            raise InvalidCommandError(f"Unknown artifact {artifact_id}")
        if artifact.status != "exported" or artifact.checksum is None:
            raise WorkflowConflictError("The artifact is not available before explicit export")
        stored = self.repository.get_export_file(study_id, artifact_id)
        if stored is None:
            raise WorkflowConflictError("The exported artifact bytes are unavailable")
        checksum = f"sha256:{hashlib.sha256(stored.content).hexdigest()}"
        if checksum != artifact.checksum or checksum != stored.checksum:
            raise WorkflowConflictError("The stored artifact does not match its export checksum")
        return GeneratedArtifact(
            filename=stored.filename,
            media_type=stored.media_type,
            content=stored.content,
        )

    def _workspace(self, package: StudyEvidencePackage) -> WorkspaceResponse:
        live = self._live_release_candidate(package)
        gate = self._release_gate(package, live=live)
        unresolved = set(gate.blocking_result_ids)
        validation_blockers = {result.result_id for result in blocking_failures(package.validation_results)}
        resolved = len(validation_blockers - unresolved)
        return WorkspaceResponse(
            label=package.label,
            study=package.study,
            manifest=package.manifest,
            workflow_state=package.workflow_state,
            stages=build_stages(package, gate),
            summary=WorkspaceSummary(
                record_count=sum(len(records) for records in package.records.model_dump().values()),
                source_count=len(package.manifest),
                provenance_count=len(package.provenance_edges),
                blocker_count=len(unresolved),
                resolved_blocker_count=max(resolved, 0),
                section_count=len(package.report_sections),
            ),
            claims=package.claims,
            validations=self._workspace_validations(package),
            dispositions=package.review_dispositions,
            approvals=package.approvals,
            release_gate=gate,
            export_artifacts=package.export_artifacts,
            report=assemble_report(package),
            events=package.events[-20:],
            journey=self._journey(package, gate, live),
            planner_capabilities=[
                PlannerCapability(
                    mode=PlannerMode.FIXTURE,
                    available=True,
                    label="Fixture planner",
                    detail="Exercises the structured tool contract without claiming an LLM ran.",
                ),
                PlannerCapability(
                    mode=PlannerMode.OPENAI_COMPATIBLE,
                    available=bool(self.settings.llm_api_key),
                    label="OpenAI-compatible planner",
                    detail=(
                        "Available with HELIX_LLM_API_KEY. The model selects allowlisted checks; "
                        "code executes them."
                    ),
                ),
            ],
            pinned_run=self.pinned_runs.latest(package.study.study_id),
            data_validation_executions=package.data_validation_executions,
            section_run_eligibility=self.section_runs.eligibilities(package),
            section_runs=self.repository.list_section_runs(package.study.study_id),
            candidate_evaluations=self.repository.list_candidate_evaluations(package.study.study_id),
            promotion_decisions=self.repository.list_promotion_decisions(package.study.study_id),
            section_drafts=self.repository.list_section_drafts(package.study.study_id),
            cross_section_queries=self.repository.list_cross_section_queries(package.study.study_id),
            review_scaffold_revisions=package.review_scaffold_revisions,
            drafting_cycles=self.repository.list_drafting_cycles(package.study.study_id),
            can_open_revision=self._can_open_revision(package.study.study_id),
            predecessor_snapshots=package.predecessor_snapshots,
            superseding_run_receipt=package.superseding_run_receipt,
            release_candidate=live,
            final_study_approval=package.final_study_approval,
            approval_current=approval_is_current(package.final_study_approval, live),
        )

    def _can_open_revision(self, study_id: str) -> bool:
        cycles = self.repository.list_drafting_cycles(study_id)
        latest = current_cycle(cycles, SECTION_PACKAGE_ID)
        if latest is None:
            return False
        recorded = load_recorded_attempts(
            self.repository.list_section_runs(study_id),
            self.repository.list_candidate_evaluations(study_id),
            SECTION_PACKAGE_ID,
            latest.cycle_id,
        )
        return cycle_exhausted(recorded)

    @staticmethod
    def _ensure_mutable(package: StudyEvidencePackage) -> None:
        if package.workflow_state == "exported" or any(
            artifact.status == "exported" for artifact in package.export_artifacts
        ):
            raise WorkflowConflictError(
                "The exported package is immutable. Create a controlled amendment in a production workflow."
            )

    def _planner(self, mode: PlannerMode) -> FixturePlanner | OpenAICompatiblePlanner:
        if mode == PlannerMode.FIXTURE:
            return FixturePlanner()
        return OpenAICompatiblePlanner(self.settings)

    def _with_derived_gate(self, package: StudyEvidencePackage, timestamp: str) -> StudyEvidencePackage:
        gate = self._release_gate(package, timestamp)
        other_gates = [item for item in package.gate_decisions if item.gate_type != "release"]
        return package.model_copy(update={"gate_decisions": [*other_gates, gate]})

    def _release_gate(
        self,
        package: StudyEvidencePackage,
        decided_at: str | None = None,
        *,
        live: ReleaseCandidate | None | object = _UNSET,
    ) -> GateDecision:
        blockers = sorted(
            {
                f"PROMOTION-DISABLED-{run.receipt.section_package_id}"
                for run in self.repository.list_section_runs(package.study.study_id)
                if run.candidate.status == "section_draft_candidate"
            }
        )
        return derive_release_gate(
            package,
            candidate_blocker_ids=blockers,
            decided_at=decided_at,
            live_release_candidate=(
                self._live_release_candidate(package)
                if live is _UNSET
                else cast(ReleaseCandidate | None, live)
            ),
        )

    def _live_release_candidate(self, package: StudyEvidencePackage) -> ReleaseCandidate | None:
        try:
            return compile_release_candidate(
                package,
                section_runs=self.repository.list_section_runs(package.study.study_id),
                section_drafts=self.repository.list_section_drafts(package.study.study_id),
                drafting_cycles=self.repository.list_drafting_cycles(package.study.study_id),
            )
        except MissingReleaseCandidateError:
            return None

    def _apply_claim_correction(
        self,
        package: StudyEvidencePackage,
        result_id: str,
        decision: DispositionDecision,
    ) -> tuple[list[Claim], list[ProvenanceEdge]]:
        claims = [claim.model_copy() for claim in package.claims]
        edges = [edge.model_copy() for edge in package.provenance_edges]
        if result_id != "VR-004" or decision != DispositionDecision.CORRECTED:
            return claims, edges
        corrected_ids = {"C-BW-HIGH-M", "C-BW-HIGH-F"}
        claims = [claim for claim in claims if claim.claim_id not in corrected_ids]
        edges = [edge for edge in edges if edge.claim_id not in corrected_ids]
        animals = {animal.animal_id: animal for animal in package.records.animals}
        for sex in ("M", "F"):
            source_records = [
                record
                for record in package.records.body_weights
                if record.timepoint == "DAY 28"
                and record.animal_id is not None
                and animals[record.animal_id].group_id == "G4"
                and animals[record.animal_id].sex == sex
            ]
            value = round(sum(float(record.value) for record in source_records) / len(source_records), 1)
            claim_id = f"C-BW-HIGH-{sex}"
            claims.append(
                Claim(
                    claim_id=claim_id,
                    section_id="S5",
                    field_id=f"terminal-body-weight-high-{sex.lower()}",
                    value=value,
                    unit="g",
                    grain="dose_group_x_sex",
                    status=ClaimStatus.APPROVED,
                )
            )
            edges.extend(
                ProvenanceEdge(
                    edge_id=f"PE-BW-{sex}-{index}",
                    claim_id=claim_id,
                    source_record_id=record.record_id,
                    transform_id="mean-by-sex-v1",
                    source_pointer=record.source_pointer,
                    authority_tier=1,
                )
                for index, record in enumerate(source_records, start=1)
            )
        return claims, edges

    def _source_record_map(self, package: StudyEvidencePackage) -> dict[str, SourceRecord]:
        records: dict[str, SourceRecord] = {}
        animals = {animal.animal_id: animal for animal in package.records.animals}
        for measurement in [
            *package.records.body_weights,
            *package.records.clinical_observations,
            *package.records.food_consumption,
            *package.records.organ_weights,
            *package.records.formulation,
        ]:
            animal = animals.get(measurement.animal_id or "")
            records[measurement.record_id] = SourceRecord(
                record_id=measurement.record_id,
                domain=measurement.domain,
                source_pointer=measurement.source_pointer,
                value=measurement.value,
                unit=measurement.unit,
                grain=measurement.grain,
                attributes={
                    "animal_id": measurement.animal_id,
                    "group_id": measurement.group_id or (animal.group_id if animal else None),
                    "sex": animal.sex if animal else None,
                    "timepoint": measurement.timepoint,
                    "test_code": measurement.test_code,
                },
            )
        for finding in package.records.microscopic_findings:
            animal = animals[finding.animal_id]
            records[finding.finding_id] = SourceRecord(
                record_id=finding.finding_id,
                domain=finding.domain,
                source_pointer=finding.source_pointer,
                value=finding.severity,
                unit=None,
                grain="animal_x_tissue",
                attributes={
                    "animal_id": finding.animal_id,
                    "group_id": animal.group_id,
                    "sex": animal.sex,
                    "tissue": finding.tissue,
                    "finding": finding.finding,
                },
            )
        return records

    def _exported_artifact(self, artifact: ExportArtifact, content: bytes) -> ExportArtifact:
        digest = hashlib.sha256(content).hexdigest()
        return artifact.model_copy(update={"checksum": f"sha256:{digest}", "status": "exported"})

    def _exported_at(self, package: StudyEvidencePackage) -> str:
        export_events = [event for event in package.events if event.event == "explicit_export"]
        return export_events[-1].timestamp if export_events else self._now()

    def _event(
        self,
        event: str,
        actor: str,
        outcome: str,
        details: dict[str, str | int | float | bool | None],
        *,
        timestamp: str | None = None,
    ) -> WorkflowEvent:
        return WorkflowEvent(
            event_id=f"EV-{uuid4().hex[:12].upper()}",
            event=event,
            actor=actor,
            timestamp=timestamp or self._now(),
            outcome=outcome,
            details=details,
        )

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat().replace("+00:00", "Z")

    @staticmethod
    def _claim_and_edges(
        package: StudyEvidencePackage,
        claim_id: str,
    ) -> tuple[Claim | None, list[ProvenanceEdge]]:
        claim = next((item for item in package.claims if item.claim_id == claim_id), None)
        edges = [edge for edge in package.provenance_edges if edge.claim_id == claim_id]
        if claim is not None:
            return claim, edges
        for execution in package.data_validation_executions:
            claim = next((item for item in execution.claims if item.claim_id == claim_id), None)
            if claim is not None:
                return claim, [edge for edge in execution.provenance_edges if edge.claim_id == claim_id]
        return None, []

    @staticmethod
    def _workspace_validations(package: StudyEvidencePackage) -> list[ValidationResult]:
        results = list(package.validation_results)
        seen = {item.result_id for item in results}
        for execution in package.data_validation_executions:
            for item in as_validation_results(execution):
                if item.result_id not in seen:
                    results.append(item)
                    seen.add(item.result_id)
        return results

    @staticmethod
    def _claim_text(package: StudyEvidencePackage, claim: Claim) -> str:
        if any(item.claim_id == claim.claim_id for item in package.claims):
            return claim_report_text(package, claim.claim_id)
        if claim.value is None:
            return "Needs review"
        return f"{claim.claim_type or claim.field_id} is {claim.value} {claim.unit} at {claim.grain}."


def _unresolved_dvp_result_ids(
    package: StudyEvidencePackage,
    latest_dispositions: dict[str, ReviewDisposition],
) -> list[str]:
    unresolved: list[str] = []
    for execution in package.data_validation_executions:
        for result in execution.results:
            if result.status != ValidationStatus.FAIL:
                continue
            policy = policy_for(result.enforcement_class)
            if not policy.blocks_gate:
                continue
            if policy.dispositionable:
                latest = latest_dispositions.get(result.result_id)
                if (
                    latest is not None
                    and latest.decision in RESOLVED_DISPOSITIONS
                    and latest.artifact_id == execution.receipt.receipt_id
                ):
                    continue
            unresolved.append(result.result_id)
    return unresolved


def _parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def derive_release_gate(
    package: StudyEvidencePackage,
    candidate_blocker_ids: list[str] | None = None,
    decided_at: str | None = None,
    live_release_candidate: ReleaseCandidate | None = None,
) -> GateDecision:
    latest_dispositions: dict[str, ReviewDisposition] = {}
    for disposition in package.review_dispositions:
        latest_dispositions[disposition.result_id] = disposition
    unresolved = [
        result.result_id
        for result in blocking_failures(package.validation_results)
        if latest_dispositions.get(result.result_id) is None
        or latest_dispositions[result.result_id].decision not in RESOLVED_DISPOSITIONS
    ]
    unresolved.extend(_unresolved_dvp_result_ids(package, latest_dispositions))
    unresolved.extend(candidate_blocker_ids or [])
    unresolved = list(dict.fromkeys(unresolved))
    approval_roles = {approval.role for approval in package.approvals}
    has_unreviewed_sections = any(
        section.status == SectionStatus.NEEDS_REVIEW for section in package.report_sections
    )
    current_approval = approval_is_current(package.final_study_approval, live_release_candidate)

    # Nothing has been checked yet. "No failing result" is not "passed", and an
    # uploaded study reaches this function before any validation has run, so
    # without this it falls through to READY_FOR_SIGNATURE on an empty result
    # set. Packages that have been validated are unaffected.
    never_validated = not package.validation_results

    # An empty export set means nothing has been exported, not everything.
    if package.export_artifacts and all(
        artifact.status == "exported" for artifact in package.export_artifacts
    ):
        status = GateStatus.EXPORTED
    elif never_validated or unresolved:
        status = GateStatus.BLOCKED
    elif not REQUIRED_APPROVALS.issubset(approval_roles):
        status = GateStatus.READY_FOR_SIGNATURE
    elif has_unreviewed_sections:
        status = GateStatus.BLOCKED
    elif not current_approval:
        status = GateStatus.READY_FOR_SIGNATURE
    else:
        status = GateStatus.READY_FOR_EXPORT
    prior = next((gate for gate in package.gate_decisions if gate.gate_type == "release"), None)
    timestamp = decided_at or (prior.decided_at if prior else datetime.now(UTC).isoformat())
    return GateDecision(
        gate_id="GATE-RELEASE",
        gate_type="release",
        status=status,
        blocking_result_ids=unresolved,
        decided_at=timestamp,
    )


def build_stages(package: StudyEvidencePackage, gate: GateDecision) -> list[Stage]:
    definitions = [
        (
            "authorized-upload",
            "Authorized upload and frozen manifest",
            "human",
            "The study owner authorizes each source. HELIX freezes checksums, authority, and lock state.",
            "Authorized artifacts",
            f"{len(package.manifest)} protocol, template, data, statistics, and pattern inputs",
            "Frozen manifest",
            "Checksums, authority tiers, and owner authorization",
            "The agent cannot add an unapproved source.",
            ["Authorization recorded", "Checksums captured", "Manifest frozen"],
        ),
        (
            "parse",
            "Parse protocol, template, and source data",
            "agent",
            "The supplied bundle represents frozen artifacts as typed facts without changing source records.",
            "Frozen artifacts",
            "Authorized synthetic protocol, template, and source representations",
            "Typed study records",
            f"{sum(len(records) for records in package.records.model_dump().values()):,} normalized records",
            "Parsing may flag ambiguity. It may not repair raw study data.",
            ["Protocol facts present", "Template fields present", "Source grains assigned"],
        ),
        (
            "resolve-study",
            "Resolve study type and pattern",
            "hybrid",
            "HELIX matches the protocol to the 28-day repeat-dose profile and its sponsor template.",
            "Protocol facts",
            "Species, route, duration, endpoints, and study start date",
            "Study profile",
            f"{package.study.study_type_id} and report template v1",
            "Approved reports guide structure and phrasing. Their values never enter this study.",
            ["Study type resolved", "Pattern compatibility checked", "Study start context retained"],
        ),
        (
            "extract",
            "Deterministic extraction",
            "agent",
            "Code selects source rows and computes report-ready values at the field's required grain.",
            "Normalized study records",
            "BW, CL, FW, OM, MI, and PC domains",
            "Candidate claims",
            "Values, units, grain, and versioned transform IDs",
            "The planner selects tools. Deterministic code reads values and performs math.",
            ["Source rows selected", "Transforms versioned", "No model-generated numbers"],
        ),
        (
            "validate",
            "Hybrid validation",
            "hybrid",
            "Rules check keys, grain, provenance, report coverage, and source reconciliation.",
            "Claims and field registry",
            "Typed claims plus report rules",
            "Validation evidence",
            "Deterministic results and constrained agent-proposed tool checks",
            "An LLM can propose an allowlisted check. It cannot set the result.",
            ["Schema checks run", "Grain mismatch retained", "Severity conflict retained"],
        ),
        (
            "draft",
            "Structured section drafting",
            "agent",
            "The structured assembler writes around validated claims and preserves explicit review markers.",
            "Validated claims and pattern",
            "Current facts kept separate from prior-report style",
            "Eight report sections",
            "Typed blocks, claims, and review markers",
            "Automation cannot invent values or own final scientific judgment.",
            ["Eight sections instantiated", "Claims inserted", "Review markers retained"],
        ),
        (
            "provenance",
            "Compile provenance",
            "agent",
            "Each quantitative claim links to source records, a transform, validation, and manifest state.",
            "Draft claims and evidence IDs",
            "Current report fields",
            "Evidence graph",
            f"{len(package.provenance_edges)} source-to-claim edges",
            "A numeric claim without provenance cannot pass its section gate.",
            ["Numeric claims inspected", "Edges compiled", "Authority tiers attached"],
        ),
        (
            "gate",
            "Section and release gates",
            "hybrid",
            "The service combines validation, dispositions, approvals, and package preflight.",
            "Sections, checks, and provenance",
            f"{len(package.report_sections)} sections and {len(package.validation_results)} results",
            "Gate decision",
            f"{len(gate.blocking_result_ids)} unresolved blocking results",
            "Only recorded dispositions and approvals can change release state.",
            ["Coverage evaluated", "Release prerequisites evaluated", "Export policy enforced"],
        ),
        (
            "review",
            "Review and approval",
            "human",
            "Qualified people resolve findings, perform peer review, provide the QAU statement, and approve.",
            "Draft and evidence drawers",
            "Review markers, lineage, and audit events",
            "Recorded review approvals",
            f"{len({approval.role for approval in package.approvals})} of 4 roles recorded",
            "People own scientific interpretation, Quality Assurance Unit work, and final approval.",
            ["Pathologist review", "Peer review", "QAU statement", "Study director approval"],
        ),
        (
            "export",
            "Explicit final export",
            "human",
            "After release approval, a user separately exports the locked synthetic package.",
            "Approved release package",
            "Report and illustrative data support files",
            "Checksummed export",
            f"{len(package.export_artifacts)} approved artifacts",
            "Preparation never triggers export. Export packages approved hashes only; never FDA acceptance.",
            ["Release checked", "Package preflight checked", "Explicit action recorded"],
        ),
    ]
    if gate.status == GateStatus.EXPORTED:
        current_index = 10
    elif gate.status == GateStatus.READY_FOR_EXPORT:
        current_index = 9
    elif not gate.blocking_result_ids:
        current_index = 8
    else:
        current_index = 7
    stages: list[Stage] = []
    for index, definition in enumerate(definitions):
        if index < current_index:
            status = "complete"
        elif index == current_index:
            status = "current"
        elif index == 7 and gate.blocking_result_ids:
            status = "blocked"
        else:
            status = "pending"
        stages.append(
            Stage(
                stage_id=definition[0],
                name=definition[1],
                owner=definition[2],
                status=status,
                summary=definition[3],
                input_title=definition[4],
                input_detail=definition[5],
                output_title=definition[6],
                output_detail=definition[7],
                boundary=definition[8],
                checks=definition[9],
            )
        )
    return stages
