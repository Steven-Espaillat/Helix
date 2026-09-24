# UI lanes: file ownership, ports, and databases

**Status:** in force from UI step 0 (the visual parity kit) until lanes A to D merge. Written against base `feat/steven-workspace` @ `e56bf7fd`, which includes the ADO sync: Alembic migrations, `intake_jobs.py`, and the intake-job routes.
**Scope:** `steven/helix-prototypes` on the fork `Perk4/Helix`. PRs target `feat/steven-workspace`. Issues live on `Steven-Espaillat/Helix`.
**Why:** four lanes build the v1 stage-gated workspace in parallel. Each path below has **one** owner, so lanes do not collide on rebase.

> The upstream tickets (#19 to #23) cite `docs/prototypes/issue-17-api-ui-research/`.
> In this repo the same reference files are `research/helix-e2e-workbench-v1.html` and `research/HANDOFF.md`.
> The HTML wins on conflict.

## 1. Lanes

| Lane | Tickets, in order | One-line scope |
|---|---|---|
| **Step 0** | this PR | Shared tokens and components, shell layout, the parity kit, this map. Step 0 owns the SHARED paths for the whole program. |
| **A** | #19 journey progress, then #20 freeze manifest, then #26 (API gap: upload sessions and run controls) | The Progress Bar from `workspace.journey`. Human Gate 1 over `POST /pinned-runs`. The upload form with intake-job progress (`POST /studies/jobs`, `intake_jobs.py`). Study selection instead of the hard-wired `STUDY-HLX-028`. An explicit, audited human freeze of an uploaded file list. Pause and resume commands. |
| **B** | #21 | The Agent Step view for stages 2 to 7, backed by the existing commands and run events. |
| **C** | #22 | The Traceability Review gate: the accordion, the five-step flow, and the typed disposition form. |
| **D** | #23 plus the demo-unqualified-packages flag | Report review, role approvals, explicit export, and downloads. The demo flag covers **both** the freeze/run qualification gate and the export gate, including their labels. |

Dependencies from the issues:
- #19 blocks #20, #21, #22, and #23.
- #20 blocks #21.
- #21 blocks #22 and #23.
- #22 blocks #23.

In practice, B, C, and D can build their view components against fixtures in parallel. They merge in ticket order and rebase onto A's #19.

## 2. Rules

1. **One owner for each path.** A lane edits only the paths it owns (section 3). It can read anything.
2. **Shared paths belong to step 0.** A lane that needs a change to a SHARED path **stops and escalates**. The escalation goes to the step-0 owner in a comment on the lane PR, plus a note in the lane's evidence file. It names the file, the change, and why. The step-0 owner lands the change as a small PR on `feat/steven-workspace`, and the lane rebases onto it. Do not edit a shared file "just a little". The only exceptions are the ones listed in section 4.
3. **Function-level ownership.** Some hot files (`service.py`, `run_plans.py`, `api.ts`, `workbench.spec.ts`) are split by function below. Touch only your own functions. Adding a new function is a new-file change: put it in a lane-owned module, not the hot file.
4. **New code goes into new, lane-owned files.** Prefer a new component, API module, router, service module, or spec over growing a shared file.
5. **No local authority.** Every lane follows the governance rules in the issues. The frontend never passes a gate, derives release readiness, or advances progress locally.
6. **Synthetic-only.** Keep `Synthetic data · Not for submission` visible. Never claim FDA approval, FDA compliance, or submission readiness.
7. **Parity.** Each lane turns on its screens in its own `frontend/tests/parity/screens/lane-*.ts`. Each lane PR attaches its `verify-parity.sh` result. Do not raise a threshold to get green (see `frontend/tests/parity/README.md`).
8. **Parity evidence.** Runs write to `frontend/parity-out/` (gitignored), so parallel runs never conflict. A lane commits only its **own** screens' folders, `evidence/parity/<screen-id>/{side-by-side.png,result.json}`, where the screen's `lane` is that lane. Every step-0 screen folder (and `design-tokens-*`) belongs to step 0. `summary.json`/`summary.md` are not committed; paste the summary table into the PR body instead.
9. **Serialize Playwright per worktree.** Use your own ports (section 6). Before a run on the Mac, check `lsof -nP -iTCP:<port> -sTCP:LISTEN`. Run only one Playwright job in a worktree at a time, because the dist dirs and `next-env.d.ts` are per worktree.

## 3. Ownership map

### 3.1 SHARED: step 0 owns these; lanes must not edit them

Frontend (`frontend/`):

| Path | What |
|---|---|
| `src/styles/helix-v1.css` | Design tokens (color, type scale, spacing, radii, shadows and halos) and shared component CSS: shell, tones, card, kicker, chip, pill, button, list row, spinner, stage rail, banners, data table, and layout grids. |
| `src/components/ui/**` | The shared component set: `Card`, `Kicker`, `Button`, `Chip`, `Pill`, `Spinner`, `StatusDot`, `ListRow`, `Banner`/`GateBanner`, `StageRail`, `DataTable`/`FileCell`, `cx`/`toneClass`/`toneColor`. |
| `src/components/icons.tsx` | Inline stroke icons. Request new icons from step 0. |
| `src/components/shell/**` | `ShellHeader`, `StudyContext` (`StudyProvider`, `useStudySelection`), `SelectedStudyWorkbench`, and `studyId.ts`. |
| `src/components/HelixWorkbench.tsx` | Shell layout: header, progress region, stage-view slot, notices, and footer. See the A exception in section 4. |
| `src/app/layout.tsx`, `src/app/page.tsx` | Font and stylesheet imports. Lane view stylesheets are already imported. The page reads `?study=`. |
| `src/app/globals.css` | Legacy pre-v1 panel CSS. See the deletion exception in section 4. |
| `src/app/parity/**` | Parity fixtures. They are for tests only. |
| `src/lib/api.ts`: `request`, `ApiError`, `getWorkspace`, `isWorkspace`/`isJourney` guards, `getEvidence` | Core client and workspace read. Section 3.2 lists which lane owns each remaining wrapper. |
| `src/lib/types.ts`, `src/lib/journey-contract.typecheck.ts` | Type re-exports and the #25 contract checks. |
| `src/lib/api-schema.d.ts` | **Generated.** See section 5. |
| `playwright.config.ts`, `playwright.parity.config.ts`, `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts` | Build and test config. A new dependency means escalating. |
| `tests/parity/{parity.spec.ts,image.ts,parity.config.ts,types.ts,global-setup.ts,sensitivity.mjs,screens/index.ts,screens/step0.ts,README.md}`, `evidence/parity/.gitignore` | The parity kit. |
| `tests/shell.spec.ts` | Shell contract (header, tokens, fonts, and the rule that the only navigation is Journey progress). |

Backend (`backend/`) and repo:

| Path | What |
|---|---|
| `backend/migrations/**`, `backend/alembic.ini`, `app/models.py` | Database schema and Alembic history (landed with the ADO sync in base `e56bf7fd`). **Any new table, column, or revision means escalating.** See section 5.3. |
| `app/schemas.py` | `WorkspaceResponse` and every existing model. New lane-only request and response models go in lane modules (section 3.2). |
| `app/main.py` | App factory and route registration. Section 7 proposes routers; until they exist, route edits escalate. |
| `app/database.py`, `app/config.py`, `app/repository.py`, `app/seed.py`, `app/journey.py`, `app/run_events.py` | Cross-cutting persistence, config, and the #25 journey projection and event store. |
| `app/service.py`: `StudyService.__init__`, `workspace`, `list_studies`, `_journey_command` and the run-event sync, `build_stages`, and every private helper not listed in section 3.2 | Workspace assembly and the command transaction wrapper. |
| `app/run_plans.py`: `PinnedRunService.freeze` (orchestration), `_build_plan`, `_load_governed_inputs`, `_load_governed_schema`, `_applicable_packages`, `_resolve_study_type`, hashing helpers | Pinned Run orchestration. Lanes change it only through the extraction in section 7. |
| `backend/openapi.json` | **Generated.** See section 5. |
| `scripts/verify-live.sh`, `scripts/verify-parity.sh`, `scripts/verify-parity-sensitivity.sh`, `Makefile`, `compose.yaml`, `azure-pipelines.yml` | Shared runners and CI. |
| `synthetic-e2e/**`, `skills/**`, `research/**`, `docs/adr/**`, `docs/specifications/**` | Seed data, governed packages, and reference docs. |

### 3.2 Lane-owned paths

Paths marked *(new)* do not exist yet. The owning lane creates them at exactly that path, so the imports other lanes expect stay stable.

**Lane A: #19, #20, #26**

| Area | Paths |
|---|---|
| Journey progress (#19) | `src/components/journey/ProgressBar.tsx` *(new)*: maps `workspace.journey.stages` onto `StageRailNode[]`, with no merge table. `src/components/journey/useSelectedStage.ts` *(new)*: the local selected reached stage. `tests/journey-progress.spec.ts` *(new)*. |
| Gate 1 (#20) | `src/components/upload/UploadGate.tsx`, `PinnedRunDetail.tsx` *(new)*. `src/lib/api/intake.ts` *(new)*: `freezePinnedRun`. `src/styles/views/upload.css`, already seeded from the reference. `tests/upload-gate.spec.ts` *(new)*. |
| Upload and run controls (#26) | `src/components/upload/IntakeUploadForm.tsx`, `IntakeJobProgress.tsx`, `StudyPicker.tsx` *(new)*. Intake-job wrappers (`POST /studies/jobs` and job polling) and pause/resume wrappers go in `src/lib/api/intake.ts` and `src/lib/api/runControls.ts` *(new)*. `tests/intake-upload.spec.ts` *(new)*. |
| Study selection | Lane A **uses** the step-0 seam. It calls `useStudySelection().selectStudy(id)` after an intake job completes, or from `StudyPicker`. It does not edit `StudyContext.tsx`. If the seam is not enough (for example, a server-side list of recent studies), escalate. |
| Backend | `app/intake.py`, `app/intake_jobs.py` (the upload job runner and its stage progress, used by #26), `tests/test_intake.py`, `tests/test_intake_jobs.py`. The intake-job routes that are in `main.py` today stay SHARED until the `routers/intake.py` extraction in section 7. Until then, a change to them means escalating. Proposed *(new)*, see section 7: `app/manifest_authorization.py` (the audited human freeze of an uploaded file list, and the `_validate_manifest` rules); `app/run_controls.py` (pause/resume commands that append `run_paused`/`run_resumed` through the shared event store API); `app/routers/intake.py`; `tests/test_manifest_authorization.py`; `tests/test_run_controls.py`. Function-level: `service.freeze_run`, and `run_plans.PinnedRunService._validate_manifest` until it is extracted. |
| Parity | `tests/parity/screens/lane-a.ts` |

**Lane B: #21**

| Area | Paths |
|---|---|
| Frontend | `src/components/agent/**` *(new)*: `AgentStageView.tsx`, `RunBanner.tsx` (composes `Banner`), `ActivityList.tsx`, `StageIO.tsx`. `src/lib/runEvents.ts`. `src/styles/views/agent.css`. Legacy `src/components/StudyJourney.tsx`, which B replaces and then deletes. `tests/agent-steps.spec.ts` *(new)*, `tests/run-events-client.spec.ts`, `tests/codex-section-run.spec.ts`. |
| `api.ts` functions | `runValidation`, `runDataValidation`, `reviseSection`, `runSectionAgent`, `evaluateCandidate`, `promoteSectionDraft`, `queryCrossSection`. New wrappers go in `src/lib/api/agentSteps.ts` *(new)*. |
| Backend | `app/data_validation.py`, `validation.py`, `body_weight.py`, `section_runs.py`, `section_executor.py`, `section_promotion.py`, `section_revisions.py`, `drafting_cycles.py`, `candidate_evaluations.py`, `cross_section_queries.py`, `provenance_compiler.py`, `study_output_evaluation.py`, `template_conformance.py`, `review_scaffolds.py`, `superseding_runs.py`, `agents/**`, and their tests. Function-level: `service.run_data_validation`, `service.run_validation`. |
| Parity | `tests/parity/screens/lane-b.ts` |

B does **not** own the qualification check that `section_runs.py` calls. Lane D owns it (see section 7).

**Lane C: #22**

| Area | Paths |
|---|---|
| Frontend | `src/components/traceability/**` *(new)*: `TraceabilityStageView.tsx`, `RuleAccordion.tsx`, `TraceFlow.tsx`, `DispositionForm.tsx`. `src/styles/views/traceability.css`. Legacy `src/components/EvidenceChain.tsx`, which C replaces and then deletes. `tests/traceability-gate.spec.ts` *(new)*. |
| `api.ts` functions | `recordDisposition`. C changes it to the typed `DispositionCommand` and deletes the old signature. |
| Backend | Proposed *(new)*: `app/traceability.py` (disposition rules, and the trace-gate approval receipt only if the product needs it); `app/routers/traceability.py`; `tests/test_traceability_gate.py`. Function-level: `service.disposition`, `service.evidence`. |
| Parity | `tests/parity/screens/lane-c.ts` |

**Lane D: #23 plus the demo-unqualified flag**

| Area | Paths |
|---|---|
| Frontend | `src/components/review/**` *(new)*: `ReviewStageView.tsx`, `SectionList.tsx`, `DraftCanvas.tsx`, `SignOffs.tsx`, `ExportPanel.tsx`, `Downloads.tsx`. `src/components/DemoLabel.tsx`, from the `cursor/demo-unqualified-flag` branch. `src/styles/views/review.css`. Legacy `src/components/ReportAssembly.tsx`, which D replaces and then deletes. `tests/review-export.spec.ts` *(new)*. |
| `api.ts` functions | `recordApproval`, `recordFinalStudyApproval`, `exportPackage`, `artifactDownloadUrl`. New wrappers go in `src/lib/api/release.ts` *(new)*. |
| Backend | `app/approved_exports.py`, `release_candidates.py`, `artifacts.py`, `reporting.py`, `template_contracts.py`, `tests/test_export_approved_artifacts.py`, `test_final_study_approval.py`, `test_demo_unqualified_flag.py`. Proposed *(new)*: `app/qualification.py`, the single home for the demo-unqualified flag at the freeze/run and export gates. Function-level: `service.approve`, `record_final_study_approval`, `export`, `artifact`, `derive_release_gate`, and `run_plans.PinnedRunService._pin_declared_identities` (the qualification branch, about lines 495 to 620) until it is extracted. |
| Parity | `tests/parity/screens/lane-d.ts` |

### 3.3 Shared test file: `frontend/tests/workbench.spec.ts`

This 1,300-line legacy full-flow spec is shared. A lane may edit only the `test(...)` blocks whose behavior its ticket changes. Keep those diffs local and put new coverage in the lane's own spec:
- C: disposition calls and assertions.
- D: approval, export, and download assertions.
- B: validation and section-run steps.
- A: freeze steps.

When a lane deletes the legacy component a block drives, it moves the block to its own spec in the same PR.

## 4. Declared exceptions (the only shared edits allowed without escalation)

| Lane | Shared file | Allowed edit |
|---|---|---|
| A (#19) | `src/components/HelixWorkbench.tsx` | A one-time edit of **two regions**: (1) replace the reserved `progress-region` section with `<ProgressBar>`, keeping `data-testid="progress-region"`; (2) replace the body of the `stage-view` section with a switch on the selected stage that renders `UploadGate`, `AgentStageView`, `TraceabilityStageView`, or `ReviewStageView` from the paths in section 3.2. Until those lanes merge, the legacy panels stay as the fallback for their views. After this merge, the file returns to step 0. |
| A (#26) | `src/components/HelixWorkbench.tsx` | Mount `IntakeUploadForm` in the upload view slot. No other change is needed, because study selection already comes from `useStudySelection()`. |
| C (#22) | `src/components/HelixWorkbench.tsx` | The `recordDisposition` signature migration only: the `resolve()` handler that passes the typed command, as #22 requires ("update every caller in the same pull request"). |
| C (#22) | `src/components/ReportAssembly.tsx` (Lane D's file) | **One expression only:** the `recordDisposition(...)` call, updated to the new signature. This is the only cross-lane edit in the program and it is sequenced: C lands it; D never edits that call and rebases over it. If D has already deleted `ReportAssembly.tsx`, the exception lapses and D's replacement must use the new signature. C names the hunk in its PR body. |
| Any lane | `src/app/globals.css` | **Deletions only**, of legacy selectors used only by a legacy component the lane deletes in the same PR. Never add rules here. |
| Any lane | `frontend/tests/parity/screens/index.ts` | None. It already imports all four lane files. |

## 5. Generated API types and cross-cutting backend files

### 5.1 How lanes add endpoints

- Each lane adds endpoints in its **own router module** (`app/routers/<lane>.py`, proposed in section 7). Request and response models live beside the router or in `app/schemas_<lane>.py` *(new)*.
- Changes to `WorkspaceResponse` are SHARED. Examples: new fields that the Progress Bar or gates read. Escalate them. Step 0 lands the schema field first, with a default value, so each lane only fills it.

### 5.2 Regenerated `openapi.json` and `api-schema.d.ts`

These files are never hand-merged.
- Each lane PR commits its regenerated files (`make generate` from `steven/helix-prototypes`). CI and the reviewer check that regenerating leaves no diff.
- When two lanes both added endpoints, **the second lane to merge** resolves the conflict at rebase:
  1. Take either side: `git checkout --theirs backend/openapi.json frontend/src/lib/api-schema.d.ts`.
  2. Run `make generate` on the rebased tree.
  3. Commit the result as "chore: regenerate API types after rebase".

  Because the endpoints are in separate routers, the regenerated output contains both lanes' endpoints with no semantic conflict.
- If a regen changes a shared model, stop and escalate. That means another lane changed `schemas.py`, which the rule forbids.
- Step 0 owns the final regen after all four lanes merge, and it fixes any drift.

### 5.3 Models and migrations

- Tables and columns are SHARED. A lane that needs one escalates with the proposed Alembic revision. Step 0 lands it, or approves the lane landing that one file.
- There is one Alembic head at a time. When two revisions branch from the same head, the second lane to merge re-points its `down_revision` onto the new head at rebase. It never merges heads.

## 6. Worktrees, ports, and databases

The ports below are claimed. Before starting, confirm each is free with `lsof -nP -iTCP:<port> -sTCP:LISTEN`. Never use `8010`/`3010`, which belong to the concurrent ADO-sync proof worker, or `8020`/`3020`, which belong to step 0.

| Lane | Worktree | Branch prefix | Dev API / web | `verify-live.sh` (`HELIX_LIVE_API_PORT` / `HELIX_LIVE_WEB_PORT`) | `verify-parity.sh` (`HELIX_PARITY_API_PORT` / `HELIX_PARITY_WEB_PORT`) | SQLite file | PostgreSQL (if used) |
|---|---|---|---|---|---|---|---|
| step 0 | `/Users/perk/src/Helix-step0` | `cursor/ui-step0-*` | 8020 / 3020 | 8120 / 3120 | 8020 / 3020 | `mktemp` per run | none |
| A | `/Users/perk/src/Helix-lane-a` | `cursor/ui-lane-a-*` | 8031 / 3031 | 8131 / 3131 | 8231 / 3231 | `/tmp/helix-lane-a.db` | db `helix_lane_a` on port 5441 |
| B | `/Users/perk/src/Helix-lane-b` | `cursor/ui-lane-b-*` | 8032 / 3032 | 8132 / 3132 | 8232 / 3232 | `/tmp/helix-lane-b.db` | db `helix_lane_b` on port 5442 |
| C | `/Users/perk/src/Helix-lane-c` | `cursor/ui-lane-c-*` | 8033 / 3033 | 8133 / 3133 | 8233 / 3233 | `/tmp/helix-lane-c.db` | db `helix_lane_c` on port 5443 |
| D | `/Users/perk/src/Helix-lane-d` | `cursor/ui-lane-d-*` | 8034 / 3034 | 8134 / 3134 | 8234 / 3234 | `/tmp/helix-lane-d.db` | db `helix_lane_d` on port 5444 |

- Create a worktree from the main clone:
  ```bash
  git -C /Users/perk/src/Helix fetch origin
  git -C /Users/perk/src/Helix worktree add -b cursor/ui-lane-a-19-progress /Users/perk/src/Helix-lane-a origin/feat/steven-workspace
  ```
  Then run `npm ci` in `frontend/` and `uv sync` in `backend/`.
- Dev servers (example for Lane A):
  ```bash
  HELIX_DATABASE_URL=sqlite+pysqlite:////tmp/helix-lane-a.db \
  HELIX_SEED_PATH=$PWD/../synthetic-e2e/helix-synthetic-bundle.json \
  HELIX_CORS_ORIGINS='["http://127.0.0.1:3031"]' \
  uv run uvicorn app.main:app --host 127.0.0.1 --port 8031

  NEXT_PUBLIC_API_URL=http://127.0.0.1:8031/api/v1 NEXT_DIST_DIR=.next-lane \
  HELIX_PARITY_FIXTURES=1 npx next dev --hostname 127.0.0.1 --port 3031
  ```
- `verify-live.sh` and `verify-parity.sh` create and delete their own temp SQLite files, so they never touch the dev database.
- PostgreSQL (for the PG test variants or intake-job work): each lane starts its **own** throwaway cluster (`initdb`/`pg_ctl` under the worktree's tmp dir) on its port, or uses its own database. Never reuse the ADO-sync worker's cluster.
- Lane A's run-control tests append run events. Keep them on Lane A's DB only.

## 7. Recommended backend extraction (proposal only; step 0 does not change the backend)

`run_plans.py` and `service.py` are touched by A (manifest authorization), C (traceability), and D (qualification gates). Before the lanes start their backend work, one small, behavior-preserving backend PR owned by step 0 (a "step 0.5") should do the following. It moves code without changing behavior, and the existing pytest suite proves that.

| Extract | From | To *(new)* | Owner after |
|---|---|---|---|
| Qualification checks. The `invalid_package_qualification` branch and the `qualification_receipts` hash check, about lines 495 to 620. | `run_plans.PinnedRunService._pin_declared_identities` | `app/qualification.py`: `check_package_qualification(skill, suite_identity) -> list[PlanningEvidence]` and `verify_qualification_receipts(...)`. `section_runs.py` and the export path call the same module. | **D** (the demo-unqualified flag at both gates) |
| Manifest validation and the human authorization of an uploaded file list | `run_plans._validate_manifest`, plus a new audited `authorize_manifest` command | `app/manifest_authorization.py` | **A** |
| Release commands | `service.approve`, `record_final_study_approval`, `export`, `artifact`, `derive_release_gate` | `app/release.py` as free functions; `StudyService` keeps thin delegating methods | **D** |
| Traceability commands | `service.disposition`, `service.evidence` | `app/traceability.py` | **C** |
| Agent-step commands | `service.run_data_validation`, `run_validation` | `app/agent_steps.py` | **B** |
| Routes | `app/main.py` route bodies | `app/routers/{intake,agent_steps,traceability,release}.py` as `APIRouter`s. `main.py` keeps `create_app()`, the event and command transaction wrapper, and one `include_router` line per router (all four pre-wired). | A / B / C / D |

After the extraction, `service.py` and `run_plans.py` keep only orchestration (the shared `_journey_command` transaction and run-event sync, and `PinnedRunService.freeze`). They stop being a collision point. Until the extraction lands, the function-level ownership in section 3 applies. A lane that must touch another lane's function escalates.

Pending work to rebase onto: the `cursor/demo-unqualified-flag` branch (Lane D's input) already touches `run_plans.py`, `service.py`, `section_runs.py`, `release_candidates.py`, `schemas.py`, `openapi.json`, `globals.css`, `HelixWorkbench.tsx`, `ReportAssembly.tsx`, and `StudyJourney.tsx`. Lane D rebases it onto this step 0:
- Its `globals.css` additions move to `src/styles/views/review.css`, or to `DemoLabel` styles in a lane file.
- Its `HelixWorkbench.tsx` hunks go through the exceptions above, or through escalation.
- Its `StudyJourney.tsx` hunks are **not** covered by any exception (that file is Lane B's). D moves that UI into its own `DemoLabel.tsx` rendered from D's views. If a hunk cannot move, D stops and escalates to Lane B and the Chief of Staff before editing.

## 8. Study-selection seam (landed in step 0)

- `src/components/shell/studyId.ts` provides `DEFAULT_STUDY_ID` (`STUDY-HLX-028`) and `normalizeStudyId()`. It accepts an ID only if it matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; anything else falls back to the default.
- `src/app/page.tsx` reads `?study=<id>` on the server and passes it to `<StudyProvider>`.
- `useStudySelection()` returns `{ studyId, selectStudy }`. `selectStudy(id)` updates the context and the URL (`history.replaceState`, no reload). `SelectedStudyWorkbench` remounts `HelixWorkbench` with `key={studyId}`, so no state leaks between studies.
- Lane A (#26): after `POST /studies/jobs` finishes, call `selectStudy(job.study_id)`. The shell then loads that study's workspace. No shell edit is needed.
