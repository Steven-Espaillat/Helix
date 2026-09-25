import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.seed import load_seed_package
from app.validation import OpenAICompatiblePlanner, execute_agent_plan, parse_agent_plan

SEED_PATH = Path(__file__).resolve().parents[2] / "synthetic-e2e" / "helix-synthetic-bundle.json"


class StubResponse:
    status_code = 200
    text = ""

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, object]:
        plan = {
            "proposals": [
                {"tool": "grounded_numeric_claim", "claim_id": "C-BW-HIGH"},
                {"tool": "source_severity_match", "claim_id": "C-MI-LIVER"},
                {"tool": "human_judgment_required", "claim_id": "C-NOAEL"},
            ]
        }
        return {"choices": [{"message": {"content": json.dumps(plan)}}]}


def test_openai_compatible_planner_uses_strict_plan_then_deterministic_tools(monkeypatch) -> None:
    request: dict[str, object] = {}

    def fake_post(url: str, **kwargs: object) -> StubResponse:
        request["url"] = url
        request.update(kwargs)
        return StubResponse()

    monkeypatch.setattr("app.validation.httpx.post", fake_post)
    settings = Settings(
        llm_base_url="https://planner.example/v1/",
        llm_api_key="test-key",
        llm_model="test-model",
    )
    package = load_seed_package(SEED_PATH)

    plan = OpenAICompatiblePlanner(settings).plan(package)
    results = execute_agent_plan(package, plan)

    assert request["url"] == "https://planner.example/v1/chat/completions"
    assert request["headers"] == {"Authorization": "Bearer test-key"}
    payload = request["json"]
    assert isinstance(payload, dict)
    assert "temperature" not in payload
    assert payload["response_format"]["json_schema"]["strict"] is True
    assert [result.tool_name for result in results] == [
        "grounded_numeric_claim",
        "source_severity_match",
        "human_judgment_required",
    ]
    assert [result.status.value for result in results] == ["pass", "fail", "pass"]


def test_agent_plan_rejects_unregistered_tools() -> None:
    with pytest.raises(ValidationError):
        parse_agent_plan({"proposals": [{"tool": "invent_a_result", "claim_id": "C-BW-HIGH"}]})
