# #8946 browser acceptance

Spec: `tests/e2e/command-palette-ux.e2e.spec.ts`. These are UI behavior tests,
not screenshot comparisons. Successful layout/scroll scenarios attach screenshots;
the CI project also retains failure screenshots and traces.

Both viewer projects include `command-palette-ux` in their filename allowlists.

Verify discovery without starting a server/browser:

```sh
pnpm exec playwright test tests/e2e/command-palette-ux.e2e.spec.ts --project=viewer-e2e-ci --list
```

Expect 11 tests: six layout cases, three unloaded keyboard scenarios, one loaded
sample scenario, and one first-visit privacy-notification stacking scenario. After the coordinator's root build has produced this candidate's
viewer dist, run from the repository root through existing fleet admission:

```sh
~/build-workers/ifc-fleet run --cwd "$PWD" -- env PLAYWRIGHT_PORT=31946 pnpm test:e2e:ci tests/e2e/command-palette-ux.e2e.spec.ts
```

Use a free per-run port and verify any reused server belongs to this candidate.
The root `test:e2e:ci` script invokes Playwright directly, so `PLAYWRIGHT_PORT`
is not subject to Turbo's strict environment filtering. No `TEST_PATTERN` is
needed: that variable selects viewer unit-test filenames, not Playwright specs.
The coordinator owns builds and full validation; do not duplicate queued jobs.

Coverage:

- Light and dark at 1440×900, 390×844 and 800×400: dialog and search inside the
  viewport, search top stable through browse/filter/empty/clear; clear is reachable
  and restores input focus. Actual browser rectangles have a 1 CSS px tolerance.
- Native Tab/Shift+Tab cycles through input/close, skipping command options;
  empty results add Clear search to that cycle. Keyboard activation clears it.
- A short viewport's overflowing list scrolls to the last and back to the first
  active row via arrows, keeping input focus and a matching active descendant.
- Escape/reopen resets query/selection. Enter on Settings opens the real Settings
  dialog with its General tab, without changing model data or invoking downloads.
- The bundled `building-architecture.ifc` uses the existing `?model=` load path
  and store readiness signal, then repeats keyboard execution with a real model.
  A missing bundled sample explicitly skips that case; it never fabricates a model.

Unloaded tests deliberately disable `navigator.gpu`, following the existing
palette-entry spec, to avoid irrelevant adapter discovery stalls. The loaded
case retains WebGPU and requires a built WASM runtime and working adapter.
Narrow layout uses a 390 CSS px viewport with a keyboard; this does not certify
an OS virtual keyboard, touch gestures, or mobile browser chrome.

Real GPU evidence on PC requires the existing managed GPU helper and an attaching
harness using `chromium.connectOverCDP(process.env.IFC_GPU_CDP_URL)`. The root
Playwright projects launch their own Chrome and do not consume that variable;
merely wrapping the command in `--gpu` does not attach to Windows Chrome. This
spec does not add an alternative launcher. Coordinate any real GPU acceptance
with the existing helper; a SwiftShader result proves UI behavior only.

No browser tests or builds were run by this test-authoring task. Discovery and
syntax checks alone are not acceptance evidence. IME/recents/task-alias/pointer
handoff scenarios from the hillclimb charter still need separate evidence; this
focused suite does not claim complete #8946 acceptance or any #8947 inventory.

## Durable iteration receipts

For a reviewed candidate, record the exact Git SHA and dist index SHA256 before
capture. Use the existing `tests/ui-scenes/capture.mjs` command-palette scene for
loaded light/dark comparisons against the frozen baseline; its manifest records
the adapter, viewport, errors and screenshot hashes. Keep baseline/candidate roles
separate from file names when using the pair-review helper.

The behavior suite also covers first-visit toast stacking and first-recent selection
on reopen. Keep its screenshot attachments with the JSON reporter: set
`PLAYWRIGHT_JSON_OUTPUT_FILE` to an owned scratch path and append `--reporter=json`.
The report embeds PNG attachment bodies as base64. Extract only those PNGs and a
compact status/skip/error summary, then remove the large intermediate JSON once
verified; the normal list reporter does not retain passed screenshot attachments.
No production UI mock or store mutation substitutes for the loaded sample scenario.

A root Turbo focused check may use `--only` **only after** this source's unchanged
sibling dependencies are already built and the dry run confirms exactly the test
task. This is a lightweight diagnostic, not full root graph/typecheck coverage.
Without that condition use normal fleet admission, since environment-dependent
Turbo hashes can rebuild dependencies even in an apparently built checkout.

Palette comparison matrix (six scenes × two themes), after obtaining a verified
build and the managed GPU helper's CDP endpoint:

```sh
node tests/ui-scenes/command-palette/capture-matrix.mjs \
  --dist "$PALETTE_DIST" --out "$PALETTE_EVIDENCE" --label "$PALETTE_SOURCE" \
  --scenes command-palette,palette-browse,palette-annot,palette-narrow,palette-empty,palette-short \
  --themes light,dark --cdp "$IFC_GPU_CDP_URL"
```

Do not confuse CI head SHA with its tested tree. Record the tested-tree artifact
and compare it to the source tree; a squash/merge-queue head can legitimately have
a different commit SHA with identical tree. Preserve the artifact IDs and dist
hashes. Retire downloaded dist directories and owned preview servers after review;
keep compact screenshots/receipts, not full generated builds.
