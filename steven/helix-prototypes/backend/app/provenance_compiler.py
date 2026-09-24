import re
from dataclasses import dataclass
from uuid import uuid4

from .run_plans import canonical_hash
from .schemas import (
    Claim,
    ClaimStatus,
    ProvenanceBinding,
    ProvenanceBlocker,
    ProvenanceEdge,
    ProvenanceReceipt,
    SectionDraftCandidate,
)

NUMBER = re.compile(r"\d+(?:\.\d+)?")

ALLOWED_CLAIM_STATUSES = {ClaimStatus.VALIDATED, ClaimStatus.APPROVED}


@dataclass(frozen=True)
class AllowedClaim:
    claim: Claim
    claim_hash: str
    artifact_hash: str


def allowed_claims_for(
    claims: list[Claim],
    edges: list[ProvenanceEdge],
    allowed_ids: set[str],
) -> dict[str, AllowedClaim]:
    allowed: dict[str, AllowedClaim] = {}
    for claim in claims:
        if claim.claim_id not in allowed_ids:
            continue
        if claim.status not in ALLOWED_CLAIM_STATUSES:
            continue
        claim_hash = canonical_hash(claim.model_dump(mode="json"))
        source_hashes = [item for item in claim.source_hashes if item]
        if source_hashes:
            artifact_hash = source_hashes[0]
        else:
            related = [
                edge.model_dump(mode="json") for edge in edges if edge.claim_id == claim.claim_id
            ]
            artifact_hash = canonical_hash(related)
        allowed[claim.claim_id] = AllowedClaim(claim, claim_hash, artifact_hash)
    return allowed


def compile_provenance(
    candidate: SectionDraftCandidate,
    claims: dict[str, AllowedClaim],
    *,
    candidate_hash: str,
    receipt_id: str | None = None,
) -> ProvenanceReceipt:
    bindings: list[ProvenanceBinding] = []
    blockers: list[ProvenanceBlocker] = []
    for location, text, claim_ids in _locations(candidate):
        binding, blocker = _bind(location, text, claim_ids, claims)
        if binding is not None:
            bindings.append(binding)
        if blocker is not None:
            blockers.append(blocker)
    return ProvenanceReceipt(
        schema_version="helix.provenance-receipt/v1",
        receipt_id=receipt_id or f"PRV-{uuid4().hex[:12].upper()}",
        candidate_id=candidate.candidate_id,
        candidate_hash=candidate_hash,
        status="blocked" if blockers else "passed",
        enforcement_class="hard_blocker",
        waivable=False,
        bindings=bindings,
        blockers=blockers,
    )


def _locations(candidate: SectionDraftCandidate) -> list[tuple[str, str, list[str]]]:
    items: list[tuple[str, str, list[str]]] = []
    for block in candidate.content_blocks:
        block_id = str(block.get("block_id", "unknown"))
        kind = block.get("kind")
        spans = block.get("factual_spans")
        if isinstance(spans, list):
            for index, span in enumerate(spans):
                if not isinstance(span, dict):
                    continue
                text = str(span.get("text", ""))
                claim_ids = span.get("claim_ids")
                ids = [str(item) for item in claim_ids] if isinstance(claim_ids, list) else []
                items.append((f"{kind}:{block_id}:span:{index}", text, ids))
        if kind == "table" and isinstance(block.get("content"), dict):
            rows = block["content"].get("rows")
            if not isinstance(rows, list):
                continue
            for row_index, row in enumerate(rows):
                if not isinstance(row, dict) or not isinstance(row.get("cells"), list):
                    continue
                for cell_index, cell in enumerate(row["cells"]):
                    if not isinstance(cell, dict):
                        continue
                    text = str(cell.get("text", ""))
                    claim_ids = cell.get("claim_ids")
                    ids = [str(item) for item in claim_ids] if isinstance(claim_ids, list) else []
                    items.append(
                        (f"table:{block_id}:row:{row_index}:cell:{cell_index}", text, ids)
                    )
    return items


def _bind(
    location: str,
    text: str,
    claim_ids: list[str],
    claims: dict[str, AllowedClaim],
) -> tuple[ProvenanceBinding | None, ProvenanceBlocker | None]:
    if len(claim_ids) != 1:
        return None, ProvenanceBlocker(
            code="unsupported-claim-binding",
            location=location,
            text=text or "[empty]",
            message="A factual span or table cell must bind to one allowed Validated Claim.",
        )
    claim_id = claim_ids[0]
    allowed = claims.get(claim_id)
    if allowed is None:
        return None, ProvenanceBlocker(
            code="undeclared-claim",
            location=location,
            text=text or "[empty]",
            message=f"{claim_id} is not an allowed Validated Claim.",
        )
    if not _supported(text, allowed.claim):
        return None, ProvenanceBlocker(
            code="unsupported-content",
            location=location,
            text=text,
            message=f"{location} is not supported by {claim_id}.",
        )
    return (
        ProvenanceBinding(
            location=location,
            text=text,
            claim_id=claim_id,
            claim_hash=allowed.claim_hash,
            artifact_hash=allowed.artifact_hash,
        ),
        None,
    )


def _supported(text: str, claim: Claim) -> bool:
    numbers = NUMBER.findall(text)
    if not numbers:
        return True
    if claim.value is None:
        return False
    expected = _format_number(claim.value)
    if expected not in numbers:
        return False
    if claim.unit and claim.unit not in text:
        return False
    extras = [item for item in numbers if item != expected]
    return not extras


def _format_number(value: float) -> str:
    as_int = int(value)
    if value == as_int:
        return str(as_int)
    return f"{value:g}"
