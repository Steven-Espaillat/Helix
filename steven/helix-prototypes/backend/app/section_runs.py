import hashlib
import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from jsonschema import Draft202012Validator
from sqlalchemy.orm import Session

from .agents.codex_section_agent import SectionAgent
from .repository import StudyPackageRepository
from .review_scaffolds import assemble_review_scaffold, record_if_changed
from .schemas import (
    ClaimStatus,
    PinnedRun,
    SectionDraftCandidate,
    SectionRunCommand,
    SectionRunEligibility,
    SectionRunReceipt,
    StudyEvidencePackage,
    WorkflowEvent,
)
from .template_contracts import evaluate_template_contract, impact_set_for

SECTION_PACKAGE_ID = "section.5_2_3_body_weight"
SECTION_ID = "5_2_3_body_weight"
CLAIM_ID = "C-BW-HIGH"
SKILL_NAME = "helix-section-agent"


class SectionRunConflictError(RuntimeError):
    pass


class SectionRunUnavailableError(RuntimeError):
    pass


class CandidateValidationError(ValueError):
    pass


class UnknownSectionPackageError(ValueError):
    pass


def canonical_hash(value: object) -> str:
    encoded = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def manifest_fingerprint(package: StudyEvidencePackage) -> str:
    return canonical_hash([item.model_dump(mode="json") for item in package.manifest])


def governed_versions_fingerprint(pinned_run: PinnedRun) -> str:
    return canonical_hash(pinned_run.run_plan.governed_versions)


class SectionRunService:
    def __init__(self, session: Session, agent: SectionAgent, repository_root: Path):
        self.session = session
        self.agent = agent
        self.repository_root = repository_root
        self.repository = StudyPackageRepository(session)
        self.contracts = repository_root / "skills" / "helix-evidence-pipeline" / "contracts"
        self.package_path = (
            repository_root
            / "skills"
            / "helix-evidence-pipeline"
            / "packages"
            / "sections"
            / "5_2_3_body_weight"
            / "package.json"
        )
        self.template_path = repository_root / "backend" / "app" / "data" / "report-template.json"
        self.skill_path = repository_root / ".agents" / "skills" / SKILL_NAME / "SKILL.md"

    def eligibilities(self, package: StudyEvidencePackage) -> list[SectionRunEligibility]:
        definitions = self._section_package_definitions()
        return [self._eligibility_for(package, definition, definitions) for definition in definitions]

    def eligibility(self, package: StudyEvidencePackage) -> SectionRunEligibility:
        return self.eligibility_for(package, SECTION_PACKAGE_ID)

    def eligibility_for(
        self, package: StudyEvidencePackage, section_package_id: str
    ) -> SectionRunEligibility:
        match = next(
            (
                item
                for item in self.eligibilities(package)
                if item.section_package_id == section_package_id
            ),
            None,
        )
        if match is None:
            raise UnknownSectionPackageError(f"Unknown Section Package {section_package_id}")
        return match

    def persist_contract_revision(
        self,
        package: StudyEvidencePackage,
        *,
        run_id: str,
        event_id: str,
        candidate_id: str | None = None,
    ) -> StudyEvidencePackage:
        revision = assemble_review_scaffold(
            package,
            self.eligibilities(package),
            run_id=run_id,
            event_id=event_id,
            candidate_id=candidate_id,
        )
        schema = self._load_json(self.contracts / "review-scaffold-revision.schema.json")
        return record_if_changed(package, revision, schema)

    def _eligibility_for(
        self,
        package: StudyEvidencePackage,
        package_definition: dict[str, object],
        all_definitions: list[dict[str, object]],
    ) -> SectionRunEligibility:
        reasons: list[str] = []
        package_id = str(package_definition["package_id"])
        required_claim = next(
            (
                item
                for item in package_definition.get("required_claims", [])
                if item.get("claim_selector") == CLAIM_ID and item.get("required") is True
            ),
            None,
        )
        claim = next((item for item in package.claims if item.claim_id == CLAIM_ID), None)
        if claim is None or claim.status not in {ClaimStatus.VALIDATED, ClaimStatus.APPROVED}:
            reasons.append("C-BW-HIGH is not a Validated Claim")
        if (
            claim is not None
            and required_claim is not None
            and claim.grain != required_claim.get("input_grain")
        ):
            reasons.append("C-BW-HIGH does not match the Section Package input grain")
        if required_claim is None:
            reasons.append("The Section Package does not require C-BW-HIGH")
        if claim is not None and not any(edge.claim_id == CLAIM_ID for edge in package.provenance_edges):
            reasons.append("C-BW-HIGH has no provenance")
        if not package.manifest or any(not item.locked for item in package.manifest):
            reasons.append("The source manifest is not frozen")
        pinned_run = package.pinned_run
        if pinned_run is None:
            reasons.append("Freeze the authorized manifest first")
        else:
            if pinned_run.manifest_hash != manifest_fingerprint(package):
                reasons.append("The Pinned Run manifest fingerprint does not match the current manifest")
            if pinned_run.status != "planned":
                reasons.append("The Pinned Run requires study-type review")
            resolution = pinned_run.study_type_resolution
            if resolution.status == "resolved" and resolution.study_type_id not in package_definition.get(
                "study_type_ids", []
            ):
                reasons.append("The Section Package does not apply to the resolved study type")
            if not any(
                node.node_id == package_id and node.package_id == package_id
                for node in pinned_run.run_plan.nodes
            ):
                reasons.append("The Section Package is not part of the Pinned Run")
            if any(
                not (self.repository_root / item.path).is_file()
                or self._file_hash(self.repository_root / item.path) != item.content_hash
                for item in pinned_run.governed_inputs
            ):
                reasons.append("The Pinned Run governed-input fingerprint does not match")
        if self.repository.latest_event(package.study.study_id, "validation_run") is None:
            reasons.append("Run hybrid validation first")
        gate_results = evaluate_template_contract(package_definition, self._load_json(self.template_path))
        reasons.extend(item.message for item in gate_results if item.status == "blocked")
        if package_definition.get("maturity") != "vertical_slice":
            reasons.append("The Section Package is not the vertical slice")
        if package_definition.get("promotion_allowed") is not False:
            reasons.append("The Section Package must prohibit promotion")
        return SectionRunEligibility(
            section_package_id=package_id,
            eligible=not reasons,
            reasons=reasons,
            gate_results=gate_results,
            impact_set=impact_set_for(package_id, all_definitions),
        )

    def _section_package_definitions(self) -> list[dict[str, object]]:
        directory = (
            self.repository_root / "skills" / "helix-evidence-pipeline" / "packages" / "sections"
        )
        return [self._load_json(path) for path in sorted(directory.glob("*/package.json"))]

    def run(self, study_id: str, command: SectionRunCommand) -> SectionRunReceipt:
        request_hash = canonical_hash(
            {"study_id": study_id, "section_package_id": command.section_package_id}
        )
        prior_receipt = self._replay(study_id, command.idempotency_key, request_hash)
        if prior_receipt is not None:
            return prior_receipt
        if command.section_package_id != SECTION_PACKAGE_ID:
            raise UnknownSectionPackageError(f"Unknown Section Package {command.section_package_id}")

        package = self.repository.get(study_id, for_update=True)
        prior_receipt = self._replay(study_id, command.idempotency_key, request_hash)
        if prior_receipt is not None:
            return prior_receipt
        eligibility = self.eligibility_for(package, command.section_package_id)
        if not eligibility.eligible:
            if any(item.status == "blocked" for item in eligibility.gate_results):
                event_id = f"EV-{uuid4().hex[:12].upper()}"
                blocked_run_id = (
                    package.pinned_run.run_id
                    if package.pinned_run is not None
                    else f"RUN-{uuid4().hex[:12].upper()}"
                )
                updated = self.persist_contract_revision(
                    package,
                    run_id=blocked_run_id,
                    event_id=event_id,
                )
                if updated.review_scaffold_revisions != package.review_scaffold_revisions:
                    self.repository.save(updated)
                    self.session.commit()
            raise SectionRunConflictError("; ".join(eligibility.reasons))
        pinned_run = package.pinned_run
        if pinned_run is None:
            raise SectionRunConflictError("Freeze the authorized manifest first")

        run_id = f"SRUN-{uuid4().hex[:12].upper()}"
        envelope = self._build_envelope(package, run_id, pinned_run)
        envelope_hash = canonical_hash(envelope)
        row = self.repository.add_section_run(
            run_id=run_id,
            study_id=study_id,
            section_package_id=SECTION_PACKAGE_ID,
            idempotency_key=command.idempotency_key,
            request_hash=request_hash,
            envelope=envelope,
        )
        candidate_schema = self._load_json(self.contracts / "section-draft-candidate.schema.json")
        skill_hash = self._file_hash(self.skill_path)
        candidate_id = f"SDC-{uuid4().hex[:12].upper()}"
        prompt = self._prompt(
            envelope=envelope,
            candidate_id=candidate_id,
            thread_receipt_instruction=(
                "Set agent_receipt.thread_id to {{CODEX_THREAD_ID}}. "
                f"Set skill_name to {SKILL_NAME} and skill_hash to {skill_hash}."
            ),
        )
        try:
            result = self.agent.run(
                envelope_id=str(envelope["envelope_id"]),
                prompt=prompt,
                output_schema=candidate_schema,
            )
        except Exception as error:
            self.session.rollback()
            raise SectionRunUnavailableError("The Codex SDK section run failed") from error
        try:
            candidate = self._validate_candidate(
                result.final_response,
                schema=candidate_schema,
                run_id=run_id,
                candidate_id=candidate_id,
                thread_id=result.thread_id,
                skill_hash=skill_hash,
                executor_receipt_ids=[
                    str(receipt["artifact_id"]) for receipt in envelope["executor_receipts"]
                ],
            )
            now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            event_id = f"EV-{uuid4().hex[:12].upper()}"
            package = self.persist_contract_revision(
                package,
                run_id=run_id,
                event_id=event_id,
                candidate_id=candidate.candidate_id,
            )
            revision = package.review_scaffold_revisions[-1]
            receipt = SectionRunReceipt(
                run_id=run_id,
                section_id=SECTION_ID,
                section_package_id=SECTION_PACKAGE_ID,
                status="candidate_recorded",
                candidate_id=candidate.candidate_id,
                candidate_hash=canonical_hash(candidate.model_dump(mode="json")),
                envelope_hash=envelope_hash,
                agent_runtime="codex_sdk",
                codex_thread_id=result.thread_id,
                skill_name=SKILL_NAME,
                skill_hash=skill_hash,
                review_scaffold_revision=int(revision["sequence"]),
            )
            row.candidate = candidate.model_dump(mode="json")
            row.receipt = receipt.model_dump(mode="json")
            row.review_scaffold = revision
            event = WorkflowEvent(
                event_id=event_id,
                event="section_candidate_recorded",
                actor="HELIX Codex section runtime",
                timestamp=now,
                outcome="candidate_recorded",
                details={
                    "run_id": run_id,
                    "candidate_id": candidate.candidate_id,
                    "codex_thread_id": result.thread_id,
                    "review_scaffold_revision": int(revision["sequence"]),
                },
            )
            updated = package.model_copy(update={"events": [*package.events, event]})
            self.repository.save(updated)
            self.repository.append_event(
                study_id=study_id,
                event_type=event.event,
                actor=event.actor,
                payload={"outcome": event.outcome, **event.details},
                idempotency_key=f"section-run:{command.idempotency_key}",
                occurred_at=datetime.fromisoformat(now.replace("Z", "+00:00")),
            )
            self.session.commit()
            return receipt
        except Exception:
            self.session.rollback()
            raise

    def _replay(
        self,
        study_id: str,
        idempotency_key: str,
        request_hash: str,
    ) -> SectionRunReceipt | None:
        prior = self.repository.get_section_run(study_id, idempotency_key)
        if prior is None:
            return None
        if prior.request_hash != request_hash:
            raise SectionRunConflictError("The idempotency key was already used for another command")
        if prior.receipt is None:
            raise SectionRunConflictError("The prior section run did not complete")
        return SectionRunReceipt.model_validate(prior.receipt)

    def _build_envelope(
        self,
        package: StudyEvidencePackage,
        run_id: str,
        pinned_run: PinnedRun,
    ) -> dict[str, object]:
        claim = next(item for item in package.claims if item.claim_id == CLAIM_ID)
        package_definition = self._load_json(self.package_path)
        claim_value = claim.model_dump(mode="json")
        envelope = {
            "schema_version": "helix.section-execution-envelope/v1",
            "envelope_id": f"ENV-{uuid4().hex[:12].upper()}",
            "run_id": run_id,
            "pinned_run_id": pinned_run.run_id,
            "run_plan_hash": pinned_run.run_plan.fingerprint,
            "manifest_hash": manifest_fingerprint(package),
            "section_package": {
                "package_id": SECTION_PACKAGE_ID,
                "version": package_definition["version"],
                "path": str(self.package_path.relative_to(self.repository_root)),
                "hash": self._file_hash(self.package_path),
            },
            "direct_dependencies": [
                {
                    "artifact_id": "validation.body_weight",
                    "hash": canonical_hash(
                        [
                            item.model_dump(mode="json")
                            for item in package.validation_results
                            if item.scope_id in {CLAIM_ID, "S5"}
                        ]
                    ),
                }
            ],
            "validated_claims": [
                {
                    "claim_id": claim.claim_id,
                    "field_id": claim.field_id,
                    "value": claim.value,
                    "unit": claim.unit,
                    "grain": claim.grain,
                    "hash": canonical_hash(claim_value),
                }
            ],
            "study_context": {
                "study_id": package.study.study_id,
                "study_type_id": package.study.study_type_id,
                "group": "high-dose",
                "timepoint": "terminal",
            },
            "structured_failures": [
                {
                    "result_id": result.result_id,
                    "code": result.rule_id,
                    "message": result.message,
                }
                for result in package.validation_results
                if result.result_id == "VR-004" and result.status == "fail"
            ],
            "executor_receipts": [
                {
                    "artifact_id": "EXEC-BW-SUMMARY-001",
                    "hash": canonical_hash(
                        [
                            edge.model_dump(mode="json")
                            for edge in package.provenance_edges
                            if edge.claim_id == CLAIM_ID
                        ]
                    ),
                }
            ],
            "governed_versions": pinned_run.run_plan.governed_versions,
        }
        schema = self._load_json(self.contracts / "section-execution-envelope.schema.json")
        errors = list(Draft202012Validator(schema).iter_errors(envelope))
        if errors:
            raise CandidateValidationError(errors[0].message)
        return envelope

    def _validate_candidate(
        self,
        response: str,
        *,
        schema: dict[str, object],
        run_id: str,
        candidate_id: str,
        thread_id: str,
        skill_hash: str,
        executor_receipt_ids: list[str],
    ) -> SectionDraftCandidate:
        try:
            raw = json.loads(response)
        except json.JSONDecodeError as error:
            raise CandidateValidationError("Codex returned malformed candidate JSON") from error
        errors = sorted(Draft202012Validator(schema).iter_errors(raw), key=lambda item: list(item.path))
        if errors:
            raise CandidateValidationError(f"Codex candidate failed schema validation: {errors[0].message}")
        candidate = SectionDraftCandidate.model_validate(raw)
        expected = {
            "run_id": run_id,
            "candidate_id": candidate_id,
            "section_id": SECTION_ID,
            "section_package_id": SECTION_PACKAGE_ID,
            "section_package_version": "0.1.0",
        }
        for field, value in expected.items():
            if getattr(candidate, field) != value:
                raise CandidateValidationError(f"Codex candidate returned an invalid {field}")
        if candidate.validated_claim_ids != [CLAIM_ID]:
            raise CandidateValidationError("Codex candidate cited an unapproved claim")
        for claim_ids in self._nested_claim_id_lists(candidate.content_blocks):
            if not isinstance(claim_ids, list) or len(claim_ids) != 1 or set(claim_ids) != {CLAIM_ID}:
                raise CandidateValidationError("Codex candidate content cited an unapproved claim")
        for block in candidate.content_blocks:
            content_fragments = self._content_fragments(block)
            factual_spans = block.get("factual_spans")
            span_fragments = (
                [span.get("text") for span in factual_spans if isinstance(span, dict)]
                if isinstance(factual_spans, list)
                else []
            )
            if Counter(content_fragments) != Counter(span_fragments):
                raise CandidateValidationError("Codex candidate factual spans do not cover the block content")
        if len(candidate.executor_receipt_ids) != len(executor_receipt_ids) or set(
            candidate.executor_receipt_ids
        ) != set(executor_receipt_ids):
            raise CandidateValidationError("Codex candidate returned invalid executor receipts")
        receipt = candidate.agent_receipt
        if receipt != {
            "runtime": "codex_sdk",
            "thread_id": thread_id,
            "skill_name": SKILL_NAME,
            "skill_hash": skill_hash,
        }:
            raise CandidateValidationError("Codex candidate omitted or changed its runtime receipt")
        if "286.2 g" not in json.dumps(candidate.content_blocks, ensure_ascii=False):
            raise CandidateValidationError("Codex candidate did not preserve the validated value 286.2 g")
        return candidate

    def _prompt(
        self,
        *,
        envelope: dict[str, object],
        candidate_id: str,
        thread_receipt_instruction: str,
    ) -> str:
        return (
            f"Invoke ${SKILL_NAME} for the one persisted SectionExecutionEnvelope below. "
            "Return exactly one JSON object that matches the supplied output schema. "
            f"Use candidate_id {candidate_id}, run_id {envelope['run_id']}, section_id {SECTION_ID}, "
            f"section_package_id {SECTION_PACKAGE_ID}, section_package_version 0.1.0, "
            "drafting_cycle_id CYCLE-BW-001, and attempt 1. Cite only C-BW-HIGH. "
            "Write one factual span containing the exact text '286.2 g'. "
            f"{thread_receipt_instruction} Envelope: "
            f"{json.dumps(envelope, separators=(',', ':'), sort_keys=True)}"
        )

    @staticmethod
    def _content_fragments(block: dict[str, object]) -> list[str]:
        content = block.get("content")
        if isinstance(content, str):
            return [content]
        if not isinstance(content, dict):
            return []
        rows = content.get("rows")
        if not isinstance(rows, list):
            return []
        return [
            str(cell["text"])
            for row in rows
            if isinstance(row, dict) and isinstance(row.get("cells"), list)
            for cell in row["cells"]
            if isinstance(cell, dict) and "text" in cell
        ]

    @classmethod
    def _nested_claim_id_lists(cls, value: object):
        if isinstance(value, dict):
            for key, nested_value in value.items():
                if key == "claim_ids":
                    yield nested_value
                yield from cls._nested_claim_id_lists(nested_value)
        elif isinstance(value, list):
            for item in value:
                yield from cls._nested_claim_id_lists(item)

    @staticmethod
    def _load_json(path: Path) -> dict[str, object]:
        return json.loads(path.read_text())

    @staticmethod
    def _file_hash(path: Path) -> str:
        return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"
