"""Package qualification gate and the demo-only unqualified-packages flag (Lane D).

HELIX_DEMO_UNQUALIFIED_PACKAGES handles the two unqualified section packages.

DEMO ONLY. THIS IS NOT QUALIFICATION. With the flag off (the default) nothing here is
consulted and every gate behaves exactly as it does without this module.

With the flag on:
- The Pinned Run gate accepts section.5_2_3_body_weight and section.5_3_discussion while
  their qualification_status is still "pending". No other package, status, or hash is
  affected, and the package files are never written.
- The exact label "Demo: not qualified" is carried by the workspace payload
  (demo_unqualified_packages). The run_requested event of a demo-frozen run carries the
  skipped package ids (DEMO_EVENT_DETAIL), not the label. The UI shows a small
  "Not qualified" status label for a demo-frozen run only (DH-7, #68).
- Export fails closed for a demo-frozen run (DH-7, #68): demo_frozen_export_refusal()
  returns a refusal message. The service checks it before the idempotent export replay and
  before serving any stored artifact bytes, so a demo run exported before this guard existed
  can no longer be replayed or downloaded (409, code DEMO_NOT_QUALIFIED, flag on or off).
  approved_exports.materialize_approved_artifacts also raises it first as a backstop. Unqualified output can
  never leave the system. Strict runs and flag-off behaviour are unchanged.
- The freeze stays human-only. The flag never creates, triggers, or replays a Pinned Run;
  it only changes what the human freeze command accepts.
- No qualification hash, skill hash, or package hash is fabricated. A skipped package has no
  qualification receipt, so the receipt hash check simply has nothing to verify for it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

DEMO_FLAG_ENV = "HELIX_DEMO_UNQUALIFIED_PACKAGES"
DEMO_LABEL = "Demo: not qualified"
DEMO_NOTE = (
    "Demo only, not qualification. These section packages are qualification_status "
    '"pending"; HELIX_DEMO_UNQUALIFIED_PACKAGES let this run proceed without a passing '
    "qualification."
)
# Exactly the two packages named in the ticket. Anything else keeps the strict gate.
DEMO_UNQUALIFIED_PACKAGE_IDS: tuple[str, ...] = (
    "section.5_2_3_body_weight",
    "section.5_3_discussion",
)
# Recorded on the run_requested event of a demo-frozen Pinned Run (comma-separated ids).
DEMO_EVENT_DETAIL = "demo_unqualified_packages"


def demo_packages_of(pinned_run: Any) -> list[str]:
    """Package ids whose qualification was skipped when this Pinned Run was frozen."""
    if pinned_run is None:
        return []
    for event in pinned_run.event_history:
        if event.event == "run_requested":
            value = event.details.get(DEMO_EVENT_DETAIL)
            if isinstance(value, str) and value:
                return [item for item in value.split(",") if item]
    return []


# Machine-readable code on the 409 for a demo-frozen export, replay, or download (DH-7 P2).
DEMO_NOT_QUALIFIED = "demo_not_qualified"
DEMO_EXPORT_REFUSAL = "Export refused: this run was frozen with the demo flag (packages not qualified)."


def demo_frozen_export_refusal(pinned_run: Any) -> str | None:
    """Fail closed: a run that skipped qualification can never be exported.

    Returns the refusal message (not an exception) so approved_exports can raise its own
    ApprovedExportError without a circular import.
    """
    return DEMO_EXPORT_REFUSAL if demo_packages_of(pinned_run) else None


def skips_qualification(flag_on: bool, package_id: str, skill: dict[str, Any]) -> bool:
    """True only when the demo flag lets this exact package pass the gate while "pending".

    Any other package, any other status (for example "failed"), or the flag off keeps the
    strict ``invalid_package_qualification`` check.
    """
    return (
        flag_on
        and package_id in DEMO_UNQUALIFIED_PACKAGE_IDS
        and skill.get("qualification_status") == "pending"
    )


def demo_notice(package_ids: list[str], titles: dict[str, str]) -> dict[str, object]:
    return {
        "label": DEMO_LABEL,
        "note": DEMO_NOTE,
        "sections": [
            {
                "section_package_id": package_id,
                "title": titles.get(package_id, package_id),
                "qualification_status": "pending",
                "label": DEMO_LABEL,
            }
            for package_id in package_ids
        ],
    }


def section_package_definitions(repository_root: Path) -> dict[str, dict[str, Any]]:
    sections = repository_root / "skills" / "helix-evidence-pipeline" / "packages" / "sections"
    definitions: dict[str, dict[str, Any]] = {}
    for path in sorted(sections.glob("*/package.json")):
        definition = json.loads(path.read_text())
        definitions[str(definition["package_id"])] = definition
    return definitions


def demo_package_ids(repository_root: Path, *, flag_on: bool, pinned_run: Any) -> list[str]:
    """Packages to label: those a demo-frozen run skipped, plus (flag on) the pending demo packages."""
    ids = set(demo_packages_of(pinned_run))
    if flag_on:
        definitions = section_package_definitions(repository_root)
        for package_id in DEMO_UNQUALIFIED_PACKAGE_IDS:
            skill = (definitions.get(package_id) or {}).get("skill") or {}
            if skill.get("qualification_status") == "pending":
                ids.add(package_id)
    return [package_id for package_id in DEMO_UNQUALIFIED_PACKAGE_IDS if package_id in ids]


def demo_package_labels(repository_root: Path, *, flag_on: bool, pinned_run: Any) -> list[dict[str, str]]:
    ids = demo_package_ids(repository_root, flag_on=flag_on, pinned_run=pinned_run)
    if not ids:
        return []
    definitions = section_package_definitions(repository_root)
    return [
        {
            "section_package_id": package_id,
            "section_id": str(definitions.get(package_id, {}).get("section_id", "")),
            "prototype_section_id": str(definitions.get(package_id, {}).get("prototype_section_id", "")),
            "title": str(definitions.get(package_id, {}).get("title", package_id)),
            "qualification_status": "pending",
            "label": DEMO_LABEL,
        }
        for package_id in ids
    ]


DEFAULT_REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def section_titles(repository_root: Path = DEFAULT_REPOSITORY_ROOT) -> dict[str, str]:
    return {
        package_id: str(definition.get("title", package_id))
        for package_id, definition in section_package_definitions(repository_root).items()
    }
