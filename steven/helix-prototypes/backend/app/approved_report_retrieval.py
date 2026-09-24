import json
import re
from pathlib import Path


def extract_report_metadata(text: str) -> tuple[str, str, str]:
    """
    Extract identifying metadata from a Markdown research report.

    Derives the report type from the characters before the first dash in the
    study number. For example, "TOX-2024-0412" produces report type "TOX".

    Args:
        text: Complete Markdown report text containing "Study Title" and
            "Study Number" metadata fields.

    Returns:
        A tuple containing:
            - report_type: Prefix from the study number, such as "TOX".
            - report_id: Complete study number, such as "TOX-2024-0412".
            - report_title: Value of the "Study Title" field.

    Raises:
        ValueError: If the report title, study number, or derived report type
            cannot be extracted.
    """

    report_title_match = re.search(
        r"\*\*Study Title:\*\*\s*(.+?)(?=\*\*Study Number:)",
        text,
        re.DOTALL
    )

    report_id_match = re.search(
        r"\*\*Study Number:\*\*\s*([^\*\n]+)",
        text
    )

    report_title = (
        report_title_match.group(1).strip()
        if report_title_match else None
    )

    report_id = (
        report_id_match.group(1).strip()
        if report_id_match else None
    )

    report_id = (
        report_id_match.group(1).strip()
        if report_id_match else None
    )

    # Everything before the first dash
    report_type = (
        report_id.split("-")[0]
        if report_id else None
    )

    if not all([report_type, report_id, report_title]):
        raise ValueError(
            "Could not extract report_type, report_id, and report_title from report metadata."
        )

    return report_type, report_id, report_title

def add_report(
    md_file_path: str,
    kb_path: str = "knowledge_base.json"
) -> dict:
    """
    Parse a Markdown report and add it to the approved-report knowledge base.

    Extracts report metadata and numbered Markdown sections, including each
    section's title, parent hierarchy, and content. The updated knowledge base
    is saved as JSON.

    Args:
        md_file_path: Path to the Markdown report to process.
        kb_path: Path to the JSON knowledge-base file. If the file does not
            exist, it is created.

    Returns:
        The complete updated knowledge-base dictionary, organized as:
        report type -> report ID -> report metadata and sections.

    Raises:
        FileNotFoundError: If the Markdown report does not exist.
        UnicodeDecodeError: If the report cannot be read as UTF-8.
        ValueError: If required report metadata cannot be extracted.
        json.JSONDecodeError: If the existing knowledge-base file is not
            valid JSON.

    Notes:
        Adding a report with an existing report type and report ID replaces
        that report's existing knowledge-base entry.
    """

    text = Path(md_file_path).read_text(
        encoding="utf-8"
    )

    report_type, report_id, report_title = (
        extract_report_metadata(text)
    )

    heading_pattern = re.compile(
        r"^(#{1,6})\s+(\d+(?:\.\d+)*\.?)\s+(.+)$",
        re.MULTILINE
    )

    matches = list(
        heading_pattern.finditer(text)
    )

    title_lookup = {}

    for match in matches:

        section_num = match.group(2).rstrip(".")
        section_title = match.group(3).strip()

        title_lookup[section_num] = section_title

    kb_file = Path(kb_path)

    if kb_file.exists():

        with open(
            kb_file,
            encoding="utf-8"
        ) as f:

            kb = json.load(f)

    else:

        kb = {}

    kb.setdefault(report_type, {})

    report_entry = {
        "report_id": report_id,
        "report_title": report_title,
        "sections": {}
    }

    for idx, match in enumerate(matches):

        section_num = section_num = match.group(2).rstrip(".")
        section_title = match.group(3).strip()

        start = match.end()

        end = matches[idx + 1].start() if idx < len(matches) - 1 else len(text)

        content = text[start:end].strip()

        parent_sections = {}

        parts = section_num.split(".")

        for i in range(1, len(parts)):

            parent_num = ".".join(parts[:i])

            if parent_num in title_lookup:

                parent_sections[parent_num] = (
                    title_lookup[parent_num]
                )

        report_entry["sections"][section_num] = {
            "section_number": section_num,
            "section_title": section_title,
            "parent_sections": parent_sections,
            "content": content
        }

    kb[report_type][report_id] = report_entry

    with open(
        kb_path,
        "w",
        encoding="utf-8"
    ) as f:

        json.dump(
            kb,
            f,
            indent=2,
            ensure_ascii=False
        )

    return kb


def get_section(
    kb: dict,
    report_type: str,
    report_id: str,
    section_number: str
) -> dict:
    """
    Retrieve one specific section from one approved report.

    Args:
        kb: Knowledge-base dictionary returned by add_report().
        report_type: Report-type identifier, such as "TOX".
        report_id: Exact report identifier, such as "TOX-2024-0412".
        section_number: Exact section number, such as "5.2.2".

    Returns:
        A dictionary containing the section number, section title, parent
        sections, and section content.

    Raises:
        KeyError: If the report type, report ID, or section number is not
            present in the knowledge base.
    """

    return (
        kb[report_type]
          [report_id]
          ["sections"]
          [section_number]
    )


def get_all_examples(
    kb: dict,
    report_type: str,
    section_number: str
) -> list:
    """
    Retrieve the same section from all approved reports of one report type.

    Use this function when an agent needs approved examples of a specific
    section from multiple reports.

    Args:
        kb: Knowledge-base dictionary returned by add_report().
        report_type: Report-type identifier, such as "TOX".
        section_number: Exact section number to retrieve, such as "5.2.2".

    Returns:
        A list of matching section dictionaries. Each result contains the
        report ID, section number, section title, parent sections, and content.
        Returns an empty list if no reports contain the requested section.

    Raises:
        KeyError: If the requested report type is not present in the
            knowledge base.
    """

    examples = []

    for report_id, report in (
        kb[report_type].items()
    ):

        if section_number in report["sections"]:

            examples.append({
                "report_id": report_id,
                **report["sections"][
                    section_number
                ]
            })

    return examples


if __name__ == "__main__":

    kb = add_report(
        md_file_path="C:/TitaniumEngineer/Titanium_Engineer-04_Team_3/Data/data_v2.0/data/Approved_Reports/Approved_report_1.md",
    )
    kb = add_report(
        md_file_path="C:/TitaniumEngineer/Titanium_Engineer-04_Team_3/Data/data_v2.0/data/Approved_Reports/Approved_report_2.md",
    )
    kb = add_report(
        md_file_path="C:/TitaniumEngineer/Titanium_Engineer-04_Team_3/Data/data_v2.0/data/Approved_Reports/Approved_report_3.md",
    )

    print("\nKnowledge base created.\n")

    # section = get_section(
    #     kb,
    #     report_type="TOX",
    #     report_id="TOX-2024-0412",
    #     section_number="3.6"
    # )


    examples = get_all_examples(
        kb=kb,
        report_type="TOX",
        section_number="5.2.2"
    )

    print(f"Found {len(examples)} examples\n")

    for example in examples:

        print("=" * 80)
        print(example["report_id"])
        print(example["section_title"])
        print(example["parent_sections"])
        print(example["content"][:500])
        print()