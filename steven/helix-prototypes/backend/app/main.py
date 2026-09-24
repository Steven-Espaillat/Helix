from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from .agents.codex_section_agent import CodexSectionAgent, SectionAgent
from .candidate_evaluations import (
    CandidateEvaluationConflictError,
    CandidateEvaluationService,
    UnknownSectionRunError,
)
from .config import Settings, get_settings
from .data_validation import DataValidationConflictError, UnknownValidationPackageError
from .database import create_database_engine, create_schema, create_session_factory
from .repository import StudyNotFoundError
from .run_plans import PinnedRunService, RunConflictError, RunPlanRejectedError
from .schemas import (
    ApprovalCommand,
    CandidateEvaluation,
    CandidateEvaluationCommand,
    CrossSectionQueryCommand,
    CrossSectionQueryReceipt,
    DataValidationCommand,
    DataValidationExecution,
    DispositionCommand,
    EvidenceChain,
    ExportCommand,
    ExportReceipt,
    FreezeRunCommand,
    HumanDirectedRevisionCommand,
    HumanDirectedRevisionReceipt,
    PinnedRun,
    PromotionCommand,
    SectionDraft,
    SectionRunCommand,
    SectionRunReceipt,
    StudyListItem,
    ValidationRequest,
    ValidationRun,
    WorkspaceResponse,
)
from .section_promotion import (
    PromotionConflictError,
    PromotionRejectedError,
    SectionPromotionService,
    UnknownPromotionTargetError,
)
from .section_revisions import RevisionConflictError, SectionRevisionService
from .section_runs import (
    CandidateValidationError,
    SectionRunConflictError,
    SectionRunService,
    SectionRunUnavailableError,
    UnknownSectionPackageError,
)
from .seed import seed_database
from .service import InvalidCommandError, StudyService, WorkflowConflictError
from .validation import PlannerUnavailableError


def create_app(
    settings: Settings | None = None,
    engine: Engine | None = None,
    section_agent: SectionAgent | None = None,
) -> FastAPI:
    active_settings = settings or get_settings()
    active_engine = engine or create_database_engine(active_settings)
    active_section_agent = section_agent or CodexSectionAgent(active_settings.codex_repository_root)
    session_factory = create_session_factory(active_engine)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        create_schema(active_engine)
        if active_settings.auto_seed:
            with session_factory() as session:
                seed_database(session, active_settings)
        yield
        active_engine.dispose()

    app = FastAPI(
        title="HELIX synthetic nonclinical workflow API",
        version="0.1.0",
        description=(
            "A synthetic pattern-testing API. It does not certify GLP, Part 11, SEND, eCTD, "
            "or FDA acceptance."
        ),
        lifespan=lifespan,
    )
    app.state.settings = active_settings
    app.state.engine = active_engine
    app.state.session_factory = session_factory
    app.add_middleware(
        CORSMiddleware,
        allow_origins=active_settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Idempotency-Key"],
    )

    def get_session() -> Iterator[Session]:
        with session_factory() as session:
            yield session

    SessionDependency = Annotated[Session, Depends(get_session)]

    def service(session: SessionDependency) -> StudyService:
        section_runs = SectionRunService(
            session,
            active_section_agent,
            active_settings.codex_repository_root,
        )
        pinned_runs = PinnedRunService(session, active_settings.codex_repository_root)
        return StudyService(session, active_settings, section_runs, pinned_runs)

    ServiceDependency = Annotated[StudyService, Depends(service)]

    def section_run_service(session: SessionDependency) -> SectionRunService:
        return SectionRunService(
            session,
            active_section_agent,
            active_settings.codex_repository_root,
        )

    SectionRunServiceDependency = Annotated[SectionRunService, Depends(section_run_service)]

    def candidate_evaluation_service(session: SessionDependency) -> CandidateEvaluationService:
        return CandidateEvaluationService(session, active_settings.codex_repository_root)

    CandidateEvaluationServiceDependency = Annotated[
        CandidateEvaluationService, Depends(candidate_evaluation_service)
    ]

    @app.get("/health", tags=["system"])
    def health(session: SessionDependency) -> dict[str, str]:
        session.execute(text("SELECT 1"))
        return {"status": "ok", "storage": active_engine.dialect.name}

    @app.get("/api/v1/studies", response_model=list[StudyListItem], tags=["studies"])
    def list_studies(study_service: ServiceDependency) -> list[StudyListItem]:
        return study_service.list_studies()

    @app.get(
        "/api/v1/studies/{study_id}/workspace",
        response_model=WorkspaceResponse,
        tags=["workspace"],
    )
    def get_workspace(study_id: str, study_service: ServiceDependency) -> WorkspaceResponse:
        return _call(lambda: study_service.workspace(study_id))

    @app.post(
        "/api/v1/studies/{study_id}/pinned-runs",
        response_model=PinnedRun,
        status_code=status.HTTP_201_CREATED,
        tags=["run-plans"],
    )
    def freeze_run(
        study_id: str,
        command: FreezeRunCommand,
        study_service: ServiceDependency,
    ) -> PinnedRun:
        return _call(lambda: study_service.freeze_run(study_id, command))

    @app.post(
        "/api/v1/studies/{study_id}/data-validation-packages",
        response_model=DataValidationExecution,
        status_code=status.HTTP_201_CREATED,
        tags=["data-validation"],
    )
    def run_data_validation(
        study_id: str,
        command: DataValidationCommand,
        study_service: ServiceDependency,
    ) -> DataValidationExecution:
        return _call(lambda: study_service.run_data_validation(study_id, command))

    @app.post(
        "/api/v1/studies/{study_id}/validation-runs",
        response_model=ValidationRun,
        status_code=status.HTTP_201_CREATED,
        tags=["validation"],
    )
    def run_validation(
        study_id: str,
        request: ValidationRequest,
        study_service: ServiceDependency,
    ) -> ValidationRun:
        return _call(lambda: study_service.run_validation(study_id, request))

    @app.post(
        "/api/v1/studies/{study_id}/section-runs",
        response_model=SectionRunReceipt,
        status_code=status.HTTP_201_CREATED,
        tags=["section-runs"],
    )
    def run_section(
        study_id: str,
        command: SectionRunCommand,
        section_service: SectionRunServiceDependency,
    ) -> SectionRunReceipt:
        return _call(lambda: section_service.run(study_id, command))

    def section_revision_service(session: SessionDependency) -> SectionRevisionService:
        return SectionRevisionService(session, section_run_service(session))

    SectionRevisionServiceDependency = Annotated[
        SectionRevisionService, Depends(section_revision_service)
    ]

    @app.post(
        "/api/v1/studies/{study_id}/section-revisions",
        response_model=HumanDirectedRevisionReceipt,
        status_code=status.HTTP_201_CREATED,
        tags=["section-revisions"],
    )
    def revise_section(
        study_id: str,
        command: HumanDirectedRevisionCommand,
        revisions: SectionRevisionServiceDependency,
    ) -> HumanDirectedRevisionReceipt:
        return _call(lambda: revisions.revise(study_id, command))

    @app.post(
        "/api/v1/studies/{study_id}/section-runs/{run_id}/evaluations",
        response_model=CandidateEvaluation,
        status_code=status.HTTP_201_CREATED,
        tags=["candidate-evaluations"],
    )
    def evaluate_candidate(
        study_id: str,
        run_id: str,
        command: CandidateEvaluationCommand,
        evaluation_service: CandidateEvaluationServiceDependency,
    ) -> CandidateEvaluation:
        return _call(lambda: evaluation_service.evaluate(study_id, run_id, command))

    @app.post(
        "/api/v1/studies/{study_id}/section-runs/{run_id}/cross-section-queries",
        response_model=CrossSectionQueryReceipt,
        status_code=status.HTTP_201_CREATED,
        tags=["cross-section-queries"],
    )
    def query_cross_section(
        study_id: str,
        run_id: str,
        command: CrossSectionQueryCommand,
        evaluation_service: CandidateEvaluationServiceDependency,
    ) -> CrossSectionQueryReceipt:
        return _call(lambda: evaluation_service.query(study_id, run_id, command))

    def promotion_service(session: SessionDependency) -> SectionPromotionService:
        return SectionPromotionService(session, active_settings.codex_repository_root)

    PromotionServiceDependency = Annotated[SectionPromotionService, Depends(promotion_service)]

    @app.post(
        "/api/v1/studies/{study_id}/section-runs/{run_id}/promotions",
        response_model=SectionDraft,
        status_code=status.HTTP_201_CREATED,
        tags=["section-promotion"],
    )
    def promote_section_draft(
        study_id: str,
        run_id: str,
        command: PromotionCommand,
        promotions: PromotionServiceDependency,
    ) -> SectionDraft:
        return _call(lambda: promotions.promote(study_id, run_id, command))

    @app.get(
        "/api/v1/studies/{study_id}/claims/{claim_id}/evidence",
        response_model=EvidenceChain,
        tags=["evidence"],
    )
    def get_evidence(
        study_id: str,
        claim_id: str,
        study_service: ServiceDependency,
    ) -> EvidenceChain:
        return _call(lambda: study_service.evidence(study_id, claim_id))

    @app.post(
        "/api/v1/studies/{study_id}/validation-results/{result_id}/dispositions",
        response_model=WorkspaceResponse,
        tags=["review"],
    )
    def record_disposition(
        study_id: str,
        result_id: str,
        command: DispositionCommand,
        study_service: ServiceDependency,
    ) -> WorkspaceResponse:
        return _call(lambda: study_service.disposition(study_id, result_id, command))

    @app.post(
        "/api/v1/studies/{study_id}/approvals",
        response_model=WorkspaceResponse,
        tags=["review"],
    )
    def record_approval(
        study_id: str,
        command: ApprovalCommand,
        study_service: ServiceDependency,
    ) -> WorkspaceResponse:
        return _call(lambda: study_service.approve(study_id, command))

    @app.get(
        "/api/v1/studies/{study_id}/exports/{artifact_id}",
        response_class=Response,
        tags=["export"],
    )
    def download_artifact(
        study_id: str,
        artifact_id: str,
        study_service: ServiceDependency,
    ) -> Response:
        generated = _call(lambda: study_service.artifact(study_id, artifact_id))
        return Response(
            content=generated.content,
            media_type=generated.media_type,
            headers={"Content-Disposition": f'attachment; filename="{generated.filename}"'},
        )

    @app.post(
        "/api/v1/studies/{study_id}/exports",
        response_model=ExportReceipt,
        tags=["export"],
    )
    def export_package(
        study_id: str,
        command: ExportCommand,
        study_service: ServiceDependency,
    ) -> ExportReceipt:
        return _call(lambda: study_service.export(study_id, command))

    return app


def _call[ResponseT](operation: Callable[[], ResponseT]) -> ResponseT:
    try:
        return operation()
    except StudyNotFoundError as error:
        raise HTTPException(status_code=404, detail=f"Unknown study {error.args[0]}") from error
    except (
        InvalidCommandError,
        UnknownSectionPackageError,
        UnknownValidationPackageError,
        UnknownSectionRunError,
        UnknownPromotionTargetError,
    ) as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except (
        WorkflowConflictError,
        SectionRunConflictError,
        RevisionConflictError,
        RunConflictError,
        CandidateEvaluationConflictError,
        DataValidationConflictError,
        PromotionConflictError,
        PromotionRejectedError,
    ) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except RunPlanRejectedError as error:
        raise HTTPException(
            status_code=422,
            detail=[item.model_dump(mode="json") for item in error.evidence],
        ) from error
    except CandidateValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except (PlannerUnavailableError, SectionRunUnavailableError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


app = create_app()
