# SLICE 6 prove evidence

Commands were run from `steven/helix-prototypes` on `cursor/slice-6-section-promotion-2fdf`.

Base: `origin/feat/steven-workspace` at `ba14d48f0d390d8a629ca9abf06b3eda88c28ddc`.

## make test

```text
make test
```

Outcome: green.

- synthetic bundle verified
- ruff clean
- pytest 100 passed
- frontend typecheck and production build succeeded

## verify-section-promotion.sh

```text
./scripts/verify-section-promotion.sh
```

Outcome: green. Wrote `evidence/section-promotion-receipt.json`.

- Client-authored `status: promoted` HTTP status: `422`
- Promotion HTTP status: `409`
- Replay of the same idempotency key: `409`
- Failed condition: `package_permission` (`vertical_slice packages cannot be promoted`)
- `section_drafts`: `[]`
- Advisory SOE status: `failed`
- Disposition `artifact_hash` bound to the candidate hash
- `review_required_current` before disposition: `passed=false`
- `review_required_current` after disposition: `passed=true`
- Package permission still rejects after the disposition is current

## verify-candidate-evaluation.sh

```text
./scripts/verify-candidate-evaluation.sh
```

Outcome: green. Slice 4 evaluation path still passes after promotion recording.

## verify-live.sh

```text
./scripts/verify-live.sh
```

Outcome: green.

- Playwright `workbench.spec.ts`: 6 passed
- `codex-section-run.spec.ts`: skipped without `HELIX_CODEX_LIVE=1`
- New test: renders backend promotion status and draft evidence without recalculating eligibility
- Promote is disabled until a candidate evaluation exists, then POSTs; the workbench renders `eligible` from the backend field even when a condition is failed

## verify-postgres.sh

Skipped. This slice does not change storage dialect behavior.
