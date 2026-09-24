"""Backend-owned nine-stage journey projection (Steven-Espaillat/Helix#25).

The projection is a pure function of persisted facts. It never reads client state,
so reloading the workspace restores the same stages and actions.

Governance encoded here:
- Upload (gate 1) stays current until a Pinned Run exists; freezing is the only exit.
- Agent-owned steps never complete a human gate. Traceability (gate 2) completes only
  when no blocking result is unresolved and at least one human disposition resolved a
  blocker. Review and export (gate 3) completes only after a server-confirmed export.
- Dispositioned blockers keep the outcome ``dispositioned``; they are never ``passed``.
"""

from dataclasses import dataclass, field
from typing import Any, Literal

from .schemas import (
    RESOLVED_DISPOSITIONS,
    Approval,
    ApprovalRole,
    DataValidationExecution,
    GateDecision,
    GateStatus,
    JourneyAction,
    JourneyBoundaryItem,
    JourneyRunIdentity,
    JourneyStage,
    JourneyStageId,
    JourneyStageStatus,
    ManifestEntry,
    PinnedRun,
    ReportSection,
    ReviewDisposition,
    SectionStatus,
    ValidationResult,
    ValidationStatus,
    WorkbenchJourney,
)

STAGE_ORDER: tuple[JourneyStageId, ...] = (
    "upload",
    "parse",
    "resolve",
    "extract",
    "validate",
    "draft",
    "provenance",
    "traceability",
    "review-export",
)
GATE_NUMBERS: dict[str, Literal[1, 2, 3]] = {"upload": 1, "traceability": 2, "review-export": 3}
REQUIRED_APPROVAL_ROLES = (
    ApprovalRole.PATHOLOGIST,
    ApprovalRole.PEER_REVIEWER,
    ApprovalRole.QAU,
    ApprovalRole.STUDY_DIRECTOR,
)

# Static copy follows research/helix-e2e-workbench-v1.html (the HTML wins on conflict).
_STATIC: dict[str, dict[str, Any]] = {
    "upload": {
        "short": "Upload",
        "name": "Upload and authorize inputs",
        "summary": (
            "The study owner authorizes each source. Freezing the manifest pins checksums and"
            " starts the run."
        ),
        "input": ("Authorized artifacts", "Protocol, template, source data, statistics, and pattern inputs"),
        "output": ("Frozen manifest", "Checksums, authority tiers, and owner authorization"),
        "boundary": "The agent cannot add an unapproved source. Only the freeze command leaves this gate.",
    },
    "parse": {
        "short": "Parse",
        "name": "Parse protocol, template and source data",
        "summary": (
            "Format-specific parsers convert each frozen file into normalized facts without "
            "changing the originals."
        ),
        "input": ("Frozen files", "Authorized synthetic protocol, template, and source representations"),
        "output": ("Typed source records", "Normalized study records with source pointers"),
        "boundary": "Parsing may flag ambiguity. It may not repair or overwrite raw study data.",
    },
    "resolve": {
        "short": "Resolve",
        "name": "Resolve study type and pattern",
        "summary": (
            "HELIX resolves the study type and retrieves the approved report pattern for "
            "structure only."
        ),
        "input": ("Protocol facts", "species · route · duration · endpoints"),
        "output": ("Study profile", "Resolved study type and report template"),
        "boundary": "Prior reports may guide structure and phrasing. Their values never enter the new study.",
    },
    "extract": {
        "short": "Extract",
        "name": "Deterministic extraction",
        "summary": (
            "Code reads the selected source rows and computes report-ready values at the "
            "required grain."
        ),
        "input": ("Normalized study records", "Pinned data-validation packages"),
        "output": ("Candidate claims", "values · units · grain · transform IDs"),
        "boundary": (
            "The model selects tools and evidence. Deterministic code reads values and "
            "performs math."
        ),
    },
    "validate": {
        "short": "Validate",
        "name": "Deterministic validation",
        "summary": (
            "Rules check keys, terminology, units, grain, authority, aggregation and source-"
            "to-report reconciliation."
        ),
        "input": ("Candidate claims", "claims + field rule registry"),
        "output": ("Validation evidence", "passes · blockers · exact evidence IDs"),
        "boundary": "A failed rule creates a blocker. The agent cannot downgrade it to green.",
    },
    "draft": {
        "short": "Draft",
        "name": "Structured section drafting",
        "summary": (
            "Report sections are assembled around validated claims with explicit review "
            "markers for unresolved fields."
        ),
        "input": ("Validated claims + pattern", "facts separated from style pattern"),
        "output": ("Structured sections", "draft text · tables · review markers"),
        "boundary": (
            "The model may write prose. It may not invent a value or make the final "
            "scientific judgment."
        ),
    },
    "provenance": {
        "short": "Provenance",
        "name": "Compile provenance",
        "summary": (
            "Every report claim is linked to exact source records, the deterministic "
            "transform, validation results and manifest version."
        ),
        "input": ("Draft claims + evidence IDs", "all numeric claims"),
        "output": ("Provenance graph", "source → transform → claim"),
        "boundary": "A numeric claim without a provenance edge cannot pass its section gate.",
    },
    "traceability": {
        "short": "Gates",
        "name": "Traceability review",
        "summary": (
            "A reviewer records a disposition for every blocking result before review and "
            "export opens."
        ),
        "input": ("Validation evidence", "blockers with exact evidence IDs"),
        "output": ("Recorded dispositions", "each blocker resolved by a named reviewer"),
        "boundary": (
            "Agent execution stops here. A disposition is recorded as a disposition, never as"
            " a pass."
        ),
    },
    "review-export": {
        "short": "Review & export",
        "name": "Review, sign and export",
        "summary": (
            "Reviewers sign, the Study Director records Final Study Approval, and an explicit"
            " export command releases artifacts."
        ),
        "input": ("Traceable report", "dispositions, approvals, and release candidate"),
        "output": ("Exported artifacts", "checksummed synthetic artifacts"),
        "boundary": "Approvals can make export ready. Only the explicit export command completes this stage.",
    },
}


@dataclass(frozen=True)
class JourneyFacts:
    label: str
    study_id: str
    manifest: list[ManifestEntry]
    record_count: int
    pinned_run: PinnedRun | None
    dvp_executions: list[DataValidationExecution]
    validation_ran: bool
    validation_results: list[ValidationResult]
    report_sections: list[ReportSection]
    provenance_edge_count: int
    gate: GateDecision
    dispositions: list[ReviewDisposition]
    approvals: list[Approval]
    final_study_approval_current: bool
    exported: bool
    export_artifact_count: int = 0
    paused: bool = False
    marks: dict[str, dict[str, Any]] = field(default_factory=dict)
    latest_event: Any = None
    latest_sequence: int = 0
    api_root: str = "/api/v1"


def _action(
    action_id: str,
    label: str,
    status: str,
    *,
    detail: str | None = None,
    outcome: str | None = None,
    command: str | None = None,
) -> JourneyAction:
    return JourneyAction.model_validate(
        {
            "action_id": action_id,
            "label": label,
            "detail": detail,
            "status": status,
            "outcome": outcome,
            "command": command,
        }
    )


def _disposition_command(study_path: str, result_id: str) -> str | None:
    # Candidate promotion blockers are cleared by their own workflow, not a disposition.
    if result_id.startswith("PROMOTION-"):
        return None
    return f"POST {study_path}/validation-results/{result_id}/dispositions"


def _latest_dispositions(dispositions: list[ReviewDisposition]) -> dict[str, ReviewDisposition]:
    latest: dict[str, ReviewDisposition] = {}
    for item in dispositions:
        latest[item.result_id] = item
    return latest


def _blocking_result_ids(facts: JourneyFacts) -> list[str]:
    ids = [
        result.result_id
        for result in facts.validation_results
        if result.status == ValidationStatus.FAIL and result.severity == "blocker"
    ]
    for execution in facts.dvp_executions:
        ids.extend(
            result.result_id
            for result in execution.results
            if result.status == ValidationStatus.FAIL and result.enforcement_class != "warning"
        )
    ids.extend(facts.gate.blocking_result_ids)
    return list(dict.fromkeys(ids))


def project_journey(facts: JourneyFacts) -> WorkbenchJourney:
    study_path = f"{facts.api_root}/studies/{facts.study_id}"
    run = facts.pinned_run
    statuses: dict[str, JourneyStageStatus] = {}
    actions: dict[str, list[JourneyAction]] = {}

    # Gate 1: Upload. Only a persisted Pinned Run (the freeze command) completes it.
    frozen = run is not None
    actions["upload"] = [
        _action(
            f"manifest:{entry.artifact_id}",
            f"Authorized {entry.name}",
            "done",
            detail=f"{entry.kind} · tier {entry.authority_tier} · {entry.checksum}",
            outcome="passed",
        )
        for entry in facts.manifest
    ] + [
        _action(
            "manifest:freeze",
            "Freeze manifest and start the Pinned Run",
            "done" if frozen else "pending",
            outcome="passed" if frozen else None,
            command=f"POST {study_path}/pinned-runs",
        )
    ]
    statuses["upload"] = "complete" if frozen else "current"

    # Agent steps 2-3 come from the persisted Pinned Run.
    parse_nodes = [node for node in run.run_plan.nodes if node.node_type == "parse"] if run else []
    actions["parse"] = [
        _action(
            f"node:{node.node_id}",
            f"Parsed {node.node_id}",
            "done" if frozen else "pending",
            outcome="passed" if frozen else None,
        )
        for node in parse_nodes
    ] or [_action("parse:records", "Parse frozen inputs", "pending")]
    if frozen:
        actions["parse"].append(
            _action(
                "parse:records", f"Normalized {facts.record_count:,} source records", "done", outcome="passed"
            )
        )
    statuses["parse"] = "complete" if frozen else "pending"

    resolved = bool(run and run.study_type_resolution.status == "resolved")
    if run is None:
        actions["resolve"] = [_action("resolve:study-type", "Resolve study type", "pending")]
        statuses["resolve"] = "pending"
    else:
        resolution = run.study_type_resolution
        actions["resolve"] = [
            _action(
                "resolve:study-type",
                f"Resolved {resolution.study_type_id}" if resolved else "Study type needs review",
                "done" if resolved else "blocked",
                outcome="passed" if resolved else "blocker",
            )
        ]
        statuses["resolve"] = "complete" if resolved else "blocked"

    # Step 4: Extract completes when a pinned data-validation execution is bound to the run.
    bound = [item for item in facts.dvp_executions if run is not None and item.receipt.run_id == run.run_id]
    actions["extract"] = [
        _action(
            f"dvp:{item.receipt.package_id}",
            f"Executed {item.receipt.package_id} ({len(item.claims)} claims)",
            "done",
            detail=item.receipt.receipt_id,
            outcome="blocker" if item.receipt.status == "blocked" else "passed",
        )
        for item in bound
    ] or [_action("dvp:pending", "Execute pinned data-validation packages", "pending")]
    if statuses["resolve"] != "complete":
        statuses["extract"] = "pending"
    else:
        statuses["extract"] = "complete" if bound else "current"

    # Step 5: Validate completes on a validation run recorded after the freeze.
    validated = statuses["extract"] == "complete" and facts.validation_ran
    if validated:
        actions["validate"] = [
            _action(
                f"result:{result.result_id}",
                f"{result.rule_id} · {result.scope_id}",
                "done",
                detail=result.message,
                outcome=(
                    "blocker"
                    if result.status == ValidationStatus.FAIL and result.severity == "blocker"
                    else "warning"
                    if result.status == ValidationStatus.FAIL
                    else "passed"
                ),
            )
            for result in facts.validation_results
        ]
    else:
        actions["validate"] = [
            _action(
                "validate:run",
                "Run deterministic validation",
                "pending",
                command=f"POST {study_path}/validation-runs",
            )
        ]
    if statuses["extract"] != "complete":
        statuses["validate"] = "pending"
    else:
        statuses["validate"] = "complete" if validated else "current"

    # Steps 6-7: deterministic assembly and provenance over the validated package.
    actions["draft"] = [
        _action(
            f"section:{section.section_id}",
            f"Assembled {section.title}",
            "done" if validated else "pending",
            outcome=(
                ("warning" if section.status == SectionStatus.NEEDS_REVIEW else "passed")
                if validated
                else None
            ),
        )
        for section in facts.report_sections
    ]
    statuses["draft"] = "complete" if validated else "pending"
    has_edges = facts.provenance_edge_count > 0
    actions["provenance"] = [
        _action(
            "provenance:edges",
            f"Compiled {facts.provenance_edge_count} provenance edges",
            ("done" if has_edges else "blocked") if validated else "pending",
            outcome=("passed" if has_edges else "blocker") if validated else None,
        )
    ]
    if not validated:
        statuses["provenance"] = "pending"
    else:
        statuses["provenance"] = "complete" if has_edges else "blocked"

    # Gate 2: Traceability review. Only human dispositions resolve blockers.
    latest = _latest_dispositions(facts.dispositions)
    unresolved = set(facts.gate.blocking_result_ids)
    blocking = _blocking_result_ids(facts) if statuses["provenance"] == "complete" else []
    trace_actions: list[JourneyAction] = []
    human_resolved = 0
    for result_id in blocking:
        decision = latest.get(result_id)
        if result_id in unresolved or decision is None or decision.decision not in RESOLVED_DISPOSITIONS:
            trace_actions.append(
                _action(
                    f"disposition:{result_id}",
                    f"Blocker {result_id} awaits disposition",
                    "blocked",
                    outcome="blocker",
                    command=_disposition_command(study_path, result_id),
                )
            )
        else:
            human_resolved += 1 if decision.reviewer else 0
            trace_actions.append(
                _action(
                    f"disposition:{result_id}",
                    f"Blocker {result_id} dispositioned as {decision.decision.value}",
                    "done",
                    detail=decision.reason,
                    outcome="dispositioned",
                    command=_disposition_command(study_path, result_id),
                )
            )
    actions["traceability"] = trace_actions
    if statuses["provenance"] != "complete":
        statuses["traceability"] = "pending"
    elif unresolved:
        statuses["traceability"] = "blocked"
    elif human_resolved > 0:
        statuses["traceability"] = "complete"
    else:
        # No human disposition exists yet; an agent step can never pass this gate.
        statuses["traceability"] = "current"

    # Gate 3: Review and export. Separate commands; only export completes the stage.
    roles = {approval.role for approval in facts.approvals}
    approvals_done = all(role in roles for role in REQUIRED_APPROVAL_ROLES)
    final_actions = [
        _action(
            f"approval:{role.value}",
            f"{role.value.replace('_', ' ').title()} approval",
            "done" if role in roles else "pending",
            outcome="passed" if role in roles else None,
            command=f"POST {study_path}/approvals",
        )
        for role in REQUIRED_APPROVAL_ROLES
    ]
    final_actions.append(
        _action(
            "final-study-approval",
            "Final Study Approval",
            "done" if facts.final_study_approval_current else "pending",
            outcome="passed" if facts.final_study_approval_current else None,
            command=f"POST {study_path}/final-study-approvals",
        )
    )
    final_actions.append(
        _action(
            "export",
            "Explicit export",
            "done" if facts.exported else "pending",
            detail=f"{facts.export_artifact_count} checksummed artifacts" if facts.exported else None,
            outcome="passed" if facts.exported else None,
            command=f"POST {study_path}/exports",
        )
    )
    actions["review-export"] = final_actions
    if statuses["traceability"] != "complete":
        statuses["review-export"] = "pending"
    elif facts.exported:
        statuses["review-export"] = "complete"
    elif facts.gate.status == GateStatus.BLOCKED and approvals_done:
        statuses["review-export"] = "blocked"
    else:
        statuses["review-export"] = "current"

    current_stage_id = next((sid for sid in STAGE_ORDER if statuses[sid] != "complete"), None)
    if facts.paused and current_stage_id is not None and statuses[current_stage_id] == "current":
        statuses[current_stage_id] = "paused"

    stages: list[JourneyStage] = []
    for index, stage_id in enumerate(STAGE_ORDER, start=1):
        static = _STATIC[stage_id]
        mark = facts.marks.get(stage_id, {})
        status = statuses[stage_id]
        stages.append(
            JourneyStage(
                stage_id=stage_id,
                sequence=index,
                kind="human_gate" if stage_id in GATE_NUMBERS else "agent_step",
                gate_number=GATE_NUMBERS.get(stage_id),
                short_label=static["short"],
                name=static["name"],
                status=status,
                selectable=status != "pending",
                summary=static["summary"],
                input=JourneyBoundaryItem(title=static["input"][0], detail=static["input"][1]),
                output=JourneyBoundaryItem(title=static["output"][0], detail=static["output"][1]),
                control_boundary=static["boundary"],
                actions=actions[stage_id],
                gate_status=facts.gate.status
                if stage_id == "review-export" and status != "pending"
                else None,
                started_sequence=mark.get("started_sequence"),
                started_at=mark.get("started_at"),
                finished_sequence=mark.get("finished_sequence"),
                finished_at=mark.get("finished_at"),
            )
        )

    identity = None
    if run is not None:
        identity = JourneyRunIdentity(
            run_id=run.run_id,
            study_id=facts.study_id,
            run_status=run.status,
            run_version=run.run_plan.fingerprint,
            created_at=run.created_at,
            manifest_hash=run.manifest_hash,
            run_plan_fingerprint=run.run_plan.fingerprint,
            predecessor_run_id=run.predecessor_run_id,
            latest_event_id=facts.latest_event.event_id if facts.latest_event is not None else None,
            latest_sequence=facts.latest_sequence,
            events_url=f"{study_path}/pinned-runs/{run.run_id}/events",
        )
    return WorkbenchJourney(
        label=facts.label,
        current_stage_id=current_stage_id,
        run=identity,
        stages=stages,
        latest_event=facts.latest_event,
    )
