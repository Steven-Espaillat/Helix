# Visual parity kit

The kit renders one of our screens and the v1 reference build
(`research/helix-e2e-workbench-v1.html`) at the same viewport. It diffs the two
captures with [pixelmatch](https://github.com/mapbox/pixelmatch) and writes the
results under `frontend/parity-out/<screen>/` (gitignored). The run **fails** when
an `enforced` screen differs by more than its threshold, or when any reference
`--hx-*` design token differs on our side (`design-tokens-light`/`-dark`).

Owner: UI step 0. Lanes edit only their own `screens/lane-*.ts` file
(`docs/ui-lanes-ownership.md`).

## Run it

```bash
# From steven/helix-prototypes. Starts a throwaway backend + production web build
# on 8020/3020 (override with HELIX_PARITY_API_PORT / HELIX_PARITY_WEB_PORT).
./scripts/verify-parity.sh

# Against servers you already run (lane workers use their own ports).
# The web server needs HELIX_PARITY_FIXTURES=1 for the /parity component fixtures.
HELIX_PARITY_BASE_URL=http://127.0.0.1:3031 ./scripts/verify-parity.sh
# or: cd frontend && HELIX_PARITY_BASE_URL=http://127.0.0.1:3031 npm run test:parity

# Sensitivity self-test: proves the kit catches known token breaks (same env).
./scripts/verify-parity-sensitivity.sh
```

| Env var | Default | Meaning |
|---|---|---|
| `HELIX_PARITY_BASE_URL` | `http://127.0.0.1:3020` | Our web app. If set, `verify-parity.sh` starts no servers. |
| `HELIX_PARITY_API_PORT` / `HELIX_PARITY_WEB_PORT` | `8020` / `3020` | Ports for the self-started servers. The script refuses to start if a port is busy. |
| `HELIX_PARITY_ONLY` | all | Comma-separated screen IDs. |
| `HELIX_PARITY_INCLUDE_PENDING` | off | `1` also captures `pending` screens. They are reported but never fail. |
| `HELIX_PARITY_OUT` | `parity-out` (gitignored) | Output directory, relative to `frontend/`. |
| `HELIX_PARITY_MUTATE_CSS` | empty | Sensitivity self-test only: CSS injected into our side. Never set it in a normal run. |
| `HELIX_PARITY_FIXTURES` | off | Web-server flag. `1` enables `/parity`. Without it, `/parity` returns 404. |

Outputs for each screen:
- `ours.png`, `reference.png`, and `diff.png`. Only `side-by-side.png` is committed; the other three are gitignored.
- `side-by-side.png`: ours, then the reference, then the diff. Captures wider than 900px stack top to bottom; narrower ones sit left to right.
- `result.json`: the ratio, pixel counts, sizes, and pass/fail.

For the whole run, `summary.md` and `summary.json` are written.

## Capture rules

- The viewport is **1440x900 CSS px at deviceScaleFactor 1**, in a fresh browser context for each side. It uses `reducedMotion: reduce`, disables animations and transitions, hides the caret, and moves the mouse to 0,0 so nothing shows a hover state.
- Fonts are identical on both sides. The reference asks Google Fonts for IBM Plex. The kit answers that request with the same `@fontsource` files our app self-hosts, so the run works offline and diffs never come from a different font build.
- `selector` captures the first matching element. `"viewport"` captures the whole viewport.
- **Size mismatch:** the smaller image is padded with magenta, and the padded pixels count as different. A height change is a real layout diff, so it is never hidden.
- **Masks** (`mask: [selector]` on either side) are unioned and painted the same neutral grey on both images. Masked pixels are left out of the denominator. Use them only for dynamic or deliberately different content, and say why in `notes`.
- `replaceText` exists for server data that cannot be masked cleanly. Prefer masks.

## Threshold and rationale

| Setting | Value | Why |
|---|---|---|
| pixelmatch `threshold` (per-pixel YIQ distance) | **0.02** | The pixelmatch default (0.1) is too loose for this palette: at 0.1, swapping `--hx-surface` white for cream, changing `--hx-bg`, or setting `--hx-line` to `--hx-line-soft` all measured 0.000 %. At 0.02 each of those fails 8 or 9 of the 9 enforced screens, and identical markup still measures 0.000 %. `scripts/verify-parity-sensitivity.sh` re-proves this on every run. |
| Header budget | **0.1 %** | The brand mark is under 1 % of the 1440x60 header, so a full logo recolor measured 0.600 % and passed the default budget. |
| Design tokens | **0 mismatches** | All `--hx-*` tokens in the reference `<style>`: color tokens must resolve to the same color in each theme; others must have the same declared value (quotes and whitespace normalized). |
| `includeAA` | **false** | Anti-aliased edge pixels are detected and not counted. |
| Max diff ratio (fail above) | **1.0 %** of compared pixels | See the measurements below. |

Measured on this kit, 2026-09-24 on macOS in Playwright Chromium:
- **Identical markup** (the shared components rendered with the reference copy) diffs at **0.000 %** on every enforced screen, in both themes.
- **Real drift** fails clearly. Changing `--hx-radius` from 12 to 8 px and `--hx-fs-step` from 11 to 12 px gave 1.55 % to 4.55 % per affected screen, and all 7 affected screens failed.
- **Earlier real bugs this kit found**, all fixed in step 0:

  | Bug | Diff |
  |---|---|
  | A block-level study descriptor, instead of the reference's inline one, moved the header text by about 2 px | 0.5 % light / 1.1 % dark |
  | `-webkit-font-smoothing: antialiased` changed text rasterization compared with the reference | up to 0.9 % |
  | List-row icons were aligned to `middle` instead of the baseline | 0.09 % |

  Most of these sit near the threshold. That is why the threshold is not looser than 1 %. A single-pixel text shift in a text-heavy region lands at roughly 0.5 to 1 %.

**Per-screen overrides:** `maxDiffRatio` and `pixelThreshold` on a screen entry. An override must say in `notes` why it is needed. Do not raise a threshold to turn a real layout difference green. Fix the markup, or record the difference as a documented deviation with a mask.

## Screens

Screen entries live in `screens/`. There is one file per owner, so lanes never edit the same file.

| File | Owner | Screens |
|---|---|---|
| `screens/step0.ts` | step 0 | shell header (light and dark), shared-component fixtures (StageRail at stage 0 and 7 and in dark, GateBanner, DataTable, auth Card, full upload composition), and the report-only whole viewport |
| `screens/lane-a.ts` | Lane A | `journey-progress-light` (#19) and `upload-gate-light` (#20), both pending |
| `screens/lane-b.ts` | Lane B | `agent-step-light` (#21), pending |
| `screens/lane-c.ts` | Lane C | `traceability-gate-light` (#22), pending |
| `screens/lane-d.ts` | Lane D | `review-export-light` and `review-export-dark` (#23), pending |

To turn a lane screen on:
1. Set the reference `?stage=N` to match the server state your seeded backend is in.
2. Point `ours.selector` at your view's root element.
3. Add masks for documented deviations, for example Pause/Resume, which is hidden until #26.
4. Change `status` to `"enforced"`.
5. Run `HELIX_PARITY_ONLY=<id> ./scripts/verify-parity.sh`. Copy **only your own** screen folders' `side-by-side.png` and `result.json` from `frontend/parity-out/<id>/` to `evidence/parity/<id>/` and commit them. Do not commit `summary.*` or other lanes' folders; paste the summary table into the PR body.

The fixture route `/parity?fixture=upload&stage=N` (`src/app/parity`) renders the shared components with the reference copy from `src/app/parity/fixtures.ts`. That data is for tests only; production code must never import it.
