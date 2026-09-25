# DH-1 gate evidence (Steven-Espaillat/Helix#65)

Local-only on Perk's Mac, ports API 8031 / web 3031, dist `.next-dh1`. No Codex calls: every spec that could reach `section-runs` stubs or guards it.

- `npx tsc --noEmit`: clean.
- Hermetic Playwright (`dh1-auto-run`, `upload-gate`, `agent-steps`, `journey-progress`): all pass, also with `--repeat-each=2`.
- `verify-live.sh` against a temporary qualified copy of the repo (`HELIX_CODEX_REPOSITORY_ROOT`): 84 passed, 1 skipped, three consecutive runs (`verify-live-qualified.log`).
- `verify-live.sh` on shipped packages: fails only `workbench.spec.ts` live export and the predecessor-run test, the same two tests that fail on base `d4e5015a` because package qualification is pending (`verify-live-shipped.log`).
- Backend pytest: 84 failures, identical count to base (qualification pending); the new `test_open_event_stream_does_not_hold_the_sqlite_write_lock` passes, and fails without the `main.py` fix.
- `ruff check app tests scripts` (the standard scope): 5 findings, identical to base; none added. (The earlier "34" was the whole backend directory, also identical to base.)

Screenshots in this folder come from `tests/dh1-auto-run.spec.ts`.

## Follow-up (Tester P2s on #32)

- A failed workspace reload after the freeze is retried once. If it still fails, Upload shows "the workspace did not reload" with a Reload button, never "Manifest frozen", and the auto-start waits until a reloaded workspace shows the run past Upload.
- The Gate 2 stop message is shown as the workbench notice after the view moves to Traceability.
- Gates at this tip: hermetic DH-1, upload-gate, agent-steps and journey-progress specs 80/80 with `--repeat-each=2`; qualified `verify-live.sh` 86 passed, three runs in a row (`verify-live-qualified.log`); shipped `verify-live.sh` fails only the two base-red tests (`verify-live-shipped.log`); pytest 84 failures and ruff 5, both identical to base; `tsc --noEmit` clean.
- New screenshot: `freeze-reload-needed.png`.

## Merge of base 3590d47a (after #40 and #37 DH-4 phase 1)

- Conflict was one hunk in `HelixWorkbench.tsx`. I kept #37's Gate 3 `draftsBody` (ReportAssembly and ChatDock inside `ReviewStageView`) and passed it `onRefresh={refreshQuietly}`. The l8Aj5 reload retry, the Gate 2 stop notice and this file's ruff count are unchanged on top.
- `tsc --noEmit`: clean. `next build`: runs inside every verify-live below.
- verify-live, same ports and dist, base `3590d47a` compared with tip (logs and passed-test lists are in `merge-3590d47a/`):
  - Flag OFF (`HELIX_DEMO_UNQUALIFIED_PACKAGES` unset): base 90 passed and 2 failed, tip 92 passed and the same 2 failed (the full synthetic flow and predecessor-run tests, which also fail on base).
  - Flag ON (`HELIX_DEMO_UNQUALIFIED_PACKAGES=1`): base 92 passed and 0 failed, tip 94 passed and 0 failed.
- No functional loss: every test that passes on base also passes on the tip, in both modes. The only gains are the 2 new `dh1-auto-run` reload-failure tests.
