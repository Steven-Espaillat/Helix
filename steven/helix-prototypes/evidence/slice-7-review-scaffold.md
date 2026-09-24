# SLICE 7 prove evidence

Commands were run from `steven/helix-prototypes` on `cursor/slice-7-review-scaffold-versioning-77ea`.

Base: `origin/feat/steven-workspace` at `1e44a528a906f3e1af40202367c2b59ca44cb4f5`.

P0 fix: file SQLite transactions now start with `BEGIN IMMEDIATE` so concurrent scaffold-visible writes mint distinct sequences. Proven code is `6e6154ef4c089883e091bce6ac01cc7c93e2cf80`.

## concurrent QueuePool file SQLite

```text
cd backend && uv run pytest tests/test_review_scaffold_versioning.py::test_two_concurrent_pictures_allocate_consecutive_sequences
```

Outcome: green. Before the fix, the same test stored sequences `[1, 2]` and dropped one picture. After the fix, sequences are `[1, 2, 3]` and both `EV-CONCURRENT-A` and `EV-CONCURRENT-B` remain. Ten repeats passed. The engine uses QueuePool against a tempfile database, not `:memory:` StaticPool.

## make test

```text
make test
```

Outcome: green.

- synthetic bundle verified
- ruff clean
- pytest 106 passed
- frontend typecheck and production build succeeded

## verify-review-scaffold.sh

```text
./scripts/verify-review-scaffold.sh
```

Outcome: green. Wrote `evidence/review-scaffold-receipt.json`.

- Sequences after validation through pathologist approval: `[1, 2, 3, 4, 5, 6]`
- History length: `6`
- After draft replay and evaluation replay: history length `2` (no extra revision)
- `export_eligible` on every revision: `false`
- `admit_export_document` rejected the latest revision
- Release-candidate schema rejected the latest revision
- Every `needs_review` section used placeholder `[NEEDS REVIEW]` and named at least one blocker ID

## verify-section-promotion.sh

```text
./scripts/verify-section-promotion.sh
```

Outcome: green. Slice 6 promotion path still passes after scaffold persist.

## verify-live.sh

```text
./scripts/verify-live.sh
```

Outcome: green. This path uses file SQLite, so it also runs under `BEGIN IMMEDIATE`.

- Playwright `workbench.spec.ts`: 6 passed
- `codex-section-run.spec.ts`: skipped without `HELIX_CODEX_LIVE=1`
- Journey shows `review-scaffold-history` and the triggering event ID after validation
- Report assembly has no `review-scaffold-history` (`toHaveCount(0)`)

## verify-postgres.sh

Skipped. Postgres still uses `FOR UPDATE`. The new serializer is file SQLite only.
