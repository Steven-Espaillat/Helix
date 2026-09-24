# SLICE 8 prove evidence

Commands were run from `steven/helix-prototypes` on `cursor/slice-8-revision-cycles-22d4`.

Base: `688f6ce903459f0484a0b2b3f660321dbfadf35f`.

Organizing structure: append-only `DraftingCycle` plus `admit_attempt` keyed by `(section_package_id, drafting_cycle_id)`. `HumanDirectedRevisionCommand` opens a cycle. It does not edit candidates or Section Drafts and does not invoke Codex. Hold closes the current window. A second revision while the current cycle has zero attempts is rejected.

## make test

```text
make test
```

Outcome: green.

- synthetic bundle verified
- ruff clean
- pytest 118 passed
- frontend typecheck and production build
- first draft without a revision command still records `CYCLE-BW-001` attempt 1
- after three failed attempts, revision preserves the three section runs and an injected Section Draft
- the new cycle admits three more failures, then 409; the first cycle's three attempts remain
- hold enables `can_open_revision` and a later draft is attempt 1 of the new cycle
- a second revision while the successor has zero attempts is 409
- evaluating the new cycle's first candidate mints new provenance, study-output, and conformance receipt ids
- revision adds zero `FakeSectionAgent` calls and leaves discussion eligibility and impact hashes unchanged
- an SOE disposition and pathologist approval bound to the cycle-1 candidate appear in receipt and latest scaffold stale lists
- a monkeypatched `section.dependent` is stored on `cycle.impact_set.transitive`; discussion is excluded
- command and cycle unknown-property and missing-required fixtures fail JSON Schema and Pydantic; valid fixtures pass both

## verify-human-directed-revision.sh

```text
./scripts/verify-human-directed-revision.sh
```

Outcome: green. Wrote `evidence/human-directed-revision-receipt.json`.

- Predecessor cycle: `CYCLE-BW-001`
- New cycle: `CYCLE-53D22D81FD89`
- Attempts: `{CYCLE-BW-001: [1, 2, 3], CYCLE-53D22D81FD89: [1, 2, 3]}`
- Agent calls during revision: `0`
- Fourth attempt of the new cycle: HTTP `409`
- Fresh evaluation id distinct from cycle 1 attempt 3
- Stale disposition ids include the bound SOE result and disposition
- Stale approval ids include the bound pathologist approval
- Discussion impact set unchanged

## predecessor scripts

```text
./scripts/verify-review-scaffold.sh
./scripts/verify-candidate-attempts.sh
```

Outcome: green. Predecessor receipts were not rewritten into this slice.

## verify-live.sh

```text
./scripts/verify-live.sh
```

Outcome: green. Playwright `workbench.spec.ts` 7 passed, 1 skipped (`codex-section-run` without `HELIX_CODEX_LIVE=1`). Includes `offers revise after stop_for_review and shows a new cycle without changing discussion hashes`.

## verify-postgres.sh

Skipped. Tests use `create_all`. No dialect locking change.
