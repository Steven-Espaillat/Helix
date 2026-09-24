"""Persisted run events for the nine-stage journey (Steven-Espaillat/Helix#25).

Run events are derived by diffing the projected journey before and after a command
persists its state, and they are written in the same transaction as that state. They
therefore report only persisted transitions. They are distinct from the append-only
audit history in ``audit_events`` / ``WorkspaceResponse.events``.
"""

import re
from datetime import UTC, datetime
from typing import Any

from pydantic import TypeAdapter
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .journey import STAGE_ORDER
from .models import RunEventRow, RunJourneyStateRow
from .schemas import RunEvent, WorkbenchJourney

DEFAULT_RETENTION = 1000
RUN_EVENT_ADAPTER: TypeAdapter[Any] = TypeAdapter(RunEvent)
_CURSOR = re.compile(r"^(?P<run_id>RUN-[A-Z0-9-]+)\.E(?P<sequence>\d{6,})$")


class EventCursorExpiredError(RuntimeError):
    def __init__(self, run_id: str, latest_event_id: str | None):
        super().__init__("The Last-Event-ID is outside the retained run-event window")
        self.run_id = run_id
        self.latest_event_id = latest_event_id


class InvalidEventCursorError(ValueError):
    pass


def event_id_for(run_id: str, sequence: int) -> str:
    return f"{run_id}.E{sequence:06d}"


def parse_cursor(run_id: str, cursor: str) -> int:
    match = _CURSOR.match(cursor.strip())
    if match is None or match.group("run_id") != run_id:
        raise InvalidEventCursorError("Last-Event-ID does not name an event of this run")
    return int(match.group("sequence"))


def _leading_int(value: str | None) -> int:
    match = re.match(r"^(\d+)", value or "")
    return int(match.group(1)) if match else 0


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class RunEventStore:
    def __init__(self, session: Session, *, retention: int = DEFAULT_RETENTION):
        self.session = session
        self.retention = max(retention, 1)

    def state(self, run_id: str) -> RunJourneyStateRow | None:
        return self.session.get(RunJourneyStateRow, run_id)

    def lock_state(self, run_id: str, study_id: str) -> RunJourneyStateRow:
        """Take (creating if needed) the per-run state lock. Call before reading facts."""
        return self._state_for_update(run_id, study_id)

    def _state_for_update(self, run_id: str, study_id: str) -> RunJourneyStateRow:
        state = self.session.scalar(
            select(RunJourneyStateRow).where(RunJourneyStateRow.run_id == run_id).with_for_update()
        )
        if state is None:
            state = RunJourneyStateRow(
                run_id=run_id,
                study_id=study_id,
                last_sequence=0,
                oldest_retained_sequence=1,
                stages={},
                actions={},
            )
            self.session.add(state)
            self.session.flush()
        return state

    def append(
        self,
        *,
        run_id: str,
        study_id: str,
        label: str,
        event_type: str,
        stage_id: str,
        payload: dict[str, Any] | None = None,
        occurred_at: str | None = None,
        state: RunJourneyStateRow | None = None,
    ) -> dict[str, Any]:
        """Append one event. The caller owns the transaction (commit happens with the command)."""
        state = state or self._state_for_update(run_id, study_id)
        sequence = state.last_sequence + 1
        event = {
            "label": label,
            "event_id": event_id_for(run_id, sequence),
            "run_id": run_id,
            "study_id": study_id,
            "sequence": sequence,
            "stage_id": stage_id,
            "occurred_at": occurred_at or _now(),
            "type": event_type,
            **(payload or {}),
        }
        validated = RUN_EVENT_ADAPTER.validate_python(event)
        body = RUN_EVENT_ADAPTER.dump_python(validated, mode="json")
        self.session.add(
            RunEventRow(
                event_id=body["event_id"],
                run_id=run_id,
                study_id=study_id,
                sequence=sequence,
                event_type=event_type,
                stage_id=stage_id,
                occurred_at=body["occurred_at"],
                payload=body,
            )
        )
        state.last_sequence = sequence
        if event_type in {"stage_started", "gate_reached", "stage_finished"}:
            marks = dict(state.stages.get(stage_id, {}).get("marks", {}))
            key = "finished" if event_type == "stage_finished" else "started"
            marks[f"{key}_sequence"] = sequence
            marks[f"{key}_at"] = body["occurred_at"]
            stages = dict(state.stages)
            stages[stage_id] = {**stages.get(stage_id, {}), "marks": marks}
            state.stages = stages
        floor = sequence - self.retention
        if floor >= state.oldest_retained_sequence:
            self.session.execute(
                delete(RunEventRow).where(RunEventRow.run_id == run_id, RunEventRow.sequence <= floor)
            )
            state.oldest_retained_sequence = floor + 1
        self.session.flush()
        return body

    def sync(self, journey: WorkbenchJourney) -> list[dict[str, Any]]:
        """Diff ``journey`` against the last recorded projection and append transition events."""
        if journey.run is None:
            return []
        run_id = journey.run.run_id
        study_id = journey.run.study_id
        state = self._state_for_update(run_id, study_id)
        first_sync = not state.stages
        recorded: dict[str, Any] = {key: dict(value) for key, value in state.stages.items()}
        recorded_actions: dict[str, Any] = dict(state.actions)
        emitted: list[dict[str, Any]] = []

        def emit(event_type: str, stage_id: str, **payload: Any) -> None:
            emitted.append(
                self.append(
                    run_id=run_id,
                    study_id=study_id,
                    label=journey.label,
                    event_type=event_type,
                    stage_id=stage_id,
                    payload=payload,
                    state=state,
                )
            )

        for stage in journey.stages:
            if stage.stage_id not in STAGE_ORDER:
                continue
            default = "current" if stage.stage_id == "upload" and first_sync else "pending"
            old = recorded.get(stage.stage_id, {}).get("status", default)
            new = stage.status
            reached = new != "pending"
            if reached and old == "pending":
                if stage.kind == "human_gate":
                    emit("gate_reached", stage.stage_id, gate_number=stage.gate_number)
                else:
                    emit("stage_started", stage.stage_id)
            for action in stage.actions:
                if action.status == "pending":
                    continue
                key = f"{stage.stage_id}/{action.action_id}"
                signature = f"{action.status}:{action.outcome}"
                if recorded_actions.get(key) == signature:
                    continue
                if key not in recorded_actions:
                    emit(
                        "action_started",
                        stage.stage_id,
                        action_id=action.action_id,
                        action_label=action.label,
                    )
                flag = (
                    "blocker"
                    if action.outcome == "blocker"
                    else "warning"
                    if action.outcome == "warning"
                    else None
                )
                emit(
                    "action_finished",
                    stage.stage_id,
                    action_id=action.action_id,
                    action_label=action.label,
                    outcome=action.outcome,
                    flag=flag,
                )
                recorded_actions[key] = signature
            if new == "complete" and old != "complete":
                emit("stage_finished", stage.stage_id)
                if stage.stage_id == "review-export":
                    exported = [item for item in stage.actions if item.action_id == "export"]
                    emit(
                        "export_finished",
                        stage.stage_id,
                        artifact_count=_leading_int(exported[0].detail) if exported else 0,
                    )
            current = dict(state.stages.get(stage.stage_id, {}))
            current["status"] = new
            stages = dict(state.stages)
            stages[stage.stage_id] = current
            state.stages = stages
        state.actions = recorded_actions
        self.session.flush()
        return emitted

    def record_failure(
        self,
        *,
        run_id: str,
        study_id: str,
        label: str,
        stage_id: str,
        command: str,
        detail: str,
    ) -> dict[str, Any]:
        return self.append(
            run_id=run_id,
            study_id=study_id,
            label=label,
            event_type="command_failed",
            stage_id=stage_id,
            payload={"command": command, "detail": detail[:500]},
        )

    def latest(self, run_id: str) -> dict[str, Any] | None:
        row = self.session.scalar(
            select(RunEventRow)
            .where(RunEventRow.run_id == run_id)
            .order_by(RunEventRow.sequence.desc())
            .limit(1)
        )
        return dict(row.payload) if row is not None else None

    def is_paused(self, run_id: str) -> bool:
        row = self.session.scalar(
            select(RunEventRow)
            .where(
                RunEventRow.run_id == run_id,
                RunEventRow.event_type.in_(("run_paused", "run_resumed")),
            )
            .order_by(RunEventRow.sequence.desc())
            .limit(1)
        )
        return row is not None and row.event_type == "run_paused"

    def marks(self, run_id: str) -> dict[str, dict[str, Any]]:
        state = self.state(run_id)
        if state is None:
            return {}
        return {key: dict(value.get("marks", {})) for key, value in state.stages.items()}

    def replay(self, run_id: str, cursor: str | None) -> list[dict[str, Any]]:
        """Return retained events after ``cursor``; raise when missed events were pruned."""
        state = self.state(run_id)
        last_sequence = state.last_sequence if state is not None else 0
        oldest = state.oldest_retained_sequence if state is not None else 1
        after = 0
        if cursor:
            after = parse_cursor(run_id, cursor)
            if after > last_sequence:
                raise InvalidEventCursorError("Last-Event-ID is ahead of the persisted run events")
            if after + 1 < oldest:
                latest = event_id_for(run_id, last_sequence) if last_sequence else None
                raise EventCursorExpiredError(run_id, latest)
        rows = self.session.scalars(
            select(RunEventRow)
            .where(RunEventRow.run_id == run_id, RunEventRow.sequence > after)
            .order_by(RunEventRow.sequence)
        ).all()
        # A prune that races this read leaves a gap after the cursor. Report it as an
        # expired cursor (409) instead of silently skipping the missing events.
        gap = (rows and rows[0].sequence != after + 1) or (not rows and last_sequence > after)
        if cursor and gap:
            latest = rows[-1].event_id if rows else event_id_for(run_id, last_sequence)
            raise EventCursorExpiredError(run_id, latest)
        return [dict(row.payload) for row in rows]
