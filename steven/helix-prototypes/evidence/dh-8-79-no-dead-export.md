# DH-8 (#79): no dead export affordances on demo-frozen runs

Branch `cursor/dh-8-79-no-dead-export`, off `feat/steven-workspace` at `2346c276` (includes #33/#75, #37, #39).
Presentation only. No backend change (`git diff 2346c276 -- backend` is empty). Everything was run locally on Perk's Mac.

## What changed

The "demo-frozen" test is the DH-7 `isDemoFrozen(workspace)` (a pinned run frozen with the demo flag). It now lives in `review/reviewState.ts` and is shared.

| Surface | Demo-frozen run (after this PR) | Qualified run |
|---|---|---|
| Gate 3 `ExportPanel` | Stays disabled with the DH-7 reason, also after an old export. The button reads "Export not available", never "Package exported". There are no receipt hashes. `export-receipt-refused` shows "Not available: demo not qualified…". | unchanged |
| Gate 3 `Downloads` | No links, no checksums, and no artifact probe requests. For a pre-guard export, `downloads-refused` shows "Downloads · Not available: demo not qualified" plus the reason. Otherwise nothing renders. | unchanged |
| Legacy `ReportAssembly` export card (in Gate 3 since #37) | `export-package` is disabled and reads "Export not available". It shows the same reason (`export-package-disabled-reason`, `data-gate="demo_not_qualified"`, `aria-describedby`). The heading is "Artifact export not available" instead of "Approved artifact export". Each artifact shows its label plus "Not available: demo not qualified", with no `<a>` and no `export-checksum-*`. | unchanged |
| Legacy `StudyJourney` "export" stage card (rendered in Gate 3) | The server copy "Approved release package" / "N approved artifacts" / boundary is replaced by "Release package (demo run, not qualified)" / "Not available: demo not qualified" / the reason. This is a 3-line render override via `demoExportStageCopy()`. | server copy unchanged |
| ChatDock at 1024px (Tester P2 on #33) | `scroll-margin-bottom: 136px` on the export reasons, the refused receipt, the refused downloads and the export card. When they are scrolled into view they stop above the fixed dock (about 112px). | same CSS; no visual change (parity identical) |

## Acceptance mapping (#79)

1. **Legacy ReportAssembly export disabled with the DH-7 reason; "Approved" copy dropped.** Screenshots: `dh-8-79/demo-frozen-1440-report-assembly-export-card.png` and `dh-8-79/demo-frozen-1440.json` (`exportPackage.enabled=false`, `packageReason` = DH-7 reason, `approvedReleasePackageText=0`, `approvedArtifactExportText=0`). Spec: `review-export.spec.ts` "demo-frozen run (DH-8): the legacy ReportAssembly export is disabled…".
2. **Pre-guard demo export shows refused states, not live links.** I created a real pre-guard state by freezing and exporting a demo run on the pre-guard commit `6cc1bb96` (flag on). I then served that DB with this branch:
   - `preguard-download-probe.txt`: both artifacts return **409 `demo_not_qualified`** on the head backend, so any link would be dead.
   - Before, on base 2346c276 (`base-preguard-demo-export-1440*.png/json`): "Package exported", 4 live download links, 2 checksums, 3 receipt hashes, and 4 probe GETs that would 409.
   - After, on head (`preguard-demo-export-1440*.png/json`): 0 links, 0 checksums, 0 hashes, 0 probe requests. `downloads-refused` and `export-receipt-refused` are shown and both reasons are visible.
   - Spec: "demo run exported before the DH-7 guard (DH-8)…".
3. **Flag ON/OFF, demo-frozen and qualified coverage.** There are 4 new specs; the verify-live gates below run the specs with the flag ON, OFF, and against the qualified copy.
4. **ChatDock at 1024px.** `demo-frozen-1024-*-scrolled-end.png` and `demo-frozen-1024-chatdock.json` show reason bottom 632 < dock top 657, so the reason is clear. Spec: "demo-frozen run at 1024px (DH-8)…". I confirmed that spec **fails** without the CSS fix, so it is meaningful. There is no position where the reason is permanently covered: it sits more than 4,000px above the document end.

## No functional loss on qualified runs

Qualified copy (`qualified_fixture_root`, flag off), driven live to FSA and then exported. I captured the same DOM facts from **base 2346c276 and head** (`qualified-no-functional-loss.md`):
- **All 30 fields are identical.** Before export: both export buttons are enabled with the same text and heading. After export: 4 download links, 2 legacy links, 2 checksums, 3 receipt hashes, 1 Downloads card, 4 probe requests, and no refused or reason elements.
- A live download returns 200 (`qualified-download-probe.txt`).
- Screenshots: `qualified-{base,head}-{ready,exported}-1440-*.png`.

## Gates vs base (2346c276)

| Gate | Base | Head |
|---|---|---|
| tsc | 0 errors | 0 errors |
| next build (inside verify-live) | pass | pass |
| review-export.spec.ts (local dev, 19434/19435) | n/a | 19/19 passed |
| verify-live flag ON (19444/19445) | 95 passed, 1 skipped, 0 failed | **98 passed**, 1 skipped, 0 failed |
| verify-live flag OFF | 93 passed, 2 failed, 1 skipped | **96 passed, same 2 failed**, 1 skipped |
| verify-live qualified copy | 95 passed, 1 skipped, 0 failed | **98 passed**, 1 skipped, 0 failed |
| parity flag OFF (19454/19455) | 35/35, enforced all pass | 35/35, enforced all pass; **every row's mismatch ratio is identical** (`parity-ratios-head-vs-base.tsv`; traceability-gate-light 0.7127% on both) |

- **Flag-OFF failures.** Both failures are in `workbench.spec.ts:49` (freeze notice "Manifest frozen by the server as Pinned Run") and `workbench.spec.ts:464` ("Workspace is missing a pinned run"). They also fail on base, with identical errors: the default repository root cannot freeze with the flag off.
- **Test count +3.** 4 DH-8 specs were added. "demo flag on: exported downloads show no demo note" was folded into the pre-guard spec: its old expectation (a live `downloads` card on a demo export) is exactly the dead affordance #79 removes, and its `downloads-demo-note` and `DEMO` assertions carry over.
- **Per-test diff.** Head vs base shows only these additions, the removal, and line-number shifts. No test changed status.

## Notes

- `verify-live.sh` and `verify-parity.sh` create their own `mktemp` DB, which cannot be overridden. The dev and evidence servers used `/tmp/helix-dh8.db` (plus `/tmp/helix-dh8-preguard.db` for the pre-guard state).
- The dev server used `NEXT_DIST_DIR=.next-dh8-dev` so it would not clobber the verify-live `.next`. It was removed afterwards, and `tsconfig.json` and `next-env.d.ts` were restored.
- Reproduction scripts are in `dh-8-79/scripts/`.
