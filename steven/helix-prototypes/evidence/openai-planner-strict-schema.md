# OpenAI planner: strict schema + typed upstream errors

Branch `cursor/openai-planner-strict-schema` (PR Perk4/Helix#21), gated against base `feat/steven-workspace` @ `1209e048` (head `e3b8df95`). Merged as `0af5f2ac`, absorbed upstream as #53, which is `feat/steven-workspace` @ `90407248`. Scope: `backend/app/validation.py` and tests only. Follow-up changes are in the last section.

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

My own capture kept only the tail of the output, so it did not record the parsed plan. The Tester closed that gap on PR #21 with exactly one live call through the route (after `POST /pinned-runs` returned 201): `POST /api/v1/studies/STUDY-HLX-028/validation-runs {"planner":"openai_compatible"}` returned **HTTP 201** with 14 results, including 4 planner-proposed tool checks (grounded_numeric_claim x2, source_severity_match x1, human_judgment_required x1), and persisted one `validation_runs` row with `llm_used=1`. Source: the Tester's gate comment on Perk4/Helix#21.

## Follow-up (PR #21 P2s, branch `cursor/planner-p2-followup`, base `90407248`)

No live calls were made for this follow-up; everything below is mocked HTTP.

- **Redaction (hard rule).** `_SECRET_PATTERNS` now matches every `sk-` key form, including `sk-proj-`, `sk-svcacct-`, `sk-admin-`, and OpenAI's masked echo (`sk-proj-****abcd`). The `*` mask counts as part of the key, so the visible tail is redacted too. Tests cover 7 key shapes, and a masked `sk-proj` key in a 401 body never reaches the log, the error text, or the route's JSON detail.
- **Typed status for upstream 4xx.** `PlannerUpstreamError.http_status` / `as_detail()`: upstream 429 is HELIX 429 `planner_rate_limited`; any other upstream 4xx is HELIX **502** `planner_upstream_rejected`; upstream 5xx stays 503 `planner_upstream_unavailable`. The detail carries `code`, `message`, `upstream_status`, `upstream_type`, `upstream_code`, and `upstream_param`. No key and no network failure still give plain 503. `main.py` gets one `except PlannerUpstreamError` clause ahead of the 503 mapping (a shared file, 2 lines). `frontend/src/lib/api.ts` now shows `detail.message` for typed errors instead of the generic fallback (a shared file, 3 lines).
- **Length limits restored.** `minItems`/`maxItems` are in `_STRICT_KEYWORDS`, since strict mode supports them. The strict schema now enforces 1 to 12 proposals upstream, and `AgentPlan` still re-checks the reply. A test asserts both.
- **Smaller logs.** An unusable 2xx reply logs only its byte count and the parse error type, never the model output.
- **Fail loudly.** `_strict_node` raises on an open `additionalProperties` schema instead of silently closing it.

Proof, all local:
- `tests/test_planner_openai_strict.py`: 25 passed, including a route-level test for 400 to 502 and 429 to 429.
- Full `pytest`: 84 failures, the identical list to base `90407248` (diffed line by line).
- `ruff check .` in `backend/`: 34 findings, identical to base (diffed). No new findings; the pre-existing `main.py` I001/B008 findings are unchanged.
- `tsc --noEmit`: clean.
- `verify-live.sh` on shipped packages: 16 passed, 2 failed, 1 skipped. The failures are `workbench.spec.ts:38` and `:399` (qualification 422), the same as base.
- `verify-live.sh` against a qualified throwaway copy (`qualified_fixture_root`, outside the repo, `HELIX_CODEX_REPOSITORY_ROOT`): 18 passed, 0 failed, 1 skipped (Codex SDK). No Codex call; the spec never clicks draft.
