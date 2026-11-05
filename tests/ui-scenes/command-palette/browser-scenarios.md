# #8946 browser acceptance

Spec: `tests/e2e/command-palette-ux.e2e.spec.ts`. These are UI behavior tests,
not screenshot comparisons. Successful layout/scroll scenarios attach screenshots;
the CI project also retains failure screenshots and traces.

Both viewer projects include `command-palette-ux` in their filename allowlists.

Verify discovery without starting a server/browser:

```sh
pnpm exec playwright test tests/e2e/command-palette-ux.e2e.spec.ts --project=viewer-e2e-ci --list
```

Expect 10 tests: six layout cases, three unloaded keyboard scenarios, one loaded
sample scenario. After the coordinator's root build has produced this candidate's
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
