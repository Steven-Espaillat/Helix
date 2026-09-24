from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    AuditEventRow,
    CandidateEvaluationRow,
    CrossSectionQueryRow,
    DataValidationRunRow,
    ExportFileRow,
    PinnedRunRow,
    SectionRunRow,
    StudyPackageRow,
    ValidationRunRow,
)
from .schemas import (
    CandidateEvaluation,
    CrossSectionQueryReceipt,
    DataValidationExecution,
    StoredSectionRun,
    StudyEvidencePackage,
    ValidationRun,
)


class StudyNotFoundError(LookupError):
    pass


class StudyPackageRepository:
    def __init__(self, session: Session):
        self.session = session

    def list_packages(self) -> list[StudyEvidencePackage]:
        rows = self.session.scalars(select(StudyPackageRow).order_by(StudyPackageRow.study_id)).all()
        return [StudyEvidencePackage.model_validate(row.data) for row in rows]

    def get(self, study_id: str, *, for_update: bool = False) -> StudyEvidencePackage:
        statement = select(StudyPackageRow).where(StudyPackageRow.study_id == study_id)
        if for_update:
            statement = statement.with_for_update()
        row = self.session.scalar(statement)
        if row is None:
            raise StudyNotFoundError(study_id)
        return StudyEvidencePackage.model_validate(row.data)

    def save(self, package: StudyEvidencePackage) -> int:
        row = self.session.get(StudyPackageRow, package.study.study_id)
        if row is None:
            row = StudyPackageRow(
                study_id=package.study.study_id,
                package_id=package.package_id,
                label=package.label,
                data=package.model_dump(mode="json"),
            )
            self.session.add(row)
        else:
            row.data = package.model_dump(mode="json")
            row.version += 1
        self.session.flush()
        return row.version

    def append_event(
        self,
        *,
        study_id: str,
        event_type: str,
        actor: str,
        payload: dict[str, Any],
        idempotency_key: str | None = None,
        occurred_at: datetime | None = None,
    ) -> AuditEventRow:
        if idempotency_key is not None:
            existing = self.session.scalar(
                select(AuditEventRow).where(
                    AuditEventRow.study_id == study_id,
                    AuditEventRow.idempotency_key == idempotency_key,
                )
            )
            if existing is not None:
                return existing
        row = AuditEventRow(
            study_id=study_id,
            event_type=event_type,
            actor=actor,
            payload=payload,
            idempotency_key=idempotency_key,
            occurred_at=occurred_at,
        )
        self.session.add(row)
        self.session.flush()
        return row

    def get_event_by_idempotency_key(self, study_id: str, key: str) -> AuditEventRow | None:
        return self.session.scalar(
            select(AuditEventRow).where(
                AuditEventRow.study_id == study_id,
                AuditEventRow.idempotency_key == key,
            )
        )

    def latest_event(self, study_id: str, event_type: str) -> AuditEventRow | None:
        return self.session.scalar(
            select(AuditEventRow)
            .where(
                AuditEventRow.study_id == study_id,
                AuditEventRow.event_type == event_type,
            )
            .order_by(AuditEventRow.occurred_at.desc(), AuditEventRow.id.desc())
            .limit(1)
        )

    def save_export_file(
        self,
        *,
        study_id: str,
        artifact_id: str,
        filename: str,
        media_type: str,
        checksum: str,
        content: bytes,
    ) -> ExportFileRow:
        existing = self.session.scalar(
            select(ExportFileRow).where(
                ExportFileRow.study_id == study_id,
                ExportFileRow.artifact_id == artifact_id,
            )
        )
        if existing is not None:
            return existing
        row = ExportFileRow(
            study_id=study_id,
            artifact_id=artifact_id,
            filename=filename,
            media_type=media_type,
            checksum=checksum,
            content=content,
        )
        self.session.add(row)
        self.session.flush()
        return row

    def get_export_file(self, study_id: str, artifact_id: str) -> ExportFileRow | None:
        return self.session.scalar(
            select(ExportFileRow).where(
                ExportFileRow.study_id == study_id,
                ExportFileRow.artifact_id == artifact_id,
            )
        )

    def save_validation_run(self, run: ValidationRun) -> None:
        self.session.add(
            ValidationRunRow(
                run_id=run.run_id,
                study_id=run.study_id,
                planner_mode=run.planner.value,
                llm_used=run.llm_used,
                planner_label=run.planner_label,
                rule_bundle_version=run.rule_bundle_version,
                results=[result.model_dump(mode="json") for result in run.results],
                created_at=run.created_at,
            )
        )
        self.session.flush()

    def get_pinned_run(self, study_id: str, idempotency_key: str) -> PinnedRunRow | None:
        return self.session.scalar(
            select(PinnedRunRow).where(
                PinnedRunRow.study_id == study_id,
                PinnedRunRow.idempotency_key == idempotency_key,
            )
        )

    def add_pinned_run(
        self,
        *,
        run_id: str,
        study_id: str,
        idempotency_key: str,
        request_hash: str,
    ) -> PinnedRunRow:
        row = PinnedRunRow(
            run_id=run_id,
            study_id=study_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
        )
        self.session.add(row)
        self.session.flush()
        return row

    def get_section_run(self, study_id: str, idempotency_key: str) -> SectionRunRow | None:
        return self.session.scalar(
            select(SectionRunRow).where(
                SectionRunRow.study_id == study_id,
                SectionRunRow.idempotency_key == idempotency_key,
            )
        )

    def add_section_run(
        self,
        *,
        run_id: str,
        study_id: str,
        section_package_id: str,
        attempt: int,
        idempotency_key: str,
        request_hash: str,
        envelope: dict[str, Any],
    ) -> SectionRunRow:
        row = SectionRunRow(
            run_id=run_id,
            study_id=study_id,
            section_package_id=section_package_id,
            attempt=attempt,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            envelope=envelope,
        )
        self.session.add(row)
        self.session.flush()
        return row

    def list_section_runs(self, study_id: str) -> list[StoredSectionRun]:
        rows = self.session.scalars(
            select(SectionRunRow)
            .where(SectionRunRow.study_id == study_id, SectionRunRow.receipt.is_not(None))
            .order_by(SectionRunRow.created_at, SectionRunRow.run_id)
        ).all()
        return [
            StoredSectionRun.model_validate(
                {
                    "receipt": row.receipt,
                    "candidate": row.candidate,
                    "envelope": row.envelope,
                    "review_scaffold": row.review_scaffold,
                }
            )
            for row in rows
        ]

    def get_section_run_by_id(self, study_id: str, run_id: str) -> SectionRunRow | None:
        return self.session.scalar(
            select(SectionRunRow).where(
                SectionRunRow.study_id == study_id,
                SectionRunRow.run_id == run_id,
            )
        )

    def get_candidate_evaluation(self, study_id: str, idempotency_key: str) -> CandidateEvaluationRow | None:
        return self.session.scalar(
            select(CandidateEvaluationRow).where(
                CandidateEvaluationRow.study_id == study_id,
                CandidateEvaluationRow.idempotency_key == idempotency_key,
            )
        )

    def list_candidate_evaluations(self, study_id: str) -> list[CandidateEvaluation]:
        rows = self.session.scalars(
            select(CandidateEvaluationRow)
            .where(CandidateEvaluationRow.study_id == study_id)
            .order_by(CandidateEvaluationRow.created_at, CandidateEvaluationRow.id)
        ).all()
        return [CandidateEvaluation.model_validate(row.evaluation) for row in rows]

    def add_candidate_evaluation(
        self,
        *,
        study_id: str,
        run_id: str,
        candidate_id: str,
        idempotency_key: str,
        request_hash: str,
        evaluation: CandidateEvaluation,
    ) -> CandidateEvaluationRow:
        row = CandidateEvaluationRow(
            study_id=study_id,
            run_id=run_id,
            candidate_id=candidate_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            evaluation=evaluation.model_dump(mode="json"),
        )
        self.session.add(row)
        self.session.flush()
        return row

    def get_cross_section_query(self, study_id: str, idempotency_key: str) -> CrossSectionQueryRow | None:
        return self.session.scalar(
            select(CrossSectionQueryRow).where(
                CrossSectionQueryRow.study_id == study_id,
                CrossSectionQueryRow.idempotency_key == idempotency_key,
            )
        )

    def list_cross_section_queries(self, study_id: str) -> list[CrossSectionQueryReceipt]:
        rows = self.session.scalars(
            select(CrossSectionQueryRow)
            .where(CrossSectionQueryRow.study_id == study_id)
            .order_by(CrossSectionQueryRow.created_at, CrossSectionQueryRow.id)
        ).all()
        return [CrossSectionQueryReceipt.model_validate(row.receipt) for row in rows]

    def add_cross_section_query(
        self,
        *,
        study_id: str,
        run_id: str,
        idempotency_key: str,
        request_hash: str,
        receipt: CrossSectionQueryReceipt,
    ) -> CrossSectionQueryRow:
        row = CrossSectionQueryRow(
            study_id=study_id,
            run_id=run_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            receipt=receipt.model_dump(mode="json"),
        )
        self.session.add(row)
        self.session.flush()
        return row

    def get_data_validation_run(self, study_id: str, idempotency_key: str) -> DataValidationRunRow | None:
        return self.session.scalar(
            select(DataValidationRunRow).where(
                DataValidationRunRow.study_id == study_id,
                DataValidationRunRow.idempotency_key == idempotency_key,
            )
        )

    def get_data_validation_for_run(
        self,
        study_id: str,
        run_id: str,
        package_id: str,
    ) -> DataValidationRunRow | None:
        return self.session.scalar(
            select(DataValidationRunRow)
            .where(
                DataValidationRunRow.study_id == study_id,
                DataValidationRunRow.run_id == run_id,
                DataValidationRunRow.package_id == package_id,
            )
            .order_by(DataValidationRunRow.id)
            .limit(1)
        )

    def add_data_validation_run(
        self,
        *,
        study_id: str,
        run_id: str,
        package_id: str,
        idempotency_key: str,
        execution: DataValidationExecution,
    ) -> DataValidationRunRow:
        row = DataValidationRunRow(
            study_id=study_id,
            run_id=run_id,
            package_id=package_id,
            idempotency_key=idempotency_key,
            execution=execution.model_dump(mode="json"),
        )
        self.session.add(row)
        self.session.flush()
        return row

    def add_data_validation_alias(
        self,
        existing: DataValidationRunRow,
        *,
        idempotency_key: str,
    ) -> DataValidationRunRow:
        prior = self.get_data_validation_run(existing.study_id, idempotency_key)
        if prior is not None:
            return prior
        return self.add_data_validation_run(
            study_id=existing.study_id,
            run_id=existing.run_id,
            package_id=existing.package_id,
            idempotency_key=idempotency_key,
            execution=DataValidationExecution.model_validate(existing.execution),
        )
