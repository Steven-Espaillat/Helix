# UI lane A: journey progress, intake upload, manifest freeze (#19, #20, partial #26)

Base: `feat/steven-workspace` @ `904072487e5e1d659debce0eb0972c4b78aa0ee0`, merged into the branch (not rebased, because the branch was already pushed). Local run on Stevens-MacBook-Pro, 2026-09-24 CT. No Codex or OpenAI calls: the Codex spec stays skipped and the worktree has no `.env`.

## P1 fix: only a human may freeze the manifest
- Backend: `service._run_validation_command` and `DataValidationService.execute` no longer freeze as "HELIX validation service" when no Pinned Run exists. Both raise `HumanFreezeRequiredError`, a typed HTTP 409 (`code: human_freeze_required`, `operation`, and the freeze route). Nothing is written first.
- Frontend: `StudyJourney` keeps "Run hybrid validation" and "Execute body-weight package" disabled, with a note, until `workspace.pinned_run` exists.
- `workbench.spec.ts:38` now freezes through Human Gate 1 (consent, then freeze) before it runs validation, instead of depending on the auto-freeze.
- Tests:
  - `backend/tests/test_manifest_authorization.py::test_commands_without_a_human_freeze_refuse_and_never_auto_freeze` covers both routes. It checks the 409 code, that the pinned-run, DV-run, validation-run, audit and run-event row counts are unchanged, that there is no pinned run, and that no "HELIX validation service" audit actor appears after a later human freeze. Against the old code, both cases fail (the old code froze and returned 201).
  - `frontend/tests/upload-gate.spec.ts` "only Human Gate 1 can pin a run…" is the live repro against the real API: with consent unchecked, both buttons are disabled, both POSTs return 409 `human_freeze_required`, and `pinned_run` stays null. A second spec checks the buttons re-enable once a run is pinned.

## Backend
- `tests/test_manifest_authorization.py`: 5 passed.
- Full `uv run pytest`: 84 failed. That is the same set as base (`invalid_package_qualification`); see `ui-lane-a/pytest-failures-*.txt`.
- `make test` stops at ruff with 5 errors in `app/intake.py`, `app/main.py` and `tests/test_intake.py`, which are the same as on base. This PR adds none.
- P2-2: a DV failure after freeze records `command_failed`, and only domain refusals reach the client as `reason`. Other errors say "internal error; see the server log" and are logged with the traceback.

## Frontend
- `npx tsc --noEmit`: clean. `next build`: OK (inside verify-live).
- `scripts/verify-live.sh`, shipped (unqualified) packages: 38 passed, 2 failed, 1 skipped. The failures are `workbench.spec.ts:38` and `:399`, both from 422 `invalid_package_qualification` on base. `:38` now fails at the human freeze itself. Log: `ui-lane-a/verify-live.txt`.
- `scripts/verify-live.sh` with `HELIX_CODEX_REPOSITORY_ROOT` pointing at a throwaway copy that has package qualification set **only in that copy** (outside the repo, via `tests/test_journey_run_events.qualified_fixture_root`): **40 passed, 0 failed, 1 skipped.** This includes `:38` end to end (human freeze, then validation, through export) and the no-auto-freeze repro. Log: `ui-lane-a/verify-live-qualified-copy.txt`.
- The shared tracked evidence screenshots and receipts are restored to base (P2-6). Lane A evidence lives under `evidence/ui-lane-a/` only.

## Visual parity (`scripts/verify-parity.sh`, exit 0)
| Screen | Status | Diff | Max | Result | Note |
|---|---|---|---|---|---|
| journey-progress-light | enforced | 0.000% | 1.00% | PASS | the meta line now sits under the card (P2-1) |
| upload-gate-light | report-only | 39.19% | 1.00% | reported | ours is 1360x1094 and the reference is 1360x880. The workspace has 10 seeded inputs and the reference shows 7. The Type column is uppercase and Role has no tier suffix (P2-5). |

## Test-local fixture
`frontend/tests/fixtures/lane-a-freeze.json` is a real freeze response captured from a throwaway qualified copy, with DV claims and edges cut to 2 each and a `_note`. Specs load it only through route mocks. Nothing shipped carries a passed status or hash, and no qualification override is committed.
