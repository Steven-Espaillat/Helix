import hashlib
import json
import os
import stat
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from .schemas import SkillDocumentHash, SkillReferencesHash

SECTION_AGENT_ROOT = Path(".agents/skills/helix-section-agent")


class SkillTreeError(ValueError):
    pass


@dataclass(frozen=True)
class SkillIntegrity:
    skill_hash: SkillDocumentHash
    skill_references_hash: SkillReferencesHash


def skill_integrity(skill_root: Path) -> SkillIntegrity:
    if not skill_root.is_dir():
        raise SkillTreeError(f"Skill root does not exist: {skill_root}")
    if not (skill_root / "SKILL.md").exists():
        raise SkillTreeError(f"Skill root is missing SKILL.md: {skill_root}")

    skill_bytes: bytes | None = None
    references: dict[str, str] = {}
    for dirpath, dirnames, filenames in os.walk(skill_root, followlinks=False):
        current = Path(dirpath)
        if current == skill_root:
            dirnames[:] = [name for name in dirnames if name != "evals"]
        for name in dirnames:
            entry = current / name
            if entry.is_symlink():
                raise SkillTreeError(f"Skill tree contains a symlink: {entry}")
        for name in filenames:
            path = current / name
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                raise SkillTreeError(f"Skill tree contains a non-regular file: {path}")
            relative = _relative_path(skill_root, path)
            content = path.read_bytes()
            if relative == "SKILL.md":
                skill_bytes = content
                continue
            if relative in references:
                raise SkillTreeError(f"Duplicate skill path: {relative}")
            references[relative] = _sha256(content)

    if skill_bytes is None:
        raise SkillTreeError(f"Skill root is missing SKILL.md: {skill_root}")
    preimage = json.dumps(references, separators=(",", ":"), sort_keys=True).encode()
    return SkillIntegrity(
        skill_hash=SkillDocumentHash(_sha256(skill_bytes)),
        skill_references_hash=SkillReferencesHash(_sha256(preimage)),
    )


def _relative_path(skill_root: Path, path: Path) -> str:
    relative = unicodedata.normalize("NFC", path.relative_to(skill_root).as_posix())
    if "\\" in relative or ".." in Path(relative).parts:
        raise SkillTreeError(f"Illegal skill path: {relative}")
    return relative


def _sha256(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"
