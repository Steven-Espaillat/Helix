"""OpenAI strict structured-output compatibility for the planner (mocked HTTP)."""

import json
import logging
from pathlib import Path
from typing import Any

import httpx
import jsonschema
import pytest
from pydantic import ValidationError

from app.config import Settings
from app.seed import load_seed_package
from app.validation import (
    AgentPlan,
    OpenAICompatiblePlanner,
    PlannerResponseError,
    PlannerUnavailableError,
    PlannerUpstreamError,
    strict_plan_schema,
)

SEED_PATH = Path(__file__).resolve().parents[2] / "synthetic-e2e" / "helix-synthetic-bundle.json"
KEY = "sk-test-DO-NOT-LOG-0123456789abcdef"

# Keywords OpenAI strict mode accepts (structured outputs "supported schemas").
STRICT_ALLOWED = {
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "anyOf",
    "enum",
    "$ref",
    "$defs",
    "description",
    "minItems",
    "maxItems",
}
STRICT_FORBIDDEN = {"oneOf", "allOf", "not", "discriminator", "if", "then", "else", "patternProperties"}

GOOD_PLAN = {
    "proposals": [
        {"tool": "grounded_numeric_claim", "claim_id": "C-BW-HIGH"},
        {"tool": "source_severity_match", "claim_id": "C-MI-LIVER"},
        {"tool": "human_judgment_required", "claim_id": "C-NOAEL"},
    ]
}


def _walk_schema(node: Any, path: str, problems: list[str]) -> None:
    if isinstance(node, list):
        for index, item in enumerate(node):
            _walk_schema(item, f"{path}[{index}]", problems)
        return
    if not isinstance(node, dict):
        return
    for key in node:
        if key in STRICT_FORBIDDEN:
            problems.append(f"{path}: forbidden keyword {key}")
        elif key not in STRICT_ALLOWED:
            problems.append(f"{path}: unsupported keyword {key}")
    if node.get("type") == "object":
        if node.get("additionalProperties") is not False:
            problems.append(f"{path}: object without additionalProperties: false")
        if sorted(node.get("required", [])) != sorted(node.get("properties", {})):
            problems.append(f"{path}: not every property is required")
    for key in ("properties", "$defs"):
        for name, child in node.get(key, {}).items():
            _walk_schema(child, f"{path}.{key}.{name}", problems)
    for key in ("items", "anyOf"):
        if key in node:
            _walk_schema(node[key], f"{path}.{key}", problems)


def test_plan_schema_is_openai_strict_mode_valid() -> None:
    schema = strict_plan_schema()
    problems: list[str] = []
    _walk_schema(schema, "$", problems)
    assert problems == []
    assert schema["type"] == "object"  # strict mode needs an object root
    assert "anyOf" in schema["properties"]["proposals"]["items"]
    # The raw pydantic schema is what OpenAI rejected (oneOf + discriminator).
    raw = json.dumps(AgentPlan.model_json_schema())
    assert '"oneOf"' in raw and '"discriminator"' in raw


def test_strict_schema_keeps_the_output_contract() -> None:
    schema = strict_plan_schema()
    jsonschema.Draft202012Validator.check_schema(schema)
    jsonschema.validate(GOOD_PLAN, schema)
    AgentPlan.model_validate(GOOD_PLAN)
    for bad in (
        {"proposals": [{"tool": "invent_a_result", "claim_id": "C-BW-HIGH"}]},
        {"proposals": [{"tool": "grounded_numeric_claim"}]},
        {"proposals": [{"tool": "grounded_numeric_claim", "claim_id": "C", "extra": 1}]},
        {"plan": []},
    ):
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(bad, schema)
        with pytest.raises(ValidationError):
            AgentPlan.model_validate(bad)
    # Length limits are enforced upstream by the strict schema and on the reply by AgentPlan.
    proposals = schema["properties"]["proposals"]
    assert (proposals["minItems"], proposals["maxItems"]) == (1, 12)
    for bad_length in ({"proposals": []}, {"proposals": GOOD_PLAN["proposals"] * 5}):
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(bad_length, schema)
    with pytest.raises(ValidationError):
        AgentPlan.model_validate({"proposals": []})
    with pytest.raises(ValidationError):
        AgentPlan.model_validate({"proposals": GOOD_PLAN["proposals"] * 5})


def _settings(base_url: str, model: str) -> Settings:
    return Settings(llm_base_url=base_url, llm_api_key=KEY, llm_model=model)


def _openai_planner() -> OpenAICompatiblePlanner:
    return OpenAICompatiblePlanner(_settings("https://api.openai.com/v1", "gpt-6-luna"))


def _ok(url: str, plan: dict[str, Any]) -> httpx.Response:
    body = {"choices": [{"message": {"content": json.dumps(plan)}}]}
    return httpx.Response(200, json=body, request=httpx.Request("POST", url))


@pytest.mark.parametrize(
    ("base_url", "model", "expected_url"),
    [
        ("https://api.openai.com/v1", "gpt-6-luna", "https://api.openai.com/v1/chat/completions"),
        (
            "https://gateway.example.azure-api.net/openai/v1/",
            "gpt-5.5",
            "https://gateway.example.azure-api.net/openai/v1/chat/completions",
        ),
    ],
)
def test_payload_works_for_openai_and_azure_gateway(
    monkeypatch, base_url: str, model: str, expected_url: str
) -> None:
    seen: dict[str, Any] = {}

    def fake_post(url: str, **kwargs: Any) -> httpx.Response:
        seen["url"] = url
        seen.update(kwargs)
        return _ok(url, GOOD_PLAN)

    monkeypatch.setattr("app.validation.httpx.post", fake_post)
    plan = OpenAICompatiblePlanner(_settings(base_url, model)).plan(load_seed_package(SEED_PATH))

    assert plan == AgentPlan.model_validate(GOOD_PLAN)
    assert seen["url"] == expected_url
    payload = seen["json"]
    assert payload["model"] == model
    assert "temperature" not in payload
    assert payload["response_format"]["type"] == "json_schema"
    assert payload["response_format"]["json_schema"]["strict"] is True
    assert payload["response_format"]["json_schema"]["schema"] == strict_plan_schema()


OPENAI_400 = {
    "error": {
        "message": (
            "Unsupported value: 'temperature' does not support 0 with this model. "
            "Only the default (1) value is supported."
        ),
        "type": "invalid_request_error",
        "param": "temperature",
        "code": "unsupported_value",
    }
}


def test_upstream_error_is_typed_and_logged_without_the_key(monkeypatch, caplog) -> None:
    def fake_post(url: str, **kwargs: Any) -> httpx.Response:
        request = httpx.Request("POST", url, headers=kwargs["headers"])
        return httpx.Response(400, json=OPENAI_400, request=request)

    monkeypatch.setattr("app.validation.httpx.post", fake_post)
    caplog.set_level(logging.WARNING, logger="app.validation")
    with pytest.raises(PlannerUpstreamError) as raised:
        _openai_planner().plan(load_seed_package(SEED_PATH))

    error = raised.value
    assert isinstance(error, PlannerUnavailableError)  # existing callers still catch it
    assert error.status_code == 400
    assert error.error_type == "invalid_request_error"
    assert error.code == "unsupported_value"
    assert error.param == "temperature"
    for fragment in ("HTTP 400", "unsupported_value", "does not support 0"):
        assert fragment in str(error)
    assert "HTTP 400" in caplog.text
    assert '"code": "unsupported_value"' in caplog.text or "unsupported_value" in caplog.text
    assert KEY not in caplog.text and KEY not in str(error)
    assert "Bearer" not in caplog.text and "Authorization" not in caplog.text


def test_key_echoed_in_upstream_body_is_redacted(monkeypatch, caplog) -> None:
    body = {
        "error": {
            "message": f"Incorrect API key provided: {KEY}",
            "type": "invalid_request_error",
            "code": "invalid_api_key",
            "param": None,
        }
    }

    def fake_post(url: str, **kwargs: Any) -> httpx.Response:
        return httpx.Response(401, json=body, request=httpx.Request("POST", url))

    monkeypatch.setattr("app.validation.httpx.post", fake_post)
    caplog.set_level(logging.WARNING, logger="app.validation")
    with pytest.raises(PlannerUpstreamError) as raised:
        _openai_planner().plan(load_seed_package(SEED_PATH))
    assert raised.value.status_code == 401 and raised.value.code == "invalid_api_key"
    assert KEY not in caplog.text and KEY not in str(raised.value)
    assert "[REDACTED]" in caplog.text


def test_invalid_plan_content_is_a_typed_response_error(monkeypatch) -> None:
    def fake_post(url: str, **kwargs: Any) -> httpx.Response:
        return _ok(url, {"proposals": [{"tool": "invent_a_result", "claim_id": "X"}]})

    monkeypatch.setattr("app.validation.httpx.post", fake_post)
    with pytest.raises(PlannerResponseError):
        _openai_planner().plan(load_seed_package(SEED_PATH))


def test_transport_error_does_not_leak_the_key(monkeypatch, caplog) -> None:
    def fake_post(url: str, **kwargs: Any) -> httpx.Response:
        raise httpx.ConnectError(f"boom {kwargs['headers']['Authorization']}")

    monkeypatch.setattr("app.validation.httpx.post", fake_post)
    caplog.set_level(logging.WARNING, logger="app.validation")
    with pytest.raises(PlannerUnavailableError) as raised:
        _openai_planner().plan(load_seed_package(SEED_PATH))
    assert KEY not in str(raised.value) and KEY not in caplog.text


@pytest.mark.parametrize(
    "secret",
    [
        "sk-proj-AbCdEf0123456789_xyz-QRS",
        "sk-proj-****abcd",
        "sk-proj-********************************************abcd",
        "sk-svcacct-0123456789abcdef",
        "sk-admin-0123456789abcdef",
        "sk-abcd",
        "sk-****wxyz",
    ],
)
def test_redaction_catches_project_and_masked_keys(secret: str) -> None:
    from app.validation import _redact

    text = f"Incorrect API key provided: {secret}. You can find your API key at ..."
    redacted = _redact(text, None)
    assert "[REDACTED]" in redacted
    # No fragment of the key survives, including the unmasked tail.
    assert secret not in redacted and secret[-4:] not in redacted


def test_masked_project_key_in_upstream_401_is_never_logged(monkeypatch, caplog) -> None:
    masked = "sk-proj-****************************************Zq9x"
    body = {
        "error": {
            "message": f"Incorrect API key provided: {masked}.",
            "type": "invalid_request_error",
            "code": "invalid_api_key",
            "param": None,
        }
    }

    def fake_post(url: str, **kwargs: Any) -> httpx.Response:
        return httpx.Response(401, json=body, request=httpx.Request("POST", url))

    monkeypatch.setattr("app.validation.httpx.post", fake_post)
    caplog.set_level(logging.WARNING, logger="app.validation")
    with pytest.raises(PlannerUpstreamError) as raised:
        _openai_planner().plan(load_seed_package(SEED_PATH))
    for surface in (caplog.text, str(raised.value), json.dumps(raised.value.as_detail())):
        assert "Zq9x" not in surface and "sk-proj" not in surface


@pytest.mark.parametrize(
    ("upstream", "expected_status", "expected_code"),
    [
        (400, 502, "planner_upstream_rejected"),
        (401, 502, "planner_upstream_rejected"),
        (404, 502, "planner_upstream_rejected"),
        (429, 429, "planner_rate_limited"),
        (500, 503, "planner_upstream_unavailable"),
    ],
)
def test_upstream_status_maps_to_typed_helix_status(
    upstream: int, expected_status: int, expected_code: str
) -> None:
    error = PlannerUpstreamError(
        status_code=upstream,
        error_type="invalid_request_error",
        code="unsupported_value",
        param="temperature",
        message="Unsupported value",
    )
    assert error.http_status == expected_status
    detail = error.as_detail()
    assert detail["code"] == expected_code
    assert detail["upstream_status"] == upstream
    assert detail["upstream_param"] == "temperature"
    assert f"HTTP {upstream}" in detail["message"]


def test_unusable_plan_logs_size_not_model_output(monkeypatch, caplog) -> None:
    leaked = "PATIENT-NAME-SHOULD-NOT-BE-LOGGED"

    def fake_post(url: str, **kwargs: Any) -> httpx.Response:
        return _ok(url, {"proposals": [{"tool": "invent_a_result", "claim_id": leaked}]})

    monkeypatch.setattr("app.validation.httpx.post", fake_post)
    caplog.set_level(logging.WARNING, logger="app.validation")
    with pytest.raises(PlannerResponseError):
        _openai_planner().plan(load_seed_package(SEED_PATH))
    assert "unusable plan" in caplog.text and "bytes" in caplog.text
    assert leaked not in caplog.text


def test_strict_schema_refuses_open_additional_properties() -> None:
    from app.validation import _strict_node

    with pytest.raises(ValueError, match="additionalProperties"):
        _strict_node({"type": "object", "additionalProperties": {"type": "string"}})


@pytest.mark.parametrize(
    ("upstream", "expected_status", "expected_code"),
    [(400, 502, "planner_upstream_rejected"), (429, 429, "planner_rate_limited")],
)
def test_route_returns_typed_status_for_upstream_4xx(
    tmp_path, monkeypatch, upstream: int, expected_status: int, expected_code: str
) -> None:
    from fastapi.testclient import TestClient

    from app.database import create_database_engine
    from app.main import create_app
    from tests.test_journey_run_events import qualified_fixture_root

    body = {
        "error": {
            "message": "Incorrect API key provided: sk-proj-****Zq9x.",
            "type": "invalid_request_error",
            "code": "unsupported_value",
            "param": "temperature",
        }
    }

    def fake_post(url: str, **kwargs: Any) -> httpx.Response:
        return httpx.Response(upstream, json=body, request=httpx.Request("POST", url))

    monkeypatch.setattr("app.validation.httpx.post", fake_post)
    settings = Settings(
        database_url="sqlite+pysqlite:///:memory:",
        seed_path=SEED_PATH,
        codex_repository_root=qualified_fixture_root(tmp_path),
        auto_seed=True,
        llm_base_url="https://api.openai.com/v1",
        llm_api_key=KEY,
        llm_model="gpt-6-luna",
    )
    with TestClient(create_app(settings, create_database_engine(settings))) as client:
        # Lane A gate: validation requires an audited human freeze (pinned run) first.
        frozen = client.post(
            "/api/v1/studies/STUDY-HLX-028/pinned-runs",
            json={"actor": "Dr. Study Owner", "idempotency_key": f"planner-4xx-freeze-{upstream}"},
        )
        assert frozen.status_code == 201, frozen.text
        response = client.post(
            "/api/v1/studies/STUDY-HLX-028/validation-runs", json={"planner": "openai_compatible"}
        )
    assert response.status_code == expected_status, response.text
    detail = response.json()["detail"]
    assert detail["code"] == expected_code
    assert detail["upstream_status"] == upstream and detail["upstream_param"] == "temperature"
    assert KEY not in response.text and "Zq9x" not in response.text
