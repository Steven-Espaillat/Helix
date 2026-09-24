# SLICE 11 prove evidence

Commands were run from `steven/helix-prototypes` on `cursor/slice-11-export-approved-artifacts-f543`.

Base: `2650d139117a39923952724ee3f9c9c951361c1d` (`feat/steven-workspace`, SLICE 10 Final Study Approval absorb).

Organizing structure: `materialize_approved_artifacts` exports only the `(artifact_id, content_hash)` pairs named by the current Final Study Approval. Bytes are the canonical JSON preimage of each approved hash. Export installs an `ExportProbe` that counts agent starts and deterministic calculation runs and refuses a non-zero probe. Review Scaffold revisions fail `admit_export_document` and never enter the artifact set. Receipt status is `exported` only.

## Acceptance

- [x] The export command is unavailable until the backend reports `ready_for_export`.
- [x] A stale approval, changed artifact, unapproved artifact, or Review Scaffold reference rejects export.
- [x] The export contains exactly the artifact IDs and hashes in the approval.
- [x] An exact replay returns identical artifact IDs, checksums, and bytes and appends no second export event.
- [x] Instrumentation proves that export starts no agent and runs no deterministic calculation.
- [x] PostgreSQL and byte-equality tests match stored bytes to the approval and receipt checksums.
- [x] A live browser test downloads the artifacts and verifies them against the receipt.

## make test

```text
make test
```

Outcome: green.

- synthetic bundle verified
- ruff clean
- pytest 150 passed
- frontend typecheck and production build
- OpenAPI regenerated with `approval_id`, `manifest_hash`, and `instrumentation` on `ExportReceipt`
- export replaces seed `OUT-*` placeholders with pending approved artifacts at Final Study Approval
- export materializes exact approved hashes without calling `generate_artifact`
- exact replay reuses bytes and appends one `explicit_export` event
- stale FSA / Review Scaffold admission / missing approval continue to return `409`

## verify-export-approved-artifacts.sh

```text
./scripts/verify-export-approved-artifacts.sh
```

Outcome: green. Wrote `evidence/export-approved-artifacts-receipt.json`.

## predecessor scripts

```text
./scripts/verify-final-study-approval.sh
./scripts/verify-superseding-runs.sh
```

Outcome: green after export binding.

## verify-live.sh

```text
./scripts/verify-live.sh
```

Outcome: green. Playwright `workbench.spec.ts` / `codex-section-run.spec.ts`: 9 passed, 1 skipped (`codex-section-run` without `HELIX_CODEX_LIVE=1`). Downloads each exported artifact and checks `sha256(bytes)` against the receipt checksum and Final Study Approval included hashes. UI asserts zero `FDA approved` copy.
