# SLICE 5 prove evidence

Commands were run from `steven/helix-prototypes` on `cursor/slice-5-cap-candidate-attempts-4459`.

Base: `origin/feat/steven-workspace` at `2783689e34e17729486f1ee2f8bd97a4decf9e30`.

## make test

```text
make test
```

Outcome: green.

- synthetic bundle verified
- ruff clean
- pytest 82 passed
- frontend typecheck and production build succeeded

## verify-candidate-attempts.sh

```text
./scripts/verify-candidate-attempts.sh
```

Outcome: green. Wrote `evidence/candidate-attempts-receipt.json`.

- Attempts recorded: `[1, 2, 3]`
- Decisions: `retry`, `retry`, `stop_for_review`
- Cap blocker: `ATTEMPT-CAP-section.5_2_3_body_weight`
- Scaffold placeholder: `[NEEDS REVIEW]`
- FakeSectionAgent calls: `3` (exact replay does not open another thread)
- Fourth attempt HTTP status: `409`
- Evaluation replay returns stored `replay_evaluation_id` without a new attempt

## verify-candidate-evaluation.sh

```text
./scripts/verify-candidate-evaluation.sh
```

Outcome: green. Slice 4 evaluation path still passes after admission control.

## verify-live.sh

```text
./scripts/verify-live.sh
```

Outcome: green.

- Playwright `workbench.spec.ts`: 5 passed
- `codex-section-run.spec.ts`: skipped without `HELIX_CODEX_LIVE=1`
- New test: shows every immutable attempt and offers no fourth attempt after `stop_for_review`

## verify-postgres.sh

Skipped. This slice does not change storage dialect behavior.
