# OpenAI planner: strict schema + typed upstream errors

Branch `cursor/openai-planner-strict-schema`, base `feat/steven-workspace` @ `e56bf7fd`. Scope: `backend/app/validation.py` and tests only.

## Reproduction (before the fix)

One call from `OpenAICompatiblePlanner.plan` with `HELIX_LLM_BASE_URL=https://api.openai.com/v1`, `HELIX_LLM_MODEL=gpt-6-luna`, on the seeded synthetic package. The key was read from the local `.env` and never printed.

OpenAI returned **HTTP 400**:

```json
{
  "error": {
    "message": "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
    "type": "invalid_request_error",
    "param": "temperature",
    "code": "unsupported_value"
  }
}
```

OpenAI reported the temperature first. The raw pydantic schema also used `oneOf` + `discriminator` (plus `title`, `const`, `minItems`/`maxItems`), which OpenAI strict structured outputs do not accept, so both were fixed.

## Fix

- No `temperature` in the payload. Newer OpenAI models accept only the default, and the Azure gateway path (gpt-5.5) accepts the default too.
- `strict_plan_schema()` rewrites `AgentPlan`'s schema for strict mode: `oneOf` becomes `anyOf`, `discriminator`/`title`/length limits are dropped, `const` becomes a one-value `enum`, and every object is closed with all properties required. The reply is still validated by `AgentPlan` (same tools, same `extra="forbid"`, 1 to 12 proposals), so the output contract is unchanged.
- A non-2xx reply raises `PlannerUpstreamError` (a `PlannerUnavailableError` subclass) with `status_code`, `error_type`, `code`, `param`, and the upstream message. The route's error message now says why, for example `Planner endpoint rejected the request (HTTP 400, unsupported_value, param=temperature): ...`. The upstream status and body are logged at WARNING, truncated to 2000 characters, with the key and any `sk-...` or `Bearer ...` text redacted. Request headers are never logged.
- A 2xx reply with an unusable plan raises `PlannerResponseError`. A transport failure logs only the exception type.
- HTTP status mapping is unchanged: `main.py` still maps `PlannerUnavailableError` to 503, now with a specific detail. That file is outside this PR's scope.

## Tests (mocked HTTP)

`tests/test_planner_openai_strict.py` has 7 tests:
- The schema uses only strict-mode keywords, has no `oneOf`/`discriminator`, and closes every object with all properties required.
- The strict schema accepts the same plans as `AgentPlan` and rejects the same bad ones (unregistered tool, missing field, extra field, wrong root).
- The payload has no temperature and uses strict `json_schema`, for both the OpenAI path (gpt-6-luna) and an Azure-gateway-style base URL (gpt-5.5).
- A 400 becomes a typed error with status, type, code, and param. The log contains the status and body, and never the key, `Bearer`, or `Authorization`.
- A key echoed in a 401 body is redacted in the log and in the error.
- An invalid plan raises `PlannerResponseError`. A transport error leaks no key.

`tests/test_validation.py`: the existing planner test now asserts there is no temperature.

- `ruff check` / `ruff format` pass on the changed files.
- The targeted tests pass: 10 passed.
- The full `pytest` run has **84 failures, the same count as base**. All of them are the known `invalid_package_qualification` 422s. `ruff check app tests scripts` shows the same 5 upstream errors as base.

## Live confirmation (one call, gpt-6-luna)

I made exactly one call after the fix, through `OpenAICompatiblePlanner.plan` directly. It needed no DB and no qualification override, and nothing was written to tracked files. OpenAI **accepted** the request: it returned a normal chat-completion body (`usage` with `completion_tokens_details`, `service_tier: "default"`), not a 400.

**Gap:** my capture kept only the tail of the output, so the parsed-plan line was not recorded. The call proves the 400 is gone. It does not by itself record that gpt-6-luna's reply parsed into an `AgentPlan`. I did not make a second billed call.
