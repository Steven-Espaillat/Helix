from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app.approved_exports import note_agent_start


@dataclass(frozen=True)
class AgentResult:
    thread_id: str
    final_response: str


class SectionAgent(Protocol):
    def run(self, *, envelope_id: str, prompt: str, output_schema: dict[str, object]) -> AgentResult: ...


class CodexSectionAgent:
    def __init__(self, repository_root: Path):
        self.repository_root = repository_root

    def run(self, *, envelope_id: str, prompt: str, output_schema: dict[str, object]) -> AgentResult:
        note_agent_start()
        from openai_codex import Codex, Sandbox

        cwd = str(self.repository_root)
        with Codex() as codex:
            thread = codex.thread_start(cwd=cwd, sandbox=Sandbox.read_only)
            result = thread.run(
                prompt.replace("{{CODEX_THREAD_ID}}", thread.id),
                cwd=cwd,
                sandbox=Sandbox.read_only,
                output_schema=output_schema,
            )
        if result.final_response is None:
            raise RuntimeError(f"Codex thread {thread.id} returned no final response for {envelope_id}")
        return AgentResult(thread_id=thread.id, final_response=result.final_response)
