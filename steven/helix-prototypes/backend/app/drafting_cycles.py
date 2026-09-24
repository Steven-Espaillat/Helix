from dataclasses import dataclass
from typing import Literal

from .run_plans import canonical_hash
from .schemas import CandidateEvaluation, SectionDraftCandidate, StoredSectionRun

MAX_ATTEMPTS = 3
DRAFTING_CYCLE_ID = "CYCLE-BW-001"
CAP_BLOCKER_ID = "ATTEMPT-CAP-section.5_2_3_body_weight"


@dataclass(frozen=True)
class CycleFingerprint:
    value: str


@dataclass(frozen=True)
class RecordedAttempt:
    candidate: SectionDraftCandidate
    envelope: dict[str, object]
    evaluation: CandidateEvaluation | None


@dataclass(frozen=True)
class StartAttempt:
    kind: Literal["start"]
    attempt: int
    drafting_cycle_id: str
    retry_failures: tuple[dict[str, str], ...]


@dataclass(frozen=True)
class RejectAttempt:
    kind: Literal["reject"]
    message: str


Admission = StartAttempt | RejectAttempt


def cycle_fingerprint(envelope: dict[str, object]) -> CycleFingerprint:
    return CycleFingerprint(
        canonical_hash(
            {
                "manifest_hash": envelope["manifest_hash"],
                "run_plan_hash": envelope["run_plan_hash"],
                "section_package": envelope["section_package"],
                "governed_versions": envelope["governed_versions"],
                "validated_claims": envelope["validated_claims"],
                "direct_dependencies": envelope["direct_dependencies"],
                "executor_receipts": envelope["executor_receipts"],
            }
        )
    )


def load_recorded_attempts(
    runs: list[StoredSectionRun],
    evaluations: list[CandidateEvaluation],
    section_package_id: str,
) -> tuple[RecordedAttempt, ...]:
    by_run = {item.run_id: item for item in evaluations}
    recorded = [
        RecordedAttempt(
            candidate=run.candidate,
            envelope=run.envelope,
            evaluation=by_run.get(run.receipt.run_id),
        )
        for run in runs
        if run.receipt.section_package_id == section_package_id
    ]
    return tuple(sorted(recorded, key=lambda item: item.candidate.attempt))


def retry_failures(evaluation: CandidateEvaluation) -> tuple[dict[str, str], ...]:
    reasons = evaluation.next_attempt_decision.reasons
    message = "; ".join(reasons) or "Structured failure from the prior Candidate Attempt"
    return tuple(
        {
            "result_id": receipt_id,
            "code": "cycle-retry",
            "message": message,
        }
        for receipt_id in evaluation.next_attempt_decision.blocking_receipt_ids
    )


def admit_attempt(
    recorded: tuple[RecordedAttempt, ...],
    proposed: CycleFingerprint,
) -> Admission:
    if not recorded:
        return StartAttempt(
            kind="start",
            attempt=1,
            drafting_cycle_id=DRAFTING_CYCLE_ID,
            retry_failures=(),
        )
    if len(recorded) >= MAX_ATTEMPTS:
        return RejectAttempt(
            kind="reject",
            message="This drafting cycle already used three Candidate Attempts",
        )
    latest = recorded[-1]
    if latest.evaluation is None:
        return RejectAttempt(
            kind="reject",
            message="Evaluate the current Candidate Attempt before starting another",
        )
    decision = latest.evaluation.next_attempt_decision
    if decision.action != "retry":
        if decision.action == "stop_for_review":
            return RejectAttempt(
                kind="reject",
                message="This drafting cycle stopped after three Candidate Attempts",
            )
        return RejectAttempt(
            kind="reject",
            message="A new invocation can start only after provenance or conformance failure",
        )
    origin = cycle_fingerprint(recorded[0].envelope)
    if origin != proposed:
        return RejectAttempt(
            kind="reject",
            message="A retry must retain the cycle's governed inputs",
        )
    return StartAttempt(
        kind="start",
        attempt=latest.candidate.attempt + 1,
        drafting_cycle_id=latest.candidate.drafting_cycle_id,
        retry_failures=retry_failures(latest.evaluation),
    )
