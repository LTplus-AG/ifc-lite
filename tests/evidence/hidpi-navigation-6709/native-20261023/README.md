# Native HiDPI navigation qualification (#6709)

Status: capture fix passes focused tests and a native DPR2 functional smoke;
paired native performance qualification remains pending.
This capsule does not yet establish issue completion or a performance verdict.

The viewer policy and capture gateway shipped in #6711. This follow-up qualifies
that implementation on a physical NVIDIA Linux desktop, using a capped build
of main `be5c740cb9f1c57e4d1531ed574e2708839996be` and the cap-only control
described in `source-pair.json`. The control changes one expression in
`viewport-render-options.ts`; all camera, capture, scene and Rust inputs are
shared. It is a qualification control, not another viewer implementation.

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
There is no fallback target search during measurement. No accepted performance cohort or closure verdict
is claimed. Service diagnostics never contribute accepted timing samples.
