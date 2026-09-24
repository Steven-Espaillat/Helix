# SLICE 3 prove evidence

Commands were run from `steven/helix-prototypes` on `cursor/slice-3-template-contract-gates-1689`.

## make test

```text
make test
```

Outcome: green.

- synthetic bundle verified
- ruff clean
- pytest 61 passed
- frontend typecheck and production build succeeded

## verify-template-contract-gates.sh

```text
./scripts/verify-template-contract-gates.sh
```

Outcome: green. Wrote `evidence/template-contract-gates.json`.

- After hybrid validation, body-weight and discussion packages are both `eligible: true`
- Body-weight gate results cover fields, locations, table_shapes, labels, units, and style_constraints
- Every Template Contract Gate result is `hard_blocker` and `waivable: false`
- Independent discussion package is not in the body-weight Section Impact Set
- `POST .../validation-results/TCR-BW-FIELDS/dispositions` returns 409 with a non-waivable detail
- Review Scaffold Revision sequence 1 records empty `section_impact_sets` when both packaged sections are eligible

## verify-live.sh

```text
./scripts/verify-live.sh
```

Outcome: green.

- Playwright `workbench.spec.ts`: 3 passed
- `codex-section-run.spec.ts`: skipped without `HELIX_CODEX_LIVE=1`
- Draft stays disabled when the intercepted workspace reports `eligible: false` even if claims look validated
- Draft enables from backend `eligible: true` even if claims are empty
- No `/section-runs` POST fires from those intercepts
