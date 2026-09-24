import hashlib
import json
from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError
from sqlalchemy.orm import Session

from .repository import StudyPackageRepository
from .schemas import (
    FreezeRunCommand,
    GovernedArtifact,
    PinnedRun,
    PlanningEvidence,
    RunPlan,
    RunPlanNode,
    StudyEvidencePackage,
    StudyTypeResolution,
)


def canonical_hash(value: object) -> str:
    encoded = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def file_hash(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


class RunConflictError(RuntimeError):
    pass


class RunPlanRejectedError(ValueError):
    def __init__(self, evidence: list[PlanningEvidence]):
        self.evidence = evidence
        super().__init__("Run Plan rejected")


@dataclass(frozen=True)
class DeclaredGovernedIdentity:
    kind: str
    artifact_id: str
    version: str
    source_package_id: str
    declared_path: str | None = None


IMPLEMENTATION_PATHS = {
    ("executor", "body-weight-summary", "1.0.0"): "backend/app/body_weight.py",
    ("skill", "helix-section-agent", "0.1.0"): ".agents/skills/helix-section-agent/SKILL.md",
    (
        "suite",
        "helix-section-agent-qualification",
        "0.1.0",
    ): ".agents/skills/helix-section-agent/evals/promptfooconfig.yaml",
    (
        "suite",
        "helix-section-study-output",
        "0.1.0",
    ): ".agents/skills/helix-section-agent/evals/study-output.yaml",
}


class PinnedRunService:
    def __init__(self, session: Session, repository_root: Path):
        self.session = session
        self.repository_root = repository_root.resolve()
        self.repository = StudyPackageRepository(session)
        self.pipeline_root = self.repository_root / "skills" / "helix-evidence-pipeline"
        self.contracts_root = self.pipeline_root / "contracts"
        self.packages_root = self.pipeline_root / "packages"
        self.authorized_manifest_path = (
            self.repository_root / "backend" / "app" / "data" / "authorized-manifest.json"
        )
        self.study_type_mapping_path = (
            self.repository_root / "backend" / "app" / "data" / "study-type-mapping.json"
        )

    def freeze(self, study_id: str, command: FreezeRunCommand) -> PinnedRun:
        package_snapshot = self.repository.get(study_id)
        request_hash = canonical_hash(
            {
                "study_id": study_id,
                "actor": command.actor,
                "manifest": [item.model_dump(mode="json") for item in package_snapshot.manifest],
            }
        )
        prior = self.repository.get_pinned_run(study_id, command.idempotency_key)
        if prior is not None:
            if prior.request_hash != request_hash:
                raise RunConflictError("The idempotency key was already used for another command")
            return self._stored_run(self.repository.get(study_id))

        package = self.repository.get(study_id, for_update=True)
        prior = self.repository.get_pinned_run(study_id, command.idempotency_key)
        if prior is not None:
            if prior.request_hash != request_hash:
                raise RunConflictError("The idempotency key was already used for another command")
            return self._stored_run(package)

        manifest_hash = canonical_hash([item.model_dump(mode="json") for item in package.manifest])
        manifest_evidence = self._validate_manifest(package)
        if manifest_evidence:
            raise RunPlanRejectedError(manifest_evidence)

        governed, package_definitions, evidence = self._load_governed_inputs()
        if evidence:
            raise RunPlanRejectedError(evidence)

        resolution = self._resolve_study_type(package)
        package_definitions = self._applicable_packages(package_definitions, resolution)
        package_ids = {str(item["package_id"]) for item in package_definitions}
        governed = [
            item
            for item in governed
            if item.kind not in {"data_validation_package", "section_package"}
            or item.artifact_id in package_ids
        ]
        declared_inputs, evidence = self._pin_declared_identities(package_definitions)
        if evidence:
            raise RunPlanRejectedError(evidence)
        governed.extend(declared_inputs)
        governed.sort(key=lambda item: (item.kind, item.artifact_id, item.version))

        run_seed = canonical_hash(
            {
                "study_id": study_id,
                "manifest_hash": manifest_hash,
                "governed_inputs": [item.model_dump(mode="json") for item in governed],
                "mapping": resolution.model_dump(mode="json"),
            }
        )
        run_id = f"RUN-{run_seed.removeprefix('sha256:')[:16].upper()}"
        current = package.pinned_run
        superseded = list(package.superseded_pinned_runs)
        if current is not None:
            if current.run_id == run_id:
                self.repository.add_pinned_run(
                    run_id=run_id,
                    study_id=study_id,
                    idempotency_key=command.idempotency_key,
                    request_hash=request_hash,
                )
                self.session.commit()
                return current
            if command.supersession is None:
                raise RunConflictError("The study already has a different immutable Pinned Run")
            if command.supersession.predecessor_run_id != current.run_id:
                raise RunConflictError("Supersession must name the current Pinned Run")
            superseded.append(current)
        elif command.supersession is not None:
            raise RunConflictError("Supersession requires a current Pinned Run")
        created_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        plan = self._build_plan(
            package_definitions,
            governed,
            resolution,
            run_id,
            created_at,
            manifest_hash,
        )

        event = {
            "event_id": f"EV-{run_seed.removeprefix('sha256:')[16:32].upper()}",
            "event": "run_requested",
            "actor": command.actor,
            "timestamp": created_at,
            "outcome": "needs_review" if resolution.status != "resolved" else "planned",
            "details": {
                "run_id": run_id,
                "manifest_hash": manifest_hash,
                "run_plan_fingerprint": plan.fingerprint,
            },
        }
        receipt = {
            "receipt_id": f"RCP-{run_seed.removeprefix('sha256:')[32:48].upper()}",
            "run_id": run_id,
            "manifest_hash": manifest_hash,
            "run_plan_fingerprint": plan.fingerprint,
            "governed_inputs_fingerprint": canonical_hash(
                [item.model_dump(mode="json") for item in governed]
            ),
            "event_id": event["event_id"],
        }
        pinned = PinnedRun(
            run_id=run_id,
            study_id=study_id,
            status="needs_review" if resolution.status != "resolved" else "planned",
            created_at=created_at,
            manifest_hash=manifest_hash,
            governed_inputs=governed,
            study_type_resolution=resolution,
            run_plan=plan,
            receipt=receipt,
            event_history=[event],
            predecessor_run_id=(
                command.supersession.predecessor_run_id if command.supersession is not None else None
            ),
            supersession_reason=command.supersession.reason if command.supersession is not None else None,
        )
        self.repository.save(
            package.model_copy(update={"pinned_run": pinned, "superseded_pinned_runs": superseded})
        )
        self.repository.add_pinned_run(
            run_id=run_id,
            study_id=study_id,
            idempotency_key=command.idempotency_key,
            request_hash=request_hash,
        )
        self.repository.append_event(
            study_id=study_id,
            event_type="run_requested",
            actor=command.actor,
            payload={"outcome": event["outcome"], **event["details"]},
            idempotency_key=f"run-freeze:{command.idempotency_key}",
            occurred_at=datetime.fromisoformat(created_at.replace("Z", "+00:00")),
        )
        self.session.commit()
        return pinned

    def latest(self, study_id: str) -> PinnedRun | None:
        package = self.repository.get(study_id)
        if package.pinned_run is None:
            return None
        return package.pinned_run

    @staticmethod
    def _stored_run(package: StudyEvidencePackage) -> PinnedRun:
        if package.pinned_run is None:
            raise RuntimeError("Pinned Run idempotency index has no stored aggregate")
        return package.pinned_run

    def _validate_manifest(self, package: StudyEvidencePackage) -> list[PlanningEvidence]:
        authorized = self._load_json(self.authorized_manifest_path)
        authorized_by_id = {item["artifact_id"]: item for item in authorized["entries"]}
        evidence: list[PlanningEvidence] = []
        counts = Counter(item.artifact_id for item in package.manifest)
        for artifact_id, count in counts.items():
            if count > 1:
                evidence.append(
                    self._evidence("duplicate_manifest_id", artifact_id, "Manifest ID is duplicated")
                )
        for item in package.manifest:
            expected = authorized_by_id.get(item.artifact_id)
            if not item.locked:
                evidence.append(
                    self._evidence("manifest_unlocked", item.artifact_id, "Manifest entry is not locked")
                )
            if not item.authorized_by or expected is None:
                evidence.append(
                    self._evidence(
                        "manifest_unauthorized", item.artifact_id, "Manifest entry is not authorized"
                    )
                )
            elif item.model_dump(mode="json") != expected:
                code = (
                    "manifest_checksum_mismatch"
                    if item.checksum != expected["checksum"]
                    else "manifest_authorization_mismatch"
                )
                evidence.append(
                    self._evidence(
                        code, item.artifact_id, "Manifest entry differs from its authorization record"
                    )
                )
        missing = sorted(set(authorized_by_id) - set(counts))
        evidence.extend(
            self._evidence("manifest_entry_missing", artifact_id, "Authorized manifest entry is missing")
            for artifact_id in missing
        )
        return evidence

    def _load_governed_inputs(
        self,
    ) -> tuple[list[GovernedArtifact], list[dict[str, object]], list[PlanningEvidence]]:
        evidence: list[PlanningEvidence] = []
        package_definitions: list[dict[str, object]] = []
        governed: list[GovernedArtifact] = []
        package_specs = [
            (
                "data_validation_package",
                self.contracts_root / "data-validation-package.schema.json",
                self.packages_root / "data-validation",
            ),
            (
                "section_package",
                self.contracts_root / "section-package.schema.json",
                self.packages_root / "sections",
            ),
        ]
        schema_paths = set(self.contracts_root.glob("*.schema.json"))
        schema_paths.update(schema_path for _, schema_path, _ in package_specs)
        schema_paths.add(self.contracts_root / "run-plan.schema.json")
        schemas: dict[Path, dict[str, object]] = {}
        for path in sorted(schema_paths):
            schema = self._load_governed_schema(path)
            if isinstance(schema, PlanningEvidence):
                evidence.append(schema)
                continue
            schemas[path] = schema
            governed.append(self._artifact("schema", path.stem, "1.0.0", path))

        for kind, schema_path, directory in package_specs:
            schema = schemas.get(schema_path)
            if schema is None:
                continue
            for path in sorted(directory.glob("*/package.json")):
                try:
                    definition = self._load_json(path)
                except (json.JSONDecodeError, OSError) as error:
                    evidence.append(self._evidence("invalid_package_json", str(path), str(error)))
                    continue
                errors = sorted(
                    Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(definition),
                    key=lambda item: list(item.path),
                )
                if errors:
                    evidence.append(
                        self._evidence(
                            "invalid_package_schema",
                            str(path.relative_to(self.repository_root)),
                            errors[0].message,
                        )
                    )
                    continue
                package_definitions.append(definition)
                governed.append(
                    self._artifact(kind, str(definition["package_id"]), str(definition["version"]), path)
                )

        static_inputs = [
            ("ontology", "helix-ontology", "1.0.0", self.pipeline_root / "references" / "ontology.md"),
            ("ontology_schema", "helix-schema", "1.0.0", self.pipeline_root / "references" / "schema.md"),
            (
                "template",
                "repeat-dose-report-template",
                "1.0.0",
                self.repository_root / "backend" / "app" / "data" / "report-template.json",
            ),
            (
                "rule_bundle",
                "helix-rules",
                "1.0.0",
                self.repository_root / "backend" / "app" / "validation.py",
            ),
            (
                "tool",
                "codex-section-runtime",
                "0.1.0",
                self.repository_root / "backend" / "app" / "agents" / "codex_section_agent.py",
            ),
            ("study_type_mapping", "study-type-mapping", "1.0.0", self.study_type_mapping_path),
        ]
        for kind, artifact_id, version, path in static_inputs:
            if not path.is_file():
                evidence.append(
                    self._evidence("governed_input_missing", artifact_id, "Governed input is missing")
                )
            else:
                governed.append(self._artifact(kind, artifact_id, version, path))
        return governed, package_definitions, evidence

    def _load_governed_schema(
        self,
        path: Path,
    ) -> dict[str, object] | PlanningEvidence:
        subject = str(path.relative_to(self.repository_root))
        try:
            schema = self._load_json(path)
        except (json.JSONDecodeError, OSError) as error:
            return self._evidence("invalid_governed_schema", subject, str(error))
        if not isinstance(schema, dict):
            return self._evidence(
                "invalid_governed_schema",
                subject,
                "Governed schema must be a JSON object",
            )
        try:
            Draft202012Validator.check_schema(schema)
        except SchemaError as error:
            return self._evidence("invalid_governed_schema", subject, error.message)
        return schema

    @staticmethod
    def _applicable_packages(
        definitions: list[dict[str, object]],
        resolution: StudyTypeResolution,
    ) -> list[dict[str, object]]:
        if resolution.status != "resolved":
            return definitions
        return [
            definition
            for definition in definitions
            if definition["schema_version"] != "helix.section-package/v1"
            or resolution.study_type_id in definition["study_type_ids"]
        ]

    def _pin_declared_identities(
        self,
        definitions: list[dict[str, object]],
    ) -> tuple[list[GovernedArtifact], list[PlanningEvidence]]:
        identities: list[DeclaredGovernedIdentity] = []
        qualification_receipts: list[tuple[DeclaredGovernedIdentity, object]] = []
        evidence: list[PlanningEvidence] = []
        for definition in definitions:
            package_id = str(definition["package_id"])
            for executor in definition.get("executors", []):
                identities.append(
                    DeclaredGovernedIdentity(
                        kind="executor",
                        artifact_id=str(executor["id"]),
                        version=str(executor["version"]),
                        source_package_id=package_id,
                    )
                )
            skill = definition.get("skill") or definition.get("agentic_skill")
            if skill is not None:
                if skill.get("qualification_status") != "passed":
                    evidence.append(
                        self._evidence(
                            "invalid_package_qualification",
                            package_id,
                            "Agentic package qualification has not passed",
                        )
                    )
                identities.append(
                    DeclaredGovernedIdentity(
                        kind="skill",
                        artifact_id=str(skill["name"]),
                        version=str(skill["version"]),
                        source_package_id=package_id,
                    )
                )
                suite = skill["promptfoo_suite"]
                suite_identity = DeclaredGovernedIdentity(
                    kind="suite",
                    artifact_id=str(suite["id"]),
                    version=str(suite["version"]),
                    source_package_id=package_id,
                    declared_path=str(suite["path"]),
                )
                identities.append(suite_identity)
                if skill.get("qualification_status") == "passed":
                    qualification_receipts.append((suite_identity, skill.get("qualification_hash")))
            study_output_suite = definition.get("study_output_eval_suite")
            if study_output_suite is not None:
                identities.append(
                    DeclaredGovernedIdentity(
                        kind="suite",
                        artifact_id=str(study_output_suite["id"]),
                        version=str(study_output_suite["version"]),
                        source_package_id=package_id,
                        declared_path=str(study_output_suite["path"]),
                    )
                )

        selected: dict[tuple[str, str, str], DeclaredGovernedIdentity] = {}
        for identity in identities:
            key = (identity.kind, identity.artifact_id, identity.version)
            prior = selected.get(key)
            if prior is not None and prior.declared_path != identity.declared_path:
                evidence.append(
                    self._evidence(
                        "governed_implementation_mismatch",
                        identity.source_package_id,
                        f"Conflicting paths declare {identity.artifact_id}@{identity.version}",
                    )
                )
                continue
            selected[key] = identity

        governed: list[GovernedArtifact] = []
        for key, identity in sorted(selected.items()):
            relative_path = IMPLEMENTATION_PATHS.get(key)
            if relative_path is None:
                evidence.append(
                    self._evidence(
                        "governed_implementation_unavailable",
                        identity.source_package_id,
                        f"No available {identity.kind} matches {identity.artifact_id}@{identity.version}",
                    )
                )
                continue
            implementation_path = (self.repository_root / relative_path).resolve()
            if identity.declared_path is not None:
                declared_path = self._safe_governed_path(identity.declared_path)
                if declared_path != implementation_path:
                    evidence.append(
                        self._evidence(
                            "governed_implementation_mismatch",
                            identity.source_package_id,
                            f"Declared path does not match {identity.artifact_id}@{identity.version}",
                        )
                    )
                    continue
            if not implementation_path.is_file():
                evidence.append(
                    self._evidence(
                        "governed_input_missing",
                        identity.artifact_id,
                        "Governed implementation is missing",
                    )
                )
                continue
            governed.append(
                self._artifact(
                    identity.kind,
                    identity.artifact_id,
                    identity.version,
                    implementation_path,
                )
            )

        for identity, expected_hash in qualification_receipts:
            relative_path = IMPLEMENTATION_PATHS.get((identity.kind, identity.artifact_id, identity.version))
            if relative_path is None:
                continue
            suite_path = (self.repository_root / relative_path).resolve()
            if suite_path.is_file() and expected_hash != file_hash(suite_path):
                evidence.append(
                    self._evidence(
                        "invalid_package_qualification",
                        identity.source_package_id,
                        "Qualification receipt does not match its governed suite",
                    )
                )
        return governed, evidence

    def _resolve_study_type(self, package: StudyEvidencePackage) -> StudyTypeResolution:
        mapping = self._load_json(self.study_type_mapping_path)
        protocol_fields = {
            "species": package.study.species,
            "route": package.study.route,
            "duration_days": package.study.duration_days,
        }
        matches = [
            item
            for item in mapping["mappings"]
            if all(protocol_fields.get(key) == value for key, value in item["protocol_fields"].items())
        ]
        if len(matches) == 1:
            return StudyTypeResolution(
                status="resolved",
                study_type_id=matches[0]["study_type_id"],
                mapping_version=mapping["version"],
                mapping_hash=file_hash(self.study_type_mapping_path),
                protocol_fields=protocol_fields,
                evidence=[],
            )
        reason = (
            "No governed study-type mapping matched"
            if not matches
            else "Multiple governed study-type mappings matched"
        )
        return StudyTypeResolution(
            status="needs_review",
            study_type_id=None,
            mapping_version=mapping["version"],
            mapping_hash=file_hash(self.study_type_mapping_path),
            protocol_fields=protocol_fields,
            evidence=[
                self._evidence(
                    "unknown_study_type" if not matches else "ambiguous_study_type",
                    package.study.study_id,
                    f"[NEEDS REVIEW] {reason}",
                )
            ],
        )

    def _build_plan(
        self,
        definitions: list[dict[str, object]],
        governed: list[GovernedArtifact],
        resolution: StudyTypeResolution,
        run_id: str,
        created_at: str,
        manifest_hash: str,
    ) -> RunPlan:
        evidence: list[PlanningEvidence] = []
        package_ids = [str(item["package_id"]) for item in definitions]
        duplicate_ids = sorted(item for item, count in Counter(package_ids).items() if count > 1)
        evidence.extend(
            self._evidence("duplicate_node_id", item, "Package ID is duplicated") for item in duplicate_ids
        )
        definitions_by_id = {str(item["package_id"]): item for item in definitions}
        base_dependencies = {"parse.body_weights", "study_type.resolve"}
        known = set(definitions_by_id) | base_dependencies
        for definition in definitions:
            for dependency in definition["depends_on"]:
                if dependency not in known:
                    evidence.append(
                        self._evidence(
                            "missing_dependency",
                            str(definition["package_id"]),
                            f"Unknown dependency {dependency}",
                        )
                    )
        cycle = self._cycle(definitions_by_id)
        if cycle:
            evidence.append(
                self._evidence("dependency_cycle", cycle[0], "Dependency cycle: " + " -> ".join(cycle))
            )
        if evidence:
            raise RunPlanRejectedError(evidence)

        common_hashes = [item.content_hash for item in governed]
        nodes: list[RunPlanNode] = []

        def add(
            node_id: str,
            node_type: str,
            depends_on: list[str],
            governed_hashes: list[str],
            *,
            package_id: str | None = None,
            package_version: str | None = None,
            status: str = "pending",
            evidence_items: list[PlanningEvidence] | None = None,
        ) -> None:
            dependency_fingerprints = [
                next(item.input_fingerprint for item in nodes if item.node_id == dependency)
                for dependency in depends_on
            ]
            fingerprint = canonical_hash(
                {
                    "node_id": node_id,
                    "manifest_hash": manifest_hash,
                    "dependencies": dependency_fingerprints,
                    "governed_hashes": sorted(governed_hashes),
                    "study_type": resolution.model_dump(mode="json"),
                }
            )
            nodes.append(
                RunPlanNode(
                    node_id=node_id,
                    node_type=node_type,
                    package_id=package_id,
                    package_version=package_version,
                    depends_on=depends_on,
                    input_fingerprint=fingerprint,
                    status=status,
                    evidence=evidence_items or [],
                )
            )

        add("parse.body_weights", "parse", [], [manifest_hash, *common_hashes])
        add(
            "study_type.resolve",
            "study_type_resolution",
            ["parse.body_weights"],
            [resolution.mapping_hash],
            status="blocked" if resolution.status != "resolved" else "pending",
            evidence_items=resolution.evidence,
        )
        ordered = self._topological(definitions_by_id, base_dependencies)
        for package_id in ordered:
            definition = definitions_by_id[package_id]
            dependencies = list(definition["depends_on"])
            blocked = resolution.status != "resolved" and self._depends_on(
                package_id, "study_type.resolve", definitions_by_id
            )
            status = "blocked" if blocked else "pending"
            evidence_items = resolution.evidence if blocked else []
            if definition["schema_version"] == "helix.section-package/v1":
                template_node_id = f"template_contract.{package_id}"
                add(
                    template_node_id,
                    "template_contract",
                    dependencies,
                    common_hashes,
                    package_id=package_id,
                    package_version=str(definition["version"]),
                    status=status,
                    evidence_items=evidence_items,
                )
                dependencies = [template_node_id]
                node_type = "section_agent"
            else:
                node_type = "data_validation"
            add(
                package_id,
                node_type,
                dependencies,
                common_hashes,
                package_id=package_id,
                package_version=str(definition["version"]),
                status=status,
                evidence_items=evidence_items,
            )

        section_id = next((item for item in ordered if item.startswith("section.")), None)
        if section_id:
            chain = [
                (f"provenance.{section_id}", "provenance"),
                (f"study_output_evaluation.{section_id}", "study_output_evaluation"),
                (f"template_conformance.{section_id}", "template_conformance"),
                (f"section_promotion.{section_id}", "section_promotion"),
                ("review_scaffold.materialize", "review_scaffold"),
            ]
            dependency = section_id
            for node_id, node_type in chain:
                add(
                    node_id,
                    node_type,
                    [dependency],
                    common_hashes,
                    status="blocked" if resolution.status != "resolved" else "pending",
                    evidence_items=resolution.evidence if resolution.status != "resolved" else [],
                )
                dependency = node_id

        plan_payload = {
            "schema_version": "helix.run-plan/v1",
            "run_id": run_id,
            "version": 1,
            "manifest_hash": manifest_hash,
            "governed_versions": {
                item.artifact_id: f"{item.version}@{item.content_hash}" for item in governed
            },
            "nodes": [item.model_dump(mode="json") for item in nodes],
        }
        fingerprint = canonical_hash(plan_payload)
        plan = RunPlan(
            schema_version="helix.run-plan/v1",
            run_plan_id=f"PLAN-{fingerprint.removeprefix('sha256:')[:16].upper()}",
            run_id=run_id,
            version=1,
            fingerprint=fingerprint,
            created_at=created_at,
            manifest_hash=manifest_hash,
            governed_versions=plan_payload["governed_versions"],
            nodes=nodes,
        )
        schema = self._load_governed_schema(self.contracts_root / "run-plan.schema.json")
        if isinstance(schema, PlanningEvidence):
            raise RunPlanRejectedError([schema])
        errors = sorted(
            Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(
                plan.model_dump(mode="json")
            ),
            key=lambda item: list(item.path),
        )
        if errors:
            raise RunPlanRejectedError(
                [self._evidence("invalid_run_plan_schema", "run_plan", errors[0].message)]
            )
        return plan

    def _safe_governed_path(self, relative_path: str) -> Path:
        path = (self.repository_root / relative_path).resolve()
        if self.repository_root not in path.parents:
            raise RunPlanRejectedError(
                [
                    self._evidence(
                        "invalid_governed_path", relative_path, "Governed path escapes the repository"
                    )
                ]
            )
        return path

    def _artifact(self, kind: str, artifact_id: str, version: str, path: Path) -> GovernedArtifact:
        return GovernedArtifact(
            kind=kind,
            artifact_id=artifact_id,
            version=version,
            path=str(path.relative_to(self.repository_root)),
            content_hash=file_hash(path),
        )

    @staticmethod
    def _depends_on(node_id: str, target: str, definitions: dict[str, dict[str, object]]) -> bool:
        pending = [node_id]
        seen: set[str] = set()
        while pending:
            current = pending.pop()
            if current == target:
                return True
            if current in seen:
                continue
            seen.add(current)
            pending.extend(str(item) for item in definitions.get(current, {}).get("depends_on", []))
        return False

    @staticmethod
    def _cycle(definitions: dict[str, dict[str, object]]) -> list[str]:
        visiting: list[str] = []
        visited: set[str] = set()

        def visit(node: str) -> list[str]:
            if node in visiting:
                index = visiting.index(node)
                return [*visiting[index:], node]
            if node in visited or node not in definitions:
                return []
            visiting.append(node)
            for dependency in definitions[node]["depends_on"]:
                cycle = visit(str(dependency))
                if cycle:
                    return cycle
            visiting.pop()
            visited.add(node)
            return []

        for node in definitions:
            cycle = visit(node)
            if cycle:
                return cycle
        return []

    @staticmethod
    def _topological(definitions: dict[str, dict[str, object]], base: set[str]) -> list[str]:
        indegree = {node: 0 for node in definitions}
        dependents: dict[str, list[str]] = defaultdict(list)
        for node, definition in definitions.items():
            for dependency in definition["depends_on"]:
                dependency = str(dependency)
                if dependency in definitions:
                    indegree[node] += 1
                    dependents[dependency].append(node)
                elif dependency not in base:
                    raise AssertionError("Dependencies must be validated before sorting")
        queue = deque(sorted(node for node, degree in indegree.items() if degree == 0))
        result: list[str] = []
        while queue:
            node = queue.popleft()
            result.append(node)
            for dependent in sorted(dependents[node]):
                indegree[dependent] -= 1
                if indegree[dependent] == 0:
                    queue.append(dependent)
        return result

    @staticmethod
    def _evidence(code: str, subject: str, message: str) -> PlanningEvidence:
        return PlanningEvidence(code=code, subject=subject, message=message)

    @staticmethod
    def _load_json(path: Path) -> dict[str, object]:
        return json.loads(path.read_text())
