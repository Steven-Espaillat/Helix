# SLICE 10 prove evidence

Commands were run from `steven/helix-prototypes` on `cursor/slice-10-final-study-approval-5c17`.

Base: `41bcf1440d0ae0dfeda0b200d6ec6b0bea928d39` (`feat/steven-workspace`, skill_references_hash).

Organizing structure: one immutable `ReleaseCandidate` manifest names every included artifact and content hash. `FinalStudyApproval` records the manifest hash plus the same included hashes. Currentness is exact set equality against the live compiled RC. Export requires a current approval. A Superseding Run clears successor `release_candidate` / `final_study_approval` while the predecessor snapshot retains the prior approval. Language stays at `ready for signature` / `ready for export`.

## Acceptance

- [x] The release-candidate manifest validates against its schema and names every included artifact and content hash.
- [x] Final Study Approval records the manifest hash and all included artifact hashes.
- [x] Unresolved sections, gates, dispositions, or configured reviewer prerequisites prevent approval.
- [x] Changing any included hash immediately marks approval stale and blocks export.
- [x] A Superseding Run cannot inherit predecessor approval.
- [x] An exact replay creates no second approval. Conflicting key reuse returns `409`.
- [x] The approval schemas and Pydantic models reject the same invalid examples and unknown properties, and the frontend shows the exact approval scope.

## make test

```text
make test
```

Outcome: green.

- synthetic bundle verified
- ruff clean
- pytest 146 passed
- frontend typecheck and production build
- OpenAPI regenerated with Final Study Approval / Release Candidate / `approval_current`
- RC + FSA fixtures dual-rejected by JSON Schema and Pydantic (unknown property, missing required, incomplete hash)
- unresolved gates / missing roles / unpromoted drafts return `409` and block export
- included-hash change marks `approval_current` false and blocks export
- superseding run clears live FSA; predecessor snapshot retains prior `approval_id`
- exact replay reuses `approval_id`; conflicting idempotency key returns `409`

## verify-final-study-approval.sh

```text
./scripts/verify-final-study-approval.sh
```

Outcome: green. Wrote `evidence/final-study-approval-receipt.json`.

- Manifest hash bound on approval
- Included artifact count and ids recorded
- Exact replay reused the same approval id
- Conflicting key status `409`
- Stale after included change; stale blocks export
- Superseding run clears approval; predecessor snapshot keeps prior approval id
- Language limited to `ready_for_signature` / `ready_for_export`

## predecessor scripts

```text
./scripts/verify-superseding-runs.sh
./scripts/verify-human-directed-revision.sh
./scripts/verify-review-scaffold.sh
```

Outcome: green. Touched predecessor verifies still pass after FSA export gating.

## verify-live.sh

```text
./scripts/verify-live.sh
```

Outcome: green. Playwright `workbench.spec.ts` / `codex-section-run.spec.ts`: 9 passed, 1 skipped (`codex-section-run` without `HELIX_CODEX_LIVE=1`). Includes end-to-end FSA before export and `renders the exact Final Study Approval scope from the workspace`. UI asserts zero `FDA approved` copy.
