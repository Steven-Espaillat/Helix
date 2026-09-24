# UI SLICE 7 (#25): backend-owned nine-stage journey and run events — verification evidence

- Ticket: Steven-Espaillat/Helix#25 (epic #17)
- Branch: `cursor/ui-slice-7-journey-run-events`
- Base: `feat/steven-workspace` @ `e626f5403829ce8dcd299d744abb9f9002fe7085` (upstream #48, which merged ADO main `97a94b5c`)
- Verified code commit: `1c85b39` (feed hardening). It builds on `420a7634` (review fixes) and merge `d9c9fee6` of `e626f540`. The evidence-only commit that follows changes this file only.
- Earlier history: `420a7634` was verified the same way (84 failed / 105 passed, same failing set). Before that, the branch was first verified at `19a14028` on base `cae879a2`. Then `2a639f00` (#17 ruff fix) was merged as `4923536b`.
- Date: 2026-09-24 (America/Chicago), macOS local run

## Environment

- The base was run in a separate detached worktree (`/Users/perk/src/Helix-base-e626`).
- The branch was run in a separate detached worktree at the verified commit (`/Users/perk/src/Helix-ui25-merge`).
- Playwright runs were serialized, and nothing was listening on ports 8010/3010 before each run.

## Results: base `e626f540` vs branch `1c85b39`

All commands were run from `steven/helix-prototypes`.

| Check | Command | Base `e626f540` | Branch `1c85b39` | Delta |
|---|---|---|---|---|
| Generation | `make generate` (first step of `make test`) | ok, but the committed `openapi.json`/`api-schema.d.ts` are stale (missing `POST /api/v1/studies`) | ok, and the regenerated files are committed (no diff after regeneration) | branch fixes the stale generated types |
| Synthetic bundle | `verify-synthetic-bundle.mjs` | verified | verified | none |
| Ruff | `uv run ruff check app tests scripts` | 4 errors: `intake.py` B905, `main.py` I001, `main.py` B008, `tests/test_intake.py` F401 | the same 4 (same codes and files) | 0 new |
| Pytest | `uv run pytest -p no:cacheprovider` | 84 failed / 87 passed | 84 failed / 113 passed | +26 new passes; failing test names identical (diffed against the base list) |
| New tests | `uv run pytest -p no:cacheprovider tests/test_journey_run_events.py` | n/a | 26 passed (the PostgreSQL variant ran, not skipped) | all new tests pass |
| Frontend typecheck | `npm run typecheck` | pass | pass | none |
| Frontend build | `npm run build` | pass | pass | none |
| Live e2e | `./scripts/verify-live.sh` | 12 passed / 2 failed / 1 skipped | 16 passed / 2 failed / 1 skipped | +4 new passes (client spec); same 2 failures |

`make test` exits non-zero at ruff on both base and branch because of the 4 upstream errors. I ran the later steps directly.

The 2 verify-live failures are the same on base and branch. Both show "The HELIX API returned an unexpected error." from the qualification 422:
- `workbench.spec.ts › runs the synthetic study from validation through explicit export`
- `workbench.spec.ts › renders predecessor run identity and carry-forward counts from the workspace`

The skipped test is the Codex spec on both.

## Qualification baseline after e626f540

These are facts observed on `e626f540`:

1. **Packages are still `pending`.** `5_2_3_body_weight` and `5_3_discussion` both have `"qualification_status": "pending"`. No section `package.json` changed between `2a639f00` and `e626f540`.
2. **The root cause is still the same 422.** Every freeze returns `invalid_package_qualification` ("Agentic package qualification has not passed"). This was confirmed as follows:
   - The failing set on `e626f540` is byte-identical to the old baseline set (84 tests at `cae879a2`/`2a639f00`).
   - With a temporary, uncommitted override (both packages marked `passed` with the backend's `file_hash(suite)`, then restored with `git checkout`), base `e626f540` runs 171 passed / 0 failed.
3. **Counts moved only by new upstream tests.** The failed count is unchanged (84) with the same names. Passes went from 66 to 87 (+21 from the new `tests/test_intake.py`). Ruff went from 10 errors (fixed by #17) to 4 new errors introduced by the intake merge.
4. **The hash-contract mismatch is unchanged.**
   - `backend/app/run_plans.py` and `scripts/lib/hash.mjs` are untouched between `2a639f00` and `e626f540`.
   - The backend still requires `qualification_hash == file_hash(<promptfoo suite file>)` (`run_plans.py:611`).
   - `scripts/record-qualification.mjs` still writes `canonicalHash({ inputs, outcome })`, so a recorded hash still cannot match what the backend checks.
   - The recorder's changes alter the recorded value but not the scheme:
     - `outcome` now includes `tokens`.
     - A cost guard fails when tokens more than double the previous artifact.
     - The artifact path is fixed to `qualifications/helix-section-agent-qualification.json`.
     - The upstream-branch warning was removed.
   - The recorder still writes only the 5.2.3 package; `5_3_discussion` has no recorder path.
   - `promptfooconfig.yaml` gained A-2/A-3 cases (+81 lines), so its `file_hash` changed too.
   - I did not run the paid recorder.

## Additional local sanity check (temporary, uncommitted override)

This is not the gate, and nothing from it is committed. Both packages were temporarily marked `passed` and then restored with `git checkout -- skills/helix-evidence-pipeline/packages/sections`.

| Check | Base `e626f540` | Branch `d9c9fee6` | Branch `420a7634` | Branch `1c85b39` |
|---|---|---|---|---|
| Pytest | 171 passed / 0 failed | 187 passed / 0 failed | 189 passed / 0 failed | 197 passed / 0 failed |
| verify-live | not run | 16 passed / 1 skipped / 0 failed | not re-run | 18 passed / 1 skipped / 0 failed |

## Merge `d9c9fee6` (e626f540 into branch): conflicts resolved

- **`backend/app/main.py`:** import blocks only.
  - Kept upstream's `re`, `File`, `Form`, `UploadFile`, `intake.IntakeRejected`/`build_package`, and `StudyPackageRepository` for the `POST /api/v1/studies` intake route.
  - Kept #25's `json`, `time`, `Header`, `Query`, and `run_events` imports for the SSE route.
  - Both routes are present unchanged.
- **`backend/app/service.py`:** auto-merged. Upstream's `derive_release_gate` changes (empty export set is not `exported`; a never-validated package is `blocked`) are compatible with the projection.
- **Regenerated `openapi.json`/`api-schema.d.ts`:** these now include both the intake route and the journey/event schemas.
- **New test:** an intake-uploaded study projects Upload as current, with no run and all later stages pending.

## Review fixes in `420a7634`

- **P1 (r4098493500):** the SSE poll cursor now starts from the validated `Last-Event-ID`, so an empty replay never re-emits retained events.
  - Regression test: reconnect at the latest cursor, with a 1 s window and 0.1 s polling. With no new events the window stays silent. When a new event is appended during the window, only that event (sequence N+1) is emitted.
- **P2 (r4098493508):** `RunConflictError` and `UnknownValidationPackageError` now append `command_failed`.
  - Test: a conflicting freeze (409) records `freeze_run`/`upload`, and an unknown DVP package (404) records `run_data_validation`/`extract`.
- Both tests fail with the fix reverted and pass with it.

## How the new tests work within the qualification gate

- Tests that need a Pinned Run use a test-local tmp copy of the governed tree under pytest `tmp_path`, with section packages marked qualified by the hash of their own suite file. Shipped package data is never modified, and these tests make no qualification claim.
- The gate test uses a tmp copy explicitly `pending` and asserts a 422 with zero run events.
- The `run_paused`/`run_resumed` events are fixture rows (#26 owns the commands).

## Feed hardening (CoS/Tester review)

Fix commit `1c85b39`. It builds on `420a7634` and has no schema/OpenAPI change (`make generate` produced no diff).

- **a) Transactional sync (the approach: sync runs inside the command's own transaction).**
  - `_journey_command` registers a SQLAlchemy `before_commit` hook for the length of the command. Every commit the command makes, including freeze/DVP internal commits, first calls `_sync_run_events_in_transaction`.
  - That function flushes, reads the pinned run id, and takes the run-state row lock (`RunEventStore.lock_state`, `SELECT … FOR UPDATE`) **before** it reads package facts. Only then does it diff and append events.
  - Events therefore commit or roll back atomically with the state change. The old post-commit `sync_run_events` step, and the response-journey patch that went with it, are gone. Command responses are built after the commit, so they already carry the new sequence marks.
  - Mapped failures remove the hook, roll back, and record `command_failed` in a separate commit. Docstrings are updated.
- **b) Gap-safe replay.** When `replay()` is given a cursor, it raises `EventCursorExpiredError` (409) in two cases:
  - `rows[0].sequence != after+1`;
  - no rows come back while `last_sequence > after`.
  
  A prune that races a replay now returns 409 instead of a silent gap. The retention check `after+1 < oldest` is unchanged.
- **c) Terminal SSE frame.** When the poll loop hits an expired cursor, it emits `event: cursor_expired` with `data: <EventCursorExpired JSON>` and then ends the stream. The frame has no `id:` line, so the browser's Last-Event-ID stays at the last delivered event.
- **d) Frontend dedupe.** `runEvents.ts` now dedupes by max sequence: any `seq <= lastSeq` is dropped, and `lastSeq` is seeded from the `lastEventId` passed in. The code documents that callers **must persist the returned `lastEventId` across reconnects**. A terminal `cursor_expired` frame refreshes the workspace and reconnects, the same as a 409.

### New tests and fail-without-fix check

Each test was run with its fix reverted, then the fix was restored.

| Test | Fails without | Result with the fix reverted |
|---|---|---|
| `test_concurrent_commands_on_one_study_emit_gap_free_sequences_without_duplicates[postgresql]`: two threads, two sessions, two dispositions; thread A is delayed just before the lock | a (`service.py` reverted to `420a7634`) | **FAILS**: duplicate `action_finished` (45 vs 43 unique) |
| `…[sqlite-file]`: same test on file SQLite | — | passes either way. SQLite's `BEGIN IMMEDIATE` serializes whole transactions, so this race can only be reproduced on PostgreSQL |
| `test_prune_racing_replay_returns_409_not_a_silent_gap[partial]` / `[all]`: a prune is injected between replay's state read and its row read | b (gap check disabled) | **FAILS** (200 with a silent gap) |
| `test_poll_loop_cursor_expiry_emits_terminal_cursor_expired_frame` | c (`main.py` reverted) | **FAILS**: no frame, the stream just ends. It also fails with b disabled (events after the gap leak through) |
| `test_silent_then_cursor_plus_one_reconnect_delivers_exactly_next_event_once`: Last-Event-ID=N, silent polls, then N+1 arrives, and exactly N+1 is delivered once | the P1 poll-cursor fix (`initial_sequence` forced to 0) | **FAILS** (replays retained events) |
| `test_cursor_at_oldest_minus_one_replays_and_oldest_minus_two_expires` | the boundary check (mutating it to `after < oldest`) | **FAILS**. It passes without b, because this boundary predates this change: it is a coverage test |
| `test_mid_history_reconnect_delivers_exactly_the_missing_range` | — | coverage test: it passes without the new fixes |
| frontend `the same frames sent twice call onEvent once per sequence, across reconnects` (existing Node-only Playwright client spec with a fake fetch) | d (`runEvents.ts` reverted to the Set dedupe) | **FAILS** (5,6 delivered again after reconnect) |
| frontend `a terminal cursor_expired frame refreshes the workspace and reconnects` | client-side c/d | **FAILS** |

The PostgreSQL variant starts a throwaway PG18 cluster (`initdb`/`pg_ctl` under pytest tmp, on a free port). It skips if the binaries are missing; it ran, and did not skip, in this proof.

## Logs (local, not committed)

- Base: `/tmp/e626-{maketest,ruff,pytest,tc,build,verify-live,pytest-override}.log`
- Branch at `d9c9fee6`: `/tmp/ui25m-*.log`
- Branch at `420a7634`: `/tmp/ui25f-*.log`
- Branch at `1c85b39`: `/tmp/ui25h-*.log`
