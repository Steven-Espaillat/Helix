# UI SLICE 0 prove evidence: v1 tokens and one-page shell (#18)

Commands were run from `steven/helix-prototypes` on `cursor/ui-slice-0-v1-shell-tokens`, locally on macOS (Node 22.23.2, npm 10.9.8).

Base: `4a1d22ac86e05ebd3395add74ec48704de6c7156` (`feat/steven-workspace`, "Merge main and preserve governed section execution").
Tip: the PR head commit that adds this note. Its SHA is in the PR description.

Sources: `research/helix-e2e-workbench-v1.html` (it wins on conflict), `research/HANDOFF.md` sections 2, 3, 5.1, and 6, `docs/specifications/helix-v1-ui-redesign.md`, ADR 0022, and issues Steven-Espaillat/Helix#18 and #17. `.scratch/helix-ui-redesign-v1/grill-with-docs.md` does not exist in the checkout, so this slice did not use it.

## Acceptance

- [x] The v1 header renders the brand, the study identity from `WorkspaceResponse.study`, the `Synthetic data · Not for submission` badge, the release pill, and a synthetic demo avatar. `tests/shell.spec.ts` checks it in light and dark themes.
- [x] The Study journey, Evidence chain, and Report assembly tabs are gone, and the page has no side menu. The shell spec checks that no matching button or tab, no `navigation` role, and no `tablist` exists.
- [x] The v1 `light-dark()` tokens are copied from the reference into `:root`. The shell's cards, buttons, chips, focus outline, and tone helpers read only `--hx-*` tokens. The old panel variables are aliases of those tokens, and the old hex literals were replaced with tokens. No component file contains a hex color.
- [x] UI text uses IBM Plex Sans and identifiers use IBM Plex Mono, both self-hosted through `@fontsource`. Georgia (`--hx-serif`) is used only for report body text. The spec checks that no element outside `.report-paper` computes a Georgia font.
- [x] Inline stroke SVG icons replace the `✓` and `→` text symbols. The spec checks that the shell chrome has no emoji or arrow and check symbols, and that the page has no emoji.
- [x] The release pill still takes its status from `WorkspaceResponse.release_gate.status` and keeps `data-testid="release-status"`, plus `data-status` and `data-workflow-state`. A routed spec changes only the server status and confirms that the pill follows it.
- [x] One loading, error, and retry boundary wraps `getWorkspace`. Loading is a polite `status`, and an error is an `alert` whose Retry button you can reach with Tab and activate with Enter.
- [x] Playwright covers light and dark themes through `page.emulateMedia({ colorScheme })`. Screenshots: `evidence/helix-v1-shell-light.png` and `evidence/helix-v1-shell-dark.png`.
- [x] The spec checks that the page text contains no claim of FDA approval, FDA compliance, or submission readiness.

## make test

```text
make test
```

Outcome: **red, and it fails the same way before this change.** `make test` stops at `ruff check` with 10 errors in `backend/app/approved_report_retrieval.py` and `backend/app/section_executor.py`. Both files came in with the upstream merge in base `4a1d22a`, and this PR does not touch the backend.

Each step, run on its own against this branch:

| Step | Result | Same on base `4a1d22a`? |
|---|---|---|
| `node skills/helix-evidence-pipeline/scripts/verify-synthetic-bundle.mjs ...` | verified (1662 records, 14 edges, 3 blockers, release blocked) | yes |
| `cd backend && uv run ruff check app tests scripts` | 10 errors | yes, same 10 |
| `cd backend && uv run pytest` | 84 failed, 66 passed | yes, same 84 failed and 66 passed |
| `cd frontend && npm run typecheck` | pass | n/a |
| `cd frontend && npm run build` | pass (Next.js 16.3.5, compiled, TypeScript finished) | n/a |

The backend failures trace to `invalid_package_qualification` ("Agentic package qualification has not passed"). Both section packages declare `qualification_status: "pending"`, and the merged run-plan gate rejects them. The SLICE 11 evidence recorded pytest at 150 passed before the merge.

## verify-live

```text
./scripts/verify-live.sh
```

Outcome on this branch: **12 passed, 2 failed, 1 skipped** (the Codex live spec is skipped without `HELIX_CODEX_LIVE=1`).

- Pass: all 4 new `tests/shell.spec.ts` tests (light shell, dark shell, loading/error/retry, server-owned release pill).
- Pass: 8 existing `tests/workbench.spec.ts` tests.
- Fail: `runs the synthetic study from validation through explicit export`. `POST /validation-runs` returns 422 `invalid_package_qualification`, which is the backend qualification gate above.
- Fail: `renders predecessor run identity and carry-forward counts from the workspace`. The seeded workspace has no `pinned_run`, so the test fixture throws "Workspace is missing a pinned run."

Baseline on unmodified `4a1d22a`: **8 passed, 2 failed, 1 skipped**, with the same two tests failing for the same reasons. This change adds 4 passing tests and no new failures.

Local-only diagnostic, **not committed and not a prove result**: I temporarily set both section packages to `qualification_status: "passed"` with the matching suite hash, then ran `./scripts/verify-live.sh` again. Result: **14 passed, 1 skipped, 0 failed**, including the full validation-to-export flow and the predecessor-run test on the one-page layout. I then reverted the package files and the regenerated legacy evidence with `git checkout`.

## Test changes in `tests/workbench.spec.ts`

- Removed the clicks on the Study journey, Evidence chain, and Report assembly tabs, because all three panels now render on one page.
- Removed one assertion that `review-scaffold-history` is hidden on the Report assembly tab. With no tabs, that state no longer exists.
- The synthetic badge text is now `Synthetic data · Not for submission`. The release pill text now uses the v1 labels (`Release blocked`, `Ready for signature`, `Ready for export`, `Package exported`), and one `data-status` assertion was added.

## Deviations from the reference

- The tokens live on `:root` instead of `#helix-e2e`, so the page background and the boot states share them. The shell root still uses `id="helix-e2e"`.
- The reference hides the synthetic badge below 1100px. Issue #18 and spec #17 require the badge on every screen, so the header wraps instead.
- The reference avatar reads "Signed-in user" and shows initials. Here it is a person icon labeled "Synthetic demo identity. Not an authenticated user or signer." Configured identity is #27.
- `app/icon.svg` (the favicon) keeps its old colors, because a favicon cannot read CSS tokens.
