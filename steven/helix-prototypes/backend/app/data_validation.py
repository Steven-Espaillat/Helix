import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from sqlalchemy.orm import Session

from .body_weight import (
    EXECUTOR_ID,
    EXECUTOR_VERSION,
    FIXTURE_PATH,
    OUTPUT_GRAIN,
    PACKAGE_ID,
    PACKAGE_VERSION,
    SOURCE_ARTIFACT_ID,
    TERMINAL_CLAIM_ID,
    BodyWeightComputation,
    compute_body_weight_summary,
    file_hash,
    load_frozen_fixture,
    load_section_consumers,
    provenance_failures,
    recompute_matches_fixture,
)
from .models import DataValidationRunRow
from .repository import StudyPackageRepository
from .run_plans import PinnedRunService, canonical_hash
from .schemas import (
    Claim,
    DataValidationCommand,
    DataValidationExecution,
    DataValidationReceipt,
    DataValidationRuleResult,
    FreezeRunCommand,
    PinnedRun,
    ProvenanceEdge,
    SectionClaimReference,
    StudyEvidencePackage,
    ValidationResult,
    ValidationStatus,
    WorkflowEvent,
)

PACKAGE_RELATIVE = Path("skills/helix-evidence-pipeline/packages/data-validation/body-weight/package.json")
EXECUTOR_RELATIVE = Path("backend/app/body_weight.py")
_RESULT_IDS = {
    "body-weight-required-grain": "VR-BW-GRAIN",
    "body-weight-summary-recompute": "VR-BW-RECOMPUTE",
    "body-weight-cell-provenance": "VR-BW-PROVENANCE",
}


EnforcementClass = Literal["hard_blocker", "review_required", "warning"]


@dataclass(frozen=True)
class EnforcementPolicy:
    blocks_claims: bool
    blocks_gate: bool
    dispositionable: bool


ENFORCEMENT_POLICIES: dict[EnforcementClass, EnforcementPolicy] = {
    "hard_blocker": EnforcementPolicy(blocks_claims=True, blocks_gate=True, dispositionable=False),
    "review_required": EnforcementPolicy(blocks_claims=True, blocks_gate=True, dispositionable=True),
    "warning": EnforcementPolicy(blocks_claims=False, blocks_gate=False, dispositionable=False),
}


@dataclass(frozen=True)
class GateRule:
    rule_id: str
    rule_version: str
    enforcement_class: EnforcementClass


def policy_for(enforcement_class: EnforcementClass) -> EnforcementPolicy:
    return ENFORCEMENT_POLICIES[enforcement_class]


def load_gate_rules(package_json: Path) -> list[GateRule]:
    payload = json.loads(package_json.read_text())
    rules = payload["rules"]
    if not isinstance(rules, list):
        raise ValueError("package.json rules must be a list")
    loaded: list[GateRule] = []
    for item in rules:
        if not isinstance(item, dict):
            raise ValueError("package.json rule must be an object")
        enforcement = item["enforcement_class"]
        if not isinstance(enforcement, str) or enforcement not in ENFORCEMENT_POLICIES:
            raise ValueError(f"invalid enforcement_class {enforcement}")
        loaded.append(
            GateRule(
                rule_id=str(item["rule_id"]),
                rule_version=str(item["rule_version"]),
                enforcement_class=enforcement,
            )
        )
    return loaded


def _result_id(rule_id: str) -> str:
    return _RESULT_IDS.get(rule_id, f"VR-{rule_id.upper()}")


def _gate_result(
    rule: GateRule,
    *,
    passed: bool,
    evidence_ids: list[str],
    message: str,
    scope_id: str,
    enforcement_class: EnforcementClass | None = None,
) -> DataValidationRuleResult:
    return DataValidationRuleResult(
        result_id=_result_id(rule.rule_id),
        rule_id=rule.rule_id,
        rule_version=rule.rule_version,
        enforcement_class=enforcement_class or rule.enforcement_class,
        status=ValidationStatus.PASS if passed else ValidationStatus.FAIL,
        scope_id=scope_id,
        evidence_ids=evidence_ids,
        message=message,
        waivable=False,
        package_id=PACKAGE_ID,
        executor_id=EXECUTOR_ID,
    )


def _evaluate_grain(
    rule: GateRule,
    computation: BodyWeightComputation,
    _fixture: dict[str, object],
) -> DataValidationRuleResult:
    grain_ids = [issue.record_id for issue in computation.grain_issues]
    passed = not computation.grain_issues
    return _gate_result(
        rule,
        passed=passed,
        evidence_ids=grain_ids or [OUTPUT_GRAIN],
        message=(
            "Every body-weight record has grain and projects to study_day × sex × dose_group."
            if passed
            else (
                f"{len(computation.grain_issues)} body-weight records are missing grain "
                "or a provenance edge required to project study_day × sex × dose_group."
            )
        ),
        scope_id=PACKAGE_ID,
    )


def _evaluate_recompute(
    rule: GateRule,
    computation: BodyWeightComputation,
    fixture: dict[str, object],
) -> DataValidationRuleResult:
    matched, recompute_evidence = recompute_matches_fixture(computation, fixture)
    return _gate_result(
        rule,
        passed=matched,
        evidence_ids=recompute_evidence or [TERMINAL_CLAIM_ID, str(FIXTURE_PATH)],
        message=(
            "Recomputed body-weight summaries match the frozen fixture."
            if matched
            else "Recomputed body-weight summaries do not match the frozen fixture."
        ),
        scope_id=TERMINAL_CLAIM_ID,
    )


def _evaluate_provenance(
    rule: GateRule,
    computation: BodyWeightComputation,
    _fixture: dict[str, object],
) -> DataValidationRuleResult:
    provenance_evidence = provenance_failures(computation)
    passed = not provenance_evidence
    return _gate_result(
        rule,
        passed=passed,
        evidence_ids=provenance_evidence or [edge.edge_id for edge in computation.provenance_edges[:12]],
        message=(
            "Every numeric body-weight claim has complete hashes, transforms, and edges."
            if passed
            else "A body-weight claim is missing a provenance edge, source hash, or transform."
        ),
        scope_id=PACKAGE_ID,
    )


def _unknown_gate(rule: GateRule) -> DataValidationRuleResult:
    return _gate_result(
        rule,
        passed=False,
        evidence_ids=[rule.rule_id],
        message=f"No evaluator is registered for rule {rule.rule_id}.",
        scope_id=PACKAGE_ID,
        enforcement_class="hard_blocker",
    )


_EVALUATORS = {
    "body-weight-required-grain": _evaluate_grain,
    "body-weight-summary-recompute": _evaluate_recompute,
    "body-weight-cell-provenance": _evaluate_provenance,
}


def _evaluate_gate(
    rule: GateRule,
    computation: BodyWeightComputation,
    fixture: dict[str, object],
) -> DataValidationRuleResult:
    evaluator = _EVALUATORS.get(rule.rule_id)
    if evaluator is None:
        return _unknown_gate(rule)
    return evaluator(rule, computation, fixture)


class DataValidationConflictError(RuntimeError):
    pass


class UnknownValidationPackageError(ValueError):
    pass


class DataValidationService:
    def __init__(self, session: Session, pinned_runs: PinnedRunService, repository_root: Path):
        self.session = session
        self.pinned_runs = pinned_runs
        self.repository_root = repository_root.resolve()
        self.repository = StudyPackageRepository(session)

    def execute(
        self,
        study_id: str,
        command: DataValidationCommand,
        *,
        commit: bool = True,
    ) -> DataValidationExecution:
        if command.package_id != PACKAGE_ID:
            raise UnknownValidationPackageError(f"Unknown Data Validation Package {command.package_id}")
        package = self.repository.get(study_id)
        if package.pinned_run is None:
            self.pinned_runs.freeze(
                study_id,
                FreezeRunCommand(
                    actor=command.actor,
                    idempotency_key=f"dvp-freeze-{study_id}",
                ),
            )
            package = self.repository.get(study_id)
        pinned = package.pinned_run
        if pinned is None:
            raise DataValidationConflictError("Freeze the authorized manifest first")
        if pinned.status != "planned":
            raise DataValidationConflictError("The Pinned Run requires study-type review")
        node = next((item for item in pinned.run_plan.nodes if item.node_id == PACKAGE_ID), None)
        if node is None or node.status == "blocked":
            raise DataValidationConflictError("validation.body_weight is not executable in this Pinned Run")

        prior = self.repository.get_data_validation_run(study_id, command.idempotency_key)
        if prior is not None:
            if prior.run_id != pinned.run_id or prior.package_id != command.package_id:
                raise DataValidationConflictError("The idempotency key was already used for another command")
            return self._replay(prior)

        existing = self.repository.get_data_validation_for_run(study_id, pinned.run_id, command.package_id)
        if existing is not None:
            self.repository.add_data_validation_alias(
                existing,
                idempotency_key=command.idempotency_key,
            )
            if commit:
                self.session.commit()
            return self._replay(existing)

        package = self.repository.get(study_id, for_update=True)
        pinned = package.pinned_run
        if pinned is None:
            raise DataValidationConflictError("Freeze the authorized manifest first")
        existing = self.repository.get_data_validation_for_run(study_id, pinned.run_id, command.package_id)
        if existing is not None:
            self.repository.add_data_validation_alias(existing, idempotency_key=command.idempotency_key)
            if commit:
                self.session.commit()
            return self._replay(existing)

        execution = self._run(package, pinned, command)
        stored = execution.model_copy(
            update={"receipt": execution.receipt.model_copy(update={"idempotent_replay": False})}
        )
        updated = self._persist_execution(package, stored)
        self.repository.save(updated)
        self.repository.add_data_validation_run(
            study_id=study_id,
            run_id=pinned.run_id,
            package_id=command.package_id,
            idempotency_key=command.idempotency_key,
            execution=stored,
        )
        self.repository.append_event(
            study_id=study_id,
            event_type=stored.event.event,
            actor=stored.event.actor,
            payload={"outcome": stored.event.outcome, **stored.event.details},
            idempotency_key=f"dvp:{pinned.run_id}:{command.package_id}",
            occurred_at=datetime.fromisoformat(stored.event.timestamp.replace("Z", "+00:00")),
        )
        if commit:
            self.session.commit()
        return stored

    def _run(
        self,
        package: StudyEvidencePackage,
        pinned: PinnedRun,
        command: DataValidationCommand,
    ) -> DataValidationExecution:
        rules = load_gate_rules(self.repository_root / PACKAGE_RELATIVE)
        rule_versions = {rule.rule_id: rule.rule_version for rule in rules}
        computation = compute_body_weight_summary(package, rule_versions=rule_versions)
        fixture = load_frozen_fixture(self.repository_root)
        results = self._rule_results(computation, fixture, rules)
        blocked = any(
            result.status == ValidationStatus.FAIL
            and policy_for(result.enforcement_class).blocks_claims
            for result in results
        )
        claims = [] if blocked else computation.claims
        edges = [] if blocked else computation.provenance_edges
        created_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        receipt_seed = canonical_hash(
            {
                "run_id": pinned.run_id,
                "package_id": PACKAGE_ID,
                "package_hash": file_hash(self.repository_root / PACKAGE_RELATIVE),
                "executor_hash": file_hash(self.repository_root / EXECUTOR_RELATIVE),
                "claim_ids": [claim.claim_id for claim in claims],
                "result_ids": [result.result_id for result in results],
            }
        )
        event_id = f"EV-DVP-{receipt_seed.removeprefix('sha256:')[16:28].upper()}"
        receipt = DataValidationReceipt(
            receipt_id=f"RCP-DVP-{receipt_seed.removeprefix('sha256:')[:16].upper()}",
            run_id=pinned.run_id,
            package_id=PACKAGE_ID,
            package_version=PACKAGE_VERSION,
            package_hash=file_hash(self.repository_root / PACKAGE_RELATIVE),
            node_id=PACKAGE_ID,
            executor_id=EXECUTOR_ID,
            executor_version=EXECUTOR_VERSION,
            executor_hash=file_hash(self.repository_root / EXECUTOR_RELATIVE),
            rule_bundle_id=PACKAGE_ID,
            rule_ids=[rule.rule_id for rule in rules],
            source_artifact_id=SOURCE_ARTIFACT_ID,
            source_hash=self._source_hash(package),
            governed_versions=pinned.run_plan.governed_versions,
            input_fingerprint=self._input_fingerprint(pinned),
            claim_ids=[claim.claim_id for claim in claims],
            result_ids=[result.result_id for result in results],
            event_id=event_id,
            status="blocked" if blocked else "passed",
            idempotent_replay=False,
        )
        event = WorkflowEvent(
            event_id=event_id,
            event="data_validation_completed",
            actor=command.actor,
            timestamp=created_at,
            outcome=receipt.status,
            details={
                "run_id": pinned.run_id,
                "package_id": PACKAGE_ID,
                "receipt_id": receipt.receipt_id,
                "executor_id": EXECUTOR_ID,
                "source_artifact_id": SOURCE_ARTIFACT_ID,
            },
        )
        references = [
            SectionClaimReference(
                section_id=section_id,
                section_package_id=section_package_id,
                title=title,
                claim_id=TERMINAL_CLAIM_ID,
                executor_receipt_id=receipt.receipt_id,
            )
            for section_id, section_package_id, title in load_section_consumers(self.repository_root)
            if TERMINAL_CLAIM_ID in receipt.claim_ids
        ]
        return DataValidationExecution(
            receipt=receipt,
            claims=claims,
            results=results,
            provenance_edges=edges,
            section_references=references,
            event=event,
        )

    def _rule_results(
        self,
        computation: BodyWeightComputation,
        fixture: dict[str, object],
        rules: list[GateRule],
    ) -> list[DataValidationRuleResult]:
        return [_evaluate_gate(rule, computation, fixture) for rule in rules]

    def _persist_execution(
        self,
        package: StudyEvidencePackage,
        execution: DataValidationExecution,
    ) -> StudyEvidencePackage:
        executions = [
            item
            for item in package.data_validation_executions
            if not (
                item.receipt.run_id == execution.receipt.run_id
                and item.receipt.package_id == execution.receipt.package_id
            )
        ]
        executions.append(execution)
        claims = _upsert_claims(package.claims, execution.claims)
        edges = _upsert_edges(package.provenance_edges, execution.provenance_edges)
        events = [*package.events, execution.event]
        return package.model_copy(
            update={
                "data_validation_executions": executions,
                "claims": claims,
                "provenance_edges": edges,
                "events": events,
            }
        )

    def _replay(self, row: DataValidationRunRow) -> DataValidationExecution:
        execution = DataValidationExecution.model_validate(row.execution)
        return execution.model_copy(
            update={"receipt": execution.receipt.model_copy(update={"idempotent_replay": True})}
        )

    @staticmethod
    def _source_hash(package: StudyEvidencePackage) -> str:
        artifact = next((item for item in package.manifest if item.artifact_id == SOURCE_ARTIFACT_ID), None)
        if artifact is None:
            raise DataValidationConflictError("The pinned run is missing the body-weight source artifact")
        return artifact.checksum

    @staticmethod
    def _input_fingerprint(pinned: PinnedRun) -> str:
        node = next(item for item in pinned.run_plan.nodes if item.node_id == PACKAGE_ID)
        return node.input_fingerprint


def as_validation_results(execution: DataValidationExecution) -> list[ValidationResult]:
    return [
        ValidationResult(
            result_id=result.result_id,
            rule_id=result.rule_id,
            scope_id=result.scope_id,
            severity="blocker" if result.enforcement_class != "warning" else "warning",
            status=result.status,
            evidence_ids=result.evidence_ids,
            message=result.message,
            rule_version=result.rule_version,
            tool_name=result.executor_id,
            enforcement_class=result.enforcement_class,
            waivable=result.waivable,
            package_id=result.package_id,
            executor_id=result.executor_id,
        )
        for result in execution.results
    ]


def _upsert_claims(existing: list[Claim], produced: list[Claim]) -> list[Claim]:
    if not produced:
        return existing
    incoming = {claim.claim_id: claim for claim in produced}
    claims: list[Claim] = []
    seen: set[str] = set()
    for claim in existing:
        replacement = incoming.get(claim.claim_id)
        if replacement is not None:
            claims.append(replacement)
            seen.add(claim.claim_id)
        else:
            claims.append(claim)
    claims.extend(claim for claim in produced if claim.claim_id not in seen)
    return claims


def _upsert_edges(
    existing: list[ProvenanceEdge],
    produced: list[ProvenanceEdge],
) -> list[ProvenanceEdge]:
    if not produced:
        return existing
    produced_ids = {edge.claim_id for edge in produced}
    retained = [edge for edge in existing if edge.claim_id not in produced_ids]
    return [*retained, *produced]
