from uuid import uuid4

from .run_plans import canonical_hash
from .schemas import (
    Claim,
    ClaimStatus,
    CrossSectionQueryReceipt,
    CrossSectionReturnedArtifact,
    SectionDraftCandidate,
    StoredSectionRun,
)

FACT_PREFIX = "fact:"
CLAIM_PREFIX = "claim:"
DRAFT_PREFIX = "section_draft:"


def execute_cross_section_query(
    *,
    run: StoredSectionRun,
    artifact_ids: list[str],
    claims: list[Claim],
    drafts: dict[str, tuple[SectionDraftCandidate, str]],
    query_id: str | None = None,
) -> CrossSectionQueryReceipt:
    envelope = run.envelope
    package = envelope.get("section_package")
    package_id = (
        str(package.get("package_id"))
        if isinstance(package, dict) and package.get("package_id")
        else run.receipt.section_package_id
    )
    allowed = _allowed(envelope, claims, drafts)
    returned: list[CrossSectionReturnedArtifact] = []
    rejected: list[str] = []
    for artifact_id in artifact_ids:
        match = allowed.get(artifact_id)
        if match is None:
            rejected.append(artifact_id)
            continue
        returned.append(match)
    status = "rejected" if rejected else "returned"
    return CrossSectionQueryReceipt(
        schema_version="helix.cross-section-query-receipt/v1",
        query_id=query_id or f"CSQ-{uuid4().hex[:12].upper()}",
        run_id=run.receipt.run_id,
        section_package_id=package_id,
        requested_artifact_ids=artifact_ids,
        returned=returned,
        rejected_artifact_ids=rejected,
        status=status,
        message=None if not rejected else "Cross-Section Queries cannot read undeclared data.",
    )


def _allowed(
    envelope: dict[str, object],
    claims: list[Claim],
    drafts: dict[str, tuple[SectionDraftCandidate, str]],
) -> dict[str, CrossSectionReturnedArtifact]:
    allowed: dict[str, CrossSectionReturnedArtifact] = {}
    dependencies = envelope.get("direct_dependencies")
    if isinstance(dependencies, list):
        for item in dependencies:
            if not isinstance(item, dict):
                continue
            artifact_id = str(item.get("artifact_id", ""))
            digest = str(item.get("hash", ""))
            if artifact_id and digest.startswith("sha256:"):
                allowed[artifact_id] = CrossSectionReturnedArtifact(
                    artifact_id=artifact_id,
                    kind="fact",
                    hash=digest,
                )
    context = envelope.get("study_context")
    if isinstance(context, dict):
        for key, value in context.items():
            artifact_id = f"{FACT_PREFIX}{key}"
            allowed[artifact_id] = CrossSectionReturnedArtifact(
                artifact_id=artifact_id,
                kind="fact",
                hash=canonical_hash({key: value}),
            )
    declared_claims = envelope.get("validated_claims")
    declared_ids: set[str] = set()
    if isinstance(declared_claims, list):
        for item in declared_claims:
            if isinstance(item, dict) and item.get("claim_id"):
                declared_ids.add(str(item["claim_id"]))
                digest = item.get("hash")
                artifact_id = f"{CLAIM_PREFIX}{item['claim_id']}"
                if isinstance(digest, str) and digest.startswith("sha256:"):
                    allowed[artifact_id] = CrossSectionReturnedArtifact(
                        artifact_id=artifact_id,
                        kind="claim",
                        hash=digest,
                    )
    for claim in claims:
        if claim.claim_id not in declared_ids or claim.status not in {
            ClaimStatus.VALIDATED,
            ClaimStatus.APPROVED,
        }:
            continue
        artifact_id = f"{CLAIM_PREFIX}{claim.claim_id}"
        allowed.setdefault(
            artifact_id,
            CrossSectionReturnedArtifact(
                artifact_id=artifact_id,
                kind="claim",
                hash=canonical_hash(claim.model_dump(mode="json")),
            ),
        )
    for section_package_id, (_draft, digest) in drafts.items():
        artifact_id = f"{DRAFT_PREFIX}{section_package_id}"
        allowed[artifact_id] = CrossSectionReturnedArtifact(
            artifact_id=artifact_id,
            kind="section_draft",
            hash=digest,
        )
    return allowed
