# SLICE 4 prove evidence

Commands were run from `steven/helix-prototypes` on `cursor/slice-4-candidate-evaluation-ef9c`.

Base: `origin/feat/steven-workspace` at `8c5c623b217c16650aa997b8aad8794debadb8a9`.

## make test

```text
make test
```

Outcome: green.

- synthetic bundle verified
- ruff clean
- pytest 74 passed
- frontend typecheck and production build succeeded

## verify-candidate-evaluation.sh

```text
./scripts/verify-candidate-evaluation.sh
```

Outcome: green. Wrote `evidence/candidate-evaluation-receipt.json`.

- A conforming FakeSectionAgent candidate binds every factual span and table cell to `C-BW-HIGH` with `sha256:` claim and artifact hashes
- Template Conformance results cover completeness, table_coverage, terminology, units, rounding, and approved_language
- Study Output Evaluation stays `review_required` on both pass and fail
- Unsupported numeric content blocks provenance, preserves the stored candidate, and rejects waiver with 409
- Advisory `"approved"` failure leaves provenance and conformance passed with an empty blocking-receipt list
- A Cross-Section Query returns declared `claim:C-BW-HIGH` and `validation.body_weight` hashes and rejects `claim:C-NOAEL`
- The evaluation and query persist on the workspace with the original candidate hash

## verify-live.sh

```text
./scripts/verify-live.sh
```

Outcome: green.

- Playwright `workbench.spec.ts`: 4 passed
- `codex-section-run.spec.ts`: skipped without `HELIX_CODEX_LIVE=1`
- Evaluate and query stay disabled until a recorded section run exists
- Injected backend hashes and TCF rule IDs render unchanged in the workbench

## verify-postgres.sh

Skipped. This slice does not change storage dialect behavior.
