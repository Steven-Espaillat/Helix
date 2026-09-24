# SLICE 9 prove evidence

Commands were run from `steven/helix-prototypes` on `cursor/slice-9-superseding-runs-fec3`.

Base: `68134f412b522317eec18968a036d723c91f38cd`.

Organizing structure: append-only `PredecessorSnapshot` plus complete per-node fingerprints. `plan_supersession` compares parse, validation, and section fingerprints. A correction mints a new `PinnedRun`. It does not mutate the predecessor. Parsing reuses only identical content hashes. A section artifact carries forward only on an identical complete Dependency Fingerprint with recorded lineage. The successor issues fresh DVP receipts, gates, Review Scaffold Revisions, and empty approval state.

P1 follow-up: successor clone remints empty `validation_results` and pending export artifacts; freeze is a single-commit path with `uq_pinned_run_key` IntegrityError replay; `POST /validation-runs` uses the current pinned run instead of the burned study-level freeze key.

## make test

```text
make test
```

Outcome: green.

- synthetic bundle verified
- ruff clean
- pytest 132 passed
- frontend typecheck and production build
- a correction freeze mints a new run with `predecessor_run_id` and `supersession_reason`
- the predecessor pinned run, claims, validations, events, export artifacts, workflow state, section runs, drafts, and frozen inputs remain byte-for-byte in `predecessor_snapshots`
- parse fingerprints match only for identical records and source checksum
- discussion-only template change reuses parse and carries the body-weight candidate with predecessor lineage
- a changed source checksum reruns parse, validation, body-weight, and discussion; carried_forward is empty
- a governed validation-package version change reuses parse and reruns validation plus both sections
- the successor records fresh DVP receipt ids, a new scaffold revision, and empty approvals while a matching artifact is carried
- leftover seed VR-004/005/006 FAIL rows do not block the successor gate after dispositions are wiped; source correction remints hybrid validation via `POST /validation-runs`
- freeze replays `uq_pinned_run_key` IntegrityError on file SQLite QueuePool and concurrent supersession binds one `run_id`
- supersession after export clears successor export artifacts and workflow_state; predecessor export files stay
- lineage, superseding-run, and predecessor-snapshot schemas reject unknown fields and incomplete hashes; Pydantic dual-rejects the same fixtures

## verify-superseding-runs.sh

```text
./scripts/verify-superseding-runs.sh
```

Outcome: green. Wrote `evidence/superseding-run-receipt.json`.

- Predecessor run: `RUN-0AB6B4E8A1E3AE1E`
- Discussion-only successor: `RUN-E4708EBC0BE611C8`
- Source-change successor: `RUN-296FC108D983ED68`
- Parse reused on discussion-only mutation: `true`
- Carried artifact ids include the predecessor candidate and injected Section Draft
- Carried lineage names the predecessor run
- Discussion-only rerun nodes: `section.5_3_discussion`
- Fresh DVP receipt and `GATE-RELEASE` recorded; scaffold sequence 1
- Source change parse reused: `false`
- Source change rerun nodes: parse, validation, body-weight, discussion

## predecessor scripts

```text
./scripts/verify-human-directed-revision.sh
./scripts/verify-review-scaffold.sh
```

Outcome: green. Predecessor receipts were not rewritten into this slice.

## verify-live.sh

```text
./scripts/verify-live.sh
```

Outcome: green. Playwright `workbench.spec.ts` 8 passed, 1 skipped (`codex-section-run` without `HELIX_CODEX_LIVE=1`). Includes `renders predecessor run identity and carry-forward counts from the workspace`.
