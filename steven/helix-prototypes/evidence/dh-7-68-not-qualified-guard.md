# DH-7 (#68): "Not qualified" label + export fails closed for demo-frozen runs

Spec: Steven-Espaillat/Helix#64 (stories 25-29). Ticket: Steven-Espaillat/Helix#68.

**Base:** `feat/steven-workspace` @ `6cc1bb96` (DH-1, #32). I fetched it, verified the SHA, rebased onto it and pushed with `--force-with-lease`; this was Tester P1-1. The first round was on `d4e5015a`.

**Where:** worktree `/Users/perk/src/Helix-dh7` (made with `git worktree add`), branch `cursor/dh-7-68-not-qualified-guard`. The base comparison ran in `/Users/perk/src/Helix-dh7-base`, detached at `6cc1bb96`. Local only on Stevens-MacBook-Pro, 2026-09-25 CT. No Codex or OpenAI calls.

**Ports and DB:** `docs/ui-lanes-ownership.md` assigns no 194xx range, so I used these:

| Use | Ports | DB |
|---|---|---|
| Dev | API 19434, web 19435 | `/tmp/helix-dh7.db`, fresh on every start |
| verify-live | 19444 / 19445 | the script's own `mktemp` SQLite DB (not overridable) |
| parity | 19454 / 19455 | the script's own `mktemp` SQLite DB (not overridable) |
| pytest | - | `/tmp/helix-dh7-pytest.db` (head), `/tmp/helix-dh7-base-pytest.db` (base) |

The flag, ports and DB were set inline on every command.

## Guard design (credit: Design Critic proposal, Perk4/Helix#25 comment 5827577860)
**`app/qualification.py`**
- The pure helper `demo_frozen_export_refusal(pinned_run) -> str | None` returns `DEMO_EXPORT_REFUSAL` when `demo_packages_of(pinned_run)` is non-empty.
- It returns a message rather than raising, so there is no circular import.
- New constant: `DEMO_NOT_QUALIFIED = "demo_not_qualified"`.

**`app/service.py`** (lane D functions `export` and `artifact`)
- `refuse_demo_frozen_export(package)` raises `DemoNotQualifiedExportError`, a subclass of `WorkflowConflictError`.
- It runs as the **first step of `_export_command`**, before the idempotent-replay check.
- It also runs as the **first step of `artifact()`**, before any stored bytes are served.
- This is Tester P1-2 / Codex thread l8TeY: a demo run exported by the parent release can no longer be replayed (new or same key) or downloaded, with the flag on or off.

**`app/approved_exports.materialize_approved_artifacts()`** still raises the refusal first, as a backstop.

**The 409 response** (Tester P2b) is `{"detail": {"code": "demo_not_qualified", "message": DEMO_EXPORT_REFUSAL}}`.
- This is the same `{code, message}` envelope other typed errors use, for example `human_freeze_required`.
- The frontend `errorMessage` already reads `detail.message`.
- The mapping is 2 lines in `main._call`, which is a **shared file** (see the escalations section).
- The slice-11 request and success response formats are unchanged.

**Other behaviour**
- The guard is keyed on the frozen run, not on the flag. With the flag on over a qualified tree, nothing is skipped, so export returns 200.
- Strict runs and flag-off behaviour are unchanged.
- The docstring now says the `run_requested` event carries package ids, not the label.

## UI
- **Label:** `ReviewStageView` shows a small kit `Chip` (`hx-chip t-warn xs`, `data-testid="run-not-qualified"`) reading "Not qualified", in the Gate 3 banner **only**, and only when `demoFrozenPackages(workspace)` is non-empty. That helper mirrors backend `demo_packages_of`.
- **No demo chrome:** no banner, toggle, "Demo:" text or `.demo-banner`. ReportAssembly and ChatDock are untouched.
- **Export panel** (Tester P2a): on a demo-frozen run the Export button is disabled and keeps the label "Export final package". Below it, a visible reason with `data-gate="demo_not_qualified"` reads: "Export is refused for this run. It was frozen with the demo flag, so its section packages have no passing qualification."
  - The panel never shows "ready for export" or "Retry export".
  - No click is possible, so no refused POST is sent.
  - The header release pill still shows the server's release gate, unchanged.

**Screenshots** (`dh-7-68/`)
- **Flag on, demo-frozen run:**
  - `flag-on-demo-frozen-{banner,stage}.png` show the label.
  - `flag-on-demo-frozen-export-disabled.png` shows the disabled button and its reason.
  - The live API drive is `flag-on-demo-frozen-drive.json`: human freeze 201 → FSA 200 → `POST /exports` 409 `{code: demo_not_qualified, message}`. The gate stays `ready_for_export` and both artifacts stay `pending`.
- **Flag off, strict run** on a qualified copy (`/tmp/helix-dh7-qualified/helix`, made by `qualified_fixture_root`):
  - `flag-off-strict*.png` show no label.
  - Export returns 200 (`flag-off-strict-drive.json`, from round 1).

## Tester P1/P2 mapping (PR #33 comment 5830288804)
| Item | Fix | Proof |
|---|---|---|
| P1-1: verify-live flag ON worse after merge (`:38` expects "Package exported") | Rebased onto `6cc1bb96`. `workbench.spec.ts:38` has a flag-ON branch that runs only when the server's pinned run is demo-frozen: the button is disabled with reason `demo_not_qualified`, `POST /exports` returns 409 `code=demo_not_qualified`, artifacts are not exported, each download returns 409, and there is no "Package exported". The flag-OFF path is unchanged (and a flag-ON qualified run takes the normal path) | verify-live flag ON: **86 passed / 0 failed** (base 84/0) |
| P1-2: legacy demo export replays 200 / downloads 200 | Refusal moved ahead of the replay check and ahead of `artifact()` | `test_legacy_demo_export_replay_fails_closed[flag-on/flag-off]` and `test_legacy_demo_export_download_fails_closed[flag-on/flag-off]` build a legacy export with the guard patched out (200s asserted), then reopen the same DB. All 4 fail when the two service calls are removed (checked) |
| P2a: button enabled, "Retry export" | Disabled with a visible reason on demo-frozen runs | `review-export.spec.ts` "demo-frozen run: export is disabled with a visible reason…"; screenshot |
| P2b: no machine code | 409 `detail = {code: "demo_not_qualified", message}` | backend tests assert the full detail; `:38` asserts the code |
| P2: chip only in Gate 3 | Kept in Gate 3 only, as directed | spec asserts exactly one "Not qualified" |
| P2: `demo_export_value` unreachable | Left in place (not in scope) | - |

## Acceptance (#68)
| Criterion | Evidence |
|---|---|
| Demo-frozen: small "Not qualified" label; strict: none; no `.demo-banner` | `review-export.spec.ts` label tests (demo-frozen; strict at review, FSA and exported; flag on but not frozen; flag off) and live screenshots |
| Demo-frozen export returns 409 with the refusal detail; nothing materialized or recorded | Flipped `test_flag_on_exports_…` (409 on first call and replay; gate, artifacts and stages unchanged), the legacy replay and download tests, the live drive, and verify-live `:38` flag ON |
| Flipped test; strict and flag-off export tests unchanged and green | `test_flag_off_export_bytes_carry_no_demo_label` unchanged; `…keyed_on_the_frozen_run_not_the_flag` (flag on + qualified tree returns 200); helper unit test |
| Freeze stays human-only (409 `human_freeze_required`) | `test_flag_on_never_freezes_by_itself_…[flag-on/flag-off]`; spec "freeze stays a human action" |
| No fake hashes; packages stay pending | Package files are byte-identical and `pending` with no `qualification_hash` (freeze and flipped tests) |
| pytest = base + new/flipped; ruff, tsc, build clean; verify-live no worse than base | Gates below |

## Gates (head vs base `6cc1bb96`)
| Gate | Base 6cc1bb96 | Head |
|---|---|---|
| `test_demo_unqualified_flag.py` | - | **18/18 passed** |
| Full backend pytest | 285 tests, 201 passed, 84 failed | **292 tests, 208 passed, 84 failed**: identical failure set, 0 new (`pytest-full-failures.txt`) |
| ruff `app tests` | 5 errors | **5, identical** (`ruff-head.txt`) |
| tsc | - | clean |
| next build | OK | OK (inside every verify-live run) |
| `review-export.spec.ts` | - | **16/16** on dev 19435/19434 |
| verify-live flag ON (shipped tree) | 84 passed, 0 failed, 1 skipped | **86 passed, 0 failed, 1 skipped** |
| verify-live flag OFF (shipped tree) | 82 passed, 2 failed (`:38` freeze 422, `:425` no pinned run) | **84 passed, 2 failed** (same two tests, now at `:49` and `:463`) |
| verify-live flag OFF (qualified copy) | 84 passed, 0 failed | **86 passed, 0 failed** |
| Parity (flag off) | exit 0, 25/25 enforced PASS | **exit 0, 25/25 enforced PASS; enforced rows identical to base** |

Notes:
- The +2 verify-live passes are the two DH-7 tests in `review-export.spec.ts`.
- On parity, 24 enforced screens are at 0.000 %. Lane C's `traceability-gate-light` is at 0.709 % (budget 1 %) **on base too**, identical row; it is not a DH-7 screen.
- Logs:
  - `verify-live-{flag-on,flag-off,qualified}.log`
  - `base-verify-live-*.log`
  - `parity-full-kit{.log,-summary.md}`
  - `base-parity-summary.md`
  - `review-export-spec.log`
  - `pytest-demo-flag.txt`

## Shared-file edits (escalations for Chief of Staff)
- **`backend/app/main.py`** (`_call`, 3 lines plus 1 import name): maps `DemoNotQualifiedExportError` to a 409 with `{code, message}` ahead of the generic `WorkflowConflictError` string mapping. This is what Tester P2b needs; there is no lane-owned place for HTTP mapping.
- **`frontend/tests/workbench.spec.ts`** (shared spec, section 3.3 lets D edit export assertions): only the `:38` export step gained a flag-ON demo-frozen branch, plus the helper `isDemoFrozen`. The flag-OFF path is unchanged.
- **Lane D's own files:**
  - `app/qualification.py`, `app/approved_exports.py`
  - `service.export` / `service.artifact` (`app/service.py`, function-level lane D)
  - `tests/test_demo_unqualified_flag.py`
  - `src/components/review/**`, `tests/review-export.spec.ts`
