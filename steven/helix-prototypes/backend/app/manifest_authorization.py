"""Human Gate 1: the freeze of an authorized manifest (Lane A, Steven-Espaillat/Helix#20).

The freeze command commits the Pinned Run before it starts the pinned
``validation.body_weight`` Data Validation execution. If that execution fails, the
Pinned Run stays frozen, no Data Validation execution is recorded, and the caller gets
a typed error naming the run and the retry operation. The retry runs Data Validation
for that run. It never freezes again.
"""

from typing import Any

from fastapi import HTTPException, status

DATA_VALIDATION_PACKAGE_ID = "validation.body_weight"
FREEZE_DATA_VALIDATION_FAILED = "data_validation_failed_after_freeze"
HUMAN_FREEZE_REQUIRED = "human_freeze_required"


def freeze_data_validation_key(run_id: str) -> str:
    """Run-scoped Data Validation key shared by the freeze command and its retry."""
    return f"dvp-{run_id}-{DATA_VALIDATION_PACKAGE_ID}"


class FreezeDataValidationFailedError(HTTPException):
    """The manifest froze, but the pinned Data Validation execution did not complete.

    Raised as an HTTP error so the shared route wrapper returns it unchanged
    (HTTP 409, typed ``detail``) without a new mapping in ``main.py``.
    """

    def __init__(self, *, study_id: str, run_id: str, reason: str) -> None:
        self.study_id = study_id
        self.run_id = run_id
        self.reason = reason
        super().__init__(status_code=status.HTTP_409_CONFLICT, detail=self.as_detail())

    def as_detail(self) -> dict[str, Any]:
        return {
            "code": FREEZE_DATA_VALIDATION_FAILED,
            "message": "Manifest frozen; Data Validation failed.",
            "study_id": self.study_id,
            "run_id": self.run_id,
            "pinned_run_preserved": True,
            "reason": self.reason[:500],
            "retry": {
                "operation": "run_data_validation",
                "method": "POST",
                "path": f"/api/v1/studies/{self.study_id}/data-validation-packages",
                "package_id": DATA_VALIDATION_PACKAGE_ID,
                "idempotency_key": freeze_data_validation_key(self.run_id),
            },
        }


class HumanFreezeRequiredError(HTTPException):
    """A command needed a Pinned Run, but no human has frozen the manifest yet.

    Only Human Gate 1 (the audited freeze command) may create the Pinned Run. Validation
    and Data Validation refuse with this typed HTTP 409 instead of freezing on their own.
    Nothing is written before it is raised.
    """

    def __init__(self, *, study_id: str, operation: str) -> None:
        self.study_id = study_id
        self.operation = operation
        super().__init__(status_code=status.HTTP_409_CONFLICT, detail=self.as_detail())

    def as_detail(self) -> dict[str, Any]:
        return {
            "code": HUMAN_FREEZE_REQUIRED,
            "message": "A human must freeze the authorized manifest before this command can run.",
            "study_id": self.study_id,
            "operation": self.operation,
            "freeze": {
                "operation": "freeze_pinned_run",
                "method": "POST",
                "path": f"/api/v1/studies/{self.study_id}/pinned-runs",
            },
        }
