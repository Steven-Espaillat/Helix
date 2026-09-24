"""HELIX section executor — deterministic calculation, one function per report section.

Design (deliberately simple, single file):

    .agents/skills/helix-section-agent/references/section_skills/skill_<id>.md
                                  the presentation contract (referenced, never executed)
    compute_<id>(package)         the deterministic calculation (this file)

The executor NEVER calls an LLM. Each compute function reads the frozen study
records, computes the numbers a section needs, and returns a `SectionResult`
carrying structured `facts` plus `provenance` (which source records back each
number). `build_draft_messages()` pairs those facts with the section's skill so
an LLM can render the narrative — that render step is optional and lives
outside this file, keeping the calculation pure and testable without credentials.

Add a section = write one `compute_<id>` and register it in REGISTRY.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from statistics import mean

from .schemas import Animal, StudyEvidencePackage

SKILLS_DIR = (
    Path(__file__).resolve().parents[2]
    / ".agents"
    / "skills"
    / "helix-section-agent"
    / "references"
    / "section_skills"
)


# --------------------------------------------------------------------------- #
# Result + provenance containers
# --------------------------------------------------------------------------- #

@dataclass
class Provenance:
    """Links one computed number to the source records that produced it."""

    section_id: str
    claim: str
    source_record_ids: list[str]
    agg: str = "value"  # value | mean | count | incidence


@dataclass
class SectionResult:
    section_id: str
    title: str
    skill_file: str
    data_available: bool
    facts: dict
    provenance: list[Provenance] = field(default_factory=list)
    note: str = ""


# --------------------------------------------------------------------------- #
# Skill loader (shared by every section)
# --------------------------------------------------------------------------- #

def load_skill(section_id: str) -> str:
    """Return the section's skill markdown, or a marker if it is not present."""
    path = SKILLS_DIR / f"skill_{section_id}.md"
    if not path.exists():
        return f"[SKILL FILE NOT FOUND: skill_{section_id}.md]"
    return path.read_text(encoding="utf-8")


def load_meta_prompt() -> str:
    """Return the global narrative-style guide applied to every section, or empty."""
    path = SKILLS_DIR / "meta_prompt_pathology_narrative.md"
    return path.read_text(encoding="utf-8") if path.exists() else ""


# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #

def _animals(package: StudyEvidencePackage) -> dict[str, Animal]:
    return {a.animal_id: a for a in package.records.animals}


def _group_meta(package: StudyEvidencePackage) -> dict[str, dict]:
    return {
        g.group_id: {"label": g.label, "dose": g.dose, "dose_unit": g.dose_unit}
        for g in package.study.dose_groups
    }


def _ordered_group_ids(package: StudyEvidencePackage) -> list[str]:
    return [g.group_id for g in package.study.dose_groups]


def _day_num(timepoint: str) -> int:
    """'DAY 28' -> 28. Non-day timepoints sort last."""
    parts = timepoint.split()
    return int(parts[-1]) if len(parts) == 2 and parts[-1].isdigit() else 10_000


def _sex_label(sex: str) -> str:
    return {"M": "Male", "F": "Female"}.get(sex.strip().upper(), sex)


# --------------------------------------------------------------------------- #
# 5.2.3 Body Weight  —  mean body weight by group x sex x study day
# --------------------------------------------------------------------------- #

def compute_body_weight(package: StudyEvidencePackage) -> SectionResult:
    animals = _animals(package)
    groups = _group_meta(package)
    rows = package.records.body_weights

    days = sorted({_day_num(r.timepoint) for r in rows if _day_num(r.timepoint) < 10_000})

    def means_for(sex: str) -> tuple[dict, list[Provenance]]:
        table: dict[str, dict[int, float]] = {}
        prov: list[Provenance] = []
        for gid in _ordered_group_ids(package):
            for day in days:
                cell_ids: list[str] = []
                vals: list[float] = []
                for r in rows:
                    a = animals.get(r.animal_id or "")
                    if a and a.group_id == gid and a.sex == sex and _day_num(r.timepoint) == day:
                        vals.append(float(r.value))
                        cell_ids.append(r.record_id)
                if vals:
                    table.setdefault(gid, {})[day] = round(mean(vals), 1)
                    cell_mean = round(mean(vals), 1)
                    prov.append(Provenance(
                        section_id="5_2_3_body_weight",
                        claim=f"{_sex_label(sex)} {gid} Day {day} mean {cell_mean} g (n={len(vals)})",
                        source_record_ids=cell_ids,
                        agg="mean",
                    ))
        return table, prov

    male, male_prov = means_for("M")
    female, female_prov = means_for("F")

    facts = {
        "recording_days": days,
        "duration_days": package.study.duration_days,
        "unit": "g",
        "groups": [{"group_id": gid, **groups[gid]} for gid in _ordered_group_ids(package)],
        "male_means": male,
        "female_means": female,
    }
    return SectionResult(
        section_id="5_2_3_body_weight",
        title="5.2.3 Body Weight",
        skill_file="skill_5_2_3_body_weight.md",
        data_available=bool(male or female),
        facts=facts,
        provenance=male_prov + female_prov,
    )


# --------------------------------------------------------------------------- #
# 5.3.1 Organ Weights  —  mean terminal organ weight by group x sex x organ
# --------------------------------------------------------------------------- #

def compute_organ_weights(package: StudyEvidencePackage) -> SectionResult:
    animals = _animals(package)
    groups = _group_meta(package)
    rows = package.records.organ_weights
    organs = sorted({r.test_code for r in rows})

    tables: dict[str, dict] = {"Male": {}, "Female": {}}
    prov: list[Provenance] = []
    for sex in ("M", "F"):
        for gid in _ordered_group_ids(package):
            for organ in organs:
                vals, ids = [], []
                for r in rows:
                    a = animals.get(r.animal_id or "")
                    if a and a.group_id == gid and a.sex == sex and r.test_code == organ:
                        vals.append(float(r.value))
                        ids.append(r.record_id)
                if vals:
                    tables[_sex_label(sex)].setdefault(organ, {})[gid] = round(mean(vals), 2)
                    prov.append(Provenance(
                        section_id="5_3_1_organ_weights",
                        claim=f"{_sex_label(sex)} {organ} {gid} mean {round(mean(vals),2)} g",
                        source_record_ids=ids,
                        agg="mean",
                    ))

    facts = {
        "unit": "g",
        "timepoint": "terminal",
        "organs": organs,
        "groups": [{"group_id": gid, **groups[gid]} for gid in _ordered_group_ids(package)],
        "male_means": tables["Male"],
        "female_means": tables["Female"],
    }
    return SectionResult(
        section_id="5_3_1_organ_weights",
        title="5.3.1 Organ Weights",
        skill_file="skill_5_3_1_organ_weights.md",
        data_available=bool(tables["Male"] or tables["Female"]),
        facts=facts,
        provenance=prov,
    )


# --------------------------------------------------------------------------- #
# 5.2.2 Clinical Observations  —  abnormal-finding incidence per group
# --------------------------------------------------------------------------- #

_NORMAL_TEXT = {"no abnormality detected", "no abnormal findings", "normal", ""}


def compute_clinical_obs(package: StudyEvidencePackage) -> SectionResult:
    animals = _animals(package)
    groups = _group_meta(package)
    rows = package.records.clinical_observations

    # animals-per-group (denominator)
    n_by_group: dict[str, int] = {}
    for a in package.records.animals:
        n_by_group[a.group_id] = n_by_group.get(a.group_id, 0) + 1

    # animals with >=1 abnormal finding, per group
    abnormal_animals: dict[str, set[str]] = {}
    findings: dict[str, dict[str, int]] = {}
    prov: list[Provenance] = []
    for r in rows:
        value = str(r.value).strip()
        if value.lower() in _NORMAL_TEXT:
            continue
        a = animals.get(r.animal_id or "")
        if not a:
            continue
        abnormal_animals.setdefault(a.group_id, set()).add(a.animal_id)
        findings.setdefault(a.group_id, {})
        findings[a.group_id][value] = findings[a.group_id].get(value, 0) + 1
        prov.append(Provenance(
            section_id="5_2_2_clinical_obs",
            claim=f"{a.group_id} {a.animal_id} {r.timepoint}: {value}",
            source_record_ids=[r.record_id],
        ))

    incidence = {
        gid: {"n_affected": len(abnormal_animals.get(gid, set())),
              "n_total": n_by_group.get(gid, 0),
              "findings": findings.get(gid, {})}
        for gid in _ordered_group_ids(package)
    }
    any_abnormal = any(v["n_affected"] for v in incidence.values())
    facts = {
        "groups": [{"group_id": gid, **groups[gid]} for gid in _ordered_group_ids(package)],
        "incidence": incidence,
        "any_abnormal": any_abnormal,
    }
    return SectionResult(
        section_id="5_2_2_clinical_obs",
        title="5.2.2 Clinical Observations",
        skill_file="skill_5_2_2_clinical_obs.md",
        data_available=True,
        facts=facts,
        provenance=prov,
        note="" if any_abnormal else "No abnormal clinical observations recorded in any group.",
    )


# --------------------------------------------------------------------------- #
# 5.3.3 Microscopic Findings  —  finding incidence + severities per tissue/group
# --------------------------------------------------------------------------- #

def compute_microscopic(package: StudyEvidencePackage) -> SectionResult:
    animals = _animals(package)
    groups = _group_meta(package)
    rows = package.records.microscopic_findings

    n_by_group: dict[str, int] = {}
    for a in package.records.animals:
        n_by_group[a.group_id] = n_by_group.get(a.group_id, 0) + 1

    # tissue -> finding -> group -> {count, severities, record_ids}
    agg: dict[str, dict[str, dict[str, dict]]] = {}
    prov: list[Provenance] = []
    for r in rows:
        if r.finding.strip().lower() in _NORMAL_TEXT or r.severity.strip().lower() == "none":
            continue
        a = animals.get(r.animal_id)
        if not a:
            continue
        cell = agg.setdefault(r.tissue, {}).setdefault(r.finding, {}).setdefault(
            a.group_id, {"count": 0, "severities": set(), "record_ids": []}
        )
        cell["count"] += 1
        cell["severities"].add(r.severity)
        cell["record_ids"].append(r.finding_id)

    # serialize (sets -> sorted lists) and build provenance
    findings_out: dict[str, dict[str, dict[str, dict]]] = {}
    for tissue, fmap in agg.items():
        for finding, gmap in fmap.items():
            for gid, cell in gmap.items():
                findings_out.setdefault(tissue, {}).setdefault(finding, {})[gid] = {
                    "count": cell["count"],
                    "n_total": n_by_group.get(gid, 0),
                    "severities": sorted(cell["severities"]),
                }
                severities = sorted(cell["severities"])
                prov.append(Provenance(
                    section_id="5_3_3_microscopic",
                    claim=f"{tissue} {finding} in {cell['count']} {gid} animals (severity {severities})",
                    source_record_ids=cell["record_ids"],
                    agg="incidence",
                ))

    facts = {
        "groups": [{"group_id": gid, **groups[gid]} for gid in _ordered_group_ids(package)],
        "findings": findings_out,
        "grading_scale": "1 (minimal) to 5 (severe)",
    }
    return SectionResult(
        section_id="5_3_3_microscopic",
        title="5.3.3 Microscopic Findings",
        skill_file="skill_5_3_3_microscopic.md",
        data_available=bool(findings_out),
        facts=facts,
        provenance=prov,
        note="" if findings_out else "No treatment-related microscopic findings recorded.",
    )


# --------------------------------------------------------------------------- #
# 5.1 Formulation Analysis  —  measured concentration by group x timepoint
# --------------------------------------------------------------------------- #

def compute_formulation(package: StudyEvidencePackage) -> SectionResult:
    groups = _group_meta(package)
    rows = package.records.formulation
    prov: list[Provenance] = []

    table: dict[str, dict[str, float]] = {}
    for r in rows:
        gid = r.group_id or ""
        table.setdefault(gid, {})[r.timepoint] = float(r.value)
        prov.append(Provenance(
            section_id="5_1_formulation",
            claim=f"{gid} {r.timepoint} measured {r.value} {r.unit}",
            source_record_ids=[r.record_id],
        ))

    facts = {
        "unit": rows[0].unit if rows else "mg/mL",
        "timepoints": sorted({r.timepoint for r in rows}, key=_day_num),
        "groups": [{"group_id": gid, **groups[gid]} for gid in _ordered_group_ids(package)],
        "measured": table,
        "acceptance_criterion": "+/- 10% of nominal concentration",
    }
    return SectionResult(
        section_id="5_1_formulation",
        title="5.1 Formulation Analysis",
        skill_file="skill_5_1_formulation.md",
        data_available=bool(table),
        facts=facts,
        provenance=prov,
    )


# --------------------------------------------------------------------------- #
# 2. Experimental Design  —  group allocation (M/F counts, dose)
# --------------------------------------------------------------------------- #

def compute_experimental_design(package: StudyEvidencePackage) -> SectionResult:
    groups = _group_meta(package)
    counts: dict[str, dict[str, int]] = {}
    for a in package.records.animals:
        c = counts.setdefault(a.group_id, {"M": 0, "F": 0})
        c[a.sex] = c.get(a.sex, 0) + 1

    allocation = [
        {"group_id": gid, **groups[gid],
         "males": counts.get(gid, {}).get("M", 0),
         "females": counts.get(gid, {}).get("F", 0)}
        for gid in _ordered_group_ids(package)
    ]
    facts = {
        "species": package.study.species,
        "route": package.study.route,
        "duration_days": package.study.duration_days,
        "allocation": allocation,
        "total_animals": len(package.records.animals),
    }
    return SectionResult(
        section_id="2_experimental_design",
        title="2. Experimental Design",
        skill_file="skill_2_experimental_design.md",
        data_available=True,
        facts=facts,
    )


# --------------------------------------------------------------------------- #
# 5.2.1 Mortality  —  survival counts (no disposition domain in this bundle)
# --------------------------------------------------------------------------- #

def compute_mortality(package: StudyEvidencePackage) -> SectionResult:
    total = len(package.records.animals)
    facts = {"total_animals": total, "unscheduled_deaths": [], "survivors": total}
    return SectionResult(
        section_id="5_2_1_mortality",
        title="5.2.1 Mortality",
        skill_file="skill_5_2_1_mortality.md",
        data_available=True,
        facts=facts,
        note="No disposition/mortality domain in this bundle; all animals treated as "
             "surviving to scheduled necropsy. Confirm against source before release.",
    )


# --------------------------------------------------------------------------- #
# Text / judgment sections  —  facts from study metadata, no numeric calc
# --------------------------------------------------------------------------- #

def _study_facts(package: StudyEvidencePackage) -> dict:
    s = package.study
    return {
        "study_id": s.study_id, "species": s.species, "route": s.route,
        "duration_days": s.duration_days, "protocol_version": s.protocol_version,
        "doses": [{"group_id": g.group_id, "label": g.label, "dose": g.dose,
                   "dose_unit": g.dose_unit} for g in s.dose_groups],
    }


def compute_summary(package: StudyEvidencePackage) -> SectionResult:
    return SectionResult("summary", "Summary", "skill_summary.md", True,
                         _study_facts(package),
                         note="Integrated narrative; NOAEL requires human judgment.")


def compute_objective(package: StudyEvidencePackage) -> SectionResult:
    return SectionResult("1_objective", "1. Objective", "skill_1_objective.md", True,
                         _study_facts(package))


def compute_materials_methods(package: StudyEvidencePackage) -> SectionResult:
    return SectionResult("3_materials_methods", "3. Materials and Methods",
                         "skill_3_materials_methods.md", True, _study_facts(package))


def compute_deviations(package: StudyEvidencePackage) -> SectionResult:
    return SectionResult("4_deviations", "4. Deviations from Protocol",
                         "skill_4_deviations.md", False, {"deviations": []},
                         note="No deviation/disposition domain present in this bundle.")


def compute_macroscopic(package: StudyEvidencePackage) -> SectionResult:
    return SectionResult("5_3_2_macroscopic", "5.3.2 Macroscopic Observations",
                         "skill_5_3_2_macroscopic.md", False, {"findings": {}},
                         note="No gross-pathology domain present in this bundle.")


def compute_conclusion(package: StudyEvidencePackage) -> SectionResult:
    noael = next((c for c in package.claims if c.field_id == "noael"), None)
    return SectionResult("5_3_4_conclusion", "5.3.4 Conclusion",
                         "skill_5_3_4_conclusion.md", False,
                         {"noael_claim": noael.claim_id if noael else None},
                         note="[NEEDS REVIEW] NOAEL requires qualified scientific judgment.")


def compute_qa(package: StudyEvidencePackage) -> SectionResult:
    return SectionResult("7_qa_statement", "7. Quality Assurance Statement",
                         "skill_7_qa_statement.md", True, _study_facts(package))


# --------------------------------------------------------------------------- #
# Registry  —  add a section by adding one line here
# --------------------------------------------------------------------------- #

REGISTRY = {
    "summary": compute_summary,
    "1_objective": compute_objective,
    "2_experimental_design": compute_experimental_design,
    "3_materials_methods": compute_materials_methods,
    "4_deviations": compute_deviations,
    "5_1_formulation": compute_formulation,
    "5_2_1_mortality": compute_mortality,
    "5_2_2_clinical_obs": compute_clinical_obs,
    "5_2_3_body_weight": compute_body_weight,
    "5_3_1_organ_weights": compute_organ_weights,
    "5_3_2_macroscopic": compute_macroscopic,
    "5_3_3_microscopic": compute_microscopic,
    "5_3_4_conclusion": compute_conclusion,
    "7_qa_statement": compute_qa,
}


def run_section(section_id: str, package: StudyEvidencePackage) -> SectionResult:
    if section_id not in REGISTRY:
        raise KeyError(f"No executor registered for section '{section_id}'")
    return REGISTRY[section_id](package)


def run_all(package: StudyEvidencePackage) -> list[SectionResult]:
    return [REGISTRY[sid](package) for sid in REGISTRY]


# --------------------------------------------------------------------------- #
# Glue to the LLM render step (optional; no LLM call here)
# --------------------------------------------------------------------------- #

class SectionNotDraftable(RuntimeError):
    """Raised when a section has no computed data for the LLM to render."""


def build_draft_messages(result: SectionResult) -> list[dict]:
    """Pair the section skill (system) with the computed facts (user).

    Hand this to any chat-completions client to produce the narrative. The LLM
    only renders/prose-wraps the numbers here — it never calculates them.

    Refuses when `data_available` is False. A skill states what a section must
    contain, so pairing one with empty facts asks for a value no computation
    produced — `skill_5_3_4_conclusion.md` requires a NOAEL "as a number with
    units" while `compute_conclusion` supplies `{"noael_claim": None}`, and the
    skill carries worked examples with real doses. Callers route a refused
    section to the `[NEEDS REVIEW]` placeholder of ADR-0004 instead.
    """
    if not result.data_available:
        raise SectionNotDraftable(
            f"{result.section_id}: no computed data to render "
            f"({result.note or 'no note'}). Route to [NEEDS REVIEW]."
        )

    skill = load_skill(result.section_id)
    meta = load_meta_prompt()
    style_layer = f"\n\n# GLOBAL NARRATIVE STYLE (applies to every section)\n\n{meta}" if meta else ""
    system = (
        "You are a GLP-study pathologist. Write the report section named "
        f"'{result.title}'. Follow the skill exactly. Use ONLY the pre-calculated "
        "values provided — do not compute, invent, or alter any number."
        + style_layer
        + f"\n\n# SECTION SKILL\n\n{skill}"
    )
    user = (
        f"Section: {result.title}\n"
        f"Data available: {result.data_available}\n"
        f"Note: {result.note or 'none'}\n\n"
        f"Pre-calculated facts (JSON):\n{json.dumps(result.facts, indent=2)}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


# --------------------------------------------------------------------------- #
# Deterministic markdown render (no LLM) — proves the calculation stands alone
# --------------------------------------------------------------------------- #

def _bw_table_markdown(title: str, means: dict, days: list[int], groups: list[dict]) -> str:
    header = "| Group | " + " | ".join(f"Day {d}" for d in days) + " |"
    sep = "|---|" + "---:|" * len(days)
    lines = [f"**{title}:**", "", header, sep]
    for g in groups:
        gid = g["group_id"]
        row = means.get(gid, {})
        cells = " | ".join(str(row.get(d, "—")) for d in days)
        lines.append(f"| {gid} - {g['label']}, {g['dose']:g} {g['dose_unit']} | {cells} |")
    return "\n".join(lines)


def to_markdown(result: SectionResult) -> str:
    """Render a computed section deterministically, no LLM. Table sections get
    real tables; other sections get a compact fact summary."""
    if result.section_id == "5_2_3_body_weight" and result.data_available:
        f = result.facts
        return (
            f"## {result.title}\n\n"
            f"Body weights were recorded on Day 1 (pre-dose) and weekly through "
            f"Day {f['duration_days']}.\n\n"
            + _bw_table_markdown(
                "Male Mean Body Weights (g)", f["male_means"], f["recording_days"], f["groups"]
            )
            + "\n\n"
            + _bw_table_markdown(
                "Female Mean Body Weights (g)", f["female_means"], f["recording_days"], f["groups"]
            )
            + f"\n\n_Provenance: {len(result.provenance)} source-backed means._"
        )
    header = f"## {result.title}"
    body = result.note or "(no narrative-free render; use build_draft_messages for prose)"
    return f"{header}\n\n{body}\n\n```json\n{json.dumps(result.facts, indent=2)}\n```"


# --------------------------------------------------------------------------- #
# CLI demo:  python -m app.section_executor
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    from .config import get_settings
    from .seed import load_seed_package, resolve_seed_path

    pkg = load_seed_package(resolve_seed_path(get_settings().seed_path))
    print(f"Study: {pkg.study.study_id}  ({len(pkg.records.animals)} animals)\n")

    print("=== Section coverage ===")
    for res in run_all(pkg):
        flag = "data" if res.data_available else "no-data"
        print(f"  [{flag:7}] {res.title:34} provenance={len(res.provenance)}")

    print("\n=== 5.2.3 Body Weight (deterministic render, no LLM) ===\n")
    print(to_markdown(run_section("5_2_3_body_weight", pkg)))
