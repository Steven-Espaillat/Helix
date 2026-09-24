import json
from pathlib import Path
from uuid import uuid4

from .run_plans import file_hash
from .schemas import SectionDraftCandidate, StudyOutputAssertionResult, StudyOutputEvaluationReceipt


def evaluate_study_output(
    candidate: SectionDraftCandidate,
    *,
    candidate_hash: str,
    suite_id: str,
    suite_version: str,
    suite_path: Path,
    receipt_id: str | None = None,
) -> StudyOutputEvaluationReceipt:
    payload = json.dumps(candidate.model_dump(mode="json"), ensure_ascii=False)
    results: list[StudyOutputAssertionResult] = []
    for assertion_type, expected in load_suite_asserts(suite_path):
        results.append(_apply(assertion_type, expected, payload, candidate.model_dump(mode="json")))
    failed = any(item.status == "failed" for item in results)
    return StudyOutputEvaluationReceipt(
        schema_version="helix.study-output-evaluation-receipt/v1",
        receipt_id=receipt_id or f"SOE-{uuid4().hex[:12].upper()}",
        candidate_id=candidate.candidate_id,
        candidate_hash=candidate_hash,
        suite_id=suite_id,
        suite_version=suite_version,
        suite_hash=file_hash(suite_path),
        status="failed" if failed else "passed",
        enforcement_class="review_required",
        waivable=False,
        results=results,
    )


def load_suite_asserts(path: Path) -> list[tuple[str, str | None]]:
    asserts: list[tuple[str, str | None]] = []
    pending: str | None = None
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if line.startswith("- type:"):
            pending = line.split(":", 1)[1].strip()
            if pending == "is-json":
                asserts.append((pending, None))
                pending = None
            continue
        if line.startswith("value:") and pending is not None:
            value = line.split(":", 1)[1].strip()
            if value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            asserts.append((pending, value))
            pending = None
    return asserts


def _apply(
    assertion_type: str,
    expected: str | None,
    payload: str,
    parsed: object,
) -> StudyOutputAssertionResult:
    if assertion_type == "is-json":
        ok = isinstance(parsed, dict)
        return StudyOutputAssertionResult(
            assertion="is-json",
            status="passed" if ok else "failed",
            message="Candidate JSON parsed." if ok else "Candidate JSON did not parse.",
        )
    if assertion_type == "contains":
        needle = expected or ""
        ok = needle in payload
        return StudyOutputAssertionResult(
            assertion=f"contains:{needle}",
            status="passed" if ok else "failed",
            message=f"Candidate contains {needle}." if ok else f"Candidate is missing {needle}.",
        )
    if assertion_type == "not-contains":
        needle = expected or ""
        ok = needle not in payload
        return StudyOutputAssertionResult(
            assertion=f"not-contains:{needle}",
            status="passed" if ok else "failed",
            message=(
                f"Candidate omits {needle}."
                if ok
                else f"Candidate contains advisory-forbidden {needle}."
            ),
        )
    return StudyOutputAssertionResult(
        assertion=assertion_type,
        status="failed",
        message=f"Unknown study-output assertion {assertion_type}.",
    )
