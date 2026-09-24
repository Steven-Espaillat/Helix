import hashlib
import re
import shutil
from pathlib import Path

from app.skill_integrity import SECTION_AGENT_ROOT, skill_integrity

ROOT = Path(__file__).resolve().parents[2]
SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
REFERENCES_PREIMAGE = (
    '{"agents/openai.yaml":"sha256:7d00ed7c289a30d0841a865fdd2970d8919cce3fdd266281531870e6d89df6fd"}'
)


def copy_skill_tree(tmp_path: Path) -> Path:
    dest = tmp_path / "helix-section-agent"
    shutil.copytree(ROOT / SECTION_AGENT_ROOT, dest)
    return dest


def test_skill_integrity_is_stable_and_splits_document_from_references(tmp_path: Path) -> None:
    skill_root = copy_skill_tree(tmp_path)
    first = skill_integrity(skill_root)
    second = skill_integrity(skill_root)
    assert first == second
    assert SHA256.fullmatch(first.skill_hash)
    assert SHA256.fullmatch(first.skill_references_hash)
    assert first.skill_hash != first.skill_references_hash


def test_agents_yaml_moves_only_references_hash(tmp_path: Path) -> None:
    skill_root = copy_skill_tree(tmp_path)
    before = skill_integrity(skill_root)
    path = skill_root / "agents" / "openai.yaml"
    path.write_bytes(path.read_bytes() + b"\n")
    after = skill_integrity(skill_root)
    assert after.skill_hash == before.skill_hash
    assert after.skill_references_hash != before.skill_references_hash


def test_skill_md_moves_only_document_hash(tmp_path: Path) -> None:
    skill_root = copy_skill_tree(tmp_path)
    before = skill_integrity(skill_root)
    path = skill_root / "SKILL.md"
    path.write_bytes(path.read_bytes() + b"\n")
    after = skill_integrity(skill_root)
    assert after.skill_hash != before.skill_hash
    assert after.skill_references_hash == before.skill_references_hash


def test_evals_mutation_moves_neither_hash(tmp_path: Path) -> None:
    skill_root = copy_skill_tree(tmp_path)
    before = skill_integrity(skill_root)
    path = skill_root / "evals" / "promptfooconfig.yaml"
    path.write_bytes(path.read_bytes() + b"\n")
    after = skill_integrity(skill_root)
    assert after == before


def test_added_reference_moves_only_references_hash(tmp_path: Path) -> None:
    skill_root = copy_skill_tree(tmp_path)
    before = skill_integrity(skill_root)
    slot = skill_root / "section-presentation" / "slot.md"
    slot.parent.mkdir()
    slot.write_bytes(b"slot")
    after = skill_integrity(skill_root)
    assert after.skill_hash == before.skill_hash
    assert after.skill_references_hash != before.skill_references_hash


def test_encoding_vector_matches_known_bytes(tmp_path: Path) -> None:
    skill_root = tmp_path / "encoding"
    (skill_root / "agents").mkdir(parents=True)
    (skill_root / "evals").mkdir()
    (skill_root / "SKILL.md").write_bytes(b"skill-bytes")
    (skill_root / "agents" / "openai.yaml").write_bytes(b"yaml-bytes")
    (skill_root / "evals" / "prompt.txt").write_bytes(b"ignored")
    integrity = skill_integrity(skill_root)
    assert integrity.skill_hash == (
        "sha256:19754cc6c3669e5af39c6a4c6759576d194138d19c317e088737c2ec86ede8a5"
    )
    assert integrity.skill_references_hash == (
        f"sha256:{hashlib.sha256(REFERENCES_PREIMAGE.encode()).hexdigest()}"
    )
    assert integrity.skill_references_hash == (
        "sha256:ca5ae2dadc1aec5ab9272355b9ed076844937ee74b015b4bdae11b3f470e981b"
    )

    empty = tmp_path / "empty"
    empty.mkdir()
    (empty / "SKILL.md").write_bytes(b"skill-bytes")
    assert skill_integrity(empty).skill_references_hash == (
        "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    )
