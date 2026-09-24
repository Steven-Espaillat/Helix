from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, DateTime, Integer, LargeBinary, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

JsonDocument = JSON().with_variant(JSONB, "postgresql")


def utc_now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class StudyPackageRow(Base):
    __tablename__ = "study_packages"

    study_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    package_id: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    data: Mapped[dict[str, Any]] = mapped_column(JsonDocument, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )


class AuditEventRow(Base):
    __tablename__ = "audit_events"
    __table_args__ = (UniqueConstraint("study_id", "idempotency_key", name="uq_audit_idempotency"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    event_type: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    actor: Mapped[str] = mapped_column(String(120), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(160), nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JsonDocument, nullable=False, default=dict)


class ExportFileRow(Base):
    __tablename__ = "export_files"
    __table_args__ = (UniqueConstraint("study_id", "artifact_id", name="uq_export_file"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    artifact_id: Mapped[str] = mapped_column(String(80), nullable=False)
    filename: Mapped[str] = mapped_column(String(200), nullable=False)
    media_type: Mapped[str] = mapped_column(String(120), nullable=False)
    checksum: Mapped[str] = mapped_column(String(80), nullable=False)
    content: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class ValidationRunRow(Base):
    __tablename__ = "validation_runs"

    run_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    study_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    planner_mode: Mapped[str] = mapped_column(String(40), nullable=False)
    llm_used: Mapped[bool] = mapped_column(nullable=False)
    planner_label: Mapped[str] = mapped_column(String(120), nullable=False)
    rule_bundle_version: Mapped[str] = mapped_column(String(40), nullable=False)
    results: Mapped[list[dict[str, Any]]] = mapped_column(JsonDocument, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class PinnedRunRow(Base):
    __tablename__ = "pinned_runs"
    __table_args__ = (UniqueConstraint("study_id", "idempotency_key", name="uq_pinned_run_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    study_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(80), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class DataValidationRunRow(Base):
    __tablename__ = "data_validation_runs"
    __table_args__ = (UniqueConstraint("study_id", "idempotency_key", name="uq_data_validation_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    run_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    package_id: Mapped[str] = mapped_column(String(120), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False)
    execution: Mapped[dict[str, Any]] = mapped_column(JsonDocument, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class SectionRunRow(Base):
    __tablename__ = "section_runs"
    __table_args__ = (
        UniqueConstraint("study_id", "idempotency_key", name="uq_section_run_key"),
        UniqueConstraint("study_id", "section_package_id", "attempt", name="uq_section_run_attempt"),
    )

    run_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    study_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    section_package_id: Mapped[str] = mapped_column(String(120), nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(80), nullable=False)
    envelope: Mapped[dict[str, Any]] = mapped_column(JsonDocument, nullable=False)
    candidate: Mapped[dict[str, Any] | None] = mapped_column(JsonDocument, nullable=True)
    receipt: Mapped[dict[str, Any] | None] = mapped_column(JsonDocument, nullable=True)
    review_scaffold: Mapped[dict[str, Any] | None] = mapped_column(JsonDocument, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class CandidateEvaluationRow(Base):
    __tablename__ = "candidate_evaluations"
    __table_args__ = (UniqueConstraint("study_id", "idempotency_key", name="uq_candidate_evaluation_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    run_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    candidate_id: Mapped[str] = mapped_column(String(80), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(80), nullable=False)
    evaluation: Mapped[dict[str, Any]] = mapped_column(JsonDocument, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class CrossSectionQueryRow(Base):
    __tablename__ = "cross_section_queries"
    __table_args__ = (UniqueConstraint("study_id", "idempotency_key", name="uq_cross_section_query_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    run_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(80), nullable=False)
    receipt: Mapped[dict[str, Any]] = mapped_column(JsonDocument, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class PromotionDecisionRow(Base):
    __tablename__ = "promotion_decisions"
    __table_args__ = (UniqueConstraint("study_id", "idempotency_key", name="uq_promotion_decision_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    run_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    candidate_id: Mapped[str] = mapped_column(String(80), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(80), nullable=False)
    decision: Mapped[dict[str, Any]] = mapped_column(JsonDocument, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class SectionDraftRow(Base):
    __tablename__ = "section_drafts"
    __table_args__ = (
        UniqueConstraint("study_id", "idempotency_key", name="uq_section_draft_key"),
        UniqueConstraint("study_id", "candidate_id", name="uq_section_draft_candidate"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    run_id: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    candidate_id: Mapped[str] = mapped_column(String(80), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(80), nullable=False)
    draft: Mapped[dict[str, Any]] = mapped_column(JsonDocument, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
