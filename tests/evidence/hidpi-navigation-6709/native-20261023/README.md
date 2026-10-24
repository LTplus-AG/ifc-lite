# Native HiDPI navigation qualification (#6709)

Status: refreshed native qualification completed successfully. All 20 original
samples passed at DPR1/DPR2, with five counterbalanced pairs per DPR, unchanged
geometry and CSS-pick witnesses, nonempty full-quality captures, restored
navigation/idle dimensions, and no page/GPU errors. The original cohort and
reviewed verdict are in [result-20261024](./result-20261024/reviewed-verdict.json).

The performance verdict is mixed: GPU queue-completion latency improves at
DPR2, but median/p95 frame cadence does not improve and maximum intervals are
worse around settling. This is no general frame-rate or no-regression claim.
The navigation cap already shipped in #6711; #8089 repairs capture lifetime.
The accepted functional evidence completes the requested comparison without
claiming #6516 loading-regression resolution.

Merge applicability: the later merge of main `fd7545da28` retains this exact
capture/navigation implementation and combines independent performance-ledger
entries. Upstream Rust/export/geometry changes are not a rerun of this cohort.
The measurements and geometry identity remain scoped to the recorded `4f90b5`
and `62dd5c` artifacts; they establish no final-bundle loading latency claim.
Current-head hosted checks validate integration separately.

The viewer policy and original capture gateway shipped in #6711. This follow-up
fixes capture serialization before WebGPU presentation discards its pixels.
The active cohort compares fixed candidate `4f90b5f332454b94e499032f212f05cb3b4a105e`
with uncapped control `62dd5cd2d64dad6beb4e355a98efce42e72bf318` on the physical
NVIDIA desktop. Both arms contain the same capture fix; only the navigation
`maxPixelRatio` expression differs. `source-pair.json` records that exact diff.

`preparation-jobs.json` describes the refreshed pair. Prior preparations and
source pins are retained in `diagnostics/pre-async-*`. Their queued staging and
measurement jobs were positively cancelled before execution when production
reader enforcement changed. No accepted native timing samples were produced.
The current candidate preparation is worker `c3bc74a3-edcd-4003-aef4-a4a9fee28037`: full
root typecheck (127 Turbo tasks plus the root tail) and 57 build/test tasks passed.
`diagnostics/async-validation-*` preserves its receipt and original log, including
the delayed-reader and three rejection regressions. Remaining preparation/staging
receipt IDs stay unset until submitted and cannot qualify in that state.

The refreshed common-runtime proof and original receipts/logs are retained as
`diagnostics/async-control-*` and `diagnostics/async-shared-runtime-*`. Both
production arms use identical WASM, JS bindings and declarations, with unchanged
source. Pop staging jobs `9c61a538` and `fa8d5ee6` precede exclusive cohort
`b157da46` in the worker queue. Those jobs subsequently completed; their original receipts, full observations
and reviewed results are retained under `result-20261024`.

The previous pair used root pnpm/Turbo. Its control passed
56 tasks with unchanged source. Its JS bindings and declarations match Pop, but
the WASM binary differs, so the cross-host pair was refused before timing. The
matching PC candidate also passed all 57 root Turbo tasks and 80 focused tests
with zero skips. Independently built binaries still differ on the same host;
the cause is not established by these hashes. The original receipts and
observed hashes remain in `diagnostics/pc-*-preparation.json`.

`repack-pc-candidate.py` therefore verifies that both full preparations passed,
that all Rust/WASM package source and build inputs are identical, and that the
generated JS bindings and types match. It copies the control's exact generated
runtime as an immutable common dependency, then rebuilds and tests the candidate
viewer through root Turbo. `--only` retains the already validated upstream
builds and prevents rebuilding the common runtime. It is used only after the
full 56/57-task upstream preparations succeeded; no unbuilt sibling is trusted.
The previous repack passed its root viewer rebuild and all 80 focused tests with zero
skips, unchanged sources, and identical WASM/JS/type bytes across the arms.
Its original receipt, proof and compressed log are retained under
`diagnostics/pc-shared-runtime-*`; private manifest
`pc-wsl-6e0cb20d-b9b0-4502-94f4-df770cc432d9-8bdf969119e0`
also preserves the prior candidate WASM. The actual PC reservation has released.
The proof records both original receipts, the canonical producer and hashes,
its own script hash, successful root commands and unchanged sources. This is
preparation evidence only; the cohort still requires exact runtime equality
across both staged served arms before browser startup.

After successful original PC receipts, `stage-pc-build.py` runs under Pop ordinary
admission for each arm. It checks source cleanliness, the original receipt and
output-log hash, and every transferred artifact. Separate staging roots preserve
the original Pop builds and source checkouts. Each `pc-*-transfer.json` binds its
original PC producer, source, artifact hashes and destination. Candidate staging
also verifies the committed repack helper's hash and its completed common-runtime
proof. The cohort binds
both producers to successful Pop staging receipts, freezes the staged served
bytes and requires identical WASM runtime bytes before browser startup. The
pinned original candidate checkout supplies Node harness dependencies; it is
not the served artifact root. No measurement occurs during transfer. A submitted receipt is not success:
`run-cohort.py` refuses either arm until its original receipt proves completed
exit zero, unchanged source, and the exact pinned commit. The fixture path is
resolved from its successful preparation receipt rather than assuming that a
new source checkout already contains the untracked model.

The candidate staging job installs Node dependencies in the pinned Pop source
checkout, copies its verified generated runtime for Node imports, and validates
the actual harness import/schedule before qualifying staging. It uses
`stage-candidate-when-ready.py` and the validated `pcRepackScript` input to recover the
unique original PC repack by its exact script and original input job IDs. It
waits at most ten minutes, refuses failed/ambiguous producers and never submits
one. Its binding records the recovered producer and executed staging command.
This allows both ordinary staging jobs to queue before the exclusive cohort,
without a benchmark barrier blocking a later prerequisite. The PC admission
waiter itself is separately bounded and does not retry a submitted producer.

`frame-dimensions-controls.mts` checks the actual dimension guard used by the
native harness, including missing, nonnumeric, nonfinite, empty and mismatched
axes at DPR1/DPR2. The controller invokes it before browser startup. Every
presentation and live canvas observation must have four finite positive
dimensions before any ratio or expected-resolution comparison is accepted.
This diagnostic qualifies the guard only, not native rendering or timings.

`sample-health-controls.mts` checks that the final idle and host awaits finish
before the error buffer is read. Late page/GPU errors and absent health
observations reject the sample while retaining observed errors. The success
flag is set only after the complete guarded operation wins its deadline race.
The controller runs these ordering controls before browser startup as well.

The earlier pre-fix pair and receipts remain in `diagnostics/pre-fix-*.json` to
explain the retained failed runs. They are historical evidence, not the active
qualification inputs. The completed qualification and explicit mixed verdict are recorded above;
merge and issue closure also require current-head CI and resolved feedback.

## Protocol

- Use the catalogued public `ara3d/AC20-FZK-Haus.ifc` fixture, SHA256
  `d42ab0dee01173106c16cd823b4614efe188fa15dd65195d95b9879bec59acc5`.
  The similarly named committed viewer demo asset has different bytes and is
  deliberately refused by the fixture guard.
- Reconcile the successful root Turbo build/test receipts in
  `preparation-jobs.json`. Freeze every served asset and the package WASM/JS/type
  files; verify source cleanliness, WASM freshness and identical runtime bytes
  across the arms. Revalidate after measurement.
- Wait for the normal Open file input, then load the target as its first model.
  The main viewport is mounted when that model loads. Run one DPR2 smoke, then five counterbalanced A/B pairs at each of DPR1 and
  DPR2. Every sample owns a fresh native browser at a 1440 by 900 CSS viewport.
  The complete smoke and cohort share exclusive registered worker admission.
- Require the active, unlocked local desktop, connected displays, AC power,
  visible/focused page, a non-fallback NVIDIA device request, and retained host
  CPU/memory observations. These sampled observations do not prove absence of
  every unknown source of interference.
- Drive the existing orbit gesture. Record actual camera movement and texture
  dimensions through navigation and settling. Require CSS resolution during
  capped DPR2 navigation, full DPR2 resolution in the control, and restored
  configured resolution on the final settled frame.
- Request the real Screenshot command during a held drag. Retain the generated
  PNG at the canonical download boundary, require full-quality dimensions, and
  verify resumed interactive resolution followed by another sharp settle.
- Compare every published flat mesh field and typed array, coordinate data, and
  canonical placed triangle corners for every semantic owner, including
  instances. Compare before/after navigation and across samples. This witnesses
  the stated CPU domain, not GPU buffer or raw IFNS byte identity.
- Click a CSS-space point independently qualified by the canonical scene
  raycast and verify the actual UI selection. Reject page/WebGPU errors, device
  loss, native GPU driver errors, interrupted focus/session, or missing/nonfinite measurements.
- Stop on the first failure and preserve it. Never replace a failed timing
  sample. A corrected preparation or diagnostic gets a separate attempt and
  does not retroactively qualify the refused run.

Metrics are rAF cadence, rAF JavaScript duration and GPU queue completion
latency. Queue completion is not GPU timestamp execution time. The retained
frame rig also reports its fixed frame-budget counter; interpret it alongside
the observed display cadence. Lower pixel counts alone establish no frame-rate
improvement. Inspect the actual exported raster and paired measurements before
publishing the verdict. This does not resolve #6516's loading regression.

## Retained harness

`qualification.mts` uses the repository's frame probe, orbit inputs, static
server, readiness checks and paired reporter. `native-platform.mts` is the
physical Linux platform adapter, using X11/Xwayland on the active physical
Wayland desktop. The current diagnostic retains ANGLE Vulkan and uses
`--disable-vulkan-surface` after a mixed WebGPU/WebGL capability check. It adds no viewer loader, decoder,
kernel, capture pipeline or production debug API.

`geometry-witness-controls.mts` executes perturbation controls against the
actual fingerprint algorithm, including its serialized page expression under
tsx. Its successful result in `geometry-witness-controls.json` is an evidence
algorithm diagnostic, not native viewer correctness coverage.

The Python controller and preparation receipt IDs describe this particular
admitted run. To reproduce on the provisioned worker, prepare both source arms
with root pnpm/Turbo, fetch the canonical fixture with `pnpm fixtures`, and use
the new successful original receipt IDs in `preparation-jobs.json`. Run the
controller only through registered exclusive benchmark admission. Do not reuse
an uncertain request, bypass a live reservation, or infer acceptance from an
old receipt or script exit alone.

## Refused preparations and diagnostics

The first controller refused the noncanonical demo-asset hash before browser
startup. Attempt 2 rendered the catalogued model but timed out on strict
metadata/render readiness and emitted WebGL errors under Wayland. Attempt 3
stopped before model load because its empty-canvas prerequisite was invalid.
Attempt 4 corrected that prerequisite: parser completion, geometry completion
and scene finalization all passed on the actual NVIDIA adapter, then Chromium's
ANGLE Vulkan WebGL shared-image errors disqualified it before timing.

Attempt 5 used ANGLE OpenGL and native Vulkan initialization. Strict model
readiness completed without the earlier GPU driver errors, but the actual
WebGPU request selected the SwiftShader fallback; the hardware guard refused
it before timing. Its concise result and compressed logs are retained.

No attempt has accepted A/B samples. A separately admitted mixed WebGPU/WebGL
capability matrix found the `vulkan-blit` setup used NVIDIA for both APIs and
presented the red/green canvases in the retained screenshot without WebGPU
errors. Its `readPixels` probe produced a logged performance stall; that message
is retained, not silently discarded. Other variants produced WebGPU import
errors or no WebGL2 context. This is capability evidence only.

Attempt 6 added `--disable-vulkan-surface` to the full model smoke/cohort. The
full viewer still emitted WebGL shared-image errors and was refused before
timing, despite passing strict model readiness on NVIDIA. The simple canvas
capability result did not cover the viewer's location-map texture imports. This
flag is documented in [Chromium's testing guide](https://developer.chrome.com/blog/supercharge-web-ai-testing)
as using blit presentation instead of a Vulkan swapchain. The strict model
readiness, hardware, health and timing guards remain unchanged. In particular,
the model harness still refuses GPU driver log errors. A rendered screenshot
alone is not a model, performance or health verdict.

Bounded service diagnostics localized the driver error to the location-map
WebGL context. Collapsing the sidebar through its normal UI before loading the
model unmounts that map; the main viewport then completes navigation without
GPU driver errors. This layout must be identical in both arms. Expanded-map
behavior is not qualified by those runs.

The model diagnostic exposed a production capture defect: the downloaded PNG
had full dimensions but every RGBA pixel was zero. The gateway yielded for GPU
completion and another animation frame before reading a WebGPU canvas whose
contents can already have been discarded. The retained same-task snapshot
contains the model and remains byte-identical after presentation. That snapshot
caught an interactive frame, so it diagnoses lifetime but does not qualify the
fixed full-resolution export. See `diagnostics/capture-lifetime-result.json`,
the actual PNGs, and the compressed diagnostic source/records.

This follow-up now fixes the gateway to serialize pixels synchronously after
its owned full-quality submission, before yielding. It still waits for GPU
completion/presentation before returning and rejects failed or cancelled work.
The controlled lifecycle fixture now expires the drawing buffer at presentation;
the regression exercises this through the actual renderer, animation loop and
BCF consumer. The corrected source passes all 80 focused capture/BCF/export tests through
root Turbo (57 tasks), then passes the real NVIDIA DPR2 functional smoke. The
actual full-resolution PNG now visibly contains the model; navigation resumes
at CSS resolution, settled quality returns, geometry is identical and all
predeclared pick witnesses pass with no page or GPU driver errors. The PNG and
compact receipts are retained under `diagnostics/capture-fixed-*`. This is a
service-admitted functional result, not accepted performance evidence.

A separate CSS-pick diagnostic found that the CPU-raycast-qualified wall point
selected a window in the actual UI. The uncapped control reproduces that exact disagreement at both DPR1 and
DPR2, while 23 other tested points agree. Actual click events truncate the
fractional target coordinates; the precise cause is not established. The
formal protocol now predeclares wall 27421/item 27395/triangle 10 and roof
slab 59553/item 59529/triangle 2 for correctness, and retains the disputed
triangle 1 as a stability witness expecting the control-observed window 28113.
There is no fallback target search during measurement. The later complete
cohort records a mixed verdict in `result-20261024`; these earlier service
diagnostics never contribute accepted timing samples.
