from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .drafting_cycles import load_recorded_attempts
from .repository import StudyPackageRepository
from .schemas import (
    DraftingCycle,
    HumanDirectedRevisionCommand,
    HumanDirectedRevisionReceipt,
    WorkflowEvent,
)
from .section_runs import SectionRunService, canonical_hash
from .template_contracts import impact_set_for


class RevisionConflictError(RuntimeError):
    pass


class SectionRevisionService:
    def __init__(self, session: Session, section_runs: SectionRunService):
        self.session = session
        self.section_runs = section_runs
        self.repository = StudyPackageRepository(session)

    def revise(self, study_id: str, command: HumanDirectedRevisionCommand) -> HumanDirectedRevisionReceipt:
        request_hash = canonical_hash(
            {
                "study_id": study_id,
                "section_package_id": command.section_package_id,
                "actor": command.actor,
            }
        )
        prior = self._replay(study_id, command.idempotency_key, request_hash)
        if prior is not None:
            return prior
        package = self.repository.get(study_id, for_update=True)
        prior = self._replay(study_id, command.idempotency_key, request_hash)
        if prior is not None:
            return prior
        eligibility = self.section_runs.eligibility_for(package, command.section_package_id)
        pinned_run = package.pinned_run
        if pinned_run is None:
            raise RevisionConflictError("Freeze the authorized manifest first")
        if not eligibility.eligible:
            raise RevisionConflictError("; ".join(eligibility.reasons))
        current = self.repository.latest_drafting_cycle(study_id, command.section_package_id)
        if current is None:
            raise RevisionConflictError("A drafting cycle must exist before a human-directed revision")
        recorded = load_recorded_attempts(
            self.repository.list_section_runs(study_id),
            self.repository.list_candidate_evaluations(study_id),
            command.section_package_id,
            current.cycle_id,
        )
        if not recorded:
            raise RevisionConflictError(
                "Draft at least one Candidate Attempt in the current cycle before opening another"
            )
        now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        event_id = f"EV-{uuid4().hex[:12].upper()}"
        cycle = DraftingCycle(
            schema_version="helix.drafting-cycle/v1",
            cycle_id=f"CYCLE-{uuid4().hex[:12].upper()}",
            run_id=pinned_run.run_id,
            section_package_id=command.section_package_id,
            predecessor_cycle_id=current.cycle_id,
            max_attempts=3,
            impact_set=impact_set_for(
                command.section_package_id,
                self.section_runs._section_package_definitions(),
            ),
            opened_at=now,
            opened_by=command.actor,
            triggering_event_id=event_id,
        )
        try:
            row = self.repository.add_drafting_cycle(
                study_id=study_id,
                cycle=cycle,
                idempotency_key=command.idempotency_key,
                request_hash=request_hash,
                stale_disposition_ids=[],
                stale_approval_ids=[],
                review_scaffold_revision=0,
            )
        except IntegrityError as error:
            self.session.rollback()
            prior = self._replay(study_id, command.idempotency_key, request_hash)
            if prior is not None:
                return prior
            raise RevisionConflictError(
                "The idempotency key was already used for another command"
            ) from error
        event = WorkflowEvent(
            event_id=event_id,
            event="human_directed_revision",
            actor=command.actor,
            timestamp=now,
            outcome="cycle_opened",
            details={
                "cycle_id": cycle.cycle_id,
                "predecessor_cycle_id": current.cycle_id,
                "section_package_id": command.section_package_id,
            },
        )
        working = package.model_copy(update={"events": [*package.events, event]})
        updated = self.section_runs.persist_contract_revision(working, event_id=event_id)
        latest = updated.review_scaffold_revisions[-1]
        context = latest["overall_study_context"]
        stale_dispositions = [str(item) for item in context.get("stale_disposition_ids", [])]
        stale_approvals = [str(item) for item in context.get("stale_approval_ids", [])]
        row.stale_disposition_ids = stale_dispositions
        row.stale_approval_ids = stale_approvals
        row.review_scaffold_revision = int(latest["sequence"])
        self.repository.save(updated)
        self.repository.append_event(
            study_id=study_id,
            event_type=event.event,
            actor=event.actor,
            payload={"outcome": event.outcome, **event.details},
            idempotency_key=f"section-revision:{command.idempotency_key}",
            occurred_at=datetime.fromisoformat(now.replace("Z", "+00:00")),
        )
        self.session.commit()
        return HumanDirectedRevisionReceipt(
            cycle=cycle,
            stale_disposition_ids=stale_dispositions,
            stale_approval_ids=stale_approvals,
            review_scaffold_revision=int(latest["sequence"]),
        )

    def _replay(
        self,
        study_id: str,
        idempotency_key: str,
        request_hash: str,
    ) -> HumanDirectedRevisionReceipt | None:
        prior = self.repository.get_drafting_cycle(study_id, idempotency_key)
        if prior is None:
            return None
        if prior.request_hash != request_hash:
            raise RevisionConflictError("The idempotency key was already used for another command")
        return HumanDirectedRevisionReceipt(
            cycle=DraftingCycle.model_validate(prior.cycle),
            stale_disposition_ids=list(prior.stale_disposition_ids),
            stale_approval_ids=list(prior.stale_approval_ids),
            review_scaffold_revision=prior.review_scaffold_revision,
            idempotent_replay=True,
        )
